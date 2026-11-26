import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { BoardAiMove, BoardAiPolicy } from '../server/bots/boardAi';
import { ChessGame } from '../server/games/chess';
import { Room, type Peer } from '../server/room';
import type { BoardClockPreset } from '../shared/boardClock';
import type { GameKind, RoomMode, ServerMessage } from '../shared/protocol';

type TestPeer = Peer & { messages: ServerMessage[] };

function peer(id: string): TestPeer {
  const messages: ServerMessage[] = [];
  return { id, messages, role: 'table', seatId: null, token: null, room: null, requestRoom: null,
    send(message) { messages.push(message); }, supersede() {} };
}

function table(t: TestContext, game: GameKind, mode: RoomMode = 'tablet', ai?: BoardAiPolicy) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let mono = 1_000;
  let sequence = 0;
  const room = new Room('CLK', mode, game, undefined, undefined, ai, () => mono);
  t.after(() => room.dispose());
  const host = peer('host');
  const guest = peer('guest');
  room.bindCreator(host, 'create', '先手');
  const send = (as: TestPeer, type: string, payload: Record<string, unknown> = {}) => {
    const id = 'cmd-' + (++sequence);
    room.command(as, type, payload, id);
    const reply = as.messages.find(message => (message.type === 'ack' || message.type === 'error') && message.id === id);
    assert.ok(reply && (reply.type === 'ack' || reply.type === 'error'), 'command reply for ' + type);
    return reply;
  };
  const ok = (as: TestPeer, type: string, payload: Record<string, unknown> = {}) => {
    const result = send(as, type, payload);
    assert.equal(result.type, 'ack', result.type === 'error' ? result.message : undefined);
  };
  const refused = (as: TestPeer, type: string, payload: Record<string, unknown>, message: RegExp) => {
    const result = send(as, type, payload);
    assert.equal(result.type, 'error');
    if (result.type === 'error') assert.match(result.message, message);
  };
  const configure = (preset: BoardClockPreset) => ok(host, 'boardClock', { preset });
  const start = (humans: TestPeer[] = mode === 'phone' ? [host, guest] : []) => {
    for (const player of humans) ok(player, 'ready', { ready: true });
    ok(host, 'start');
  };
  const advance = (ms: number, fireTimers = true) => {
    mono += ms;
    if (fireTimers) t.mock.timers.tick(ms);
  };
  const snapshot = (viewer = host) => room.snapshotFor(viewer);
  const clock = (viewer = host) => {
    const value = snapshot(viewer).boardClock;
    assert.ok(value);
    return value;
  };
  const main = () => clock().times.map(time => time?.mainMs ?? null);
  const join = () => room.bindJoin(guest, 1, '后手', 'join');
  return { room, host, guest, ok, refused, configure, start, advance, snapshot, clock, main, join };
}

test('Host configures the clock only in the lobby and changing the preset resets human readiness', t => {
  const f = table(t, 'chess', 'phone');
  f.join();
  assert.deepEqual(f.clock(), { preset: 'off', times: [null, null], running: null });
  f.refused(f.guest, 'boardClock', { preset: 'rapid' }, /只有房主/);
  for (const preset of ['byoyomi', 'toString']) f.refused(f.host, 'boardClock', { preset }, /选项无效/);
  for (const player of [f.host, f.guest]) f.ok(player, 'ready', { ready: true });
  f.configure('off');
  assert.deepEqual(f.snapshot().seats.map(seat => seat.ready), [true, true]);
  f.configure('slow');
  assert.deepEqual(f.snapshot().seats.map(seat => seat.ready), [false, false]);
  assert.deepEqual(f.main(), [1_200_000, 1_200_000]);
  f.start();
  f.refused(f.host, 'boardClock', { preset: 'rapid' }, /准备阶段/);
  f.ok(f.host, 'chessResign');
  f.refused(f.host, 'boardClock', { preset: 'rapid' }, /准备阶段/);
});

