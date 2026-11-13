import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GuandanGame } from '../server/games/guandan';
import { createPlayStamper } from '../server/games/playLog';
import type { Card } from '../shared/protocol';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = `${root}.guandan/venv/bin/python`;
const source = `${root}.guandan/DanLM`;

test('DanLM native replay preserves borrowed leads and current trick context', {
  skip: !existsSync(python) || !existsSync(`${source}/danzero/engine`),
}, () => {
  const result = spawnSync(python, ['tests/guandan_replay_test.py'], {
    cwd: root,
    env: { ...process.env, GUANDAN_SRC: source },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
});

test('authoritative replay records a borrowed lead even when its cards could beat the finisher', () => {
  const game = new GuandanGame(createPlayStamper('REPLAY'));
  game.start();
  const first = game.view(null).turn!;
  const partner = (first + 2) % 4;
  for (let seat = 0; seat < 4; seat++) {
    game.hands[seat] = [{ id: `keep-${seat}`, rank: 6, suit: 'club' }];
  }
  const head: Card = { id: 'head', rank: 3, suit: 'spade' };
  const higher: Card = { id: 'higher', rank: 17, suit: 'joker' };
  game.hands[first] = [head];
  game.hands[partner].push(higher);
  assert.deepEqual(game.command(first, 'play', { cards: [head.id] }), { ok: true });
  // A refused response must not create replay context.
  assert.equal(game.command(first, 'pass', {}).ok, false);
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(game.command(game.view(null).turn!, 'pass', {}), { ok: true });
  }
  assert.equal(game.view(null).turn, partner);
  assert.deepEqual(game.command(partner, 'play', { cards: [higher.id] }), { ok: true });
  assert.deepEqual(game.replayRows().map(({ seat, leading }) => ({ seat, leading })),
    [{ seat: first, leading: true }, { seat: partner, leading: true }]);
  assert.deepEqual(game.command(game.view(null).turn!, 'play', { cards: ['keep-wrong-seat'] }).ok, false);
  assert.equal(game.replayRows().length, 2);
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(game.command(game.view(null).turn!, 'pass', {}), { ok: true });
  }
  assert.equal(game.view(null).turn, partner);
  assert.deepEqual(game.command(partner, 'play', { cards: [`keep-${partner}`] }), { ok: true });
  assert.equal(game.phase, 'finished');
  assert.deepEqual(game.restart(), { ok: true });
  assert.deepEqual(game.replayRows(), []);
});
