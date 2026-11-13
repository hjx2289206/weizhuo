#!/usr/bin/env python3
"""Audit the server's DouZero bridge against the official DouZero implementation.

Run with the runtime venv:

    .ai/export-venv/bin/python scripts/douzero-audit.py --games 3

For every step of real (random-driven) official rollouts it:

1. projects the true game into the *public* input our server sends to the worker
   (own hand, public bottom, per-seat remaining counts, public play history),
2. rebuilds the information set with ``server/bots/douzero_worker.build_infoset``,
3. compares every observation-bearing field against the official acting infoset,
4. compares the full ``get_obs`` tensors exactly,
5. compares the chosen action with the official ``DeepAgent.act``.

Any mismatch is printed and makes the process exit non-zero. This is the evidence
that the official network sees exactly the official observation and that no hidden
hand information crosses into it.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server' / 'bots'))

import numpy as np  # noqa: E402

import douzero_worker as worker  # noqa: E402  (also puts the pinned official source on sys.path)
from douzero.env.env import Env, get_obs  # noqa: E402
# Reference only: load the original architecture directly, without upstream training imports.
import importlib.util
import torch
spec = importlib.util.spec_from_file_location('official_models', worker.SRC / 'douzero/dmc/models.py')
reference_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference_module)


class DeepAgent:
    def __init__(self, role, path):
        self.model = reference_module.model_dict[role]()
        self.model.load_state_dict(torch.load(path, map_location='cpu', weights_only=True), strict=True)
        self.model.eval()

    def act(self, infoset):
        obs = get_obs(infoset)
        with torch.no_grad():
            values = self.model(torch.from_numpy(obs['z_batch']).float(), torch.from_numpy(obs['x_batch']).float(), return_value=True)['values']
        return infoset.legal_actions[int(values.argmax())]

POSITIONS = ('landlord', 'landlord_down', 'landlord_up')
SCALARS = ('last_move', 'last_two_moves', 'last_move_dict', 'bomb_num', 'last_pid', 'num_cards_left_dict')
LISTS = ('player_hand_cards', 'three_landlord_cards', 'card_play_action_seq', 'legal_actions', 'played_cards')


def public_state(env: Env, position: str, bottom: list[int]) -> dict:
    game = env._env  # audit only: reads the engine to build the *public* projection
    seat_of = lambda pos: worker.POSITION_OFFSET[pos]  # noqa: E731 - landlord occupies seat 0 here
    plays: list[dict] = []
    seat = 0
    for action in game.card_play_action_seq:
        if action:
            # Exercise the table's descending replay representation, not just official ordering.
            plays.append({'seatId': seat, 'ranks': sorted((worker.CODE_TO_RANK[code] for code in action), reverse=True)})
        seat = (seat + 1) % 3
    counts = [len(game.info_sets[pos].player_hand_cards) for pos in POSITIONS]
    return {
        'selfSeat': seat_of(position),
        'turn': seat_of(game.acting_player_position),
        'landlord': seat_of('landlord'),
        'hand': [worker.CODE_TO_RANK[code] for code in game.info_sets[position].player_hand_cards],
        'bottom': [worker.CODE_TO_RANK[code] for code in bottom],
        'counts': counts,
        'tablePlays': plays,
    }


def compare(index: int, position: str, mine, truth) -> list[str]:
    problems: list[str] = []
    for field in LISTS:
        got, want = getattr(mine, field), getattr(truth, field)
        if got != want:
            problems.append(f'{field}: {got!r} != {want!r}')
    for field in SCALARS:
        got, want = getattr(mine, field), getattr(truth, field)
        if got != want:
            problems.append(f'{field}: {got!r} != {want!r}')
    if Counter(mine.other_hand_cards) != Counter(truth.other_hand_cards):
        problems.append('other_hand_cards: multiset differs from the public unknown multiset')
    mine_obs, truth_obs = get_obs(mine), get_obs(truth)
    for key, value in truth_obs.items():
        mirror = mine_obs.get(key)
        if not isinstance(value, np.ndarray):
            if mirror != value:
                problems.append(f'obs[{key}]: {mirror!r} != {value!r}')
            continue
        if mirror is None or mirror.shape != value.shape or not np.array_equal(mirror, value):
            problems.append(f'obs[{key}]: tensor mismatch')
    if problems:
        problems = [f'step {index} ({position})'] + problems
    return problems


def public_last_play(sequence: list[list[int]]) -> dict | None:
    """The engine's rules cursor as the room publishes it: null once the trick is cleared."""
    trailing = 0
    for action in reversed(sequence):
        if action:
            break
        trailing += 1
    if trailing >= 2:
        return None
    for index in range(len(sequence) - 1, -1, -1):
        action = sequence[index]
        if action:
            return {'seatId': index % 3, 'ranks': [worker.CODE_TO_RANK[code] for code in action]}
    return None


