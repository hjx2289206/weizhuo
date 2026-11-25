// Permanent room-automation tests: DouZero bot seats, opt-in 托管, the private automatic authority
// path, stale-decision guards, pause policy, expiry interaction and Guandan rejection.
//
// The policy here is a SYNTHETIC UNIT DOUBLE (scripted moves, manual resolution, real abort
// signals); real DouZero inference is proven end-to-end by the acceptance owner. Room and engines
// are the real ones.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, Snapshot } from '../shared/protocol';
import type { DouZeroPolicy, DouZeroState } from '../server/bots/douzero';
import { DoudizhuGame } from '../server/games/doudizhu';
import { Room, type Peer } from '../server/room';
import { canBeat, detectPlay } from '../server/rules';

const ROOM_TTL_MS = 30 * 60 * 1000;
/** How long a test waits for room cadence; the cadence itself is the room's published 600ms. */
const ACTION_WAIT_MS = 6_000;
/** The honest idle message of the real Guandan bridge before initializeGuandan() runs in tests. */
const GUANDAN_RUNTIME_IDLE_MESSAGE = 'DanLM 运行时尚未初始化（运行 scripts/guandan-setup.sh 安装 DanLM 运行时）';

let peerSeq = 0;

type FakePeer = Peer & { sent: ServerMessage[]; superseded: number };

function fakePeer(): FakePeer {
  const sent: ServerMessage[] = [];
  peerSeq += 1;
  return {
    id: `peer${peerSeq}`,
    role: 'table',
    seatId: null,
    token: null,
    room: null,
    requestRoom: null,
    sent,
    superseded: 0,
    send(message) {
      sent.push(message);
    },
    supersede() {
      this.superseded += 1;
    },
  };
}

function lastState(peer: FakePeer): Snapshot {
  for (let i = peer.sent.length - 1; i >= 0; i -= 1) {
    const message = peer.sent[i];
    if (message.type === 'state') return message.state;
  }
  throw new Error('no state snapshot received');
}

function refusals(peer: FakePeer): number {
  return peer.sent.filter((message) => message.type === 'error').length;
}

function lastError(peer: FakePeer): string | undefined {
  for (let i = peer.sent.length - 1; i >= 0; i -= 1) {
    const message = peer.sent[i];
    if (message.type === 'error') return message.message;
  }
  return undefined;
}

function lastSession(peer: FakePeer): Extract<ServerMessage, { type: 'session' }> | null {
  for (let i = peer.sent.length - 1; i >= 0; i -= 1) {
    const message = peer.sent[i];
    if (message.type === 'session') return message;
  }
  return null;
}

/** A command must be accepted: no new refusal may appear in this peer's history. */
function expectAccepted(
  room: Room,
  peer: FakePeer,
  type: string,
  payload: Record<string, unknown>,
  id: string,
): void {
  const before = refusals(peer);
  room.command(peer, type, payload, id);
  assert.equal(refusals(peer), before, `${type} (${id}) refused: ${lastError(peer)}`);
}

/** A command must be refused, optionally with an exact room/runtime message. */
function expectRefused(
  room: Room,
  peer: FakePeer,
  type: string,
  payload: Record<string, unknown>,
  id: string,
  message?: string,
): void {
  const before = refusals(peer);
  room.command(peer, type, payload, id);
  assert.equal(refusals(peer), before + 1, `${type} (${id}) was accepted`);
  if (message !== undefined) assert.equal(lastError(peer), message, `${type} (${id}) message`);
}

function ddz(room: Room): DoudizhuGame {
  if (!(room.engine instanceof DoudizhuGame)) throw new Error('expected the doudizhu engine');
  return room.engine;
}

function ddView(room: Room) {
  const view = room.engine.view(null);
  if (view.game !== 'doudizhu') throw new Error('expected the doudizhu engine view');
  return view;
}

