// Turn-clock tests: host authority, snapshot deadlines, timeout fallbacks and disconnect pause.
// Node's mock timer keeps the suite fast while still running the real setTimeout/clearTimeout path.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Card, DoudizhuSnapshot, ServerMessage, Suit } from '../shared/protocol';
import { Room, type Peer } from '../server/room';
import { DoudizhuGame } from '../server/games/doudizhu';
import { GuandanGame } from '../server/games/guandan';
import { createPlayStamper } from '../server/games/playLog';
import { createDeck } from '../server/rules';

type FakePeer = Peer & { sent: ServerMessage[]; superseded: number };
let peerSeq = 0;

function fakePeer(): FakePeer {
  const sent: ServerMessage[] = [];
  peerSeq += 1;
  return {
    id: `timer-peer${peerSeq}`,
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

function lastState(peer: FakePeer): DoudizhuSnapshot {
  for (let index = peer.sent.length - 1; index >= 0; index -= 1) {
    const message = peer.sent[index];
    if (message.type === 'state' && message.state.game === 'doudizhu') return message.state;
  }
  throw new Error('no doudizhu state');
}

function lastError(peer: FakePeer): string | undefined {
  for (let index = peer.sent.length - 1; index >= 0; index -= 1) {
    const message = peer.sent[index];
    if (message.type === 'error') return message.message;
  }
  return undefined;
}

function lastSession(peer: FakePeer): Extract<ServerMessage, { type: 'session' }> | null {
  for (let index = peer.sent.length - 1; index >= 0; index -= 1) {
    const message = peer.sent[index];
    if (message.type === 'session') return message;
  }
  return null;
}

function ddzGame(room: Room): DoudizhuGame {
  if (!(room.engine instanceof DoudizhuGame)) throw new Error('expected the doudizhu engine');
  return room.engine;
}

const PLACED = [
  { x: 0.5, y: 0.88, angle: 0 },
  { x: 0.1, y: 0.5, angle: 90 },
  { x: 0.9, y: 0.5, angle: -90 },
];

const deck = createDeck();
function pick(rank: number, suit: Suit = 'spade'): Card {
  const card = deck.find((entry) => entry.rank === rank && entry.suit === suit);
  if (!card) throw new Error(`missing ${rank}/${suit}`);
  return card;
}

interface Fixture {
  room: Room;
  host: FakePeer;
  players: FakePeer[];
}

function setup(): Fixture {
  const room = new Room('TMR', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: PLACED.map((position) => ({ ...position })) }, 'seats');
  const players = [0, 1, 2].map((seat) => {
    const peer = fakePeer();
    room.bindJoin(peer, seat, `玩家${seat}`, `join-${seat}`);
    return peer;
  });
  return { room, host, players };
}

function arm(room: Room, host: FakePeer, players: FakePeer[], seconds = 1): void {
  room.command(host, 'turnTimer', { seconds }, 'timer');
  players.forEach((peer, seat) => room.command(peer, 'ready', { ready: true }, `ready-${seat}`));
  room.command(host, 'start', {}, 'start');
}

/** Start a Doudizhu deal with a known landlord and a known small hand set. */
function toKnownPlaying(room: Room, players: FakePeer[]): void {
  room.command(players[0]!, 'bid', { value: 3 }, 'bid-3');
  const game = ddzGame(room);
  game.hands[0] = [pick(3), pick(4)];
  game.hands[1] = [pick(5), pick(6)];
  game.hands[2] = [pick(7), pick(8)];
}

test('turn clock: host-only setting is published and bidding times out as 不叫', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { room, host, players } = setup();
  try {
    room.command(players[1]!, 'turnTimer', { seconds: 30 }, 'not-host');
    assert.equal(lastError(players[1]!), '只有房主可以设置回合倒计时');
    room.command(host, 'turnTimer', { seconds: 301 }, 'too-long');
    assert.equal(lastError(host), '倒计时秒数无效');
    room.command(host, 'turnTimer', { seconds: 1 }, 'set');
    assert.equal(lastState(host).turnLimitSeconds, 1);
    assert.equal(lastState(host).turnRemainingMs, null, 'the lobby has no decision to time');

    arm(room, host, players, 1);
    const started = lastState(host);
    assert.equal(started.phase, 'bidding');
    assert.equal(started.turnSeatId, 0);
    assert.equal(started.turnLimitSeconds, 1);
    assert.ok((started.turnRemainingMs ?? 0) > 0, 'the first bidder has a deadline');

    mock.timers.tick(4000);
    const after = lastState(host);
    assert.equal(after.phase, 'bidding');
    assert.equal(after.turn, 1, 'seat 0 timed out and passed the bid');
    assert.equal(after.turnSeatId, 1, 'the next bidder gets the clock');
    assert.ok((after.turnRemainingMs ?? 0) > 0);

    // The clock is frozen while a deal is live; only the lobby/finished phases may change it.
    room.command(host, 'turnTimer', { seconds: 30 }, 'during-play');
    assert.equal(lastError(host), '牌局进行中，不能修改回合倒计时');
  } finally {
    room.dispose();
    mock.timers.reset();
  }
});

