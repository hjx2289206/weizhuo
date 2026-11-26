import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Room, type Peer, type RoomEngineSetup } from '../server/room';
import type { GameCommandType, GameContext, GameResult, RoomGame, TimeoutAction } from '../server/games/types';
import type { Card, GameKind, GameView, Phase, RoomMode, ServerMessage } from '../shared/protocol';
import { dealDuration } from '../shared/dealAnimation';
import { GAME_DEFINITIONS, GAME_KINDS } from '../shared/gameCatalog';
import { MAX_SEATS, phoneSeats } from '../shared/tableSeats';
import { orientationForSeat } from '../src/tableLayout';

const MIN_FIXTURE_SEATS = 3;
const success = { ok: true } as const;
const fail = (message: string): GameResult => ({ ok: false, message });

const FIXTURE_KIND = 'seat-fixture' as GameKind;
type BotMode = 'normal' | 'invalid' | 'empty' | 'absent';

class SeatFixtureGame implements RoomGame {
  readonly kind = FIXTURE_KIND;
  phase: Phase = 'lobby';
  private hands: Card[][] = [];
  private turn: number | null = null;
  readonly actions: number[] = [];
  readonly operations: { seat: number; type: GameCommandType; payload: Record<string, unknown> }[] = [];
  readonly botCalls: { seat: number; at: number; action: TimeoutAction | null }[] = [];
  readonly timeouts: number[] = [];

  constructor(public seatCount: number, private readonly context: GameContext) {}

  setSeatCount(count: number): GameResult {
    if (this.phase !== 'lobby' || !Number.isInteger(count) || count < MIN_FIXTURE_SEATS || count > MAX_SEATS) {
      return fail('测试牌桌人数无效');
    }
    this.seatCount = count;
    return success;
  }

  start(): void {
    this.phase = 'playing';
    this.turn = 0;
    this.hands = Array.from({ length: this.seatCount }, (_, seat) => [
      { id: `fixture-private-${seat}-card`, rank: seat + 3, suit: 'club' },
    ]);
    this.context.onDeal?.(this.seatCount, 1);
  }

  command(seat: number, action: GameCommandType, payload: Record<string, unknown>): GameResult {
    if (this.phase !== 'playing' || seat !== this.turn || (action !== 'pass' && action !== 'play')) return fail('此时不能操作');
    if (action === 'play') {
      const cards = payload.cards;
      const hand = this.handOf(seat);
      if (!Array.isArray(cards) || cards.length !== 1 || !hand[0] || cards[0] !== hand[0].id) return fail('没有这张牌');
      this.hands[seat] = [];
    }
    this.actions.push(seat);
    this.operations.push({ seat, type: action, payload });
    if (this.actions.length === this.seatCount * 2) {
      this.phase = 'finished';
      this.turn = null;
    } else {
      this.turn = (seat + 1) % this.seatCount;
    }
    return success;
  }

  timeoutAction(seat: number) {
    if (this.phase !== 'playing' || seat !== this.turn) return null;
    this.timeouts.push(seat);
    return { type: 'pass' as const, payload: {} };
  }

  hint() { return { ok: false, plays: [] }; }
  handOf(seat: number) { return this.hands[seat] ?? []; }
  passedAt() { return false; }
  requiresConnection() { return this.phase === 'playing'; }
  statusText() { return '测试牌桌'; }
  view(): GameView {
    // A test-only kind is outside the registered protocol union. Only the common view shape is needed.
    return { game: this.kind, phase: this.phase, turn: this.turn, lastPlay: null, tablePlays: [],
      trickStartIndex: 0 } as unknown as GameView;
  }
  restart(): GameResult {
    if (this.phase !== 'finished') return fail('对局尚未结束');
    this.phase = 'lobby';
    this.turn = null;
    this.actions.length = 0;
    this.operations.length = 0;
    this.hands = [];
    return success;
  }
}