/** `Promise.withResolvers` requires the ES2024 lib; this repo's tsconfig targets ES2022. */
function withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Poll a real condition; never a fixed "long enough" sleep. */
async function waitFor(check: () => boolean, label: string, timeout = ACTION_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * Negative assertion against the room's real action cadence: the only genuine delay in this file,
 * because "nothing happens" cannot be awaited from an event. One cadence plus margin is enough for
 * a stale commit to have landed, so an unchanged reading is real evidence.
 */
async function expectStable(read: () => number, label: string): Promise<void> {
  const value = read();
  await delay(900);
  assert.equal(read(), value, label);
}

/** Synthetic policy double: scripted moves, optional manual resolution, real abort signals. */
class ScriptedPolicy implements DouZeroPolicy {
  available = true;
  reason: string | null = null;
  readonly calls: DouZeroState[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  private readonly scripted: (string[] | Error)[] = [];
  private readonly waiting: ((ids: string[]) => void)[] = [];

  script(...moves: (string[] | Error)[]): void {
    this.scripted.push(...moves);
  }

  availability(): { available: boolean; message: string | null } {
    return { available: this.available, message: this.reason };
  }

  chooseMove(state: DouZeroState, signal?: AbortSignal, strength?: 'strong' | 'easy'): Promise<string[]> {
    this.calls.push(state);
    this.signals.push(signal);
    const next = this.scripted.shift();
    if (next instanceof Error) return Promise.reject(next);
    if (next !== undefined) return Promise.resolve(next);
    const { promise, resolve } = withResolvers<string[]>();
    this.waiting.push(resolve);
    return promise;
  }

  resolveNext(ids: string[]): number {
    const waiter = this.waiting.shift();
    if (!waiter) return 0;
    waiter(ids);
    return 1;
  }

  get pending(): number {
    return this.waiting.length;
  }
}

/** Lowest legal single for this seat, or [] when passing is legal (test-side expectation only). */
function legalMove(room: Room, seatId: number): string[] {
  const view = ddView(room);
  const hand = ddz(room).hands[seatId] ?? [];
  const sorted = [...hand].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  if (view.lastPlay === null || view.lastPlay.seatId === seatId) {
    return sorted.length > 0 ? [sorted[0]!.id] : [];
  }
  const lastKind = detectPlay(view.lastPlay.cards);
  const beat = sorted.find((card) => {
    const kind = detectPlay([card]);
    return kind !== null && lastKind !== null && canBeat(kind, lastKind);
  });
  return beat ? [beat.id] : [];
}

const PLACED = [
  { x: 0.5, y: 0.9, angle: 0 },
  { x: 0.1, y: 0.5, angle: 90 },
  { x: 0.9, y: 0.5, angle: -90 },
];

interface Table {
  room: Room;
  host: FakePeer;
  players: FakePeer[];
  policy: ScriptedPolicy;
}

/** Tablet Doudizhu room with three placed seats and one human per entry of `fill`. */
function setupTablet(policy: ScriptedPolicy, fill: number[] = [0, 1, 2], code = 'AT1'): Table {
  const room = new Room(code, 'tablet', 'doudizhu', policy);
  const host = fakePeer();
  room.bindHost(host, `create-${code}`);
  expectAccepted(room, host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, `seats-${code}`);
  const players: FakePeer[] = [];
  for (const seat of fill) {
    const peer = fakePeer();
    room.bindJoin(peer, seat, `玩家${seat}`, `join-${code}-${seat}`);
    players.push(peer);
  }
  return { room, host, players, policy };
}

/** Add a bot to a seat and require the host command to be accepted. */
function addBot(table: Table, seatId: number, tag: string): void {
  expectAccepted(table.room, table.host, 'addBot', { seatId }, `${tag}-bot-${seatId}`);
}

function readyHumans(table: Table, tag: string): void {
  table.players.forEach((peer, index) => {
    expectAccepted(table.room, peer, 'ready', { ready: true }, `${tag}-ready-${index}`);
  });
}

test('host adds and removes bots only in its own doudizhu lobby', () => {
  const table = setupTablet(new ScriptedPolicy(), [0, 1]);
  const { room, host, players } = table;

  expectRefused(room, players[0]!, 'addBot', { seatId: 2 }, 'bot-by-player', '只有房主可以添加机器人');
  assert.equal(room.players[2], null);

  addBot(table, 2, 'add');
  const seat = lastState(host).seats[2]!;
  assert.equal(seat.isBot, true);
  assert.equal(seat.autoPlay, true);
  assert.equal(seat.ready, true);
  assert.equal(seat.name, '机器人3');
  assert.equal(seat.count, 0);
  assert.equal(room.players[2]!.peer, null, 'a bot has no socket');
  assert.equal(room.players[2]!.connected, false);

  expectRefused(room, host, 'addBot', { seatId: 2 }, 'bot-again', '该座位已被占用');
  assert.equal(room.players[2]!.isBot, true);

  expectRefused(room, host, 'removeBot', { seatId: 0 }, 'rm-human', '该座位没有机器人');
  assert.equal(room.players[0]!.peer, players[0]);

  expectRefused(room, host, 'addBot', { seatId: 9 }, 'bot-range', '座位号无效');

  expectAccepted(room, host, 'removeBot', { seatId: 2 }, 'rm-bot');
  assert.equal(room.players[2], null);

  const empty = new Room('AT2', 'tablet', 'doudizhu', new ScriptedPolicy());
  const emptyHost = fakePeer();
  empty.bindHost(emptyHost, 'create-empty');
  expectRefused(empty, emptyHost, 'addBot', { seatId: 0 }, 'bot-unplaced', '该座位尚未放置');
  assert.equal(empty.players[0], null);

  addBot(table, 2, 'lobby');
  readyHumans(table, 'mid');
  expectAccepted(room, host, 'start', {}, 'start-mid');
  assert.equal(ddView(room).phase, 'bidding');
  expectRefused(room, host, 'removeBot', { seatId: 2 }, 'rm-midgame', '只能在准备阶段移除机器人');
  assert.equal(room.players[2]!.isBot, true);
  room.dispose();
  empty.dispose();
});

test('a guandan room rejects robot commands and reports unavailable automation', () => {
  const policy = new ScriptedPolicy();
  const room = new Room('AT3', 'tablet', 'guandan', policy);
  const host = fakePeer();
  room.bindHost(host, 'create-gu');
  assert.equal(lastState(host).seats.length, 4);
  const joiner = fakePeer();
  room.bindJoin(joiner, 0, '甲', 'join-gu');

  const automation = lastState(host).automation;
  assert.equal(automation.available, false);
  assert.equal(automation.message, GUANDAN_RUNTIME_IDLE_MESSAGE);
  assert.equal(lastState(host).seats.every((seat) => !seat.isBot && !seat.autoPlay), true);

  const viewBefore = room.engine.view(null);
  expectRefused(room, host, 'addBot', { seatId: 1 }, 'gu-addbot', GUANDAN_RUNTIME_IDLE_MESSAGE);
  expectRefused(room, joiner, 'autoPlay', { enabled: true }, 'gu-autoplay', GUANDAN_RUNTIME_IDLE_MESSAGE);
  expectRefused(room, host, 'removeBot', { seatId: 0 }, 'gu-removebot', '该座位没有机器人');
  assert.equal(room.players[1], null);
  assert.equal(room.players[0]!.autoPlay, false);
  assert.deepEqual(room.engine.view(null), viewBefore);
  assert.equal(policy.calls.length, 0);
  room.dispose();
});

test('opt-in auto play needs an available runtime and can always be cancelled', () => {
  const policy = new ScriptedPolicy();
  policy.available = false;
  policy.reason = '模型未安装';
  const table = setupTablet(policy, [0, 1, 2]);
  const { room, host, players } = table;

  expectRefused(room, players[1]!, 'autoPlay', { enabled: true }, 'opt-unavailable', '模型未安装');
  assert.equal(room.players[1]!.autoPlay, false);

  policy.available = true;
  policy.reason = null;
  expectAccepted(room, players[1]!, 'autoPlay', { enabled: true }, 'opt-on');
  assert.equal(lastState(host).seats[1]!.autoPlay, true);
  assert.equal(lastState(host).seats[1]!.ready, true, 'opting in readies the seat in the lobby');
  assert.deepEqual(
    lastState(host).seats.map((seat) => seat.autoPlay),
    [false, true, false],
    'opt-in is strictly per player',
  );

  expectAccepted(room, players[1]!, 'autoPlay', { enabled: false }, 'opt-off');
  assert.equal(lastState(host).seats[1]!.autoPlay, false);
  assert.equal(lastState(host).automation.available, true);

  // A runtime failure later must not block cancellation.
  policy.available = false;
  policy.reason = '模型崩溃';
  expectRefused(room, players[1]!, 'autoPlay', { enabled: true }, 'opt-again', '模型崩溃');
  expectAccepted(room, players[1]!, 'autoPlay', { enabled: false }, 'opt-off-2');
  room.dispose();
});

test('manual play is refused while managed and works again after cancelling', () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [0, 1, 2]);
  const { room, host, players } = table;

  expectAccepted(room, players[0]!, 'autoPlay', { enabled: true }, 'managed-on');
  readyHumans(table, 'managed');
  expectAccepted(room, host, 'start', {}, 'start-managed');
  assert.equal(ddView(room).phase, 'bidding');

  expectRefused(room, players[0]!, 'bid', { value: 3 }, 'manual-while-managed', '托管中，请先取消托管');
  assert.equal(ddView(room).bid, 0);
  assert.equal(ddView(room).turn, 0);

  expectAccepted(room, players[0]!, 'autoPlay', { enabled: false }, 'managed-off');
  expectAccepted(room, players[0]!, 'bid', { value: 3 }, 'manual-after-cancel');
  assert.equal(ddView(room).landlord, 0);
  room.dispose();
});

