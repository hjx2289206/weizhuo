"""DanLM Guandan inference worker (stdio NDJSON), modeled on douzero_worker.py.

The Node bridge (server/bots/guandan.ts) writes one request JSON object per line; this
worker answers one response JSON object per line. Everything that imports DanLM's
compiled `danzero` modules (cpython-312 darwin extensions) lives here.

Statelessness with a replay: apart from the lazily loaded model bundle, the worker keeps
no per-room state. Each request carries the whole deal — the four hands at deal start
(already after tribute/return transfers), the leading seat and this deal's public play
rows from OUR server-authoritative engine. The worker builds the official
`GuanDanRound(level, hands, first_player, team_levels)`, replays every row through
`step()` while feeding the agents `observe_action()`, and asks `get_q_values()` at the
exact current state. A mismatch between the two rule engines fails the request loudly
instead of inventing a move.

Card mapping: our raw rank 3..15 (15 === 2) maps to their rank index 1..12 plus 0 for
"2"; our raw 16/17 jokers map to their 52/53. Suits come from `danzero.engine.cards
SUIT_CHARS` ('H','S','C','D' per ui/game_manager.py) at runtime, never from an
assumption baked into this file.

Wildcards: their play vectors keep a wildcard counted at its own heart level-card type
(ui/game_manager.py marks `is_wild` from the card integer alone), so our replay rows
translate a wildcard by its own (rank, suit) as well — no substitution rewriting needed.

Honesty: tribute give/back decisions stay deterministic on the Node side (the room's
local rule); this worker only decides accepted-play rows (play vs pass) and judge rows
in the model's own Q ordering, best-first, so the bridge can validate and fall through.
"""

from __future__ import annotations

import json
import os
import sys
import traceback

SOURCE = os.environ.get("GUANDAN_SRC", "")
if not SOURCE:
    print(json.dumps({"ok": False, "error": "缺少 GUANDAN_SRC 环境变量"}), flush=True)
    sys.exit(1)

sys.path.insert(0, SOURCE)

sys.path.insert(0, os.path.dirname(__file__))

import numpy  # noqa: E402

from danzero.engine.cards import NUM_RANKS, SMALL_JOKER, SUIT_CHARS, TOTAL_CARD_TYPES  # noqa: E402
from danzero.engine.actions import DIM_CARDS, DIM_PLAY_TYPE, play_type_of  # noqa: E402
from danzero.engine.game import GuanDanRound  # noqa: E402
from danzero.engine.tribute import TributeRecord  # noqa: E402
from guandan_onnx import AGENT_REGISTRY, OnnxGuandanAgent  # noqa: E402

MAX_TOP_K = 8
MAX_PASS_WALK = 6


def out(payload: dict) -> None:
    print(json.dumps(payload), flush=True)


# ---------------------------------------------------------------------------
# card mapping
# ---------------------------------------------------------------------------

SUIT_OF_OUR_NAME = {"spade": "S", "heart": "H", "club": "C", "diamond": "D"}
OUR_NAME_OF_CHAR = {"H": "heart", "S": "spade", "C": "club", "D": "diamond"}
_build_order = "".join(SUIT_CHARS)
for char in SUIT_OF_OUR_NAME.values():
    if char not in _build_order:
        out({"ok": False, "error": f"未知的花色符号 {char!r}（SUIT_CHARS={''.join(SUIT_CHARS)}）"})
        sys.exit(1)


def card_int(card: dict) -> int:
    rank = card["r"]
    suit = card["s"]
    if suit == "joker":
        return SMALL_JOKER + (1 if rank == 17 else 0)
    rank_idx = 0 if rank == 15 else rank - 2  # raw 15 === "2"
    return _build_order.index(SUIT_OF_OUR_NAME[suit]) * NUM_RANKS + rank_idx


