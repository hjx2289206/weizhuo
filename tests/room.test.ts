// Permanent server-behaviour tests: room flow, host authority, privacy, legal ownership, turn,
// reconnect, host-approved replacement, idempotency, expiry.
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Card,
  DoudizhuGameFields,
  DoudizhuSnapshot,
  ErrorCode,
  GuandanSnapshot,
  ServerMessage,
  Snapshot,
  Suit,
} from '../shared/protocol';
import { Room, type Peer } from '../server/room';
import { DoudizhuGame } from '../server/games/doudizhu';
import { GuandanGame } from '../server/games/guandan';
import { createPlayStamper } from '../server/games/playLog';
import { createDeck } from '../server/rules';

const ROOM_TTL_MS = 30 * 60 * 1000;

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

function rawState(peer: FakePeer): Snapshot {
  for (let i = peer.sent.length - 1; i >= 0; i -= 1) {
    const message = peer.sent[i];
    if (message.type === 'state') return message.state;
  }
  throw new Error('no state snapshot received');
}

/** Snapshot of a Doudizhu room, narrowed by its discriminant (the baseline game of this suite). */
function ddzState(peer: FakePeer): DoudizhuSnapshot {
  const state = rawState(peer);
  if (state.game !== 'doudizhu') throw new Error(`${peer.id}: expected a doudizhu snapshot`);
  return state;
}

/** Snapshot of a Guandan room, narrowed by its discriminant. */
function guState(peer: FakePeer): GuandanSnapshot {
  const state = rawState(peer);
  if (state.game !== 'guandan') throw new Error(`${peer.id}: expected a guandan snapshot`);
  return state;
}

/** The Doudizhu engine of a room, narrowed for trusted fixture access after instanceof. */
function ddzGame(room: Room): DoudizhuGame {
  if (!(room.engine instanceof DoudizhuGame)) throw new Error('expected the doudizhu engine');
  return room.engine;
}

/** Public Doudizhu rules state of one engine. */
function ddzViewOf(engine: DoudizhuGame): DoudizhuGameFields {
  const view = engine.view(null);
  if (view.game !== 'doudizhu') throw new Error('expected the doudizhu engine view');
  return view;
}

/** Public Doudizhu rules state of a room. */
function ddzView(room: Room): DoudizhuGameFields {
  return ddzViewOf(ddzGame(room));
}

function lastError(peer: FakePeer): string | undefined {
  for (let i = peer.sent.length - 1; i >= 0; i -= 1) {
    const message = peer.sent[i];
    if (message.type === 'error') return message.message;
  }
  return undefined;
}

/** Count refusals so a later success can be asserted without forgetting earlier errors. */
function errorCount(peer: FakePeer): number {
  return peer.sent.filter((message) => message.type === 'error').length;
}

function lastErrorCode(peer: FakePeer): ErrorCode | undefined {
  for (let i = peer.sent.length - 1; i >= 0; i -= 1) {
    const message = peer.sent[i];
    if (message.type === 'error') return message.code;
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

function lastSeatRequest(peer: FakePeer): Extract<ServerMessage, { type: 'seat-request' }> | null {
  for (let i = peer.sent.length - 1; i >= 0; i -= 1) {
    const message = peer.sent[i];
    if (message.type === 'seat-request') return message;
  }
  return null;
}

const deck = createDeck();

function pick(rank: number, suit: Suit = 'spade'): Card {
  const found = deck.find((c) => c.rank === rank && c.suit === suit);
  if (!found) throw new Error(`missing card ${rank}/${suit}`);
  return found;
}

interface Fixture {
  room: Room;
  host: FakePeer;
  players: FakePeer[];
}

const PLACED = [
  { x: 0.5, y: 0.88, angle: 0 },
  { x: 0.1, y: 0.5, angle: 90 },
  { x: 0.9, y: 0.5, angle: -90 },
];

function setup(): Fixture {
  const room = new Room('TEST', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create-1');
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-setup');
  const players = [0, 1, 2].map((seat) => {
    const peer = fakePeer();
    room.bindJoin(peer, seat, `玩家${seat}`, `join-${seat}`);
    return peer;
  });
  return { room, host, players };
}

/** Phone room: the creator owns seat 0 and the host rights; two phones take 1 and 2. */
function setupPhone(): Fixture {
  const room = new Room('PHON', 'phone', 'doudizhu');
  const creator = fakePeer();
  room.bindCreator(creator, 'create-phone', '手机房主');
  const players = [creator];
  for (const seat of [1, 2]) {
    const peer = fakePeer();
    room.bindJoin(peer, seat, `玩家${seat}`, `join-${seat}`);
    players.push(peer);
  }
  return { room, host: creator, players };
}

/** Everybody readies up; `authority` is the tablet screen or the phone creator. */
function startGame(room: Room, authority: FakePeer, players: FakePeer[]): void {
  players.forEach((peer, seat) => room.command(peer, 'ready', { ready: true }, `ready-${seat}`));
  room.command(authority, 'start', {}, 'start-1');
}

/** Seat 0 bids 1, others pass: seat 0 becomes landlord and leads. */
function toPlaying(room: Room, players: FakePeer[]): void {
  room.command(players[0], 'bid', { value: 1 }, 'bid-0');
  room.command(players[1], 'bid', { value: 0 }, 'bid-1');
  room.command(players[2], 'bid', { value: 0 }, 'bid-2');
}

/** Overwrite each seated hand with a known, deterministic set of cards. */
function setHands(fixture: Fixture, hands: Card[][]): void {
  hands.forEach((hand, seat) => {
    ddzGame(fixture.room).hands[seat]! = hand.slice();
  });
}

/** Card ids anyone may legitimately see in this view: revealed bottom (Doudizhu) and accepted plays. */
function publicCardIds(view: Snapshot): Set<string> {
  const ids = new Set<string>([
    ...view.tablePlays.flatMap((play) => play.cards.map((card) => card.id)),
    ...(view.lastPlay?.cards ?? []).map((card) => card.id),
  ]);
  if (view.game === 'doudizhu') for (const card of view.bottom) ids.add(card.id);
  return ids;
}

/** No other seat's unplayed cards may appear anywhere in this peer's snapshot. */
function assertNoHiddenHands(room: Room, viewer: FakePeer): void {
  const view = rawState(viewer);
  const publicIds = publicCardIds(view);
  const serialized = JSON.stringify(view);
  let privateCount = 0;
  for (let seat = 0; seat < room.seatCount; seat += 1) {
    if (seat === view.selfSeat) continue;
    for (const card of room.engine.handOf(seat)) {
      if (publicIds.has(card.id)) continue; // also public via the bottom or an accepted play
      privateCount += 1;
      assert.equal(serialized.includes(`"${card.id}"`), false, `hidden card ${card.id} of seat ${seat} leaked`);
    }
  }
  assert.ok(privateCount > 0, 'fixture should leave private opponent cards to check');
}

// ---------------------------------------------------------------- lobby and deal

test('join/ready/start deals 17 each, hides hands and bottom from everyone, and publishes the table facts', () => {
  const { room, host, players } = setup();
  startGame(room, host, players);

  assert.equal(ddzView(room).phase, 'bidding');
  const table = ddzState(host);
  assert.equal(table.game, 'doudizhu');
  assert.equal(table.roomMode, 'tablet');
  assert.equal(table.hand.length, 0);
  assert.equal(table.bottom.length, 0); // pre-landlord bottom is secret
  assert.deepEqual(
    table.seats.map((s) => s.count),
    [17, 17, 17],
  );
  assert.equal(table.role, 'table');
  assert.equal(table.selfSeat, null);
  assert.equal(table.isHost, true);
  assert.equal(table.hostSeatId, null);
  assert.equal(table.hostConnected, true);
  assert.equal(table.trickStartIndex, 0);
  assert.deepEqual(table.tablePlays, []);
  assert.deepEqual(table.seatRequests, []);

  const hostSession = lastSession(host);
  assert.equal(hostSession?.role, 'table');
  assert.equal(hostSession?.seatId, null);
  assert.equal(hostSession?.token, room.hostToken);
  assert.equal(hostSession?.game, 'doudizhu');
  assert.equal(hostSession?.roomMode, 'tablet');

  const seat1View = ddzState(players[1]);
  assert.equal(seat1View.hand.length, 17);
  assert.equal(seat1View.selfSeat, 1);
  assert.equal(seat1View.role, 'player');
  assert.equal(seat1View.isHost, false);
  assert.equal(seat1View.bottom.length, 0); // pre-landlord bottom stays secret for phones too
  assert.equal(lastSession(players[1])?.role, 'player');
  assert.equal(lastSession(players[1])?.seatId, 1);
  assertNoHiddenHands(room, players[1]);
});

test('start requires three connected ready players', () => {
  const { room, host, players } = setup();
  room.command(players[0], 'ready', { ready: true }, 'r0');
  room.command(host, 'start', {}, 's');
  assert.equal(lastError(host), '有玩家尚未准备');
  room.command(players[1], 'ready', { ready: true }, 'r1');
  room.command(players[2], 'ready', { ready: true }, 'r2');
  room.command(host, 'start', {}, 's2');
  assert.equal(ddzView(room).phase, 'bidding');
});

test('bidding enforces turn order and strictly increasing values', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);

  room.command(players[1], 'bid', { value: 1 }, 'out-of-turn');
  assert.equal(lastError(players[1]), '还没轮到你叫地主');

  room.command(players[0], 'bid', { value: 2 }, 'b0');
  room.command(players[1], 'bid', { value: 1 }, 'b1'); // not higher
  assert.equal(lastError(players[1]), '叫分必须高于当前分值');

  room.command(players[1], 'bid', { value: 3 }, 'b1b'); // 3 wins immediately
  assert.equal(ddzView(room).phase, 'playing');
  assert.equal(ddzView(room).landlord, 1);
  assert.equal(ddzView(room).turn, 1);
  assert.equal(ddzGame(room).hands[1]!.length, 20); // landlord took the 3 bottom cards
});

test('landlord takes the bottom, whose cards become public', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  assert.equal(ddzView(room).landlord, 0);
  assert.equal(ddzView(room).phase, 'playing');
  assert.equal(ddzView(room).turn, 0);
  assert.equal(ddzGame(room).hands[0]!.length, 20);
  for (const peer of [host, ...players]) {
    const view = ddzState(peer);
    assert.equal(view.bottom.length, 3, 'the landlord bottom is public once bidding resolves');
    assert.equal(view.bid, 1);
    assert.equal(view.trickStartIndex, 0);
    assert.equal(view.tablePlays.length, 0);
  }
});

test('play rejects cards you do not own and plays out of turn', () => {
  const fixture = setup();
  const { room, players } = fixture;
  startGame(room, fixture.host, players);
  toPlaying(room, players);

  room.command(players[1], 'play', { cards: [ddzGame(room).hands[1]![0].id] }, 'p-oot');
  assert.equal(lastError(players[1]), '还没轮到你出牌');

  const foreign = deck.find((c) => !ddzGame(room).hands[0]!.some((h) => h.id === c.id))!;
  room.command(players[0], 'play', { cards: [foreign.id] }, 'p-own');
  assert.equal(lastError(players[0]), '你没有这些牌');
});

test('a fresh lead cannot pass; two passes clear the trick back to the leader', () => {
  const fixture = setup();
  const { room, players } = fixture;
  startGame(room, fixture.host, players);
  toPlaying(room, players);

  room.command(players[0], 'pass', {}, 'lead-pass');
  assert.equal(lastError(players[0]), '首出不能过牌');

  const lead = ddzGame(room).hands[0]![0];
  room.command(players[0], 'play', { cards: [lead.id] }, 'play-lead');
  assert.equal(ddzState(players[0]).lastPlay?.seatId, 0);
  assert.equal(ddzView(room).turn, 1);

  room.command(players[1], 'pass', {}, 'pass-1');
  room.command(players[2], 'pass', {}, 'pass-2');
  assert.equal(ddzView(room).turn, 0); // original leader leads again
  assert.equal(room.snapshotFor(players[0]).lastPlay, null); // trick cleared
  const view = ddzState(players[0]);
  assert.equal(view.trickStartIndex, view.tablePlays.length); // the finished trick became history
  assert.deepEqual(view.tablePlays.slice(view.trickStartIndex), []);
  assert.deepEqual(
    view.tablePlays.map((play) => play.seatId),
    [0],
  );
});