test('robots never gain host rights or take phone host failover', () => {
  const policy = new ScriptedPolicy();
  const room = new Room('AT4', 'phone', 'doudizhu', policy);
  const creator = fakePeer();
  room.bindCreator(creator, 'create-phone', '房主');
  expectAccepted(room, creator, 'addBot', { seatId: 1 }, 'phone-bot-1');
  expectAccepted(room, creator, 'addBot', { seatId: 2 }, 'phone-bot-2');
  assert.equal(room.hostSeatId, 0);
  assert.equal(room.players[1]!.isBot, true);

  room.detach(creator);
  assert.equal(room.hostSeatId, null, 'robots never inherit phone host rights');
  assert.equal(room.hostConnected, false);

  const back = fakePeer();
  room.bindResume(back, creator.token ?? '', 'phone-resume');
  assert.equal(lastSession(back)?.seatId, 0);
  assert.equal(room.hostSeatId, 0);
  assert.deepEqual(
    lastState(back).seats.map((seat) => seat.isBot),
    [false, true, true],
  );
  room.dispose();
});

test('an ordinary offline seat still pauses the table', () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [0, 1, 2]);
  const { room, host, players } = table;
  readyHumans(table, 'pause');
  expectAccepted(room, host, 'start', {}, 'start-pause');

  // A drop closes the socket and its identity with it: the resume arrives on a brand-new socket
  // that presents the token the client saved before the drop, exactly as the real transport does.
  const savedToken = players[1]!.token;
  assert.ok(savedToken, 'the seated socket holds the token it would have saved');
  room.detach(players[1]!);
  expectRefused(room, players[0]!, 'bid', { value: 1 }, 'paused-human', '有玩家掉线，等待重连');
  assert.equal(ddView(room).bid, 0);

  const back = fakePeer();
  room.bindResume(back, savedToken, 'resume-human');
  assert.equal(lastSession(back)?.seatId, 1, 'the fresh socket resumed seat 1');
  assert.equal(room.players[1]!.peer, back);
  players[1] = back; // the fixture follows the seat onto its new socket
  expectAccepted(room, players[0]!, 'bid', { value: 1 }, 'resumed-human');
  assert.equal(ddView(room).bid, 1);
  room.dispose();
});

