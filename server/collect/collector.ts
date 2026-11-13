// Opt-in Guandan data collection for later bot training, backed by the built-in node:sqlite
// (DatabaseSync, no native dependency). A room writes two things, never blocking or failing
// gameplay: one `deals` row per deal (the captured deal seed: all four hands after tribute,
// levels, the leading seat and the resolved exchange pairs) and one `commands` row per
// authoritative engine command, a bot's automatic picks included. The finished result lands
// on the deal row the moment the engine publishes it.
//
// Strictly opt-in: nothing is opened or written unless GUANDAN_COLLECT=1. The database lives
// in gitignored var/guandan-collect.db (override with GUANDAN_COLLECT_PATH). Every call
// swallows its own failures after reporting them exactly once — data collection must never
// decide a game or delay a message.
//
// Export: scripts/guandan-export.py turns one database into training JSONL.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Card } from '../../shared/protocol';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DB = join(ROOT, 'var', 'guandan-collect.db');

interface CollectedCard {
  id: string;
  rank: number;
  suit: string;
}

/** Deal facts worth keeping: the exact seed the bot runtime replays from. */
export interface CollectedDeal {
  roomCode: string;
  game: 'guandan';
  /** Room-local, strictly increasing counter of observed dealSeed instances. */
  dealSeq: number;
  deal: number;
  level: number;
  teamLevels: readonly [number, number];
  leader: number;
  hands: readonly (readonly Card[])[];
  tribute: readonly {
    giver: number;
    receiver: number;
    tribute: Card;
    returned: Card | null;
  }[];
}

/** Minimum identity to attach a finished round result to an already recorded deal. */
export interface GuandanResultKey {
  roomCode: string;
  game: 'guandan';
  deal: number;
  dealSeq: number;
}

export interface CollectedCommand {
  roomCode: string;
  game: 'doudizhu' | 'guandan';
  phase: string;
  dealSeq: number;
  deal: number | null;
  seatId: number | null;
  type: string;
  payload: Record<string, unknown> | null;
}

type Statement = { run: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] };

type Database = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
};

type QueuedEntry =
  | { kind: 'deal'; payload: CollectedDeal; result?: unknown }
  | { kind: 'result'; payload: GuandanResultKey; result: unknown }
  | { kind: 'command'; payload: CollectedCommand };

/**
 * Records one deal row; the room repeats it once `result` is known (an UPDATE keyed by
 * room+deal). The collector is a sidecar: any error here never reaches a peer.
 */
export const guandanCollector = {
  /** GUANDAN_COLLECT=1 (or true) turns collection on for this server process. */
  get enabled(): boolean {
    const value = process.env.GUANDAN_COLLECT;
    return value === '1' || value === 'true';
  },

  deal(data: CollectedDeal, result: unknown): void {
    try {
      ensureOpen();
      if (ready) insertDeal(data, result);
      else queue.push({ kind: 'deal', payload: data, result });
    } catch (error) {
      warnOnce(error);
    }
  },

  /** The finished round result of one recorded deal, keyed by room code + deal number. */
  dealResult(key: GuandanResultKey, result: unknown): void {
    try {
      ensureOpen();
      if (ready) {
        insertResult(key, result);
      } else {
        queue.push({ kind: 'result', payload: key, result });
      }
    } catch (error) {
      warnOnce(error);
    }
  },

  command(data: CollectedCommand): void {
    try {
      ensureOpen();
      if (ready) insertCommand(data);
      else queue.push({ kind: 'command', payload: data });
    } catch (error) {
      warnOnce(error);
    }
  },

  /** Server shutdown path; pending queued rows flush before the file closes. */
  flush(): void {
    try {
      while (queue.length > 0) {
        if (!ready) break;
        const entry = queue.shift()!;
        if (entry.kind === 'deal') insertDeal(entry.payload, entry.result);
        else if (entry.kind === 'command') insertCommand(entry.payload);
        else insertResult(entry.payload, entry.result);
      }
    } catch (error) {
      warnOnce(error);
    }
  },
};

/**
 * The queue drains into the db once it finishes opening; `ready` flips inside that promise.
 * Broadcasts are synchronous, so early rows queue for a few milliseconds at most.
 */