class AutomatedSeatFixture extends SeatFixtureGame {
  constructor(count: number, context: GameContext, private readonly botMode: Exclude<BotMode, 'absent'>) {
    super(count, context);
  }

  botAction(seat: number): TimeoutAction | null {
    if (this.phase !== 'playing' || this.view().turn !== seat) return null;
    const card = this.handOf(seat)[0];
    const action: TimeoutAction | null = this.botMode === 'empty' ? null
      : this.botMode === 'invalid' ? { type: 'play', payload: { cards: ['unknown'] } }
        : card ? { type: 'play', payload: { cards: [card.id] } } : { type: 'pass', payload: {} };
    this.botCalls.push({ seat, at: Date.now(), action });
    return action;
  }
}

type TestPeer = Peer & { messages: ServerMessage[] };
function peer(id: string): TestPeer {
  const messages: ServerMessage[] = [];
  return { id, messages, role: 'table', seatId: null, token: null, room: null, requestRoom: null,
    send(message) { messages.push(message); }, supersede() {} };
}

function table(t: TestContext, mode: RoomMode = 'phone', initial = MAX_SEATS, botMode: BotMode = 'normal') {
  const legacyCalls: string[] = [];
  function unexpected(runtime: string): never {
    legacyCalls.push(runtime);
    throw new Error(`${runtime} must never be used by the seat fixture`);
  }
  let engine!: SeatFixtureGame;
  const setup: RoomEngineSetup = {
    definition: { name: '测试牌桌', category: 'card', seatCount: initial, deckCount: 1,
      minSeats: MIN_FIXTURE_SEATS, maxSeats: MAX_SEATS, brief: '', roomModes: ['phone', 'tablet'] },
    createEngine(context) {
      engine = botMode === 'absent' ? new SeatFixtureGame(initial, context)
        : new AutomatedSeatFixture(initial, context, botMode);
      return engine;
    },
  };
  const room = new Room('EIGHT', mode, setup, {
    availability: () => unexpected('DouZero availability'),
    async chooseMove() { return unexpected('DouZero inference'); },
  }, {
    availability: () => unexpected('DanLM availability'),
    async chooseTurn() { return unexpected('DanLM inference'); },
  });
  t.after(() => {
    room.dispose();
    assert.deepEqual(legacyCalls, []);
  });
  const host = peer('host');
  room.bindCreator(host, 'create', '房主');

  let sequence = 0;
  const send = (as: TestPeer, type: string, payload: Record<string, unknown> = {}) => {
    const id = 'cmd-' + ++sequence;
    room.command(as, type, payload, id);
    const reply = as.messages.find(message => (message.type === 'ack' || message.type === 'error') && message.id === id);
    assert.ok(reply && (reply.type === 'ack' || reply.type === 'error'), type);
    return reply;
  };
  const ok = (as: TestPeer, type: string, payload: Record<string, unknown> = {}) => {
    const result = send(as, type, payload);
    assert.equal(result.type, 'ack', result.type === 'error' ? result.message : undefined);
  };
  const refused = (as: TestPeer, type: string, payload: Record<string, unknown>, expected: RegExp) => {
    const result = send(as, type, payload);
    assert.equal(result.type, 'error');
    if (result.type === 'error') assert.match(result.message, expected);
  };
  function join(seat: number) {
    const player = peer('player-' + seat + '-' + ++sequence);
    room.bindJoin(player, seat, '玩家' + (seat + 1), 'join-' + sequence);
    assert.equal(player.seatId, seat);
    return player;
  }
  function fill() {
    if (mode === 'tablet') ok(host, 'seats', { positions: phoneSeats(room.seatCount) });
    return Array.from({ length: room.seatCount }, (_, seat) => mode === 'phone' && seat === 0 ? host : join(seat));
  }
  function start(players: TestPeer[]) {
    for (const player of players) ok(player, 'ready', { ready: true });
    ok(host, 'start');
  }
  return { room, engine, host, ok, refused, join, fill, start };
}