test('offline bot seats bid and play on while a human keeps the table open', async () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [2], 'AT5');
  const { room, host } = table;
  const human = table.players[0]!;
  addBot(table, 0, 'at5');
  addBot(table, 1, 'at5');
  expectAccepted(room, human, 'ready', { ready: true }, 'at5-ready');
  expectAccepted(room, host, 'start', {}, 'start-at5');

  // Both bot seats bid before the human's turn, so wait for the turn itself, not just the first bid.
  await waitFor(() => ddView(room).turn === 2, 'the offline bot seats to bid the human in');
  assert.equal(ddView(room).bid > 0, true, 'the bots bid on without a socket');
  assert.equal(policy.calls.length, 0, 'bidding never asks the runtime for cards');
  assert.deepEqual(
    room.players.map((player) => player?.connected),
    [false, false, true],
    'both robots have no socket',
  );
  assert.equal(ddView(room).turn, 2, 'the bidding reached the human without pausing');
  expectAccepted(room, human, 'bid', { value: 0 }, 'at5-human-bid');
  assert.equal(room.players[0]!.isBot, true);
  assert.equal(lastState(host).automation.available, true);
  room.dispose();
});

test('a progressing managed round is not expirable while a bot-only lobby still is', async (t) => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [], 'AT6');
  const { room, host } = table;
  [0, 1, 2].forEach((seat) => addBot(table, seat, 'at6'));
  expectAccepted(room, host, 'start', {}, 'start-at6');

  await waitFor(() => ddView(room).phase !== 'lobby', 'the managed deal to begin');
  room.detach(host);
  await waitFor(() => room.empty === false, 'the managed round to hold the room open');
  assert.equal(room.isExpired(Date.now() + 5 * ROOM_TTL_MS, ROOM_TTL_MS), false);

  const botLobby = new Room('AT7', 'tablet', 'doudizhu', new ScriptedPolicy());
  const lobbyHost = fakePeer();
  botLobby.bindHost(lobbyHost, 'create-at7');
  expectAccepted(botLobby, lobbyHost, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-at7');
  expectAccepted(botLobby, lobbyHost, 'addBot', { seatId: 0 }, 'at7-bot');
  const emptyAt = Date.now();
  const clock = t.mock.method(Date, 'now', () => emptyAt);
  try { botLobby.detach(lobbyHost); } finally { clock.mock.restore(); }
  assert.equal(botLobby.empty, true, 'a bot-only lobby is abandoned');
  assert.equal(botLobby.isExpired(emptyAt + ROOM_TTL_MS - 1, ROOM_TTL_MS), false);
  assert.equal(botLobby.isExpired(emptyAt + ROOM_TTL_MS, ROOM_TTL_MS), true);
  botLobby.dispose();
  room.dispose();
});

