#!/usr/bin/env python3
"""DouZero CPU inference worker for the tabletop server.

Speaks one JSON object per line on stdin/stdout. Loads the three official DouZero
role networks as ONNX (landlord / landlord_down / landlord_up) once, then answers card-play
requests serially.

Only official DouZero code paths do the actual work:

* ``douzero.env.game.GameEnv.get_infoset`` builds the info set: legal actions come
  from the official move generator (``douzero.env.move_generator``) and the official
  move detector/selector; the observation fields are filled by the official code.
* ``douzero.env.env.get_obs`` encodes the observation fed to the network.
* The ONNX exports of ``douzero.dmc.models.model_dict`` provide the original
  per-action values through CPUExecutionProvider; no Torch model is imported.

This file contains no rule engine, no move enumeration, no random/min substitute.
Opponent hands never enter the process: hidden hands are rebuilt as a deterministic
placeholder split of the *public* unknown multiset (deck - own hand - played cards),
whose union is exactly what the official observation uses.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import sys
import traceback
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SRC = Path(os.environ.get('DOUZERO_SRC') or (ROOT / '.douzero' / 'douzero-src'))

DEVICE = 'cpu'

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import numpy as np  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
from onnx_cpu import MODEL_DIR, cpu_session  # noqa: E402

from douzero.env.env import get_obs  # noqa: E402
from douzero.env.game import GameEnv  # noqa: E402

# Our ranks: 3..15 (15 == 2), 16 small joker, 17 big joker.
# Official DouZero codes: 3..14, 17 ('2'), 20 (small joker), 30 (big joker).
RANK_TO_CODE = {**{rank: rank for rank in range(3, 15)}, 15: 17, 16: 20, 17: 30}
CODE_TO_RANK = {code: rank for rank, code in RANK_TO_CODE.items()}
DECK_CODES = [code for code in range(3, 15) for _ in range(4)] + [17, 17, 17, 17, 20, 30]
SELF_POSITIONS = ('landlord', 'landlord_down', 'landlord_up')  # seat = (landlord + offset) % 3
POSITION_OFFSET = {'landlord': 0, 'landlord_down': 1, 'landlord_up': 2}
ROLES = ('landlord', 'landlord_down', 'landlord_up')
MAX_TRAILING_PASSES = 2


class StateError(ValueError):
    """The caller supplied a state that cannot be a real public snapshot."""


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def position_of(seat: int, landlord: int) -> str:
    return SELF_POSITIONS[(seat - landlord) % 3]


def ranks_to_codes(ranks: list[int]) -> list[int]:
    out = []
    for rank in ranks:
        if rank not in RANK_TO_CODE:
            raise StateError(f'unknown card rank {rank!r}')
        out.append(RANK_TO_CODE[rank])
    return out


def probe_cards(state: dict[str, Any]) -> tuple[list[int], list[int]]:
    hand = ranks_to_codes([int(rank) for rank in state['hand']])
    bottom = ranks_to_codes([int(rank) for rank in state['bottom']])
    return hand, bottom


def build_sequence(state: dict[str, Any], landlord: int, turn: int) -> tuple[list[list[int]], list[int]]:
    """Replay the public play history into official ``card_play_action_seq``.

    ``tablePlays`` is the public accepted-play history of the deal, oldest first; it
    carries no passes. Passes are reconstructed from the fixed seating rotation
    (landlord leads), including two passes between the same actor's consecutive plays
    and passes at the tail before the acting player.
    """
    sequence: list[list[int]] = []
    actors: list[int] = []
    previous: int | None = None
    for index, play in enumerate(state['tablePlays']):
        seat = int(play['seatId'])
        if seat not in (0, 1, 2):
            raise StateError(f'table play {index} has seat {seat}')
        if previous is None:
            if seat != landlord:
                raise StateError('the deal must open with a landlord lead')
        else:
            tail = (previous + 1) % 3
            passes = 0
            while tail != seat:
                sequence.append([])
                actors.append(tail)
                tail = (tail + 1) % 3
                passes += 1
                if passes > MAX_TRAILING_PASSES:
                    raise StateError('play history implies an impossible pass run')
        # The table records descending ranks; official detectors require ascending moves.
        sequence.append(sorted(ranks_to_codes([int(rank) for rank in play['ranks']])))
        actors.append(seat)
        previous = seat

    if previous is None:
        if turn != landlord:
            raise StateError('nobody has played yet, so the landlord must be on turn')
    else:
        tail = (previous + 1) % 3
        passes = 0
        while tail != turn:
            sequence.append([])
            actors.append(tail)
            tail = (tail + 1) % 3
            passes += 1
            if passes > MAX_TRAILING_PASSES:
                raise StateError('trailing passes cannot exceed two')
    return sequence, actors


def is_bomb(cards: list[int]) -> bool:
    """Official ``bombs`` membership for a generator-sorted action."""
    if len(cards) == 2:
        return cards[0] == 20 and cards[1] == 30
    return len(cards) == 4 and len(set(cards)) == 1


def build_infoset(state: dict[str, Any]) -> tuple[Any, str]:
    self_seat = int(state['selfSeat'])
    turn = int(state['turn'])
    landlord = int(state['landlord'])
    if self_seat not in (0, 1, 2) or turn not in (0, 1, 2) or landlord not in (0, 1, 2):
        raise StateError('seat fields must be 0..2')
    if turn != self_seat:
        raise StateError('the acting player must be the seat on turn')
    counts = [int(value) for value in state['counts']]
    if len(counts) != 3:
        raise StateError('counts must hold three seats')

    hand, bottom = probe_cards(state)
    if not bottom:
        raise StateError('the three landlord cards are public during card play')
    if counts[self_seat] != len(hand):
        raise StateError('counts[selfSeat] must be the acting player’s remaining cards')

    position = position_of(self_seat, landlord)
    sequence, actors = build_sequence(state, landlord, turn)

    played_by_seat: list[list[int]] = [[], [], []]
    for seat, action in zip(actors, sequence):
        played_by_seat[seat].extend(action)

    for seat in range(3):
        expected = 20 if seat == landlord else 17
        remaining = expected - len(played_by_seat[seat])
        if remaining != counts[seat]:
            raise StateError(
                f'counts must be remaining cards per seat (seat {seat}: expected {remaining}, got {counts[seat]})')

    unknown = list(DECK_CODES)
    for code in hand:
        unknown.remove(code)
    for seat in range(3):
        for code in played_by_seat[seat]:
            unknown.remove(code)

    last_move_dict: dict[str, list[int]] = {role: [] for role in ROLES}
    last_pid = 'landlord'
    bomb_num = 0
    for seat, action in zip(actors, sequence):
        role = position_of(seat, landlord)
        last_move_dict[role] = list(action)
        if action:
            last_pid = role
            if is_bomb(action):
                bomb_num += 1

    others = [seat for seat in range(3) if seat != self_seat]
    hidden_total = sum(counts[seat] for seat in others)
    if len(unknown) != hidden_total:
        raise StateError('public card count does not add up')
    # Deterministic placeholder split of the public unknown multiset; only its union
    # (``other_hand_cards``) and the per-seat sizes reach the observation.
    unknown.sort()
    hands_by_seat: dict[int, list[int]] = {self_seat: list(hand)}
    cursor = 0
    for seat in others:
        hands_by_seat[seat] = unknown[cursor:cursor + counts[seat]]
        cursor += counts[seat]

    # The official information set keeps the three landlord cards minus the ones the
    # landlord already played (multiset semantics, as in GameEnv.step).
    bottom_left = list(bottom)
    for code in played_by_seat[landlord]:
        if code in bottom_left:
            bottom_left.remove(code)

    env = GameEnv(players={})  # players is only read by GameEnv.step, which we never call
    env.acting_player_position = position
    env.card_play_action_seq = sequence
    env.three_landlord_cards = bottom_left
    env.played_cards = {position_of(seat, landlord): list(played_by_seat[seat]) for seat in range(3)}
    env.last_move_dict = last_move_dict
    env.last_pid = last_pid
    env.bomb_num = bomb_num
    for seat, cards in hands_by_seat.items():
        env.info_sets[position_of(seat, landlord)].player_hand_cards = list(cards)
    env.last_move = env.get_last_move()
    env.last_two_moves = env.get_last_two_moves()
    return env.get_infoset(), position


class RoleModel:
    def __init__(self, role: str, path: Path) -> None:
        self.role = role
        self.path = path
        self.session = cpu_session(path.name)
        self.digest = hashlib.sha256(path.read_bytes()).hexdigest()

    def scores(self, obs):
        return self.session.run(None, {
            'z': obs['z_batch'].astype(np.float32),
            'x': obs['x_batch'].astype(np.float32),
        })[0].reshape(-1)


def choose(model: RoleModel, infoset: Any, strength: str = 'strong') -> tuple[list[list[int]], int, list[float], int]:
    """Official ranking: argmax over the model values of the official legal actions.

    The easy tier never swaps models: it samples among the top-ranked official actions with a
    softmax over their exact network values (temperature 1.0, top 5), so the softer behaviour
    is visibly drawn from the same weights. Returns
    ``(ranked_actions, legal_count, scores_in_legal_order, pick_index)``.
    """
    legal = [list(action) for action in infoset.legal_actions]
    if len(legal) == 1:
        return legal, 1, [], 0
    obs = get_obs(infoset)
    if obs['x_batch'].shape[0] != len(legal):
        raise RuntimeError('observation/legal action mismatch from the official encoder')
    values = model.scores(obs)
    scores = values.astype(float).tolist()
    order = np.argsort(-np.asarray(scores), kind='stable')
    # Our engine filters these moves: a top-k cutoff can discard the best legal action.
    ranked = [legal[int(index)] for index in order]
    primary = legal[int(np.argmax(values))]
    if ranked[0] != primary:  # tie-breaking parity with the official DeepAgent.act
        ranked = [primary] + [action for action in ranked if action != primary]
    ranked_scores = [scores[legal.index(action)] for action in ranked]
    pick = 0
    if strength == 'easy':
        pool = min(5, len(ranked_scores))
        top = ranked_scores[:pool]
        peak = max(top)
        weights = [math.exp(value - peak) for value in top]
        roll = random.random() * sum(weights)
        running = 0.0
        for index, weight in enumerate(weights):
            running += weight
            if roll <= running:
                pick = index
                break
        pick = min(pick, pool - 1)
    return ranked, len(legal), scores, pick


def handle(request: dict[str, Any], models: dict[str, RoleModel]) -> dict[str, Any]:
    state = request.get('state')
    if not isinstance(state, dict):
        raise StateError('missing state')
    strength = request.get('strength') or 'strong'
    if strength not in ('strong', 'easy'):
        raise StateError(f'unknown strength {strength!r}')
    infoset, position = build_infoset(state)
    ranked, legal_count, scores, pick = choose(models[position], infoset, strength)
    return {
        'ok': True,
        'position': position,
        'legal': legal_count,
        'candidates': [[CODE_TO_RANK[code] for code in action] for action in ranked],
        'pick': pick,
        'top_score':scores[0] if scores else None,
    }


def load_models() -> dict[str, RoleModel]:
    models: dict[str, RoleModel] = {}
    for role in ROLES:
        path = MODEL_DIR / f'douzero-{role}.onnx'
        if not path.is_file():
            raise RuntimeError(f'missing weights: {path}')
        models[role] = RoleModel(role, path)
    return models


def serve() -> int:
    try:
        models = load_models()
    except Exception as error:  # noqa: BLE001 - reported to the server as an honest reason
        print(json.dumps({'ready': False, 'error': f'{type(error).__name__}: {error}'}), flush=True)
        log(traceback.format_exc())
        return 1
    print(json.dumps({
        'ready': True,
        'device': DEVICE,
        'backend': 'onnxruntime',
        'providers': ['CPUExecutionProvider'],
        'numpy': np.__version__,
        'source': str(SRC),
        'weights': {role: {'path': str(model.path), 'sha256': model.digest} for role, model in models.items()},
    }), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            print(json.dumps({'ok': False, 'error': f'bad json: {error}'}), flush=True)
            continue
        if request.get('op') == 'close':
            return 0
        identifier = request.get('id')
        try:
            response = handle(request, models)
        except Exception as error:  # noqa: BLE001 - the server surfaces this and stops the bot
            response = {'ok': False, 'error': f'{type(error).__name__}: {error}'}
            log(traceback.format_exc())
        response['id'] = identifier
        print(json.dumps(response), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(serve())
