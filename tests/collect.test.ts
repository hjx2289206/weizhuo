// Opt-in Guandan collection smoke test: the collector writes deals/commands/results into an
// isolated database (temp path via GUANDAN_COLLECT_PATH) and the export script turns them
// into one JSONL record per finished deal. Gameplay never depends on this staying green —
// but if it does, training data collection keeps working.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card, Suit } from '../shared/protocol';

process.env.GUANDAN_COLLECT = '1';
const dir = mkdtempSync(join(tmpdir(), 'guandan-collect-'));
process.env.GUANDAN_COLLECT_PATH = join(dir, 'collect.db');

const { guandanCollector } = await import('../server/collect/collector');

const card = (id: string, rank: number, suit: Suit): Card => ({ id, rank, suit });

const deal = {
  roomCode: 'ZZ99',
  game: 'guandan' as const,
  dealSeq: 1,
  deal: 1,
  level: 6,
  teamLevels: [6, 4] as const,
  leader: 2,
  hands: [[card('a-h6', 6, 'heart'), card('a-s9', 9, 'spade')], [], [], []],
  tribute: [{ giver: 0, receiver: 2, tribute: card('a-s9', 9, 'spade'), returned: null }],
};

function waitReady(attempt = 0): Promise<void> {
  // The database opens asynchronously on first use; poll until the file exists.
  const path = join(dir, 'collect.db');
  if (existsSync(path) || attempt > 60) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, 50)).then(() => waitReady(attempt + 1));
}

test('collector stores deals, commands and results behind GUANDAN_COLLECT', async () => {
  assert.equal(guandanCollector.enabled, true);
  guandanCollector.deal(deal, null);
  guandanCollector.command({
    roomCode: 'ZZ99',
    game: 'guandan',
    phase: 'playing',
    dealSeq: 1,
    deal: 1,
    seatId: 2,
    type: 'play',
    payload: { cards: ['a-h6'] },
  });
  guandanCollector.dealResult({ roomCode: 'ZZ99', game: 'guandan', deal: 1, dealSeq: 1 }, { winnerTeam: 0, upgrade: 2 });
  guandanCollector.flush();

  await waitReady();
  // settle the queued writes the async open flushed on its own
  guandanCollector.flush();
  await new Promise((resolve) => setTimeout(resolve, 120));

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dir, 'collect.db'));
  const dealsRow = db.prepare('SELECT COUNT(*) AS n FROM deals').get() as { n: number | bigint };
  assert.equal(Number(dealsRow.n), 1);
  const commandsRow = db.prepare('SELECT COUNT(*) AS n FROM commands').get() as { n: number | bigint };
  assert.equal(Number(commandsRow.n), 1);
  const resultRow = db.prepare('SELECT result FROM deals').get() as { result: string | null };
  const recorded = JSON.parse(resultRow.result ?? '{}') as { winnerTeam: number };
  assert.equal(recorded.winnerTeam, 0);
  db.close();

  const outPath = join(dir, 'train.jsonl');
  execFileSync('python3', [join(process.cwd(), 'scripts', 'guandan-export.py'), join(dir, 'collect.db'), outPath]);
  const record = JSON.parse(readFileSync(outPath, 'utf8')) as {
    room: string;
    level: number;
    dealSeq: number;
    hands: { id: string; rank: number; suit: string }[][];
    plays: { kind: string; cards: { id: string }[] }[];
    result: { winnerTeam: number };
    tribute: { returned: unknown }[];
  };
  assert.equal(record.room, 'ZZ99');
  assert.equal(record.level, 6);
  assert.equal(record.dealSeq, 1);
  assert.equal(record.hands[0]![0]!.rank, 6);
  assert.equal(record.plays.length, 1);
  assert.equal(record.plays[0]!.kind, 'play');
  assert.equal(record.plays[0]!.cards[0]!.id, 'a-h6');
  assert.equal(record.result.winnerTeam, 0);
  assert.equal(record.tribute[0]!.returned, null);
});