test('Eight players rotate through a full circle, pause offline, resume and replace a high seat', t => {
  const f = table(t);
  f.refused(f.host, 'start', {}, /需要八名玩家入座/);
  const players = f.fill();
  f.start(players);
  f.refused(f.host, 'seatCount', { count: 5 }, /准备阶段/);
  for (const p of players) f.ok(p, 'pass');
  assert.deepEqual(f.engine.actions, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(f.room.snapshotFor(f.host).turn, 0);

  const eighth = players[7]!;
  const credential = eighth.token!;
  f.room.detach(eighth);
  f.refused(f.host, 'pass', {}, /掉线/);
  assert.equal(f.room.snapshotFor(f.host).turn, 0);
  const reconnected = peer('back');
  f.room.bindResume(reconnected, credential, 'resume');
  assert.equal(reconnected.seatId, 7);
  f.ok(f.host, 'pass');
  f.room.detach(reconnected);
  const replacement = peer('replacement');
  f.room.requestSeat(replacement, 7, '接替', 'request-8');
  assert.equal(f.room.snapshotFor(f.host).seatRequests[0]?.seatId, 7);

  f.ok(f.host, 'decideSeat', { requestId: 'request-8', approve: true });
  assert.equal(replacement.seatId, 7);
  assert.notEqual(replacement.token, credential);
  assert.deepEqual(f.room.snapshotFor(replacement).hand, f.engine.handOf(7));
  f.ok(players[1]!, 'pass');
  f.ok(f.host, 'transferHost', { seatId: 7 });
  assert.equal(f.room.snapshotFor(replacement).isHost, true);
  assert.equal(f.room.snapshotFor(f.host).isHost, false);
});

test('Eight players and eight spectators remain connected with one private hand per credential', t => {
  const f = table(t);
  const players = f.fill();
  const spectators = Array.from({ length: 8 }, (_, index) => peer('observer-' + index));
  for (const p of spectators) f.room.bindSpectator(p, p.id);
  const ninth = peer('observer-8');
  f.room.bindSpectator(ninth, ninth.id);
  assert.equal(ninth.room, null);
  assert.ok(ninth.messages.some(m => m.type === 'error' && /旁观人数已满/.test(m.message)));
  f.start(players);
  const hands = players.map((_, seat) => f.engine.handOf(seat)[0]!.id);
  for (const [seat, player] of players.entries()) {
    const state = f.room.snapshotFor(player);
    assert.equal(state.spectatorCount, 8);
    assert.deepEqual(state.hand.map(card => card.id), [hands[seat]]);
    const json = JSON.stringify(state);
    for (const id of hands) assert.equal(json.includes(id), id === hands[seat]);
  }
  for (const observer of spectators) {
    const state = f.room.snapshotFor(observer);
    assert.equal(state.role, 'spectator');
    assert.equal(state.seats.filter(seat => seat.connected).length, 8);
    assert.deepEqual(state.hand, []);
    assert.ok(hands.every(id => !JSON.stringify(state).includes(id)));
  }
});

test('Lobby seat count enforces host and range, keeps bots and managed seats ready, and survives rematch', t => {
  const f = table(t);
  const neighbor = f.join(1), managed = f.join(2), sixth = f.join(5), eighth = f.join(7);
  const observer = peer('view');
  f.room.bindSpectator(observer, 'spectate');
  f.ok(f.host, 'addBot', { seatId: 3 });
  for (const p of [f.host, neighbor]) f.ok(p, 'ready', { ready: true });
  f.ok(managed, 'autoPlay', { enabled: true });
  f.refused(neighbor, 'seatCount', { count: 5 }, /只有房主/);
  for (const count of [2, 9, 4.5, '5']) f.refused(f.host, 'seatCount', { count }, /3 至 8 的整数/);
  f.refused(f.host, 'seatCount', { count: 5 }, /6 号座、8 号座/);
  assert.equal(f.room.seatCount, 8);
  f.room.detach(sixth);
  f.room.detach(eighth);
  f.ok(f.host, 'removeOffline');
  f.ok(f.host, 'seatCount', { count: 5 });
  assert.deepEqual(f.room.positions, phoneSeats(5));
  assert.deepEqual(f.room.snapshotFor(observer).seatCountSettings, { count: 5, min: 3, max: 8 });
  assert.equal(f.room.snapshotFor(observer).role, 'spectator');
  assert.deepEqual(f.room.summary().seats.map(seat => seat.ready), [false, false, true, true, false]);

  f.ok(f.host, 'removeBot', { seatId: 3 });
  f.ok(managed, 'autoPlay', { enabled: false });
  const players = [f.host, neighbor, managed, f.join(3), f.join(4)];
  f.start(players);
  for (let round = 0; round < 2; round++) for (const player of players) f.ok(player, 'pass');
  f.ok(f.host, 'again');
  assert.equal(f.room.phase, 'lobby');
  assert.equal(f.room.seatCount, 5);
  assert.deepEqual(f.room.positions, phoneSeats(5));
});

test('Tablet resize retains manual placements, cancels a stale removed-seat request, and clears trailing empty placements', t => {
  const f = table(t, 'tablet', 5);
  assert.deepEqual(f.room.positions, []);
  const placed = phoneSeats(8);
  f.ok(f.host, 'seats', { positions: placed.slice(0, 5) });
  const first = f.join(0);
  f.ok(f.host, 'seatCount', { count: 8 });
  assert.deepEqual(f.room.positions, placed.slice(0, 5));
  f.ok(f.host, 'seats', { positions: placed });
  const eighth = f.join(7);
  f.room.detach(eighth);
  const applicant = peer('requester');
  f.room.requestSeat(applicant, 7, '申请接替', 'waiting');
  assert.equal(applicant.requestRoom, f.room);
  // Normal offline cleanup already cancels these requests. Leave a stale request on
  // an empty seat to exercise the resize guard itself.
  f.room.players[7] = null;
  f.ok(f.host, 'seatCount', { count: 5 });
  assert.equal(applicant.requestRoom, null);
  const reply = applicant.messages.find(message => message.type === 'seat-request' && message.status === 'cancelled');
  assert.ok(reply, 'cancelled requester is notified');
  assert.deepEqual(f.room.positions, placed.slice(0, 5));
  assert.equal(f.room.snapshotFor(first).selfSeat, 0);

  f.ok(f.host, 'seatCount', { count: 8 });
  f.ok(f.host, 'seats', { positions: placed });
  f.ok(f.host, 'clearEmptySeats');
  assert.deepEqual(f.room.positions, [placed[0]]);
  assert.equal(f.room.seatCount, 8);
});

test('Legacy fixed games and Junqi reject the generic seat count command', t => {
  for (const game of GAME_KINDS) {
    const room = new Room('FIXED', 'phone', game);
    t.after(() => room.dispose());
    const host = peer('fixed-' + game);
    room.bindCreator(host, 'create');
    room.command(host, 'seatCount', { count: 4 }, 'change');
    assert.ok(host.messages.some(m => m.type === 'error' && m.id === 'change' && /不支持自定义人数/.test(m.message)));
    const definition = GAME_DEFINITIONS[game];
    assert.equal(room.seatCount, definition.seatCount);
    assert.equal(definition.minSeats, definition.seatCount);
    assert.equal(definition.maxSeats, game === 'junqi' ? 4 : definition.seatCount);
    assert.equal(room.snapshotFor(host).seatCountSettings, undefined);
  }
});

test('The card timer falls back through timeoutAction and managed play works from seat eight', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const f = table(t);
  const players = f.fill();
  f.ok(f.host, 'turnTimer', { seconds: 1 });
  f.start(players);
  assert.equal(f.room.snapshotFor(f.host).dealAnimation?.seatCount, 8);
  t.mock.timers.tick(dealDuration(8, 1));
  for (const player of players.slice(0, 7)) f.ok(player, 'pass');
  assert.equal(f.room.snapshotFor(f.host).turnSeatId, 7);
  t.mock.timers.tick(1_000);
  assert.deepEqual(f.engine.timeouts, [7]);
  assert.equal(f.engine.actions.at(-1), 7);
  for (const player of players.slice(0, 7)) f.ok(player, 'pass');
  f.ok(players[7]!, 'autoPlay', { enabled: true });
  assert.equal(f.room.snapshotFor(f.host).seats[7]?.autoPlay, true);
  assert.equal(f.room.snapshotFor(f.host).turnSeatId, null);
  t.mock.timers.tick(600);
  assert.deepEqual(f.engine.botCalls.map(call => call.seat), [7]);
  assert.deepEqual(f.engine.timeouts, [7]);
  assert.equal(f.room.phase, 'finished');
});

