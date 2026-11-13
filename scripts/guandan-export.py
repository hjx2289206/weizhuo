#!/usr/bin/env python3
"""Export Guandan training data from the collection database to JSONL.

The collector (server/collect/collector.ts, opt-in via GUANDAN_COLLECT=1) stores one `deals`
row per deal — the four hands right after tribute, the levels, the leading seat and the
resolved exchange pairs — plus one `commands` row per authoritative engine command. This
script joins them into one JSON object per finished deal:

    {"room": "AB12", "deal": 3, "level": 6, "teamLevels": [6, 4], "leader": 1,
     "hands": [[{"id": "g0-s5", "rank": 5, "suit": "spade"}, ...] x4],
     "tribute": [{"giver": 0, "receiver": 1, "tribute": {...}, "returned": {...} | null}],
     "plays": [{"seat": 0, "kind": "play" | "pass", "cards": [...], "claim": {...}}, ...],
     "result": {...}}

Cards keep the room's raw encoding: rank 3..15 (15 === 2), 16/17 the two jokers, and suit
spade/heart/club/diamond/joker. Only deals with a recorded result are exported, so a
database that a fast server killed mid-deal stays clean.

Usage: python3 scripts/guandan-export.py [db-path] [out.jsonl]
Defaults: var/guandan-collect.db -> var/guandan-train.jsonl (print when stdout is a tty).
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_DEFAULT = os.path.join(ROOT, "var", "guandan-collect.db")
OUT_DEFAULT = os.path.join(ROOT, "var", "guandan-train.jsonl")

PLAY_TYPES = ("play", "pass")


def rows(connection: sqlite3.Connection, sql: str, args: tuple = ()) -> list[tuple]:
    cursor = connection.execute(sql, args)
    return list(cursor.fetchall())


def parse_card(card) -> dict:
    # Room command payloads carry physical card ids; deal rows carry full face objects.
    if isinstance(card, str):
        return {"id": card}
    return {"id": str(card["id"]), "rank": int(card["rank"]), "suit": str(card["suit"])}


def export(db_path: str, out_path: str) -> int:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row

    deals = rows(
        connection,
        "SELECT id, room_code, game, deal_seq, deal, level, team_levels, leader, hands, tribute, result "
        "FROM deals WHERE result IS NOT NULL ORDER BY room_code, id",
    )
    written = 0
    with open(out_path, "w", encoding="utf-8") as stream:
        for deal in deals:
            # deal_seq is the room's own counter of deal instances: it pairs every command
            # with exactly one deal row, independent of the two tables' id sequences.
            commands = rows(
                connection,
                "SELECT phase, seat, type, payload FROM commands "
                "WHERE room_code = ? AND deal_seq = ? AND type IN ('play', 'pass') ORDER BY id",
                (deal["room_code"], deal["deal_seq"]),
            )
            plays = []
            for command in commands:
                kind = str(command["type"])
                if kind not in PLAY_TYPES:
                    continue
                payload = json.loads(command["payload"]) if command["payload"] else {}
                seat = command["seat"]
                plays.append(
                    {
                        "seat": -1 if seat is None else int(seat),
                        "kind": kind,
                        "cards": [parse_card(card) for card in payload.get("cards", [])],
                        "claim": payload.get("claim"),
                    }
                )
            record = {
                "room": deal["room_code"],
                "game": str(deal["game"]),
                "dealSeq": int(deal["deal_seq"]),
                "deal": int(deal["deal"]),
                "level": int(deal["level"]),
                "teamLevels": json.loads(deal["team_levels"]),
                "leader": int(deal["leader"]),
                "hands": [
                    [parse_card(card) for card in hand] for hand in json.loads(deal["hands"])
                ],
                "tribute": [
                    {
                        "giver": int(pair["giver"]),
                        "receiver": int(pair["receiver"]),
                        "tribute": parse_card(pair["tribute"]),
                        "returned": parse_card(pair["returned"]) if pair.get("returned") else None,
                    }
                    for pair in json.loads(deal["tribute"])
                ],
                "plays": plays,
                "result": json.loads(deal["result"]),
            }
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            written += 1
    return written


def main() -> None:
    db_path = sys.argv[1] if len(sys.argv) > 1 else DB_DEFAULT
    out_path = sys.argv[2] if len(sys.argv) > 2 else OUT_DEFAULT
    if not os.path.exists(db_path):
        print(f"no collection database at {db_path} (start the server with GUANDAN_COLLECT=1)", file=sys.stderr)
        sys.exit(1)
    count = export(db_path, out_path)
    print(f"exported {count} finished deals -> {out_path}")


if __name__ == "__main__":
    main()