def raw_of(value: int) -> dict:
    if value == SMALL_JOKER:
        return {"r": 16, "s": "joker"}
    if value == SMALL_JOKER + 1:
        return {"r": 17, "s": "joker"}
    char = SUIT_CHARS[value // NUM_RANKS]
    idx = value % NUM_RANKS
    return {"r": 15 if idx == 0 else idx + 2, "s": OUR_NAME_OF_CHAR[char]}


def raw_cards_from_vector(vector: numpy.ndarray) -> list[dict]:
    cards: list[dict] = []
    for value, count in enumerate(vector[:DIM_CARDS]):
        for _ in range(int(count)):
            cards.append(raw_of(value))
    return cards


def vector_counts(vector: numpy.ndarray) -> list[int]:
    return [int(value) for value in vector[:DIM_CARDS]]


# ---------------------------------------------------------------------------
# agents: one lazily loaded bundle per registry key
# ---------------------------------------------------------------------------

agents: dict[str, OnnxGuandanAgent] = {}


def agent_for(key: str) -> OnnxGuandanAgent:
    if key not in agents:
        agents[key] = OnnxGuandanAgent(key)
    return agents[key]


# ---------------------------------------------------------------------------
# replay
# ---------------------------------------------------------------------------

def hands_from_payload(payload: dict) -> numpy.ndarray:
    hands = numpy.zeros((4, TOTAL_CARD_TYPES), dtype=numpy.int64)
    for seat, cards in enumerate(payload["deal"]["hands"]):
        for card in cards:
            hands[seat][card_int(card)] += 1
    return hands


def notify_tribute(agent: OnnxGuandanAgent, pairs: list[dict]) -> None:
    """Feed resolved exchange pairs in the agent's own TributeRecord shape."""
    records: list[TributeRecord] = []
    for pair in pairs:
        tribute = pair.get("tribute")
        returned = pair.get("returned")
        if not tribute:
            continue  # 抗贡 pairs carry no cards on our side; nothing to notify
        records.append(TributeRecord(pair["giver"], pair["receiver"], card_int(tribute)))
        if returned:
            records.append(TributeRecord(pair["receiver"], pair["giver"], card_int(returned)))
    if records:
        agent.notify_tribute(records)


def observe_and_step(agent: OnnxGuandanAgent, rnd: GuanDanRound, obs, action_index: int):
    player = int(obs.player)
    vector = numpy.array(obs.legal_plays[action_index], copy=True)
    new_obs = rnd.step(action_index)
    new_trick = new_obs is not None and bool(new_obs.is_leading)
    agent.observe_action(player, vector, new_trick)
    return new_obs


def step_pass(agent: OnnxGuandanAgent, rnd: GuanDanRound, obs, why: str):
    """Apply one real pass: find the official pass row in the current legal plays."""
    legal = obs.legal_plays
    for index in range(legal.shape[0]):
        if play_type_of(legal[index]) == "pass":
            new_obs = observe_and_step(agent, rnd, obs, index)
            if new_obs is not None and new_obs.player != obs.player:
                return new_obs
            # A pass advances the turn; if it did not (trick boundary edge), let the
            # caller's walk continue against the same obs — mirrored anyway.
            return new_obs
    raise RuntimeError(f"重放失败：{why}（它们的牌让不出 pass 行）")


CLAIM_TYPES = {
    "single": "single", "pair": "double", "triple": "triple",
    "triplePair": "fullhouse", "straight": "straight", "threePairs": "tube",
    "twoTriples": "plate", "bomb": "normalbomb", "straightFlush": "flushbomb",
    "fourJokers": "jokerbomb",
}


def matches_claim(vector, claim: dict) -> bool:
    """Match the accepted semantic action, not merely its physical wildcard cards."""
    if play_type_of(vector) != CLAIM_TYPES[claim["kind"]]:
        return False
    if claim["kind"] == "fourJokers":
        return True
    rank = int(claim["primaryRank"])
    rank_index = 0 if rank == 15 else rank - (3 if rank >= 16 else 2)
    return bool(vector[DIM_CARDS + DIM_PLAY_TYPE + rank_index])


def replay_to_decision(
    agent: OnnxGuandanAgent, rnd: GuanDanRound, obs, rows: list[dict], stop_seat: int,
    stop_leading: bool | None = None,
):
    """Replay accepted plays at their actual trick boundary, including borrowed leads.

    The finisher's partner is visited once to pass on the finishing play and again
    to lead after everybody passes. Seat identity alone cannot distinguish these.
    Older in-memory deals lack `leading`; walk past an unmatched response there,
    but never pass a free lead or silently discard an unreplayable history row.
    """
    for row in rows:
        target = int(row["seat"])
        wanted = sorted(card_int(card) for card in row["cards"])
        leading = row.get("leading")
        claim = row["claim"]
        for walk in range(MAX_PASS_WALK + 1):
            if obs is None:
                raise RuntimeError("重放失败：牌局在到达目标座位前已结束")
            at_context = obs.player == target and (leading is None or bool(obs.is_leading) == leading)
            if at_context:
                match = None
                legal = obs.legal_plays
                for index in range(legal.shape[0]):
                    if not matches_claim(legal[index], claim):
                        continue
                    got = [value for value, count in enumerate(vector_counts(legal[index])) for _ in range(count)]
                    if got == wanted:
                        match = index
                        break
                if match is not None:
                    obs = observe_and_step(agent, rnd, obs, match)
                    break
                if leading is not None or obs.is_leading:
                    raise RuntimeError(f"重放失败：座位 {target} 的历史出牌不在它们的合法动作里({wanted})")
            if walk == MAX_PASS_WALK:
                raise RuntimeError(f"重放失败：无法回到座位 {target} 的出牌点")
            obs = step_pass(agent, rnd, obs, f"座位 {target} 出牌前的 pass")

    # Walk the remaining passes until the acting seat owns the decision point.
    for walk in range(MAX_PASS_WALK + 1):
        if obs is None:
            raise RuntimeError("重放失败：轮到决策座位前牌局已结束")
        if obs.player == stop_seat and (stop_leading is None or bool(obs.is_leading) == stop_leading):
            return obs
        if walk == MAX_PASS_WALK:
            break
        obs = step_pass(agent, rnd, obs, "决策座位的 pass")
    raise RuntimeError("重放失败：过多 pass 没能回到决策座位")


def candidates(agent: OnnxGuandanAgent, rnd: GuanDanRound, obs) -> list[dict]:
    """Best-first candidates in the model's own Q order for the bridge to validate."""
    values = agent.get_q_values(obs, rnd)
    order = numpy.argsort(values)[::-1]
    legal = obs.legal_plays
    plays: list[dict] = []
    for index in order:
        vector = legal[index]
        if play_type_of(vector) == "pass":
            plays.append({"pass": True})
        else:
            plays.append({"cards": raw_cards_from_vector(vector)})
        if len(plays) >= MAX_TOP_K:
            break
    return plays


# ---------------------------------------------------------------------------
# request handling
# ---------------------------------------------------------------------------

def handle(request: dict) -> dict:
    kind = request.get("agent")
    if kind not in AGENT_REGISTRY:
        available = ", ".join(sorted(AGENT_REGISTRY))
        raise RuntimeError(f"未知模型 {kind!r}（可用：{available}）")
    agent = agent_for(kind)  # lazily loads the bundle; a preload just warms it here
    if request.get("preload"):
        return {"agent": kind}
    level = request["level"]
    agent_level = level if level <= 14 else 2  # raw 15 === "2"
    agent.reset_round(agent_level)
    notify_tribute(agent, request.get("tribute", []))

    hands = hands_from_payload(request)
    rnd = GuanDanRound(
        level=agent_level,
        hands=hands,
        first_player=int(request["firstPlayer"]),
        team_levels=tuple(request["teamLevels"]),
    )
    obs = rnd.get_observation()
    obs = replay_to_decision(agent, rnd, obs, request["rows"], int(request["selfSeat"]), request.get("leading"))
    return {
        "agent": kind,
        "plays": candidates(agent, rnd, obs),
        "legal": len(request["rows"]),
    }


def main() -> None:
    out({"ok": True, "backend": "onnxruntime", "providers": ["CPUExecutionProvider"],
         "suits": _build_order, "agents": sorted(AGENT_REGISTRY)})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            out({"ok": False, "error": f"请求行不是 JSON：{error}"})
            continue
        request_id = request.get("id")
        try:
            result = handle(request)
            out({"id": request_id, "ok": True, **result})
        except Exception as error:  # noqa: BLE001 — one bad request must not kill the worker
            detail = traceback.format_exc().strip().split("\n")[-3:]
            out({"id": request_id, "ok": False, "error": f"{error}", "detail": " / ".join(detail)})


if __name__ == "__main__":
    main()