test('Three computer seats and one managed player act through botAction after the deal and normal cadence', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 20_000 });
  const f = table(t);
  const botSeats = [1, 2, 6], managedSeat = 3;
  const players = Array.from({ length: MAX_SEATS }, (_, seat) => {
    if (seat === 0) return f.host;
    if (botSeats.includes(seat)) {
      f.ok(f.host, 'addBot', { seatId: seat });
      return null;
    }
    return f.join(seat);
  });
  f.ok(players[managedSeat]!, 'autoPlay', { enabled: true });
  assert.deepEqual(f.room.snapshotFor(f.host).automation, { available: true, message: null });
  f.start(players.filter((player): player is TestPeer => player !== null));
  const start = Date.now();

  for (let ply = 0; ply < MAX_SEATS * 2; ply++) {
    const seat = ply % MAX_SEATS;
    const player = players[seat];
    assert.equal(f.room.snapshotFor(f.host).turn, seat);
    if (player && seat !== managedSeat) {
      const card = f.engine.handOf(seat)[0];
      if (card) f.ok(player, 'play', { cards: [card.id] });
      else f.ok(player, 'pass');
      continue;
    }
    const before = f.engine.botCalls.length;
    const delay = before === 0 ? dealDuration(MAX_SEATS, 1) : 600;
    const scheduledAt = Date.now();
    t.mock.timers.tick(delay - 1);
    assert.equal(f.engine.botCalls.length, before);
    assert.equal(f.engine.operations.length, ply);
    t.mock.timers.tick(1);
    assert.equal(f.engine.botCalls.length, before + 1);
    const call = f.engine.botCalls.at(-1)!;
    assert.equal(call.seat, seat);
    assert.equal(call.at, scheduledAt + delay);
    assert.ok(call.action);
    assert.deepEqual(f.engine.operations.at(-1), { seat, ...call.action });
  }
  assert.equal(f.engine.botCalls[0]?.at, start + dealDuration(MAX_SEATS, 1));
  assert.deepEqual(f.engine.botCalls.map(call => call.seat), [1, 2, 3, 6, 1, 2, 3, 6]);
  assert.deepEqual(f.engine.timeouts, []);
  assert.equal(f.room.phase, 'finished');
});