test('approving a bot seat aborts its pending inference before the session is handed over', async () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [0]);
  const { room, host } = table;
  addBot(table, 1, 'tk');
  addBot(table, 2, 'tk');
  expectAccepted(room, table.players[0]!, 'ready', { ready: true }, 'tk-r0');
  expectAccepted(room, host, 'start', {}, 'start-takeover');
  expectAccepted(room, table.players[0]!, 'bid', { value: 3 }, 'takeover-bid');
  assert.equal(ddView(room).landlord, 0);
  policy.script(legalMove(room, 1));
  expectAccepted(room, table.players[0]!, 'play', { cards: legalMove(room, 0) }, 'takeover-lead');
  await waitFor(() => policy.calls.length > 0, 'a bot inference in flight');

  const viewBefore = room.engine.view(null);
  const handBefore = ddz(room).hands[1]!.length;
  const newcomer = fakePeer();
  room.requestSeat(newcomer, 1, '新人', 'takeover-req');
  expectAccepted(room, host, 'decideSeat', { requestId: 'takeover-req', approve: true }, 'takeover-ok');

  const session = lastSession(newcomer);
  assert.equal(session?.seatId, 1);
  assert.equal(room.players[1]!.isBot, false);
  assert.equal(room.players[1]!.autoPlay, false);
  assert.equal(room.players[1]!.peer, newcomer);
  assert.equal(room.players[1]!.token, session?.token);
  assert.equal(ddz(room).hands[1]!.length, handBefore, 'the takeover keeps the hand');
  assert.deepEqual(room.engine.view(null), viewBefore, 'the takeover keeps the game view');
  assert.equal(policy.pending, 0, 'the pending decision was abandoned, not applied');

  const playsBefore = ddView(room).tablePlays.length;
  await expectStable(() => ddView(room).tablePlays.length, 'a stale inference must not play');
  assert.equal(ddView(room).tablePlays.length, playsBefore);
  assert.equal(room.players[1]!.autoPlay, false);
  room.dispose();
});

