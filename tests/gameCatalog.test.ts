import assert from 'node:assert/strict';
import test from 'node:test';
import { Room } from '../server/room';
import { GAME_DEFINITIONS, GAME_KINDS, isBoardGame, isGameKind } from '../shared/gameCatalog';
import { GAME_NOTES, RULE_TABS } from '../src/gamePresentation';
import { readResults } from '../src/resultHistory';

test('every game is registered once and keeps its hall card and rules tab', () => {
  assert.deepEqual([...GAME_KINDS].sort(), Object.keys(GAME_DEFINITIONS).sort());
  assert.deepEqual([...GAME_KINDS].sort(), Object.keys(GAME_NOTES).sort());
  assert.deepEqual(GAME_KINDS.filter(isBoardGame), ['xiangqi', 'go', 'gomoku', 'chess', 'junqi']);
  assert.deepEqual(GAME_KINDS.filter(game => !isBoardGame(game)), ['doudizhu', 'guandan']);
  assert.deepEqual(RULE_TABS, ['doudizhu', 'guandan', 'xiangqi', 'chess', 'go', 'gomoku', 'junqi']);
  for (const game of GAME_KINDS) assert.ok(GAME_NOTES[game].trim(), game);
});

test('each catalog entry opens a phone room with its engine and declared seat count', () => {
  for (const game of GAME_KINDS) {
    const room = new Room('TEST', 'phone', game);
    assert.equal(room.engine.kind, game);
    assert.equal(room.engine.view(null).game, game);
    assert.equal(room.seatCount, GAME_DEFINITIONS[game].seatCount, game);
    assert.equal(room.positions.length, GAME_DEFINITIONS[game].seatCount, game);
    assert.equal(room.players.length, room.positions.length, game);
  }
});

test('rooms copy the shared two-seat positions', () => {
  const go = new Room('FIRST', 'phone', 'go');
  const gomoku = new Room('SECOND', 'phone', 'gomoku');
  const expected = [{ x: .5, y: .88, angle: 0 }, { x: .5, y: .12, angle: 180 }];
  assert.deepEqual(go.positions, expected);
  go.positions[0]!.y = 0;
  assert.deepEqual(gomoku.positions, expected);
  assert.deepEqual(new Room('THIRD', 'phone', 'go').positions, expected);
});

test('game validation and saved result parsing accept exactly the registered kinds', () => {
  const unknownGames = [undefined, null, 0, {}, ['go'], 'constructor', '__proto__', 'GO', 'reversi'];
  assert.ok(GAME_KINDS.every(isGameKind));
  assert.ok(unknownGames.every(game => !isGameKind(game)));
  const records = [...GAME_KINDS, ...unknownGames].map((game, index) => ({
    key: String(index), code: 'TEST', game, date: '2026-11-25T00:00:00Z',
    title: '本局结束', detail: '', players: [], plays: [],
  }));
  assert.deepEqual(readResults({ getItem: () => JSON.stringify(records) }), records.slice(0, GAME_KINDS.length));
});