test('An engine without botAction refuses both automation entry points and still times out a human turn', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 20_000 });
  const f = table(t, 'phone', MAX_SEATS, 'absent');
  const message = '本游戏暂不支持托管和电脑玩家';
  assert.deepEqual(f.room.snapshotFor(f.host).automation, { available: false, message });
  f.refused(f.host, 'autoPlay', { enabled: true }, new RegExp(`^${message}$`));
  f.refused(f.host, 'addBot', { seatId: 1 }, new RegExp(`^${message}$`));
  const players = f.fill();
  f.ok(f.host, 'turnTimer', { seconds: 1 });
  f.start(players);
  const delay = dealDuration(MAX_SEATS, 1) + 1000;
  t.mock.timers.tick(delay - 1);
  assert.deepEqual(f.engine.timeouts, []);
  assert.equal(f.room.snapshotFor(f.host).turnSeatId, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(f.engine.timeouts, [0]);
  assert.deepEqual(f.engine.botCalls, []);
  assert.equal(f.room.snapshotFor(f.host).turnSeatId, 1);
});

for (const [mode, reason] of [['invalid', '没有这张牌'], ['empty', '当前座位没有可执行操作']] as const) {
  test(`An ${mode} bot action is reported once and the managed player can resume manually`, t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 20_000 });
    const f = table(t, 'phone', MAX_SEATS, mode);
    const players = f.fill();
    f.ok(f.host, 'autoPlay', { enabled: true });
    f.start(players);
    t.mock.timers.tick(dealDuration(MAX_SEATS, 1));
    const status = { available: false, message: `电脑操作无效：${reason}` };
    assert.deepEqual(f.room.snapshotFor(f.host).automation, status);
    assert.equal(f.engine.botCalls.length, 1);
    assert.deepEqual(f.engine.actions, []);
    f.ok(players[2]!, 'rename', { name: '换个昵称' });
    t.mock.timers.tick(10_000);
    assert.deepEqual(f.room.snapshotFor(f.host).automation, status);
    assert.equal(f.engine.botCalls.length, 1);
    assert.equal(f.room.snapshotFor(f.host).turn, 0);
    f.ok(f.host, 'autoPlay', { enabled: false });
    f.ok(f.host, 'play', { cards: [f.engine.handOf(0)[0]!.id] });
    assert.equal(f.room.snapshotFor(f.host).turn, 1);
  });
}