test('托管 survives an ordinary resume and again readies managed seats', () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [0, 1, 2]);
  const { room, host, players } = table;

  expectAccepted(room, players[1]!, 'autoPlay', { enabled: true }, 'resume-opt');
  expectRefused(room, host, 'autoPlay', { enabled: false }, 'table-cannot-cancel');
  assert.equal(room.players[1]!.autoPlay, true, 'only the exact player can cancel their own 托管');

  // Same reconnect rule as above: the dropped socket is gone, the resume arrives on a fresh one.
  const savedToken = players[1]!.token;
  assert.ok(savedToken, 'the seated socket holds the token it would have saved');
  room.detach(players[1]!);
  const back = fakePeer();
  room.bindResume(back, savedToken, 'resume-opt-back');
  assert.equal(lastSession(back)?.seatId, 1, 'the fresh socket resumed seat 1');
  assert.equal(room.players[1]!.peer, back);
  assert.equal(room.players[1]!.autoPlay, true, 'resume retains voluntary auto play');
  players[1] = back; // the fixture follows the seat onto its new socket

  readyHumans(table, 'again');
  expectAccepted(room, host, 'start', {}, 'start-again');
  expectAccepted(room, players[0]!, 'bid', { value: 3 }, 'again-bid');
  expectRefused(room, players[1]!, 'play', { cards: legalMove(room, 1) }, 'again-managed', '托管中，请先取消托管');
  expectAccepted(room, players[1]!, 'autoPlay', { enabled: false }, 'again-cancel');
  assert.equal(room.players[1]!.autoPlay, false);
  room.dispose();
});

test('cancelling 托管 mid-inference stops the room acting for that seat and returns manual control', async () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [0], 'ATB');
  const { room, host } = table;
  const human = table.players[0]!;
  addBot(table, 1, 'cab');
  addBot(table, 2, 'cab');
  expectAccepted(room, human, 'ready', { ready: true }, 'cab-ready');
  expectAccepted(room, host, 'start', {}, 'cab-start');
  expectAccepted(room, human, 'bid', { value: 3 }, 'cab-bid');
  expectAccepted(room, human, 'play', { cards: legalMove(room, 0) }, 'cab-lead');
  expectAccepted(room, human, 'autoPlay', { enabled: true }, 'cab-opt');

  // Both robots answer through the runtime until the turn comes back to the managed landlord.
  for (const seat of [1, 2]) {
    await waitFor(() => policy.pending === 1, `seat ${seat} to ask the runtime`);
    assert.equal(policy.calls[policy.calls.length - 1]!.selfSeat, seat, 'the room only asks the seat on turn');
    policy.resolveNext(legalMove(room, seat));
    await waitFor(() => ddView(room).turn !== seat, `seat ${seat} to finish its turn`);
  }
  await waitFor(
    () => policy.pending === 1 && policy.calls[policy.calls.length - 1]!.selfSeat === 0,
    'the managed landlord to ask the runtime',
  );

  // Cancelling 托管 is allowed at any moment, including while the runtime is thinking.
  expectAccepted(room, human, 'autoPlay', { enabled: false }, 'cab-cancel');
  assert.equal(room.players[0]!.autoPlay, false);
  const playsBefore = ddView(room).tablePlays.length;
  const versionAfterCancel = lastState(host).version;
  policy.resolveNext(legalMove(room, 0));
  await expectStable(() => ddView(room).tablePlays.length, 'a cancelled seat must not act');
  assert.equal(ddView(room).tablePlays.length, playsBefore);
  assert.equal(lastState(host).version, versionAfterCancel, 'the cancelled seat publishes nothing');

  // Manual control is back on the very same turn, with no reconnect or rejoin.
  expectAccepted(room, human, 'play', { cards: legalMove(room, 0) }, 'cab-manual');
  assert.equal(ddView(room).tablePlays.length, playsBefore + 1, 'the human plays their own turn');
  room.dispose();
});