test('turn clock: a lead auto-plays the cheapest hint, then a follower auto-passes', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { room, host, players } = setup();
  try {
    arm(room, host, players, 1);
    toKnownPlaying(room, players);
    assert.equal(ddzGame(room).view(null).game === 'doudizhu' && ddzGame(room).view(null).turn, 0);

    mock.timers.tick(4000);
    assert.equal(ddzGame(room).handOf(0).length, 1, 'leading timeout played one card');
    assert.equal(ddzGame(room).view(null).game === 'doudizhu' && ddzGame(room).view(null).turn, 1);

    mock.timers.tick(4000);
    const state = lastState(host);
    assert.equal(state.turn, 2, 'the follower timed out and passed');
    assert.equal(state.seats[1]!.passed, true);
    assert.equal(state.lastPlay?.seatId, 0, 'the pass did not touch the live play');
  } finally {
    room.dispose();
    mock.timers.reset();
  }
});

test('turn clock: disconnect pauses the deadline and reconnect arms a fresh one', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { room, host, players } = setup();
  try {
    arm(room, host, players, 1);
    room.command(players[0]!, 'bid', { value: 3 }, 'bid-3');
    const session = lastSession(players[1]!);
    assert.ok(session);

    const handBefore = ddzGame(room).handOf(0).length;
    room.detach(players[1]!);
    let state = lastState(host);
    assert.equal(state.turnRemainingMs, null, 'a required seat is offline');
    assert.equal(state.turnSeatId, null);
    mock.timers.tick(20_000);
    assert.equal(ddzGame(room).handOf(0).length, handBefore, 'no timeout action ran while paused');
    assert.equal(ddzGame(room).view(null).game === 'doudizhu' && ddzGame(room).view(null).turn, 0);

    const resumed = fakePeer();
    room.bindResume(resumed, session!.token, 'resume');
    state = lastState(host);
    assert.equal(state.turnSeatId, 0, 'the reconnected room is timed again');
    assert.ok((state.turnRemainingMs ?? 0) > 0);
  } finally {
    room.dispose();
    mock.timers.reset();
  }
});

test('turn clock: guandan timeout lead and follow use the engine legality path', () => {
  const game = new GuandanGame(createPlayStamper('GTMR'));
  game.start();
  const first = game.view(null);
  assert.equal(first.game, 'guandan');
  assert.equal(first.phase, 'playing');
  assert.ok(first.turn !== null);
  assert.equal(game.timeoutAction((first.turn! + 1) % 4), null, 'only the acting seat is actionable');

  const before = game.handOf(first.turn!).length;
  const lead = game.timeoutAction(first.turn!);
  assert.ok(lead);
  assert.equal(lead!.type, 'play');
  const result = game.command(first.turn!, lead!.type, lead!.payload);
  assert.ok(result.ok, result.ok ? '' : result.message);
  assert.ok(game.handOf(first.turn!).length < before);

  const second = game.view(null);
  assert.equal(second.game, 'guandan');
  assert.ok(second.turn !== null);
  assert.notEqual(second.turn, first.turn);
  const follow = game.timeoutAction(second.turn!);
  assert.deepEqual(follow, { type: 'pass', payload: {} });
});