test('The unregistered game seats all eight players, finishes their turns and starts a rematch', t => {
  assert.ok(!GAME_KINDS.includes(FIXTURE_KIND));
  const f = table(t);
  const players = f.fill();
  f.start(players);
  for (const [seat, player] of players.entries()) {
    f.ok(player, 'play', { cards: [f.engine.handOf(seat)[0]!.id] });
  }
  for (const player of players) f.ok(player, 'pass');
  assert.equal(f.room.phase, 'finished');
  f.ok(f.host, 'again');
  assert.equal(f.room.snapshotFor(f.host).game, FIXTURE_KIND);
  assert.equal(f.room.seatCount, MAX_SEATS);
  f.start(players);
  assert.equal(f.room.snapshotFor(f.host).turn, 0);
});

test('Phone seats are equally spaced in order toward the right and face inward', () => {
  for (let count = 2; count <= MAX_SEATS; count++) {
    const layout = phoneSeats(count);
    assert.equal(layout.length, count);
    assert.deepEqual(layout[0], { x: .5, y: .9, angle: 0 });
    const inward = layout.map(seat => (360 - seat.angle) % 360);
    assert.deepEqual(inward, [...inward].sort((a, b) => a - b));
    const distance = ({ x, y }: typeof layout[number]) => {
      if (Math.abs(y - .9) < 1e-8) return x >= .5 ? x - .5 : 2.7 + x;
      if (Math.abs(x - .9) < 1e-8) return 1.3 - y;
      if (Math.abs(y - .1) < 1e-8) return 2.1 - x;
      return 1.9 + y;
    };
    layout.forEach((seat, index) => {
      assert.ok(Math.abs(distance(seat) - 3.2 * index / count) < 1e-8);
      assert.equal(seat.angle, orientationForSeat(seat));
    });
  }
  assert.deepEqual(phoneSeats(4).map(seat => seat.angle), [0, -90, 180, 90]);
  for (const count of [1, 9, 5.5]) assert.throws(() => phoneSeats(count), RangeError);
});