def play_against_random(models: dict, position: str, games: int, seed: int) -> tuple[int, int]:
    """Play the runtime path (public state -> worker -> official ranking) against random play."""
    wins = decisions = 0
    random.seed(seed)
    env = Env('wp')
    for _ in range(games):
        env.reset()
        bottom = list(env._env.three_landlord_cards)
        while not env._game_over:
            actor = env._env.acting_player_position
            if actor == position:
                state = public_state(env, actor, bottom)
                infoset, resolved = worker.build_infoset(state)
                ranked, _, _, _ = worker.choose(models[resolved], infoset)
                action = ranked[0]
                decisions += 1
            else:
                action = random.choice(env.infoset.legal_actions)
            assert action in env.infoset.legal_actions
            env.step(action)
        winner = env._env.get_winner()
        if (winner == 'landlord') == (position == 'landlord'):
            wins += 1
    return wins, decisions


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--games', type=int, default=3)
    parser.add_argument('--seed', type=int, default=20261017)
    parser.add_argument('--max-steps', type=int, default=400)
    parser.add_argument('--random-games', type=int, default=0,
                        help='per-role games played against random opponents with the runtime path')
    parser.add_argument('--dump-states', default=None,
                        help='write sampled public states plus the official action to this JSONL path')
    parser.add_argument('--dump-limit', type=int, default=40)
    args = parser.parse_args()
    dumped = 0

    torch.set_num_threads(2)
    models = worker.load_models()
    official_agents = {role: DeepAgent(role, str(ROOT / '.douzero/weights/douzero_WP' / f'{role}.ckpt')) for role in POSITIONS}
    random.seed(args.seed)
    np.random.seed(args.seed)

    problems: list[str] = []
    steps = actions = 0
    positions_seen: Counter[str] = Counter()
    coverage: Counter[str] = Counter()
    for game_index in range(args.games):
        env = Env('wp')
        env.reset()
        bottom = list(env._env.three_landlord_cards)
        for _ in range(args.max_steps):
            if env._game_over:
                break
            truth = env.infoset
            position = truth.player_position
            state = public_state(env, position, bottom)
            mine, resolved = worker.build_infoset(state)
            if resolved != position:
                problems.append(f'step {steps}: resolved position {resolved} != {position}')
            steps += 1
            positions_seen[position] += 1
            sequence = truth.card_play_action_seq
            if any(len(action) == 0 for action in truth.legal_actions):
                coverage['legal_pass_available'] += 1
            if not sequence:
                coverage['free_lead'] += 1
            if sequence and len(sequence[-1]) == 0:
                coverage['trailing_pass'] += 1
            if len(sequence) >= 2 and len(sequence[-1]) == 0 and len(sequence[-2]) == 0:
                coverage['trailing_two_passes'] += 1
            if len(truth.three_landlord_cards) < 3:
                coverage['bottom_card_already_played'] += 1
            if truth.bomb_num:
                coverage['after_a_bomb'] += 1
            problems.extend(compare(steps, position, mine, truth))
            ranked, legal_count, _, _ = worker.choose(models[position], mine)
            if legal_count != len(truth.legal_actions):
                problems.append(f'step {steps}: legal action count {legal_count} != {len(truth.legal_actions)}')
            official = official_agents[position].act(truth)
            if list(ranked[0]) != list(official):
                problems.append(f'step {steps} ({position}): chose {ranked[0]} but official act chose {official}')
            if args.dump_states and dumped < args.dump_limit:
                with open(args.dump_states, 'a', encoding='utf-8') as handle:
                    handle.write(json.dumps({
                        'position': position,
                        'state': state,
                        'sequence': [[worker.CODE_TO_RANK[code] for code in action] for action in sequence],
                        'lastPlay': public_last_play(sequence),
                        'legal': len(truth.legal_actions),
                        'passLegal': any(len(action) == 0 for action in truth.legal_actions),
                        'expected': [worker.CODE_TO_RANK[code] for code in official],
                    }) + '\n')
                dumped += 1
            action = random.choice(truth.legal_actions)
            if action:
                actions += 1
            env.step(action)
            if problems:
                break
        if problems:
            break

    print(f'games={args.games} steps={steps} non-pass plays={actions} positions={dict(positions_seen)}')
    print(f'coverage={dict(coverage)}')
    if problems:
        for problem in problems[:40]:
            print('MISMATCH', problem)
        print(f'FAILED: {len(problems)} problems')
        return 1
    print('OK: reconstructed information sets, observations and actions match the official implementation')
    if args.random_games:
        for offset, role in enumerate(POSITIONS):
            wins, decisions = play_against_random(models, role, args.random_games, args.seed + offset)
            print(f'{role}: won {wins}/{args.random_games} against random opponents '
                  f'({decisions} runtime decisions)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