test('duplicate action ids never execute twice', () => {
  const fixture = setup();
  const { room, players } = fixture;
  startGame(room, fixture.host, players);
  toPlaying(room, players);

  const before = ddzGame(room).hands[0]!.length;
  const cardId = ddzGame(room).hands[0]![0].id;
  room.command(players[0], 'play', { cards: [cardId] }, 'dup-1');
  const afterFirst = ddzGame(room).hands[0]!.length;
  room.command(players[0], 'play', { cards: [cardId] }, 'dup-1');
  assert.equal(afterFirst, before - 1);
  assert.equal(ddzGame(room).hands[0]!.length, afterFirst);
  assert.equal(ddzView(room).turn, 1); // still seat 1's turn, the replay did not advance play
  assert.ok(players[0].sent.some((m) => m.type === 'ack' && m.id === 'dup-1'));
});

test('a disconnected player pauses bidding and playing until they resume', () => {
  const fixture = setup();
  const { room, players } = fixture;
  startGame(room, fixture.host, players);

  room.detach(players[2]);
  room.command(players[0], 'bid', { value: 1 }, 'paused');
  assert.equal(lastError(players[0]), '有玩家掉线，等待重连');
  assert.equal(ddzState(players[0]).seats[2].connected, false);

  const resumed = fakePeer();
  room.bindResume(resumed, players[2].token ?? '', 'resume-3');
  assert.equal(resumed.role, 'player');
  assert.equal(resumed.seatId, 2);
  assert.equal(ddzState(resumed).seats[2].connected, true);
  room.command(players[0], 'bid', { value: 1 }, 'unpaused');
  assert.equal(
    players[0].sent.some((m) => m.type === 'ack' && m.id === 'unpaused'),
    true,
  );
});

test('closing every browser and resuming the same seats restores the exact hand, turn and score', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  const lead = pick(3, 'spade');
  setHands(fixture, [[lead, pick(13, 'spade')], [pick(4, 'heart')], [pick(5, 'club')]]);
  room.command(players[0], 'play', { cards: [lead.id] }, 'close-lead');

  const before = {
    hands: Array.from({ length: room.seatCount }, (_, seat) => room.engine.handOf(seat).map((card) => card.id)),
    tokens: room.players.map((player) => player!.token),
    turn: ddzView(room).turn,
    phase: ddzView(room).phase,
    bid: ddzView(room).bid,
    landlord: ddzView(room).landlord,
    scores: [...ddzView(room).scores],
    tablePlays: ddzState(host).tablePlays,
    trickStartIndex: ddzState(host).trickStartIndex,
  };

  // Every tab closes: the tablet screen and all three phones lose their sockets.
  room.detach(host);
  for (const peer of players) room.detach(peer);
  assert.equal(room.empty, true);
  assert.equal(
    room.players.every((player) => player !== null && !player.connected),
    true,
  );

  // The same browser reopening resumes each stored credential into its own seat.
  const table = fakePeer();
  room.bindResume(table, room.hostToken, 'resume-table');
  const phones = before.tokens.map((token, seat) => {
    const resumed = fakePeer();
    room.bindResume(resumed, token, `resume-${seat}`);
    return resumed;
  });

  assert.equal(ddzState(table).role, 'table');
  assert.equal(ddzState(table).selfSeat, null);
  for (const [seat, resumed] of phones.entries()) {
    const view = ddzState(resumed);
    assert.equal(view.selfSeat, seat);
    assert.deepEqual(
      view.hand.map((card) => card.id),
      before.hands[seat],
    );
    assert.equal(resumed.token, before.tokens[seat]); // same identity, same credential
    assert.equal(room.players[seat]!.peer, resumed);
  }
  assert.equal(room.empty, false);

  const after = ddzState(table);
  assert.equal(after.turn, before.turn);
  assert.equal(after.phase, before.phase);
  assert.equal(after.bid, before.bid);
  assert.equal(after.landlord, before.landlord);
  assert.deepEqual(after.scores, before.scores);
  assert.equal(after.trickStartIndex, before.trickStartIndex);
  assert.deepEqual(after.tablePlays, before.tablePlays);
  assert.deepEqual(
    after.seats.map((seat) => seat.count),
    before.hands.map((hand) => hand.length),
  );
  assert.equal(
    after.seats.every((seat) => seat.connected),
    true,
  );
  assertNoHiddenHands(room, phones[1]);

  // The resumed phone keeps its place in the turn order.
  room.command(phones[1], 'pass', {}, 'resumed-pass');
  assert.equal(lastError(phones[1]), undefined);
  assert.equal(ddzView(room).turn, 2);
});

test('an occupied seat cannot be taken over by a new join even while disconnected', () => {
  const fixture = setup();
  const intruder = fakePeer();
  fixture.room.bindJoin(intruder, 1, '别人', 'join-x');
  assert.equal(lastErrorCode(intruder), 'SEAT_OCCUPIED');
  assert.equal(intruder.role, 'table');
  assert.equal(intruder.token, null);
  assert.equal(fixture.room.players[1]!.name, '玩家1');
});

test('seats reflect exactly the placed positions; unplaced seats cannot be joined', () => {
  const room = new Room('SEAT', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'c');

  assert.equal(ddzState(host).seats.length, 0); // nothing placed yet

  room.command(host, 'seats', { positions: [{ x: 0.5, y: 0.9, angle: 0 }] }, 'seats-1');
  assert.equal(ddzState(host).seats.length, 1);
  assert.equal(ddzState(host).seats[0].y, 0.9);
  assert.equal(ddzState(host).seats[0].id, 0);

  const early = fakePeer();
  room.bindJoin(early, 1, '乙', 'j1');
  assert.equal(lastError(early), '该座位尚未放置');
  assert.equal(early.seatId, null);

  const first = fakePeer();
  room.bindJoin(first, 0, '甲', 'j0');
  assert.equal(first.seatId, 0);
  assert.equal(first.role, 'player');

  // The seated placement is frozen, but the host can still append the rest.
  room.command(host, 'seats', { positions: [{ x: 0.5, y: 0.9, angle: 0 }, { x: 0.1, y: 0.1, angle: 0 }] }, 'seats-2');
  assert.equal(lastError(host), undefined);
  assert.equal(ddzState(host).seats.length, 2);
  assert.equal(ddzState(host).seats[1].y, 0.1);
  assert.equal(ddzState(host).seats[1].name, null);
});

test('seats can be appended after a player joins, without disturbing that player', () => {
  const room = new Room('APPEND', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: [{ ...PLACED[0] }] }, 's1');

  const first = fakePeer();
  room.bindJoin(first, 0, '甲', 'j0');
  room.command(first, 'ready', { ready: true }, 'r0');
  const token = first.token;

  room.command(host, 'seats', { positions: [{ ...PLACED[0] }, { ...PLACED[1] }] }, 's2');
  assert.equal(lastError(host), undefined);
  assert.equal(room.positions.length, 2);

  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 's3');
  assert.equal(lastError(host), undefined);

  const seated = room.snapshotFor(host).seats;
  assert.deepEqual(
    seated.map((seat) => ({ x: seat.x, y: seat.y, angle: seat.angle })),
    PLACED.map((p) => ({ ...p })),
  );
  assert.equal(seated[0].name, '甲');
  assert.equal(seated[0].ready, true); // appending does not reset the seated player
  assert.equal(room.players[0]!.token, token);

  // The remaining phones take the appended seats and the game still starts.
  const second = fakePeer();
  const third = fakePeer();
  room.bindJoin(second, 1, '乙', 'j1');
  room.bindJoin(third, 2, '丙', 'j2');
  assert.equal(second.seatId, 1);
  assert.equal(third.seatId, 2);
  room.command(second, 'ready', { ready: true }, 'r1');
  room.command(third, 'ready', { ready: true }, 'r2');
  room.command(host, 'start', {}, 'start');
  assert.equal(ddzView(room).phase, 'bidding');
  assert.equal(room.players[0]!.name, '甲');
  assert.equal(ddzGame(room).hands[0]!.length, 17);
});

test('moving, truncating or clearing a seated placement is rejected without touching the room', () => {
  const room = new Room('FROZEN', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 's1');
  const player = fakePeer();
  room.bindJoin(player, 0, '甲', 'j0');

  const placements = () => room.snapshotFor(host).seats.map((seat) => ({ x: seat.x, y: seat.y, angle: seat.angle }));
  const before = placements();

  const attempts = [
    [{ x: 0.2, y: 0.2, angle: 0 }, { ...PLACED[1] }, { ...PLACED[2] }], // move a seated seat
    [{ ...PLACED[0] }, { ...PLACED[1] }], // truncate
    [{ ...PLACED[0] }], // truncate further
    [], // clear
    [PLACED[1], PLACED[0], PLACED[2]].map((p) => ({ ...p })), // reorder
  ];
  attempts.forEach((positions, index) => {
    room.command(host, 'seats', { positions }, `bad-${index}`);
    assert.ok(lastError(host), `attempt ${index} must be rejected`);
    assert.deepEqual(placements(), before);
    assert.equal(room.positions.length, 3);
  });

  // Re-sending the exact placement is a no-op rather than an error.
  const rejected = host.sent.filter((m) => m.type === 'error').length;
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'same');
  assert.equal(host.sent.filter((m) => m.type === 'error').length, rejected);
});

test('only the host places seats, and only while the lobby is open', () => {
  const fixture = setup();
  const { room, host, players } = fixture;

  room.command(players[0], 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'player-seats');
  assert.ok(lastError(players[0]));

  room.command(players[1], 'start', {}, 'player-start'); // a player is never the tablet host
  assert.ok(lastError(players[1]));

  startGame(room, host, players);
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'late-seats');
  assert.ok(lastError(host));
  assert.equal(room.positions.length, 3);
  assert.equal(ddzView(room).phase, 'bidding');
});

test('seats([]) clears every placed seat before anyone joins', () => {
  const room = new Room('RESET', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'c');
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 's1');
  assert.equal(ddzState(host).seats.length, 3);
  room.command(host, 'seats', { positions: [] }, 's2');
  assert.equal(ddzState(host).seats.length, 0);
  assert.equal(room.positions.length, 0);
});

test('landlord emptying their hand finishes the game with spring doubling and zero-sum scores', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  const last = pick(5, 'spade');
  ddzGame(room).hands[0]! = [last];
  ddzGame(room).hands[1]! = [pick(6, 'heart')];
  ddzGame(room).hands[2]! = [pick(7, 'club')];
  room.command(players[0], 'play', { cards: [last.id] }, 'finish');

  const table = ddzState(host);
  assert.equal(table.phase, 'finished');
  assert.equal(table.winner, 'landlord');
  assert.equal(table.multiplier, 2); // spring: farmers never played
  assert.deepEqual(table.scores, [4, -2, -2]);
  assert.equal(table.turn, null);
});

test('farmers winning on the landlord first lead triggers reverse spring', () => {
  const fixture = setup();
  const { room, players } = fixture;
  startGame(room, fixture.host, players);
  toPlaying(room, players);

  const lead = pick(3, 'spade');
  const reply = pick(5, 'heart');
  ddzGame(room).hands[0]! = [lead, pick(15, 'spade')];
  ddzGame(room).hands[1]! = [reply];
  ddzGame(room).hands[2]! = [pick(7, 'club')];
  room.command(players[0], 'play', { cards: [lead.id] }, 'lead');
  room.command(players[1], 'play', { cards: [reply.id] }, 'beat');

  const view = ddzState(players[1]);
  assert.equal(view.phase, 'finished');
  assert.equal(view.winner, 'farmers');
  assert.equal(view.multiplier, 2); // reverse spring: landlord played only the first lead
  assert.deepEqual(view.scores, [-4, 2, 2]);
});