test('Junqi has no board-clock setting or published clock', t => {
  const f = table(t, 'junqi', 'phone');
  f.refused(f.host, 'boardClock', { preset: 'rapid' }, /不支持棋钟/);
  assert.equal(f.snapshot().boardClock, undefined);
});

test('Accepted moves charge elapsed time and add the preset increment once', t => {
  const f = table(t, 'xiangqi');
  f.configure('rapid');
  f.start();
  f.advance(8_000);
  f.ok(f.host, 'xiangqiMove', { from: 54, to: 45 });
  assert.deepEqual(f.main(), [295_000, 300_000]);
  assert.equal(f.clock().running, 1);
  f.advance(4_000);
  f.ok(f.host, 'xiangqiMove', { from: 27, to: 36 });
  assert.deepEqual(f.main(), [295_000, 299_000]);
  assert.equal(f.clock().running, 0);
});

test('Go uses one byoyomi period at each boundary and resets unspent period time on the next turn', t => {
  const f = table(t, 'go');
  f.configure('byoyomi');
  f.start();
  f.advance(600_000 + 30_000);
  assert.deepEqual(f.clock().times[0], { mainMs: 0, periodsLeft: 2, periodRemainingMs: 30_000 });
  f.advance(7_000);
  assert.equal(f.clock().times[0]?.periodRemainingMs, 23_000);
  f.ok(f.host, 'stoneMove', { point: 40 });
  assert.deepEqual(f.clock().times[0], { mainMs: 0, periodsLeft: 2, periodRemainingMs: 30_000 });
  f.ok(f.host, 'stoneMove', { point: 41 });
  assert.equal(f.clock().running, 0);
  f.advance(30_000);
  assert.deepEqual(f.clock().times[0], { mainMs: 0, periodsLeft: 1, periodRemainingMs: 30_000 });
  f.advance(7_000);
  f.ok(f.host, 'stonePass');
  assert.deepEqual(f.clock().times[0], { mainMs: 0, periodsLeft: 1, periodRemainingMs: 30_000 });
  f.ok(f.host, 'stoneMove', { point: 42 });
  f.advance(30_000);
  assert.deepEqual(f.clock().times[0], { mainMs: 0, periodsLeft: 0, periodRemainingMs: 0 });
  const snap = f.snapshot();
  assert.ok(snap.game === 'go');
  assert.equal(snap.stones.winner, 1);
  assert.equal(snap.stones.reason, '黑方超时');
});

test('The scheduled deadline flags at zero and no clock runs after adjudication', t => {
  const f = table(t, 'chess');
  const spectator = peer('spectator');
  f.room.bindSpectator(spectator, 'observe');
  f.configure('rapid');
  f.start();
  f.advance(299_999);
  assert.equal(f.snapshot().phase, 'playing');
  assert.equal(f.clock().times[0]?.mainMs, 1);
  const version = f.snapshot().version;
  f.advance(1);
  const snap = f.snapshot();
  assert.ok(snap.game === 'chess');
  assert.equal(snap.phase, 'finished');
  assert.equal(snap.chess.winner, 1);
  assert.equal(snap.chess.reason, '白方超时');
  assert.equal(f.clock().running, null);
  assert.equal(snap.version, version + 1);
  assert.deepEqual(f.clock(spectator), f.clock());
  assert.equal(spectator.messages.at(-1)?.type, 'state');
  f.advance(999_999);
  assert.equal(f.snapshot().version, snap.version);
  assert.deepEqual(f.main(), [0, 300_000]);
});

test('A move arriving at zero before the timer callback is refused and the deadline cannot flag again', t => {
  const f = table(t, 'chess');
  f.configure('rapid');
  f.start();
  const version = f.snapshot().version;
  f.advance(300_000, false);
  f.refused(f.host, 'chessMove', { from: 52, to: 36 }, /用时已耗尽/);
  t.mock.timers.tick(300_000);
  const snap = f.snapshot();
  assert.ok(snap.game === 'chess');
  assert.equal(snap.phase, 'finished');
  assert.equal(snap.chess.winner, 1);
  assert.equal(snap.chess.moves.length, 0);
  assert.equal(snap.version, version + 1);
  assert.deepEqual(f.main(), [0, 300_000]);
});