test('a managed lobby seat cannot unready itself, and cancelling 托管 restores manual control', () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [0, 1]);
  const { room, host, players } = table;

  // Opting into 托管 readies the seat, so the host is never left waiting on a managed human.
  expectAccepted(room, players[1]!, 'autoPlay', { enabled: true }, 'mg-opt');
  assert.equal(room.players[1]!.ready, true, 'opting into 托管 readies the seat');
  expectRefused(room, players[1]!, 'ready', { ready: false }, 'mg-unready', '托管中，请先取消托管');
  assert.equal(room.players[1]!.ready, true, 'the managed seat stays ready for hosting');
  expectAccepted(room, players[1]!, 'ready', { ready: true }, 'mg-re-ready');

  // A robot seat is ready from creation and holds no socket, so no client can unready it either.
  addBot(table, 2, 'mg');
  assert.equal(room.players[2]!.ready, true);
  assert.equal(room.players[2]!.peer, null);
  expectRefused(room, players[0]!, 'addBot', { seatId: 2 }, 'mg-bot-by-player', '只有房主可以添加机器人');

  // Cancelling is the only way back to manual control, and it restores the ordinary ready toggle.
  expectAccepted(room, players[1]!, 'autoPlay', { enabled: false }, 'mg-cancel');
  assert.equal(room.players[1]!.autoPlay, false);
  expectAccepted(room, players[1]!, 'ready', { ready: false }, 'mg-manual-unready');
  assert.equal(room.players[1]!.ready, false, 'a manual seat decides its own readiness again');

  // Two ready seats plus one robot start the game: the managed seat did not stall hosting.
  expectAccepted(room, players[0]!, 'ready', { ready: true }, 'mg-ready-0');
  expectAccepted(room, players[1]!, 'ready', { ready: true }, 'mg-ready-1');
  expectAccepted(room, host, 'start', {}, 'mg-start');
  assert.notEqual(ddView(room).phase, 'lobby');
  room.dispose();
});

test('an all-managed table finds a landlord with one version bump per bid', async () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [], 'AT8');
  const { room, host } = table;
  [0, 1, 2].forEach((seat) => addBot(table, seat, 'at8'));
  expectAccepted(room, host, 'start', {}, 'start-at8');
  const versionAfterStart = lastState(host).version;

  await waitFor(() => ddView(room).phase === 'playing', 'the managed bidding to finish', 8_000);
  const view = ddView(room);
  assert.equal(view.landlord !== null, true);
  assert.equal(view.tablePlays.length, 0, 'bidding resolved without any redeal');
  assert.equal(lastState(host).version, versionAfterStart + 3, 'three bids, one version bump each');
  assert.equal(policy.calls.length, 0, 'local rule bidding never calls the runtime');
  assert.deepEqual(
    lastState(host).seats.map((seat) => seat.count),
    view.landlord === 0 ? [20, 17, 17] : view.landlord === 1 ? [17, 20, 17] : [17, 17, 20],
    'the landlord took the three bottom cards',
  );
  room.dispose();
});