test('again returns to the lobby, clears hidden info, keeps seats and scores', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);
  const last = pick(5, 'spade');
  ddzGame(room).hands[0]! = [last];
  ddzGame(room).hands[1]! = [pick(6, 'heart')];
  ddzGame(room).hands[2]! = [pick(7, 'club')];
  room.command(players[0], 'play', { cards: [last.id] }, 'finish');

  room.command(players[1], 'again', {}, 'again-player');
  assert.equal(lastError(players[1]), '只有房主可以重开');

  room.command(host, 'again', {}, 'again');
  const table = ddzState(host);
  assert.equal(table.phase, 'lobby');
  assert.equal(table.bottom.length, 0);
  assert.equal(table.landlord, null);
  assert.equal(table.trickStartIndex, 0);
  assert.deepEqual(table.tablePlays, []);
  assert.deepEqual(
    table.seats.map((s) => s.ready),
    [false, false, false],
  );
  assert.deepEqual(table.scores, [4, -2, -2]); // scores carry over
  assert.equal(table.seats[0].name, '玩家0');
});

test('malformed payloads produce Chinese errors instead of crashing', () => {
  const fixture = setup();
  const { room, players } = fixture;
  startGame(room, fixture.host, players);

  room.command(players[0], 'bid', { value: 9 }, 'bad-bid');
  assert.equal(lastError(players[0]), '叫分值无效');
  room.command(players[0], 'nonsense', {}, 'bad-type');
  assert.equal(lastError(players[0]), '未知的操作类型');

  toPlaying(room, players);
  room.command(players[0], 'play', {}, 'bad-play');
  assert.equal(lastError(players[0]), '出牌数据无效');
});

// ---------------------------------------------------------------- public play history

test('accepted plays accumulate across turns and survive a two-pass trick clear', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  const lead0 = pick(3, 'spade');
  const reply1 = pick(4, 'heart');
  const nextLead1 = pick(12, 'club');
  setHands(fixture, [
    [lead0, pick(13, 'spade')],
    [reply1, nextLead1],
    [pick(6, 'club'), pick(11, 'club')],
  ]);

  room.command(players[0], 'play', { cards: [lead0.id] }, 'hist-0');
  room.command(players[1], 'play', { cards: [reply1.id] }, 'hist-1');
  room.command(players[2], 'pass', {}, 'hist-pass-2');
  room.command(players[0], 'pass', {}, 'hist-pass-0'); // two passes: the trick returns to seat 1

  assert.equal(ddzView(room).turn, 1);
  assert.equal(room.snapshotFor(host).lastPlay, null); // active trick cleared
  const afterClear = ddzState(host).tablePlays;
  assert.deepEqual(
    afterClear.map((p) => [p.seatId, p.kind]),
    [
      [0, 'single'],
      [1, 'single'],
    ],
  );
  assert.deepEqual(
    afterClear[0].cards.map((c) => c.id),
    [lead0.id],
  );
  assert.equal(ddzState(host).trickStartIndex, afterClear.length);

  room.command(players[1], 'play', { cards: [nextLead1.id] }, 'hist-2'); // fresh lead after the clear
  const grown = ddzState(host).tablePlays;
  assert.deepEqual(
    grown.map((p) => p.seatId),
    [0, 1, 1],
  );
  assert.equal(ddzState(host).trickStartIndex, 2);
  assert.deepEqual(
    ddzState(host).tablePlays.slice(ddzState(host).trickStartIndex).map((p) => p.seatId),
    [1],
  );

  const ids = grown.map((p) => p.id);
  assert.equal(new Set(ids).size, grown.length); // room-unique ids
  const cardIds = grown.flatMap((p) => p.cards.map((c) => c.id));
  assert.equal(new Set(cardIds).size, cardIds.length); // no card appears twice in one round
  assert.ok(cardIds.length <= 54);
});

test('a winning play is recorded before the finish and held until again starts a new round', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  setHands(fixture, [[pick(5, 'spade')], [pick(6, 'heart')], [pick(7, 'club')]]);
  const winning = ddzGame(room).hands[0]![0];
  room.command(players[0], 'play', { cards: [winning.id] }, 'win-1');

  const finished = ddzState(host);
  assert.equal(finished.phase, 'finished');
  assert.equal(finished.tablePlays.length, 1);
  assert.equal(finished.tablePlays[0].cards[0].id, winning.id);
  const firstId = finished.tablePlays[0].id;

  room.command(host, 'again', {}, 'again-1');
  assert.deepEqual(ddzState(host).tablePlays, []);
  assert.deepEqual(ddzState(players[0]).tablePlays, []);
  assert.equal(ddzState(players[0]).trickStartIndex, 0);

  // A new round must never recycle an id from the previous one.
  startGame(room, host, players);
  toPlaying(room, players);
  setHands(fixture, [[pick(5, 'spade')], [pick(6, 'heart')], [pick(7, 'club')]]);
  room.command(players[0], 'play', { cards: [ddzGame(room).hands[0]![0].id] }, 'win-2');
  const second = ddzState(host).tablePlays;
  assert.equal(second.length, 1);
  assert.notEqual(second[0].id, firstId);
});

test('duplicate action ids and rejected plays never append to or rerandomise the history', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  const lead = pick(3, 'spade');
  setHands(fixture, [[lead, pick(13, 'spade')], [pick(4, 'heart')], [pick(5, 'club')]]);
  room.command(players[0], 'play', { cards: [lead.id] }, 'once');

  const record = ddzState(host).tablePlays[0];
  assert.equal(record.cards[0].id, lead.id);
  const frozen = JSON.stringify(record);

  room.command(players[0], 'play', { cards: [lead.id] }, 'once'); // idempotent replay
  assert.equal(ddzState(host).tablePlays.length, 1);
  assert.equal(JSON.stringify(ddzState(host).tablePlays[0]), frozen);

  room.command(players[1], 'play', { cards: [pick(9, 'diamond').id] }, 'invalid'); // not in hand
  assert.equal(lastError(players[1]), '你没有这些牌');
  assert.equal(ddzState(host).tablePlays.length, 1);
  assert.equal(JSON.stringify(ddzState(host).tablePlays[0]), frozen);
});

test('public history is complete for every bound peer and never carries another seat unplayed hand', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  const lead = pick(3, 'spade');
  const hands = [
    [lead, pick(13, 'spade')],
    [pick(4, 'heart'), pick(11, 'heart')],
    [pick(5, 'club'), pick(12, 'club')],
  ];
  setHands(fixture, hands);
  room.command(players[0], 'play', { cards: [lead.id] }, 'h1');

  const before = ddzState(host).tablePlays;
  assert.equal(before.length, 1);
  const resumed = fakePeer();
  room.bindResume(resumed, room.hostToken, 'resume-host');
  assert.equal(ddzState(resumed).role, 'table');
  assert.deepEqual(ddzState(resumed).tablePlays, before); // same ids and authoritative scatters

  for (const peer of players) {
    const view = ddzState(peer);
    // Phones must see the same public facts as the tablet screen: the counter and the mobile
    // board depend on them, and the history is public by construction.
    assert.deepEqual(view.tablePlays, before);
    assert.equal(view.bottom.length, 3);
    assert.deepEqual(
      view.hand.map((card) => card.id),
      hands[view.selfSeat ?? -1]
        .filter((card) => card.id !== lead.id)
        .map((card) => card.id),
    );
    assert.ok(view.trickStartIndex <= view.tablePlays.length);
    assertNoHiddenHands(room, peer);
  }
  assertNoHiddenHands(room, host); // the shared screen never receives a hand either
});

test('scatter stays inside the documented box and captured history is immutable on later appends', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  setHands(fixture, [
    [pick(3, 'spade'), pick(13, 'spade')],
    [pick(4, 'heart'), pick(12, 'heart')],
    [pick(5, 'club')],
  ]);
  room.command(players[0], 'play', { cards: [pick(3, 'spade').id] }, 'sc-0');

  const captured = ddzState(host).tablePlays; // a snapshot taken before the next play
  const first = captured[0];
  assert.ok(Math.abs(first.scatter.x) <= 0.045);
  assert.ok(Math.abs(first.scatter.y) <= 0.045);
  assert.ok(first.scatter.angle >= -8 && first.scatter.angle <= 8);
  const frozen = JSON.stringify(first);

  room.command(players[1], 'play', { cards: [pick(4, 'heart').id] }, 'sc-1');
  assert.equal(captured.length, 1); // the earlier snapshot did not grow
  assert.equal(JSON.stringify(captured[0]), frozen);
  assert.equal(ddzState(host).tablePlays.length, 2);
});

// ---------------------------------------------------------------- public preview

test('inspect summary is a public preview without hands, tokens or peer ids', () => {
  const room = new Room('SUMM', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: [{ ...PLACED[0] }] }, 's1');
  const player = fakePeer();
  room.bindJoin(player, 0, '甲', 'j0');

  const preview = room.summary();
  assert.equal(preview.code, 'SUMM');
  assert.equal(preview.game, 'doudizhu');
  assert.equal(preview.roomMode, 'tablet');
  assert.equal(preview.phase, 'lobby');
  assert.equal(preview.seats.length, 1);
  assert.equal(preview.seats[0].name, '甲');
  assert.equal(preview.seats[0].count, 0);
  assert.equal(preview.hostSeatId, null);
  assert.equal(preview.hostConnected, true);
  const serialized = JSON.stringify(preview);
  for (const secret of [room.hostToken, player.token ?? '']) {
    assert.equal(serialized.includes(secret), false, 'credential leaked in the public preview');
  }

  // A phone preview always exposes its three canonical seats: own bottom, left, right.
  const phone = new Room('PHON', 'phone', 'doudizhu');
  const creator = fakePeer();
  phone.bindCreator(creator, 'c', '主人');
  const phonePreview = phone.summary();
  assert.equal(phonePreview.roomMode, 'phone');
  assert.equal(phonePreview.hostSeatId, 0);
  assert.deepEqual(
    phonePreview.seats.map((seat) => seat.id),
    [0, 1, 2],
  );
  assert.deepEqual(
    phonePreview.seats.map((seat) => [seat.x, seat.y, seat.angle]),
    [
      [0.5, 0.88, 0],
      [0.1, 0.5, 90],
      [0.9, 0.5, -90],
    ],
  );
  assert.equal(JSON.stringify(phonePreview).includes(creator.token ?? ''), false);
});

// ---------------------------------------------------------------- host-approved replacement

test('a seat request waits for the host without granting a session, a hand or a name change', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  const targetHand = ddzGame(room).hands[2]!.map((card) => card.id);
  const targetToken = room.players[2]!.token;
  const targetName = room.players[2]!.name;

  const newcomer = fakePeer();
  room.requestSeat(newcomer, 2, '新丙', 'req-wait');
  const pending = lastSeatRequest(newcomer);
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.seatId, 2);
  assert.equal(pending?.requestId, 'req-wait');
  assert.equal(pending?.code, room.code);
  assert.ok(newcomer.sent.some((m) => m.type === 'ack' && m.id === 'req-wait'));
  assert.equal(newcomer.sent.some((m) => m.type === 'session'), false); // no identity before approval
  assert.equal(newcomer.role, 'table');
  assert.equal(newcomer.room, null);
  assert.equal(newcomer.requestRoom, room);
  assert.equal(room.snapshotFor(newcomer).hand.length, 0);

  // The target keeps everything until the host decides.
  assert.equal(room.players[2]!.token, targetToken);
  assert.equal(room.players[2]!.name, targetName);
  assert.deepEqual(
    ddzGame(room).hands[2]!.map((card) => card.id),
    targetHand,
  );
  assert.equal(room.players[2]!.peer, players[2]);
  assert.equal(players[2].superseded, 0);

  // The queue reaches the host only, carries no secrets, and warns about an online old device.
  const queue = ddzState(host).seatRequests;
  assert.deepEqual(queue, [{ id: 'req-wait', seatId: 2, name: '新丙', previousName: targetName, connected: true }]);
  assert.deepEqual(ddzState(players[1]).seatRequests, []);
  const queueJson = JSON.stringify(queue);
  assert.equal(queueJson.includes(targetToken), false);
  assert.equal(queueJson.includes(newcomer.id), false);
});