for (const [material, rank] of [['king', ''], ['king and bishop', 'b'], ['king and knight', 'n']] as const) {
  test('Chess flag yields a draw against ' + material, t => {
    const f = table(t, 'chess');
    const firstRank = rank ? rank + '6k' : '7k';
    Object.defineProperty(f.room, 'engine', { value: new ChessGame(firstRank + '/8/8/8/8/8/8/R6K w - - 0 1') });
    f.configure('rapid');
    f.start();
    assert.equal(f.snapshot().phase, 'playing');
    f.advance(300_000);
    const snap = f.snapshot();
    assert.ok(snap.game === 'chess');
    assert.equal(snap.chess.draw, true);
    assert.equal(snap.chess.winner, null);
    assert.match(snap.chess.reason, /白方超时.*子力不足.*和棋/);
  });
}

test('A player disconnect pauses both sides, a spectator disconnect does not, and resume keeps elapsed time', t => {
  const f = table(t, 'chess', 'phone');
  f.join();
  const spectator = peer('spectator');
  f.room.bindSpectator(spectator, 'observe');
  f.configure('rapid');
  f.start();
  f.advance(2_000);
  f.room.detach(spectator);
  assert.equal(f.clock().running, 0);
  f.advance(3_000);
  const token = f.guest.token!;
  f.room.detach(f.guest);
  assert.equal(f.clock().running, null);
  f.advance(400_000);
  assert.deepEqual(f.main(), [295_000, 300_000]);
  assert.equal(f.snapshot().phase, 'playing');
  f.room.bindResume(peer('back'), token, 'resume');
  assert.equal(f.clock().running, 0);
  f.advance(9_000);
  assert.deepEqual(f.main(), [286_000, 300_000]);
});

test('A disconnected shared tablet stops both clocks and reclaims them on resume', t => {
  const f = table(t, 'xiangqi');
  f.configure('rapid');
  f.start();
  f.advance(3_000);
  const token = f.host.token!;
  f.room.detach(f.host);
  assert.equal(f.clock().running, null);
  f.advance(400_000);
  assert.deepEqual(f.main(), [297_000, 300_000]);
  f.room.bindResume(peer('tablet-back'), token, 'resume');
  assert.equal(f.clock().running, 0);
  f.advance(1_000);
  assert.deepEqual(f.main(), [296_000, 300_000]);
});

test('Go passes earn the increment and scoring pauses both clocks', t => {
  const f = table(t, 'go');
  f.configure('standard');
  f.start();
  f.advance(2_000);
  f.ok(f.host, 'stonePass');
  assert.deepEqual(f.main(), [603_000, 600_000]);
  assert.equal(f.clock().running, 1);
  f.advance(3_000);
  f.ok(f.host, 'stonePass');
  const snap = f.snapshot();
  assert.ok(snap.game === 'go');
  assert.equal(snap.stones.stage, 'scoring');
  assert.deepEqual(f.main(), [603_000, 602_000]);
  assert.equal(f.clock().running, null);
  f.advance(900_000);
  assert.deepEqual(f.main(), [603_000, 602_000]);
  f.ok(f.host, 'stoneScore', { action: 'resume', side: 0 });
  assert.equal(f.clock().running, 0);
  f.advance(4_000);
  assert.deepEqual(f.main(), [599_000, 602_000]);
});