const queue: QueuedEntry[] = [];
let database: Database | null = null;
let ready = false;
let opening = false;
let warned = false;

function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[采集] Guandan 数据采集已中止（${message}）；对局不受影响。`);
}

function ensureOpen(): void {
  if (opening || ready) return;
  if (!guandanCollector.enabled) return;
  opening = true;
  void (async () => {
    try {
      const { DatabaseSync } = (await import('node:sqlite')) as { DatabaseSync: new (path: string) => Database };
      const path = process.env.GUANDAN_COLLECT_PATH || DEFAULT_DB;
      mkdirSync(dirname(path), { recursive: true });
      const db = new DatabaseSync(path);
      db.exec('PRAGMA journal_mode=WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS deals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_code TEXT NOT NULL,
          game TEXT NOT NULL,
          deal_seq INTEGER NOT NULL DEFAULT 0,
          deal INTEGER NOT NULL,
          level INTEGER NOT NULL,
          team_levels TEXT NOT NULL,
          leader INTEGER NOT NULL,
          hands TEXT NOT NULL,
          tribute TEXT NOT NULL,
          result TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS deals_room ON deals(room_code, deal_seq);
        CREATE TABLE IF NOT EXISTS commands (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_code TEXT NOT NULL,
          game TEXT NOT NULL,
          deal_seq INTEGER NOT NULL DEFAULT 0,
          phase TEXT NOT NULL,
          deal INTEGER,
          seat INTEGER,
          type TEXT NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS commands_room ON commands(room_code, deal_seq);
      `);
      database = db;
      migrate(db);
      ready = true;
      guandanCollector.flush();
    } catch (error) {
      warnOnce(error);
    }
  })();
}

/**
 * Databases written by an earlier build may lack the deal_seq link column. Adding a column
 * with a NOT NULL DEFAULT 0 backfills existing rows, so partial older collections stay
 * readable; a fresh column name that already exists simply re-errors and is ignored.
 */
function migrate(db: Database): void {
  for (const table of ['deals', 'commands']) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN deal_seq INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // column exists: this schema is current
    }
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS ${table}_deal ON ${table}(room_code, deal_seq)`);
    } catch {
      warnOnce(new Error(`无法为 ${table} 建索引`));
    }
  }
}

function cardOf(card: Card): CollectedCard {
  return { id: card.id, rank: card.rank, suit: card.suit };
}

function insertDeal(data: CollectedDeal, result: unknown): void {
  database!.prepare(
    'INSERT INTO deals (room_code, game, deal_seq, deal, level, team_levels, leader, hands, tribute, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    data.roomCode,
    data.game,
    data.dealSeq,
    data.deal,
    data.level,
    JSON.stringify(data.teamLevels),
    data.leader,
    JSON.stringify(data.hands.map((hand) => hand.map(cardOf))),
    JSON.stringify(
      data.tribute.map((pair) => ({
        giver: pair.giver,
        receiver: pair.receiver,
        tribute: cardOf(pair.tribute),
        returned: pair.returned ? cardOf(pair.returned) : null,
      })),
    ),
    result === null || result === undefined ? null : JSON.stringify(result),
    Date.now(),
  );
}

function insertResult(key: GuandanResultKey, result: unknown): void {
  // A rematch reuses deal numbers: deal_seq (the room-local dealSeed counter) separates them,
  // so level progression of the previous match keeps its own result intact.
  database!.prepare(
    'UPDATE deals SET result = ? WHERE id = (SELECT MAX(id) FROM deals WHERE room_code = ? AND deal_seq = ? AND result IS NULL)',
  ).run(JSON.stringify(result), key.roomCode, key.dealSeq);
}

function insertCommand(data: CollectedCommand): void {
  database!.prepare(
    'INSERT INTO commands (room_code, game, deal_seq, phase, deal, seat, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    data.roomCode,
    data.game,
    data.dealSeq,
    data.phase,
    data.deal,
    data.seatId,
    data.type,
    data.payload === null ? null : JSON.stringify(data.payload),
    Date.now(),
  );
}