test('host approval replaces a player midgame, keeps every counter and revokes the old token and socket', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  const lead = pick(3, 'spade');
  setHands(fixture, [
    [lead, pick(13, 'spade')],
    [pick(4, 'heart'), pick(12, 'heart')],
    [pick(5, 'club'), pick(11, 'club')],
  ]);
  room.command(players[0], 'play', { cards: [lead.id] }, 'take-lead');
  room.command(players[1], 'pass', {}, 'take-pass'); // turn moves to seat 2

  const before = ddzState(players[2]);
  const handBefore = ddzGame(room).hands[2]!.map((card) => card.id);
  const openToken = players[2].token ?? '';

  const newcomer = fakePeer();
  room.requestSeat(newcomer, 2, '新来的人', 'req-ok');
  room.command(host, 'decideSeat', { requestId: 'req-ok', approve: true }, 'decide-ok');

  const swapped = ddzState(newcomer);
  const session = lastSession(newcomer);
  assert.equal(session?.seatId, 2);
  assert.equal(session?.role, 'player');
  assert.equal(session?.roomMode, 'tablet');
  assert.notEqual(session?.token, openToken);
  assert.equal(newcomer.token, session?.token);
  assert.equal(room.players[2]!.peer, newcomer);
  assert.equal(room.players[2]!.name, '新来的人');
  assert.equal(swapped.seats[2].name, '新来的人');
  assert.equal(swapped.isHost, false);
  assert.equal(ddzState(host).isHost, true);

  // Hand, turn, counters, history and scores survive the swap exactly.
  assert.deepEqual(
    swapped.hand.map((card) => card.id),
    handBefore,
  );
  assert.equal(swapped.turn, before.turn);
  assert.equal(swapped.turn, 2); // it is the replaced seat's turn: the swap advanced nothing
  assert.equal(swapped.phase, before.phase);
  assert.equal(swapped.bid, before.bid);
  assert.equal(swapped.trickStartIndex, before.trickStartIndex);
  assert.deepEqual(swapped.tablePlays, before.tablePlays);
  assert.deepEqual(swapped.scores, before.scores);
  assert.equal(swapped.seats[1].passed, true); // a neighbour's pending pass is untouched
  assert.equal(swapped.seats[2].passed, false);
  assert.equal(swapped.seats[2].count, handBefore.length);
  assert.equal(ddzView(room).bid, before.bid); // bidding state carries over with the seat

  // The old device is kicked and its credential is dead.
  assert.equal(players[2].superseded, 1);
  const stale = fakePeer();
  room.bindResume(stale, openToken, 'resume-old');
  assert.equal(lastErrorCode(stale), 'INVALID_CREDENTIAL');
  assert.equal(room.players[2]!.peer, newcomer);
  assert.equal(room.players[2]!.name, '新来的人');
  assert.deepEqual(ddzState(host).seatRequests, []);

  // The replacement acts for exactly that seat, in the preserved turn order.
  room.command(newcomer, 'pass', {}, 'new-pass');
  assert.equal(lastError(newcomer), undefined);
  assert.ok(newcomer.sent.some((m) => m.type === 'ack' && m.id === 'new-pass'));
  assert.equal(ddzView(room).turn, 0); // two passes: the trick returns to its leader
  assert.equal(room.snapshotFor(host).lastPlay, null);
  assert.equal(ddzState(host).tablePlays.length, 1); // a pass is never history
});

test('a superseded socket can neither mutate the room nor read the replacement hand', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  const oldPeer = players[1];
  const oldToken = oldPeer.token ?? '';
  const newcomer = fakePeer();
  room.requestSeat(newcomer, 1, '顶替者', 'req-race');
  room.command(host, 'decideSeat', { requestId: 'req-race', approve: true }, 'decide-race');

  const sentBefore = oldPeer.sent.length;
  assert.equal(oldPeer.seatId, 1); // the stale socket still remembers the seat and old token
  assert.equal(oldPeer.token, oldToken);

  room.command(oldPeer, 'play', { cards: [ddzGame(room).hands[1]![0].id] }, 'stale-play');
  assert.equal(lastErrorCode(oldPeer), 'INVALID_CREDENTIAL');
  assert.equal(oldPeer.sent.length, sentBefore + 1); // error only: no ack, no replay snapshot
  assert.equal(room.snapshotFor(oldPeer).hand.length, 0);
  assert.equal(ddzView(room).turn, 0);
  assert.equal(ddzView(room).phase, 'playing');

  // The new owner still holds the full private hand.
  assert.equal(ddzState(newcomer).hand.length, ddzGame(room).hands[1]!.length);
  assert.ok(ddzGame(room).hands[1]!.length > 0);
});

test('a rejected request leaves the seat untouched and a repeated decision never rotates the token twice', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  const openToken = players[1].token ?? '';
  const openHand = ddzGame(room).hands[1]!.map((card) => card.id);

  const rejected = fakePeer();
  room.requestSeat(rejected, 1, '被拒的人', 'req-reject');
  room.command(host, 'decideSeat', { requestId: 'req-reject', approve: false }, 'decide-reject');
  assert.equal(lastSeatRequest(rejected)?.status, 'rejected');
  assert.equal(lastSession(rejected), null);
  assert.equal(rejected.requestRoom, null);
  assert.equal(room.players[1]!.token, openToken);
  assert.equal(room.players[1]!.name, '玩家1');
  assert.deepEqual(
    ddzGame(room).hands[1]!.map((card) => card.id),
    openHand,
  );
  assert.equal(players[1].superseded, 0);
  assert.deepEqual(ddzState(host).seatRequests, []);

  // The rejected device keeps working with its own credential.
  const stillMine = fakePeer();
  room.bindResume(stillMine, openToken, 'resume-1');
  assert.equal(lastSession(stillMine)?.seatId, 1);

  // Approval is idempotent: the second identical decision changes nothing.
  const newcomer = fakePeer();
  room.requestSeat(newcomer, 1, '新主人', 'req-approve');
  room.command(host, 'decideSeat', { requestId: 'req-approve', approve: true }, 'decide-a1');
  const issued = lastSession(newcomer)?.token ?? '';
  room.command(host, 'decideSeat', { requestId: 'req-approve', approve: true }, 'decide-a2');
  assert.ok(host.sent.some((m) => m.type === 'ack' && m.id === 'decide-a2'));
  assert.equal(room.players[1]!.token, issued);
  assert.equal(newcomer.token, issued);
  assert.equal(newcomer.superseded, 0);
  assert.equal(newcomer.sent.filter((m) => m.type === 'session').length, 1);

  const again = fakePeer();
  room.bindResume(again, issued, 'resume-new');
  assert.equal(lastSession(again)?.seatId, 1);
  assert.equal(room.players[1]!.name, '新主人');
});

test('a closed requester is cancelled and a stale request cannot take over a newer occupant', () => {
  const fixture = setup();
  const { room, host, players } = fixture;
  startGame(room, host, players);

  const early = fakePeer();
  room.requestSeat(early, 1, '太早的人', 'req-early');
  assert.equal(early.requestRoom, room);
  room.cancelSeatRequest(early);
  assert.equal(early.requestRoom, null);
  assert.deepEqual(ddzState(host).seatRequests, []);
  // A cancelled request is terminal: a late approval cannot grant the seat to anybody.
  room.command(host, 'decideSeat', { requestId: 'req-early', approve: true }, 'decide-early');
  assert.equal(room.players[1]!.name, '玩家1');
  assert.equal(room.players[1]!.peer, players[1]);
  assert.equal(players[1].superseded, 0);
  assert.equal(early.sent.some((m) => m.type === 'session'), false);

  // A pending request must not hijack a seat whose owner changed meanwhile.
  const stale = fakePeer();
  const newcomer = fakePeer();
  room.requestSeat(stale, 1, '旧申请', 'req-stale');
  room.requestSeat(newcomer, 1, '新占位', 'req-new');
  room.command(host, 'decideSeat', { requestId: 'req-new', approve: true }, 'decide-new');
  const occupiedToken = room.players[1]!.token;
  room.command(host, 'decideSeat', { requestId: 'req-stale', approve: true }, 'decide-stale');

  assert.equal(room.players[1]!.token, occupiedToken); // no second rotation
  assert.equal(room.players[1]!.peer, newcomer);
  assert.equal(room.players[1]!.name, '新占位');
  assert.equal(lastSeatRequest(stale)?.status, 'cancelled');
  assert.equal(stale.requestRoom, null);
  assert.equal(stale.sent.some((m) => m.type === 'session'), false);
  assert.deepEqual(ddzState(host).seatRequests, []);
});

test('only the host may decide replacement requests or read the queue', () => {
  const fixture = setup();
  const { room, host, players } = fixture;

  const outsider = fakePeer();
  room.command(outsider, 'decideSeat', { requestId: 'anything', approve: true }, 'decide-outsider');
  assert.equal(lastErrorCode(outsider), 'INVALID_CREDENTIAL');

  const player = fakePeer();
  room.requestSeat(player, 1, '申请人', 'req-denied');
  const originalToken = room.players[1]!.token;
  room.command(players[0], 'decideSeat', { requestId: 'req-denied', approve: true }, 'decide-player');
  assert.ok(lastError(players[0]));
  assert.equal(room.players[1]!.token, originalToken);
  assert.equal(room.players[1]!.peer, players[1]);
  assert.deepEqual(ddzState(players[0]).seatRequests, []); // a player never sees the queue
  assert.equal(ddzState(host).seatRequests.length, 1);
  assert.equal(lastSeatRequest(player)?.status, 'pending');

  // A bound player cannot file a replacement request, and request ids are not shareable.
  room.requestSeat(players[0], 2, 'x', 'req-bound');
  assert.ok(lastError(players[0]));
  const other = fakePeer();
  room.requestSeat(other, 1, '丙', 'req-denied');
  assert.ok(lastError(other));
  assert.equal(lastSeatRequest(other)?.status, undefined);
});

test('replacement requests need an existing occupant, a real seat and an own request id', () => {
  const room = new Room('REQ2', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: [{ ...PLACED[0] }] }, 's1');

  const early = fakePeer();
  room.requestSeat(early, 1, 'x', 'req-empty'); // seat 1 is not placed
  assert.ok(lastError(early));
  room.requestSeat(early, 7, 'x', 'req-bad'); // no such seat
  assert.ok(lastError(early));
  room.requestSeat(early, 0, 'x', ''); // no request id to correlate with
  assert.ok(lastError(early));
  assert.equal(early.requestRoom, null);

  const first = fakePeer();
  room.bindJoin(first, 0, '甲', 'j0');
  const waiting = fakePeer();
  room.requestSeat(waiting, 0, '乙', 'req-1');
  assert.equal(ddzState(host).seatRequests.length, 1);
  // Repeating the same request id from the same socket replays the pending status.
  room.requestSeat(waiting, 0, '乙', 'req-1');
  assert.equal(ddzState(host).seatRequests.length, 1);
  assert.equal(lastSeatRequest(waiting)?.status, 'pending');
});

test('a waiter that takes another seat stops waiting for the old one', () => {
  const room = new Room('WAIT', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 's1');
  const owner = fakePeer();
  room.bindJoin(owner, 0, '甲', 'j0');

  const waiter = fakePeer();
  room.requestSeat(waiter, 0, '乙', 'req-wait');
  assert.equal(ddzState(host).seatRequests.length, 1);

  // The same socket then takes the free seat 2 instead: one socket, one identity.
  room.bindJoin(waiter, 2, '乙', 'j2');
  assert.equal(waiter.seatId, 2);
  assert.equal(waiter.requestRoom, null);
  assert.deepEqual(ddzState(host).seatRequests, []);

  room.command(host, 'decideSeat', { requestId: 'req-wait', approve: true }, 'decide-late');
  assert.equal(ddzState(host).seats[0].name, '甲'); // seat 0 was never granted to the waiter
  assert.equal(room.players[0]!.peer, owner);
  assert.equal(owner.superseded, 0);
  assert.equal(room.players[2]!.peer, waiter);
  assert.equal(ddzState(host).seats[2].name, '乙');
});