test('Undo stops the current clock and starts the restored side with no refund or increment', t => {
  const f = table(t, 'gomoku');
  f.configure('rapid');
  f.start();
  f.advance(6_000);
  f.ok(f.host, 'stoneMove', { point: 112 });
  f.advance(7_000);
  f.ok(f.host, 'stoneUndo', { action: 'request' });
  assert.equal(f.clock().running, 0);
  assert.deepEqual(f.main(), [297_000, 293_000]);
  f.advance(2_000);
  assert.deepEqual(f.main(), [295_000, 293_000]);
});

test('A Reversi auto-pass skips the other clock and only the placing side earns increment', t => {
  const f = table(t, 'reversi');
  f.configure('rapid');
  f.start();
  for (const point of [19, 18, 17, 9, 1, 0, 26, 2, 10, 11, 3, 4, 8, 16, 37, 12, 5]) {
    f.ok(f.host, 'reversiMove', { point });
  }
  const [black, white] = f.main();
  assert.equal(f.clock().running, 1);
  f.advance(7_000);
  f.ok(f.host, 'reversiMove', { point: 6 });
  const snap = f.snapshot();
  assert.ok(snap.game === 'reversi');
  assert.deepEqual(snap.reversi.moves.slice(-2).map(move => [move.side, move.point]), [[1, 6], [0, null]]);
  assert.equal(f.clock().running, 1);
  assert.deepEqual(f.main(), [black, white! - 4_000]);
  f.advance(2_000);
  assert.deepEqual(f.main(), [black, white! - 6_000]);
});

test('Only the human has a clock and still earns increment in board AI mode', async t => {
  let chooseCalls = 0;
  let reply!: (move: BoardAiMove) => void;
  const ai: BoardAiPolicy = {
    availability: () => ({ available: true, message: null }),
    chooseMove: () => { chooseCalls++; return new Promise(resolve => { reply = resolve; }); },
  };
  const f = table(t, 'gomoku', 'phone', ai);
  f.ok(f.host, 'boardAi', { enabled: true, side: 1, difficulty: 'normal' });
  f.ok(f.host, 'ready', { ready: true });
  f.configure('rapid');
  assert.deepEqual(f.snapshot().seats.map(seat => seat.ready), [false, true]);
  f.start([f.host]);
  f.advance(9_000);
  f.ok(f.host, 'stoneMove', { point: 112 });
  assert.deepEqual(f.main(), [294_000, null]);
  assert.equal(f.clock().running, null);
  f.advance(1_000);
  assert.equal(chooseCalls, 1);
  f.advance(8_000);
  assert.deepEqual(f.main(), [294_000, null]);
  reply({ kind: 'gomoku', point: 113 });
  await Promise.resolve();
  assert.equal(f.clock().running, 0);
  f.advance(3_000);
  assert.deepEqual(f.main(), [291_000, null]);
});

test('Illegal moves do not settle, reset or add time and the original deadline stays armed', t => {
  const f = table(t, 'chess');
  f.configure('rapid');
  f.start();
  f.advance(2_000);
  const before = f.snapshot();
  f.refused(f.host, 'chessMove', { from: 52, to: 8 }, /不能走/);
  assert.deepEqual(f.snapshot(), before);
  f.advance(298_000);
  assert.equal(f.snapshot().phase, 'finished');
  assert.deepEqual(f.main(), [0, 300_000]);
});

test('Rematch resets the clock, retains the selected preset and waits for the next opening move', t => {
  const f = table(t, 'reversi');
  f.configure('rapid');
  f.start();
  f.advance(5_000);
  f.ok(f.host, 'reversiMove', { point: 19 });
  f.advance(8_000);
  f.ok(f.host, 'reversiResign', { side: 1 });
  assert.equal(f.clock().running, null);
  assert.deepEqual(f.main(), [298_000, 292_000]);
  f.ok(f.host, 'again');
  f.advance(400_000);
  assert.equal(f.snapshot().phase, 'lobby');
  assert.equal(f.clock().preset, 'rapid');
  assert.equal(f.clock().running, null);
  assert.deepEqual(f.main(), [300_000, 300_000]);
  f.start();
  assert.equal(f.clock().running, 0);
});