test('the runtime receives only public facts plus this seat own hand', async () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [0]);
  const { room, host } = table;
  addBot(table, 1, 'shape');
  addBot(table, 2, 'shape');
  expectAccepted(room, table.players[0]!, 'ready', { ready: true }, 'shape-r0');
  expectAccepted(room, host, 'start', {}, 'start-shape');
  expectAccepted(room, table.players[0]!, 'bid', { value: 3 }, 'shape-bid');
  policy.script(legalMove(room, 1));
  expectAccepted(room, table.players[0]!, 'play', { cards: legalMove(room, 0) }, 'shape-lead');
  await waitFor(() => policy.calls.length > 0, 'the bot decision');

  const state = policy.calls[0]!;
  assert.equal(state.selfSeat, 1);
  assert.equal(state.turn, 1);
  assert.equal(state.landlord, 0);
  assert.equal(state.hand.length, 17);
  assert.equal(state.counts.length, 3);
  assert.equal(state.counts[0], 19, 'the human lead is visible as a public hand count');
  assert.equal(state.bottom.length, 3);
  assert.equal(state.tablePlays.length, 1);
  assert.equal(state.lastPlay?.seatId, 0);
  const foreign = [0, 2].flatMap((seat) => ddz(room).hands[seat]!.map((card) => card.id));
  const leaked = foreign.filter((id) => state.hand.some((card) => card.id === id));
  assert.deepEqual(leaked, [], 'no opponent card crosses into the runtime input');
  assert.equal(JSON.stringify(state).includes('token'), false);
  policy.resolveNext([]);
  room.dispose();
});

test('runtime failure stops progression with an honest notice and keeps the table intact', async () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [0], 'AT9');
  const { room, host } = table;
  addBot(table, 1, 'fail');
  addBot(table, 2, 'fail');
  expectAccepted(room, table.players[0]!, 'ready', { ready: true }, 'fail-r0');
  expectAccepted(room, host, 'start', {}, 'start-fail');
  expectAccepted(room, table.players[0]!, 'bid', { value: 3 }, 'fail-bid');
  policy.script(new Error('model crashed'));
  expectAccepted(room, table.players[0]!, 'play', { cards: legalMove(room, 0) }, 'fail-lead');
  const viewBefore = room.engine.view(null);

  await waitFor(() => lastState(host).automation.available === false, 'the failure notice');
  const automation = lastState(host).automation;
  assert.ok((automation.message ?? '').includes('机器人'), 'an honest public failure message');
  assert.deepEqual(room.engine.view(null), viewBefore, 'a failed inference changes no game state');
  await expectStable(() => lastState(host).version, 'no further automatic progress');

  // The human can cancel the failed seat again, which clears the public notice.
  expectAccepted(room, table.players[0]!, 'autoPlay', { enabled: false }, 'fail-cancel');
  assert.equal(room.players[0]!.autoPlay, false);
  assert.equal(lastState(host).automation.available, true);
  room.dispose();
});

test('disposing the room aborts an in-flight decision and leaves no work behind', async () => {
  const policy = new ScriptedPolicy();
  const table = setupTablet(policy, [0], 'ATA');
  const { room, host } = table;
  addBot(table, 1, 'aba');
  addBot(table, 2, 'aba');
  expectAccepted(room, table.players[0]!, 'ready', { ready: true }, 'aba-r0');
  expectAccepted(room, host, 'start', {}, 'start-aba');
  expectAccepted(room, table.players[0]!, 'bid', { value: 3 }, 'aba-bid');
  expectAccepted(room, table.players[0]!, 'play', { cards: legalMove(room, 0) }, 'aba-lead');
  await waitFor(() => policy.pending === 1, 'an in-flight bot decision');
  const signal = policy.signals[policy.signals.length - 1];
  assert.ok(signal instanceof AbortSignal);

  const playsBefore = ddView(room).tablePlays.length;
  room.dispose();
  await waitFor(() => signal.aborted, 'the disposed room to abort its inference');
  // `empty` deliberately reports a bound host socket, so quiescence here is "no version ever
  // published again": the aborted decision must not act, not even to broadcast.
  const versionAfterDispose = lastState(host).version;
  policy.resolveNext(legalMove(room, 1));
  await expectStable(() => ddView(room).tablePlays.length, 'a disposed decision must not act');
  assert.equal(ddView(room).tablePlays.length, playsBefore);
  assert.equal(lastState(host).version, versionAfterDispose, 'a disposed room never publishes again');
});