test('a pending replacement request cannot survive the requester binding another room', () => {
  const roomA = new Room('AAAA', 'tablet', 'doudizhu');
  const hostA = fakePeer();
  roomA.bindHost(hostA, 'create-a');
  roomA.command(hostA, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-a');
  const occupant = fakePeer();
  roomA.bindJoin(occupant, 1, '原座位', 'join-a1');
  const occupantToken = roomA.players[1]!.token;

  const requester = fakePeer();
  roomA.requestSeat(requester, 1, '申请人', 'req-a');
  assert.equal(ddzState(hostA).seatRequests.length, 1);
  assert.equal(requester.requestRoom, roomA);

  // The same socket legitimately creates a tablet room of its own.
  const roomB = new Room('BBBB', 'tablet', 'doudizhu');
  roomB.bindHost(requester, 'create-b');
  assert.equal(requester.requestRoom, null);
  assert.deepEqual(ddzState(hostA).seatRequests, []); // room A dropped the pending entry
  assert.equal(requester.room, roomB);
  assert.equal(requester.token, roomB.hostToken);
  assert.equal(ddzState(requester).isHost, true);
  assert.equal(
    requester.sent.filter((m) => m.type === 'session' && m.code === 'AAAA').length,
    0,
  );

  const settled = requester.sent.length;
  // A late approval on the cancelled request changes neither room.
  roomA.command(hostA, 'decideSeat', { requestId: 'req-a', approve: true }, 'decide-a');
  assert.equal(requester.sent.length, settled); // no cross-room session or state was pushed
  assert.equal(requester.room, roomB);
  assert.equal(requester.role, 'table');
  assert.equal(requester.seatId, null);
  assert.equal(ddzState(requester).code, 'BBBB');
  assert.equal(roomA.players[1]!.peer, occupant);
  assert.equal(roomA.players[1]!.token, occupantToken);
  assert.equal(roomA.players[1]!.name, '原座位');
  assert.equal(roomA.players[1]!.connected, true);
  assert.equal(occupant.superseded, 0);
  assert.equal(ddzState(hostA).seats[1].connected, true);
  assert.equal(lastError(hostA), undefined);
});

test('phone creation cancels a pending request left in another room too', () => {
  const roomA = new Room('AAAA2', 'tablet', 'doudizhu');
  const hostA = fakePeer();
  roomA.bindHost(hostA, 'create-a');
  roomA.command(hostA, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-a');
  const occupant = fakePeer();
  roomA.bindJoin(occupant, 0, '甲', 'join-a0');

  const requester = fakePeer();
  roomA.requestSeat(requester, 0, '乙', 'req-a');
  assert.equal(requester.requestRoom, roomA);

  const roomB = new Room('BBBB2', 'phone', 'doudizhu');
  roomB.bindCreator(requester, 'create-b', '乙');
  assert.equal(requester.requestRoom, null);
  assert.deepEqual(ddzState(hostA).seatRequests, []);
  assert.equal(requester.room, roomB);
  assert.equal(requester.role, 'player');
  assert.equal(roomB.players[0]!.peer, requester);
  const session = lastSession(requester);
  assert.equal(session?.code, 'BBBB2');
  assert.equal(session?.roomMode, 'phone');
  assert.equal(ddzState(requester).isHost, true);

  roomA.command(hostA, 'decideSeat', { requestId: 'req-a', approve: true }, 'decide-a');
  assert.equal(roomA.players[0]!.peer, occupant);
  assert.equal(roomA.players[0]!.name, '甲');
  assert.equal(occupant.superseded, 0);
  assert.equal(roomB.players[0]!.peer, requester); // room B keeps its creator and its seat
  assert.equal(ddzState(requester).code, 'BBBB2');
  assert.equal(ddzState(requester).seatRequests.length, 0);
});

test('joining or resuming another room cancels the request left behind', () => {
  const roomA = new Room('AAAA3', 'tablet', 'doudizhu');
  const hostA = fakePeer();
  roomA.bindHost(hostA, 'create-a');
  roomA.command(hostA, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-a');
  const occupantA = fakePeer();
  roomA.bindJoin(occupantA, 0, '甲', 'join-a0');

  const roomB = new Room('BBBB3', 'tablet', 'doudizhu');
  const hostB = fakePeer();
  roomB.bindHost(hostB, 'create-b');
  roomB.command(hostB, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-b');
  const sittingB = fakePeer();
  roomB.bindJoin(sittingB, 0, '丙', 'join-b0');
  const sittingToken = roomB.players[0]!.token;

  const joiner = fakePeer();
  roomA.requestSeat(joiner, 0, '乙', 'req-join');
  roomB.bindJoin(joiner, 1, '乙', 'join-b1');
  assert.equal(joiner.requestRoom, null);
  assert.equal(roomB.players[1]!.peer, joiner);
  assert.deepEqual(ddzState(hostA).seatRequests, []);

  const resumer = fakePeer();
  roomA.requestSeat(resumer, 0, '丁', 'req-resume');
  assert.equal(ddzState(hostA).seatRequests.length, 1);
  roomB.bindResume(resumer, sittingToken, 'resume-b0');
  assert.equal(resumer.requestRoom, null);
  assert.equal(roomB.players[0]!.peer, resumer);
  assert.equal(sittingB.superseded, 1); // a resume still supersedes the previous socket
  assert.deepEqual(ddzState(hostA).seatRequests, []);

  roomA.command(hostA, 'decideSeat', { requestId: 'req-join', approve: true }, 'decide-join');
  roomA.command(hostA, 'decideSeat', { requestId: 'req-resume', approve: true }, 'decide-resume');
  assert.equal(roomA.players[0]!.peer, occupantA);
  assert.equal(roomA.players[0]!.name, '甲');
  assert.equal(occupantA.superseded, 0);
  assert.equal(roomB.players[0]!.peer, resumer);
  assert.equal(roomB.players[1]!.peer, joiner);
  assert.equal(ddzState(joiner).code, 'BBBB3');
  assert.equal(ddzState(resumer).code, 'BBBB3');
});

test('a socket that already holds a seat cannot take a second one in the same room', () => {
  const room = new Room('ONEPEER', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 's1');
  const owner = fakePeer();
  room.bindJoin(owner, 0, '甲', 'j0');
  const seat = room.players[0]!;
  const token = seat.token;
  const settled = owner.sent.length;

  room.bindJoin(owner, 1, '甲二', 'j1'); // same socket, another seat
  assert.ok(lastError(owner));
  assert.equal(owner.sent.length, settled + 1); // the refusal only: no session, no state
  assert.equal(owner.seatId, 0);
  assert.equal(owner.room, room);
  assert.equal(room.players[1], null); // no second slot was created
  assert.equal(room.players[0], seat);
  assert.equal(seat.peer, owner);
  assert.equal(seat.connected, true);
  assert.equal(seat.name, '甲');
  assert.equal(seat.token, token);
  assert.equal(owner.sent.filter((m) => m.type === 'session').length, 1);

  // The socket still acts as its only seat, and detach releases exactly that seat.
  room.command(owner, 'ready', { ready: true }, 'r0');
  assert.equal(errorCount(owner), 1);
  assert.equal(seat.ready, true);
  assert.equal(room.players.filter((p) => p !== null).length, 1);
  room.detach(owner);
  assert.equal(seat.peer, null);
  assert.equal(seat.connected, false);
});

test('a bound socket cannot resume another seat, another room or the host identity', () => {
  const room = new Room('SWITCH', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 's1');
  const first = fakePeer();
  room.bindJoin(first, 0, '甲', 'j0');
  const second = fakePeer();
  room.bindJoin(second, 1, '乙', 'j1');
  const firstToken = room.players[0]!.token;
  const secondToken = room.players[1]!.token;

  room.bindResume(first, secondToken, 'to-other-seat');
  assert.ok(lastError(first));
  assert.equal(room.players[1]!.peer, second);
  assert.equal(room.players[1]!.token, secondToken);
  assert.equal(room.players[0]!.peer, first);
  assert.equal(first.seatId, 0);

  room.bindResume(first, room.hostToken, 'to-host');
  assert.ok(lastError(first));
  assert.equal(room.hostPeer, host);
  assert.equal(first.role, 'player');
  assert.equal(host.superseded, 0);

  room.bindResume(host, secondToken, 'host-to-seat');
  assert.ok(lastError(host));
  assert.equal(room.players[1]!.peer, second);
  assert.equal(host.seatId, null);
  assert.equal(host.role, 'table');

  // A socket bound elsewhere cannot move into this room either.
  const elsewhere = new Room('ELSE', 'tablet', 'doudizhu');
  const elsewhereHost = fakePeer();
  elsewhere.bindHost(elsewhereHost, 'create-else');
  elsewhere.command(elsewhereHost, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 's-else');
  room.bindResume(elsewhereHost, firstToken, 'cross-room');
  assert.ok(lastError(elsewhereHost));
  assert.equal(elsewhere.hostPeer, elsewhereHost);
  assert.equal(elsewhereHost.room, elsewhere);
  assert.equal(room.players[0]!.peer, first);

  // Its own credential re-resumes on the same socket without kicking itself.
  const refusals = errorCount(first);
  room.bindResume(first, firstToken, 'self');
  assert.equal(errorCount(first), refusals);
  assert.equal(first.superseded, 0);
  assert.equal(room.players[0]!.peer, first);
  assert.equal(room.players[0]!.connected, true);
  assert.equal(first.role, 'player');
  assert.equal(first.seatId, 0);
  room.command(first, 'ready', { ready: true }, 'r-after');
  assert.equal(errorCount(first), refusals);
  assert.equal(room.players[0]!.ready, true);
  room.detach(first);
  assert.equal(room.players[0]!.peer, null);
  assert.equal(room.players[0]!.connected, false);

  // The host socket re-resuming its own token stays the host, without kicking itself either.
  const hostRefusals = errorCount(host);
  room.bindResume(host, room.hostToken, 'host-self');
  assert.equal(errorCount(host), hostRefusals);
  assert.equal(host.superseded, 0);
  assert.equal(room.hostPeer, host);
  assert.equal(host.role, 'table');
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'host-still-works');
  assert.equal(errorCount(host), hostRefusals);
  assert.equal(room.positions.length, 3);
});

test('a new valid request supplants the intent the same socket left in another room', () => {
  const roomA = new Room('AAAA4', 'tablet', 'doudizhu');
  const hostA = fakePeer();
  roomA.bindHost(hostA, 'create-a');
  roomA.command(hostA, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-a');
  const occupantA = fakePeer();
  roomA.bindJoin(occupantA, 1, '甲', 'join-a1');
  const occupantAToken = roomA.players[1]!.token;

  const roomB = new Room('BBBB4', 'tablet', 'doudizhu');
  const hostB = fakePeer();
  roomB.bindHost(hostB, 'create-b');
  roomB.command(hostB, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-b');
  const occupantB = fakePeer();
  roomB.bindJoin(occupantB, 0, '乙', 'join-b0');
  const occupantBToken = roomB.players[0]!.token;

  // The socket asks A, then changes its mind and asks B: only the newer intent may survive.
  const requester = fakePeer();
  roomA.requestSeat(requester, 1, '丙', 'req-a');
  assert.equal(requester.requestRoom, roomA);
  roomB.requestSeat(requester, 0, '丙', 'req-b');
  assert.deepEqual(ddzState(hostA).seatRequests, []); // A dropped the superseded intent at once
  assert.equal(ddzState(hostB).seatRequests.length, 1);
  assert.equal(requester.requestRoom, roomB);
  assert.equal(lastSeatRequest(requester)?.status, 'pending');

  // A's late approval is refused, not replayed: no seat, name, token or session moves anywhere.
  const beforeStale = requester.sent.length;
  roomA.command(hostA, 'decideSeat', { requestId: 'req-a', approve: true }, 'decide-a');
  assert.equal(requester.sent.length, beforeStale);
  assert.equal(roomA.players[1]!.peer, occupantA);
  assert.equal(roomA.players[1]!.name, '甲');
  assert.equal(roomA.players[1]!.token, occupantAToken);
  assert.equal(occupantA.superseded, 0);
  assert.equal(requester.room, null);

  // Replaying A's cancelled request id revives nothing and leaves B's pointer alone.
  roomA.requestSeat(requester, 1, '丙', 'req-a');
  assert.equal(requester.requestRoom, roomB);
  assert.deepEqual(ddzState(hostA).seatRequests, []);
  assert.equal(lastSeatRequest(requester)?.status, 'cancelled');

  // B's own approval still binds the socket to B's seat, and A stays untouched.
  roomB.command(hostB, 'decideSeat', { requestId: 'req-b', approve: true }, 'decide-b');
  assert.equal(roomB.players[0]!.peer, requester);
  assert.equal(roomB.players[0]!.name, '丙');
  assert.notEqual(roomB.players[0]!.token, occupantBToken);
  assert.equal(requester.room, roomB);
  assert.equal(requester.seatId, 0);
  assert.equal(requester.requestRoom, null);
  assert.equal(occupantB.superseded, 1);
  assert.equal(occupantA.superseded, 0);
  assert.equal(roomA.players[1]!.peer, occupantA);
  assert.equal(roomA.players[1]!.token, occupantAToken);
  assert.deepEqual(ddzState(hostA).seatRequests, []);
  assert.deepEqual(ddzState(hostB).seatRequests, []);
});

test('an invalid request elsewhere keeps a pending intent, and a closed socket clears it', () => {
  const roomA = new Room('KEEP4', 'tablet', 'doudizhu');
  const hostA = fakePeer();
  roomA.bindHost(hostA, 'create-keep');
  roomA.command(hostA, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-keep');
  const occupant = fakePeer();
  roomA.bindJoin(occupant, 1, '甲', 'join-keep');

  const roomB = new Room('BADB4', 'tablet', 'doudizhu');
  const hostB = fakePeer();
  roomB.bindHost(hostB, 'create-bad');
  roomB.command(hostB, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-bad');
  const occupantB = fakePeer();
  roomB.bindJoin(occupantB, 0, '乙', 'join-bad');

  const waiter = fakePeer();
  roomA.requestSeat(waiter, 1, '丙', 'keep-a');
  assert.equal(waiter.requestRoom, roomA);

  // A refused request must not destroy the intent A's host can still approve.
  roomB.requestSeat(waiter, 9, '丙', 'bad-range');
  assert.ok(lastError(waiter));
  roomB.requestSeat(waiter, 1, '丙', 'bad-empty'); // placed but nobody sits there
  assert.ok(lastError(waiter));
  assert.equal(waiter.requestRoom, roomA);
  assert.equal(ddzState(hostA).seatRequests.length, 1);

  // A valid request in B supplants it; closing the socket then empties both queues.
  roomB.requestSeat(waiter, 0, '丙', 'good-b');
  assert.equal(waiter.requestRoom, roomB);
  assert.deepEqual(ddzState(hostA).seatRequests, []);
  roomB.cancelSeatRequest(waiter);
  assert.equal(waiter.requestRoom, null);
  assert.deepEqual(ddzState(hostA).seatRequests, []);
  assert.deepEqual(ddzState(hostB).seatRequests, []);

  // Neither host can hand a seat to the closed socket afterwards.
  roomB.command(hostB, 'decideSeat', { requestId: 'good-b', approve: true }, 'decide-good-b');
  roomA.command(hostA, 'decideSeat', { requestId: 'keep-a', approve: true }, 'decide-keep-a');
  assert.equal(roomA.players[1]!.peer, occupant);
  assert.equal(roomA.players[1]!.name, '甲');
  assert.equal(roomB.players[0]!.peer, occupantB);
  assert.equal(roomB.players[0]!.token, occupantB.token);
  assert.equal(waiter.room, null);
  assert.equal(waiter.sent.some((m) => m.type === 'session'), false);
});

test('a newer request id supersedes the older pending one in the same room', () => {
  const room = new Room('SAME', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create-same');
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-same');
  const seat0 = fakePeer();
  const seat1 = fakePeer();
  room.bindJoin(seat0, 0, '甲', 'join-s0');
  room.bindJoin(seat1, 1, '乙', 'join-s1');
  const token1 = room.players[1]!.token;

  const requester = fakePeer();
  room.requestSeat(requester, 1, '丙', 'req-old');
  assert.equal(requester.requestRoom, room);
  // A refused request must not throw away the intent the host can still see.
  room.requestSeat(requester, 9, '丙', 'req-bad');
  assert.ok(lastError(requester));
  assert.deepEqual(ddzState(host).seatRequests.map((r) => r.id), ['req-old']);

  // The same socket asks for another seat: one connection holds one queue slot in this room.
  room.requestSeat(requester, 0, '丙', 'req-new');
  assert.deepEqual(ddzState(host).seatRequests.map((r) => r.id), ['req-new']);
  assert.equal(requester.requestRoom, room);

  // Replaying the superseded id neither revives it nor drops the pointer to the live request.
  room.requestSeat(requester, 1, '丙', 'req-old');
  assert.equal(lastSeatRequest(requester)?.status, 'cancelled');
  assert.equal(requester.requestRoom, room);
  assert.deepEqual(ddzState(host).seatRequests.map((r) => r.id), ['req-new']);

  // A late approval of the superseded id changes no seat, identity or token.
  const stale = requester.sent.length;
  room.command(host, 'decideSeat', { requestId: 'req-old', approve: true }, 'decide-old');
  assert.equal(requester.sent.length, stale);
  assert.equal(room.players[1]!.peer, seat1);
  assert.equal(room.players[1]!.token, token1);
  assert.equal(seat1.superseded, 0);
  assert.equal(requester.room, null);

  // The live request binds exactly one seat; the other slot is never handed over.
  room.command(host, 'decideSeat', { requestId: 'req-new', approve: true }, 'decide-new');
  assert.equal(room.players[0]!.peer, requester);
  assert.equal(requester.seatId, 0);
  assert.equal(seat0.superseded, 1);
  assert.equal(requester.requestRoom, null);
  assert.equal(room.players[1]!.peer, seat1);
  assert.equal(room.players[1]!.token, token1);
  assert.equal(seat1.superseded, 0);
  assert.deepEqual(ddzState(host).seatRequests, []);

  // A repeated decision on the approved id still grants nothing a second time.
  room.command(host, 'decideSeat', { requestId: 'req-new', approve: true }, 'decide-new-again');
  assert.equal(seat0.superseded, 1);
  assert.equal(requester.seatId, 0);
  assert.equal(room.players[0]!.peer, requester);
  assert.equal(requester.sent.filter((m) => m.type === 'session').length, 1); // one session only
});

test('closing a socket still cancels the live same-room request after a replay', () => {
  const room = new Room('SAME2', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create-same2');
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-same2');
  const seat0 = fakePeer();
  const seat1 = fakePeer();
  room.bindJoin(seat0, 0, '甲', 'join-t0');
  room.bindJoin(seat1, 1, '乙', 'join-t1');

  const requester = fakePeer();
  room.requestSeat(requester, 1, '丙', 'old');
  room.requestSeat(requester, 0, '丙', 'live');
  room.requestSeat(requester, 1, '丙', 'old'); // replay of the superseded id
  assert.equal(requester.requestRoom, room);
  requester.requestRoom?.cancelSeatRequest(requester); // exactly what the socket layer does on close
  assert.equal(requester.requestRoom, null);
  assert.deepEqual(ddzState(host).seatRequests, []);

  // Neither id can reach the closed socket afterwards.
  const before = requester.sent.length;
  room.command(host, 'decideSeat', { requestId: 'live', approve: true }, 'decide-live');
  room.command(host, 'decideSeat', { requestId: 'old', approve: true }, 'decide-old');
  assert.equal(requester.sent.length, before);
  assert.equal(room.players[0]!.peer, seat0);
  assert.equal(room.players[1]!.peer, seat1);
  assert.equal(seat0.superseded, 0);
  assert.equal(seat1.superseded, 0);
  assert.equal(requester.room, null);
});

test('a new id for the same seat replaces the earlier request for it', () => {
  const room = new Room('SAME3', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create-same3');
  room.command(host, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-same3');
  const seat0 = fakePeer();
  const seat1 = fakePeer();
  room.bindJoin(seat0, 0, '甲', 'join-u0');
  room.bindJoin(seat1, 1, '乙', 'join-u1');
  const token1 = room.players[1]!.token;

  const requester = fakePeer();
  room.requestSeat(requester, 1, '丙', 'first');
  room.requestSeat(requester, 1, '丁', 'second');
  assert.deepEqual(ddzState(host).seatRequests.map((r) => r.id), ['second']);

  room.command(host, 'decideSeat', { requestId: 'first', approve: true }, 'decide-first');
  assert.equal(room.players[1]!.peer, seat1);
  assert.equal(room.players[1]!.token, token1);
  assert.equal(seat1.superseded, 0);

  room.command(host, 'decideSeat', { requestId: 'second', approve: true }, 'decide-second');
  assert.equal(room.players[1]!.peer, requester);
  assert.equal(room.players[1]!.name, '丁');
  assert.notEqual(room.players[1]!.token, token1);
  assert.equal(seat1.superseded, 1);
  assert.equal(requester.seatId, 1);
  assert.equal(requester.requestRoom, null);
  assert.deepEqual(ddzState(host).seatRequests, []);
});

test('rename changes only the authenticated player own name', () => {
  const fixture = setup();
  const { room, host, players } = fixture;

  room.command(players[1], 'rename', { name: '  阿乙  ' }, 'rename-1');
  assert.equal(ddzState(host).seats[1].name, '阿乙');
  assert.equal(ddzState(players[2]).seats[1].name, '阿乙');
  assert.equal(ddzState(host).seats[0].name, '玩家0');
  assert.equal(room.players[1]!.token, players[1].token);
  assert.equal(ddzGame(room).hands[1]!.length, 0);

  room.command(players[1], 'rename', { name: '' }, 'rename-empty');
  assert.ok(lastError(players[1]));
  assert.equal(ddzState(host).seats[1].name, '阿乙');

  room.command(host, 'rename', { name: '桌面' }, 'rename-host'); // the screen owns no nickname
  assert.ok(lastError(host));
});

// ---------------------------------------------------------------- phone rooms

test('phone creation gives the creator seat 0, a private hand and host rights', () => {
  const room = new Room('PH1', 'phone', 'doudizhu');
  const creator = fakePeer();
  room.bindCreator(creator, 'create-1', '  房主甲  ');

  assert.equal(creator.role, 'player');
  assert.equal(creator.seatId, 0);
  const session = lastSession(creator);
  assert.equal(session?.role, 'player');
  assert.equal(session?.seatId, 0);
  assert.equal(session?.roomMode, 'phone');
  assert.equal(session?.game, 'doudizhu');
  assert.equal(room.hostSeatId, 0);
  assert.equal(room.hostConnected, true);

  const lobby = ddzState(creator);
  assert.equal(lobby.isHost, true);
  assert.equal(lobby.hostSeatId, 0);
  assert.equal(lobby.hand.length, 0); // no cards before the deal
  assert.deepEqual(
    lobby.seats.map((seat) => seat.id),
    [0, 1, 2],
  );

  const second = fakePeer();
  const third = fakePeer();
  room.bindJoin(second, 1, '乙', 'join-1');
  room.bindJoin(third, 2, '丙', 'join-2');
  assert.equal(ddzState(second).isHost, false);
  const blocked = fakePeer();
  room.bindJoin(blocked, 0, '抢座', 'join-0');
  assert.equal(lastErrorCode(blocked), 'SEAT_OCCUPIED');

  startGame(room, creator, [creator, second, third]);
  assert.equal(ddzView(room).phase, 'bidding');
  const view = ddzState(creator);
  assert.equal(view.role, 'player'); // the phone host stays an ordinary player
  assert.equal(view.hand.length, 17);
  assert.equal(view.isHost, true);
  assert.equal(view.seats[0].count, 17);
  assertNoHiddenHands(room, creator);

  // Fixed phone seating: even the host cannot rewrite it.
  room.command(creator, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 'seats-phone');
  assert.ok(lastError(creator));
  assert.equal(room.positions.length, 3);
});

test('a phone room plays on with public history, private hands and a mobile trick index', () => {
  const fixture = setupPhone();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  assert.equal(ddzView(room).landlord, 0);
  for (const peer of players) {
    const view = ddzState(peer);
    assert.equal(view.roomMode, 'phone');
    assert.equal(view.bottom.length, 3);
    assert.equal(view.hand.length, view.selfSeat === 0 ? 20 : 17);
    assert.equal(view.trickStartIndex, 0);
    assert.equal(view.isHost, peer.seatId === 0);
    assertNoHiddenHands(room, peer);
  }

  const leadCard = ddzGame(room).hands[0]![0];
  room.command(players[0], 'play', { cards: [leadCard.id] }, 'phone-play-0');
  for (const peer of players) {
    const view = ddzState(peer);
    assert.equal(view.tablePlays.length, 1);
    assert.equal(view.tablePlays[0].cards[0].id, leadCard.id);
    assert.equal(view.trickStartIndex, 0);
    assert.equal(view.tablePlays.slice(view.trickStartIndex).length, 1);
    assertNoHiddenHands(room, peer);
  }

  room.command(players[1], 'pass', {}, 'phone-pass-1');
  room.command(players[2], 'pass', {}, 'phone-pass-2');
  for (const peer of players) {
    const view = ddzState(peer);
    assert.equal(view.trickStartIndex, view.tablePlays.length); // the phone board clears this trick
    assert.deepEqual(view.tablePlays.slice(view.trickStartIndex), []);
    assert.equal(view.lastPlay, null);
    assert.equal(view.seats[1].passed, false);
    assert.equal(view.seats[2].passed, false);
  }
  assert.equal(ddzView(room).turn, 0);

  const nextLead = ddzGame(room).hands[0]![0];
  room.command(players[0], 'play', { cards: [nextLead.id] }, 'phone-play-1');
  for (const peer of players) {
    const view = ddzState(peer);
    assert.equal(view.tablePlays.length, 2); // the finished trick is kept as public history
    assert.equal(view.trickStartIndex, 1);
    assert.equal(view.tablePlays.slice(view.trickStartIndex).length, 1);
  }
});

test('phone host rights fail over to a connected player and never return to the old host', () => {
  const fixture = setupPhone();
  const { room, host, players } = fixture;
  startGame(room, host, players);
  toPlaying(room, players);

  room.detach(host);
  assert.equal(room.hostSeatId, 1);
  assert.equal(room.hostConnected, true);
  assert.equal(ddzState(players[1]).isHost, true);
  assert.equal(ddzState(players[2]).isHost, false);
  assert.equal(ddzState(players[1]).hostSeatId, 1);

  // The new host keeps managing the table: an approval goes through without any extra host seat.
  const newcomer = fakePeer();
  room.requestSeat(newcomer, 2, '顶替丙', 'req-h');
  room.command(players[1], 'decideSeat', { requestId: 'req-h', approve: true }, 'decide-h');
  assert.equal(room.players[2]!.name, '顶替丙');
  assert.equal(ddzState(newcomer).isHost, false); // replacing a non-host seat keeps rights off

  // Everybody offline: nobody holds rights until a legitimate resume arrives.
  room.detach(players[1]);
  room.detach(newcomer);
  assert.equal(room.hostSeatId, null);
  assert.equal(room.hostConnected, false);
  assert.equal(room.empty, true);

  const back = fakePeer();
  room.bindResume(back, players[1].token ?? '', 'resume-1');
  assert.equal(room.hostSeatId, 1);
  assert.equal(ddzState(back).isHost, true);

  const oldHost = fakePeer();
  room.bindResume(oldHost, host.token ?? '', 'resume-0');
  assert.equal(room.hostSeatId, 1); // the old host resuming does not steal the rights back
  assert.equal(ddzState(oldHost).isHost, false);
  assert.equal(ddzState(oldHost).hand.length, ddzGame(room).hands[0]!.length);
});

// ---------------------------------------------------------------- expiry

test('expiry follows continuous empty time instead of room age', () => {
  const room = new Room('TTL', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: [{ ...PLACED[0] }] }, 's1');
  const player = fakePeer();
  room.bindJoin(player, 0, '甲', 'j0');

  // An occupied room is never expired, however old it is.
  assert.equal(room.isExpired(Date.now() + 5 * ROOM_TTL_MS, ROOM_TTL_MS), false);

  const emptyAt = Date.now();
  room.detach(player);
  room.detach(host);
  assert.equal(room.empty, true);
  assert.equal(room.isExpired(emptyAt + ROOM_TTL_MS - 1, ROOM_TTL_MS), false); // freshly empty is kept
  assert.equal(room.isExpired(emptyAt + ROOM_TTL_MS, ROOM_TTL_MS), true);
  assert.equal(room.isExpired(emptyAt + 5 * ROOM_TTL_MS, ROOM_TTL_MS), true);

  // A legitimate reconnect resets the clock.
  const back = fakePeer();
  room.bindResume(back, player.token ?? '', 'resume-1');
  assert.equal(room.isExpired(emptyAt + ROOM_TTL_MS, ROOM_TTL_MS), false);
  assert.equal(room.isExpired(emptyAt + 10 * ROOM_TTL_MS, ROOM_TTL_MS), false);

  const secondEmptyAt = Date.now();
  room.detach(back);
  assert.equal(room.isExpired(secondEmptyAt + ROOM_TTL_MS - 1, ROOM_TTL_MS), false);
  assert.equal(room.isExpired(secondEmptyAt + ROOM_TTL_MS, ROOM_TTL_MS), true);

  // A brand new unclaimed room is not instantly expired either.
  const fresh = new Room('FRESH', 'tablet', 'doudizhu');
  assert.equal(fresh.isExpired(Date.now() + ROOM_TTL_MS - 1, ROOM_TTL_MS), false);
});

// ---------------------------------------------------------------- doudizhu engine in isolation

test('the doudizhu engine deals, bids, plays and stamps room-lifetime ids on its own', () => {
  const game = new DoudizhuGame(createPlayStamper('ENG'));
  game.start();
  const dealt = ddzViewOf(game);
  assert.equal(dealt.game, 'doudizhu');
  assert.equal(dealt.phase, 'bidding');
  assert.deepEqual(
    game.hands.map((hand) => hand.length),
    [17, 17, 17],
  );
  assert.equal(dealt.bottom.length, 0); // hidden before the landlord is known
  assert.equal(dealt.turn, 0);
  assert.equal(game.requiresConnection(0), true);
  assert.equal(game.passedAt(0), false);

  assert.deepEqual(game.command(0, 'pass', {}), { ok: false, message: '当前不是出牌阶段' });
  assert.deepEqual(game.command(0, 'bid', { value: 3 }), { ok: true });
  const playing = ddzViewOf(game);
  assert.equal(playing.phase, 'playing');
  assert.equal(playing.landlord, 0);
  assert.equal(playing.bid, 3);
  assert.deepEqual(
    game.hands.map((hand) => hand.length),
    [20, 17, 17],
  );
  assert.equal(playing.bottom.length, 3);
  assert.equal(playing.trickStartIndex, 0);

  const card = game.hands[0]![0]!;
  assert.deepEqual(game.command(0, 'play', { cards: [card.id] }), { ok: true });
  const afterPlay = ddzViewOf(game);
  assert.equal(afterPlay.tablePlays.length, 1);
  assert.equal(afterPlay.tablePlays[0]!.id, 'ENG:1');
  assert.equal(afterPlay.tablePlays[0]!.seatId, 0);
  assert.equal(afterPlay.turn, 1);
  assert.equal(game.hands[0]!.length, 19);
  assert(Math.abs(afterPlay.tablePlays[0]!.scatter.x) <= 0.045);
  assert(Math.abs(afterPlay.tablePlays[0]!.scatter.angle) <= 8);
  assert.deepEqual(game.command(1, 'play', { cards: [card.id] }), { ok: false, message: '你没有这些牌' });
  assert.deepEqual(game.command(1, 'tribute', { cardId: card.id }), { ok: false, message: '未知的操作类型' });
  assert.deepEqual(game.restart(), { ok: false, message: '本局尚未结束' });
  assert.equal(ddzViewOf(game).tablePlays.length, 1); // not finished: restart refused, nothing cleared
});

// ---------------------------------------------------------------- guandan kind and four seats

const GU_PLACED = [
  { x: 0.5, y: 0.9, angle: 0 },
  { x: 0.9, y: 0.5, angle: -90 },
  { x: 0.5, y: 0.1, angle: 180 },
  { x: 0.1, y: 0.5, angle: 90 },
];

interface GuFixture {
  room: Room;
  host: FakePeer;
  players: FakePeer[];
}

/** Tablet Guandan room with four placed seats and four joined players. */
function setupGuTablet(): GuFixture {
  const room = new Room('GUT', 'tablet', 'guandan');
  const host = fakePeer();
  room.bindHost(host, 'create-gu');
  const players = [0, 1, 2, 3].map((seat) => {
    const peer = fakePeer();
    room.bindJoin(peer, seat, `玩家${seat}`, `join-gu-${seat}`);
    return peer;
  });
  return { room, host, players };
}

/** Phone Guandan room: creator owns seat 0, three more phones join. */
function setupGuPhone(): GuFixture {
  const room = new Room('GUP', 'phone', 'guandan');
  const host = fakePeer();
  room.bindCreator(host, 'create-gu-phone', '甲');
  const players = [host];
  for (const seat of [1, 2, 3]) {
    const peer = fakePeer();
    room.bindJoin(peer, seat, `玩家${seat}`, `join-gu-phone-${seat}`);
    players.push(peer);
  }
  return { room, host, players };
}

test('a guandan room exposes four seats and rejects a fifth', () => {
  const room = new Room('GU1', 'tablet', 'guandan');
  const host = fakePeer();
  room.bindHost(host, 'create');
  assert.equal(room.seatCount, 4);
  assert.equal(lastSession(host)?.game, 'guandan');
  assert.equal(room.summary().game, 'guandan');
  assert.equal(room.summary().phase, 'lobby');

  assert.equal(rawState(host).seats.length, 4);

  const fourth = fakePeer();
  room.bindJoin(fourth, 3, '丁', 'j3');
  assert.equal(fourth.seatId, 3);

  const fifth = fakePeer();
  room.bindJoin(fifth, 4, '戊', 'j4');
  assert.equal(lastError(fifth), '座位号无效');
  assert.equal(fifth.seatId, null);

  room.command(host, 'seats', { positions: [...GU_PLACED, { x: 0.5, y: 0.5, angle: 0 }] }, 's5');
  assert.equal(lastError(host), '掼蛋固定四方座位，对家同队，无法自定义位置');
  assert.equal(room.positions.length, 4);

  room.command(host, 'start', {}, 'start-short');
  assert.equal(lastError(host), '需要四名玩家入座');
});

test('guandan tablet seats are fixed before joining and ignore click or join order', () => {
  const room = new Room('GU2', 'tablet', 'guandan');
  const host = fakePeer();
  room.bindHost(host, 'create');
  const expected = [
    { x: .5, y: .88, angle: 0 }, { x: .9, y: .5, angle: -90 },
    { x: .5, y: .12, angle: 180 }, { x: .1, y: .5, angle: 90 },
  ];
  assert.deepEqual(room.positions, expected);
  for (const positions of [[], GU_PLACED.slice().reverse(), GU_PLACED.slice(0, 2)]) {
    room.command(host, 'seats', { positions }, `custom-${positions.length}`);
    assert.equal(lastError(host), '掼蛋固定四方座位，对家同队，无法自定义位置');
    assert.deepEqual(room.positions, expected);
  }
  for (const seat of [3, 1, 0, 2]) {
    const player = fakePeer();
    room.bindJoin(player, seat, `位置${seat}`, `join-${seat}`);
    assert.equal(player.seatId, seat);
  }
  const seats = room.summary().seats;
  assert.deepEqual(seats.map(s => s.name), ['位置0', '位置1', '位置2', '位置3']);
  for (const seat of seats) {
    const partner = seats[(seat.id + 2) % 4]!;
    assert.equal(seat.x + partner.x, 1);
    assert.equal(seat.y + partner.y, 1);
  }
  assert.deepEqual(room.positions, expected);
  room.dispose();
});

test('guandan phone rooms use the canonical four-seat layout', () => {
  const { room, host, players } = setupGuPhone();
  const state = guState(host);
  assert.equal(state.roomMode, 'phone');
  assert.equal(state.game, 'guandan');
  assert.equal(state.seats.length, 4);
  assert.deepEqual(
    state.seats.map((seat) => [seat.id, seat.x, seat.y, seat.angle]),
    [
      [0, 0.5, 0.88, 0],
      [1, 0.9, 0.5, -90],
      [2, 0.5, 0.12, 180],
      [3, 0.1, 0.5, 90],
    ],
  );
  assert.equal(state.hostSeatId, 0);
  assert.equal(state.isHost, true);
  assert.equal(state.selfSeat, 0);
  assert.equal(room.summary().seats.length, 4);
  for (const [seat, peer] of players.entries()) {
    assert.equal(lastSession(peer)?.seatId, seat);
    assert.equal(lastSession(peer)?.game, 'guandan');
    assert.equal(guState(peer).selfSeat, seat);
  }
  const fourth = fakePeer();
  room.bindJoin(fourth, 0, '抢座', 'j-x');
  assert.equal(lastErrorCode(fourth), 'SEAT_OCCUPIED');
});

test('same-room next deal preserves the result and opens tribute or a public resistance', () => {
  const { room, host, players } = setupGuTablet();
  try {
    startGame(room, host, players);
    assert.ok(room.engine instanceof GuandanGame);
    const engine = room.engine;
    const leader = engine.view(null).turn!;
    // Finish a deterministic double-down through normal room commands.
    for (let seat = 0; seat < 4; seat++) engine.hands[seat] = [{ id: `end-${seat}`, rank: 3, suit: 'spade' }];
    room.command(players[leader]!, 'play', { cards: [`end-${leader}`] }, 'finish-head');
    for (let i = 0; i < 3; i++) {
      const turn = engine.view(null).turn!;
      room.command(players[turn]!, 'pass', {}, `pass-${i}`);
    }
    const partner = (leader + 2) % 4;
    room.command(players[partner]!, 'play', { cards: [`end-${partner}`] }, 'finish-partner');
    assert.equal(engine.phase, 'finished');
    const previous = structuredClone(engine.result);
    room.command(host, 'again', {}, 'next-deal');
    assert.deepEqual(engine.result, previous);
    assert.equal(engine.phase, 'lobby');
    players.forEach((p, i) => room.command(p, 'ready', { ready: true }, `ready-next-${i}`));
    room.command(host, 'start', {}, 'start-next');
    const state = guState(host);
    assert.equal(state.guandan.deal, 2);
    assert.deepEqual(state.guandan.result, previous);
    assert.deepEqual(state.guandan.exchange.givers.slice().sort(), [0, 1, 2, 3].filter(s => s % 2 !== leader % 2));
    const bigs = state.guandan.exchange.givers.flatMap(s => engine.handOf(s)).filter(c => c.rank === 17).length;
    assert.equal(state.guandan.exchange.stage, bigs === 2 ? 'resisted' : 'tribute');
    assert.equal(state.phase, bigs === 2 ? 'playing' : 'tribute');
    if (bigs !== 2) {
      for (const giver of state.guandan.exchange.givers) assert.equal(guState(players[giver]!).privateAction?.kind, 'tribute');
    }
  } finally { room.dispose(); }
});

test('guandan deals four private 27-card hands with no doudizhu fields', () => {
  const { room, host, players } = setupGuTablet();
  players.forEach((peer, seat) => room.command(peer, 'ready', { ready: true }, `ready-gu-${seat}`));
  room.command(host, 'start', {}, 'start-gu');

  assert.equal(room.engine.phase !== 'lobby', true);
  assert.equal(room.summary().phase, room.engine.phase);
  for (const peer of players) {
    const state = guState(peer);
    assert.equal(state.hand.length, 27);
    assert.equal(state.seats.every((seat) => seat.count === 27), true);
    assert.equal(
      ['lobby', 'tribute', 'playing', 'finished'].includes(state.phase),
      true,
    );
    assert.equal('landlord' in state, false);
    assert.equal('bid' in state, false);
    assert.equal('bottom' in state, false);
    assert.equal('scores' in state, false);
    assert.equal('guandan' in state, true);
    assert.equal(state.guandan.levels.length, 2);
    assert.equal(state.guandan.matchWinner, null);
    assert.equal(state.guandan.result, null);
    assert.equal(Array.isArray(state.guandan.finishOrder), true);
    assert.equal(Number.isInteger(state.guandan.deal), true);
    const action = state.privateAction;
    assert.equal(action === null || action.kind === 'tribute' || action.kind === 'return', true);
    assert.equal(action === null || Array.isArray(action.eligibleIds), true);
    assertNoHiddenHands(room, peer);
  }
  // A shared table screen has no seat, so it never gets a private exchange action.
  assert.equal(guState(host).privateAction, null);
  assert.equal(guState(host).hand.length, 0);
  // The Doudizhu variant keeps its own fields and never grows a guandan block.
  const ddzRoom = new Room('DDZ1', 'tablet', 'doudizhu');
  const ddzHost = fakePeer();
  ddzRoom.bindHost(ddzHost, 'create-ddz');
  ddzRoom.command(ddzHost, 'seats', { positions: PLACED.map((p) => ({ ...p })) }, 's-ddz');
  [0, 1, 2].forEach((seat) => {
    const peer = fakePeer();
    ddzRoom.bindJoin(peer, seat, `玩家${seat}`, `j-ddz-${seat}`);
    ddzRoom.command(peer, 'ready', { ready: true }, `r-ddz-${seat}`);
  });
  ddzRoom.command(ddzHost, 'start', {}, 'start-ddz');
  const ddz = ddzState(ddzHost);
  assert.equal('landlord' in ddz, true);
  assert.equal('bottom' in ddz, true);
  assert.equal('scores' in ddz, true);
  assert.equal('guandan' in ddz, false);
  assert.equal(ddz.phase, 'bidding');
});

test('guandan game commands wait for an offline seat and resume after the reconnect', () => {
  const { room, host, players } = setupGuTablet();
  players.forEach((peer, seat) => room.command(peer, 'ready', { ready: true }, `ready-gu2-${seat}`));
  room.command(host, 'start', {}, 'start-gu2');

  const token = players[2]!.token ?? '';
  room.detach(players[2]!);
  assert.equal(guState(players[0]!).seats[2]!.connected, false);
  room.command(players[0]!, 'tribute', { cardId: 'whatever' }, 'gu-paused');
  assert.equal(lastError(players[0]!), '有玩家掉线，等待重连');

  const back = fakePeer();
  room.bindResume(back, token, 'gu-resume');
  assert.equal(guState(back).seats[2]!.connected, true);
  const refusalsBefore = errorCount(players[0]!);
  room.command(players[0]!, 'tribute', { cardId: 'whatever' }, 'gu-after-resume');
  if (errorCount(players[0]!) > refusalsBefore) {
    // A rule refusal is fine; the room must no longer answer "paused".
    assert.notEqual(lastError(players[0]!), '有玩家掉线，等待重连');
  } else {
    assert.ok(players[0]!.sent.some((message) => message.type === 'ack' && message.id === 'gu-after-resume'));
  }
});

test('guandan restart stays host-only and waits for a finished deal', () => {
  const { room, host, players } = setupGuTablet();
  room.command(players[1]!, 'again', {}, 'gu-again-player');
  assert.equal(lastError(players[1]!), '只有房主可以重开'); // room authority, wording owned by the room
  const errorsBefore = errorCount(host);
  const viewBefore = room.engine.view(null);
  room.command(host, 'again', {}, 'gu-again-host');
  assert.equal(errorCount(host), errorsBefore + 1, 'the engine must refuse a restart before the deal ends');
  assert.equal(room.engine.phase, 'lobby');
  assert.deepEqual(room.engine.view(null), viewBefore);
  assert.equal(room.players.every((player) => player === null || player.ready === false), true);
});

test('a guandan room refuses doudizhu-only commands without touching its state', () => {
  const { room, host, players } = setupGuTablet();
  players.forEach((peer, seat) => room.command(peer, 'ready', { ready: true }, `ready-gu3-${seat}`));
  room.command(host, 'start', {}, 'start-gu3');
  const viewBefore = room.engine.view(0);
  const versionBefore = room.summary().phase;
  room.command(players[0]!, 'bid', { value: 3 }, 'gu-bid');
  assert.notEqual(lastError(players[0]!), undefined);
  assert.deepEqual(room.engine.view(0), viewBefore);
  assert.equal(room.summary().phase, versionBefore);
});

test('guandan phone host rights fail over across four seats and never return to the old host', () => {
  const { room, host, players } = setupGuPhone();
  const hostToken = host.token ?? '';
  const seat2Token = players[2]!.token ?? '';

  assert.equal(room.hostSeatId, 0);
  room.detach(host);
  assert.equal(room.hostSeatId, 1);
  room.detach(players[1]!);
  assert.equal(room.hostSeatId, 2);
  room.detach(players[2]!);
  assert.equal(room.hostSeatId, 3);
  assert.equal(guState(players[3]!).isHost, true);
  room.detach(players[3]!);
  assert.equal(room.hostSeatId, null);
  assert.equal(room.hostConnected, false);
  assert.equal(room.empty, true);

  const back = fakePeer();
  room.bindResume(back, seat2Token, 'gu-first-resume');
  assert.equal(room.hostSeatId, 2);
  assert.equal(guState(back).isHost, true);

  const oldHost = fakePeer();
  room.bindResume(oldHost, hostToken, 'gu-old-host');
  assert.equal(room.hostSeatId, 2); // the old host does not steal rights back
  assert.equal(guState(oldHost).isHost, false);
  assert.equal(guState(oldHost).hand.length, room.engine.handOf(0).length);
});

test('a guandan seat takeover rotates credentials and leaves the game state untouched', () => {
  const { room, host, players } = setupGuTablet();
  const openToken = players[3]!.token ?? '';
  const viewBefore = room.engine.view(null);
  assert.deepEqual(room.engine.view(3), viewBefore); // no private data while no exchange stage is live

  const newcomer = fakePeer();
  room.requestSeat(newcomer, 3, '新丁', 'gu-req');
  assert.deepEqual(room.engine.view(null), viewBefore, 'a pending request must not touch the game');
  room.command(host, 'decideSeat', { requestId: 'gu-req', approve: true }, 'gu-decide');

  const session = lastSession(newcomer);
  assert.equal(session?.seatId, 3);
  assert.equal(session?.game, 'guandan');
  assert.notEqual(session?.token, openToken);
  assert.equal(room.players[3]!.name, '新丁');
  assert.equal(players[3]!.superseded, 1);
  const stale = fakePeer();
  room.bindResume(stale, openToken, 'gu-stale');
  assert.equal(lastErrorCode(stale), 'INVALID_CREDENTIAL');
  assert.deepEqual(room.engine.view(3), viewBefore);
  assert.deepEqual(guState(newcomer).seats.map((seat) => seat.name), ['玩家0', '玩家1', '玩家2', '新丁']);
});
