// Hint generators and the private `hint` room channel. These tests assert three contracts:
// every suggestion is physically in the hand and legal under the same rules the play command
// uses, the order follows "cheapest first, preserve bombs", and a hint never mutates or
// broadcasts room state.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card, HintPlay, ServerMessage, Suit } from '../shared/protocol';
import { Room, type Peer } from '../server/room';
import { DoudizhuGame } from '../server/games/doudizhu';
import {
  canBeatGuandan,
  createGuandanDeck,
  enumerateGuandanPlays,
  isGuandanWild,
} from '../shared/guandan';
import { canBeat, createDeck, detectPlay, sortHand, type PlayKind } from '../server/rules';
import { doudizhuHints, guandanHints } from '../server/hints';

let peerSeq = 0;
type FakePeer = Peer & { sent: ServerMessage[]; superseded: number };

function fakePeer(): FakePeer {
  const sent: ServerMessage[] = [];
  peerSeq += 1;
  return {
    id: `hint-peer${peerSeq}`,
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

function lastHint(peer: FakePeer): Extract<ServerMessage, { type: 'hint' }> | null {
  for (let index = peer.sent.length - 1; index >= 0; index -= 1) {
    const message = peer.sent[index];
    if (message.type === 'hint') return message;
  }
  return null;
}

function lastError(peer: FakePeer): string | undefined {
  for (let index = peer.sent.length - 1; index >= 0; index -= 1) {
    const message = peer.sent[index];
    if (message.type === 'error') return message.message;
  }
  return undefined;
}

function ddzGame(room: Room): DoudizhuGame {
  if (!(room.engine instanceof DoudizhuGame)) throw new Error('expected the doudizhu engine');
  return room.engine;
}

const ddzDeck = createDeck();
function ddzCard(rank: number, suit: Suit = 'spade'): Card {
  const found = ddzDeck.find((card) => card.rank === rank && card.suit === suit);
  if (!found) throw new Error(`missing card ${rank}/${suit}`);
  return found;
}

function assertDdzHints(
  hand: readonly Card[],
  last: PlayKind | null,
  hints: HintPlay[],
): void {
  const ids = new Set(hand.map((card) => card.id));
  for (const hint of hints) {
    assert.ok(hint.cards.length > 0);
    assert.ok(hint.cards.every((id) => ids.has(id)), `hint ${hint.cards.join(',')} is in hand`);
    const cards = hand.filter((card) => hint.cards.includes(card.id));
    const play = detectPlay(cards);
    assert.ok(play, `hint ${hint.cards.join(',')} must be a legal shape`);
    assert.ok(canBeat(play!, last), `hint ${hint.label} must beat the cursor`);
  }
}

const PLACED = [
  { x: 0.5, y: 0.88, angle: 0 },
  { x: 0.1, y: 0.5, angle: 90 },
  { x: 0.9, y: 0.5, angle: -90 },
];

function setupDdz(): { room: Room; host: FakePeer; players: FakePeer[] } {
  const room = new Room('HINT', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: PLACED.map((position) => ({ ...position })) }, 'seats');
  const players = [0, 1, 2].map((seat) => {
    const peer = fakePeer();
    room.bindJoin(peer, seat, `玩家${seat}`, `join-${seat}`);
    return peer;
  });
  players.forEach((peer, seat) => room.command(peer, 'ready', { ready: true }, `ready-${seat}`));
  room.command(host, 'start', {}, 'start');
  room.command(players[0]!, 'bid', { value: 3 }, 'bid-0');
  return { room, host, players };
}

test('doudizhu hints: every suggestion is legal, lowest first, bombs last', () => {
  const hand = sortHand([
    ddzCard(6, 'spade'), ddzCard(6, 'heart'), ddzCard(6, 'club'), ddzCard(6, 'diamond'),
    ddzCard(7, 'spade'), ddzCard(8, 'spade'), ddzCard(3, 'spade'),
  ]);
  const last = detectPlay([ddzCard(5, 'spade')])!;
  const hints = doudizhuHints(hand, last);
  assertDdzHints(hand, last, hints);
  assert.ok(hints.length >= 4);
  // Preserve the four 6s: the first single is the 7, not a card taken from the bomb.
  assert.deepEqual(hints[0]!.cards, [ddzCard(7, 'spade').id]);
  // The bomb is still offered, but only after every ordinary single.
  const firstBomb = hints.findIndex((hint) => hint.cards.length === 4);
  assert.ok(firstBomb >= 0);
  assert.ok(hints.slice(0, firstBomb).every((hint) => hint.cards.length === 1));
});

test('doudizhu hints: following a straight only offers the same length or a bomb', () => {
  const hand = sortHand([
    ddzCard(4), ddzCard(5), ddzCard(6), ddzCard(7), ddzCard(8),
    ddzCard(9), ddzCard(10), ddzCard(11), ddzCard(12),
    ddzCard(13, 'heart'), ddzCard(13, 'club'), ddzCard(13, 'diamond'), ddzCard(13, 'spade'),
  ]);
  const cards = [3, 4, 5, 6, 7].map((rank) => ddzCard(rank));
  const last = detectPlay(cards)!;
  const hints = doudizhuHints(hand, last);
  assertDdzHints(hand, last, hints);
  for (const hint of hints) {
    const play = detectPlay(hand.filter((card) => hint.cards.includes(card.id)))!;
    assert.ok(play.kind === 'straight' || play.kind === 'bomb', `unexpected ${play.kind}`);
    if (play.kind === 'straight') assert.equal(play.length, 5);
  }
});

test('doudizhu room hint is private, read-only and turn-gated', () => {
  const { room, host, players } = setupDdz();
  const engine = ddzGame(room);
  const hand = engine.handOf(0);
  const versionBefore = room.version;
  const hostStatesBefore = host.sent.filter((message) => message.type === 'state').length;

  room.command(players[0]!, 'hint', {}, 'hint-1');
  const hint = lastHint(players[0]!);
  assert.ok(hint, 'the acting player receives a hint reply');
  assert.ok(hint!.plays.length > 0);
  const ids = new Set(hand.map((card) => card.id));
  for (const play of hint!.plays) {
    assert.ok(play.cards.every((id) => ids.has(id)), 'hint cards belong to the private hand');
    assert.ok(detectPlay(hand.filter((card) => play.cards.includes(card.id))), 'hint is a legal shape');
  }
  // The hint did not touch the room version or broadcast a snapshot to anyone else.
  assert.equal(room.version, versionBefore);
  assert.equal(host.sent.filter((message) => message.type === 'state').length, hostStatesBefore);

  room.command(players[1]!, 'hint', {}, 'hint-2');
  assert.equal(lastError(players[1]!), '还没轮到你出牌');
  assert.equal(lastHint(players[1]!), null, 'no private hint leaks to a non-acting seat');
});

test('guandan hints: wildcard-assisted pair is offered with its declaration key', () => {
  const level = 9;
  const deck = createGuandanDeck();
  const five = deck.find((card) => card.rank === 5 && card.suit === 'spade')!;
  const wild = deck.find((card) => isGuandanWild(card, level))!;
  const hints = guandanHints([five, wild], level, null);
  assert.ok(hints.length > 0);
  const pair = hints.find((hint) => hint.label === '对子');
  assert.ok(pair, 'a natural five plus a wildcard forms a pair');
  assert.equal(pair!.cards.length, 2);
  const cards = [five, wild].filter((card) => pair!.cards.includes(card.id));
  const options = enumerateGuandanPlays(cards, level);
  assert.ok(options.some((option) =>
    option.declaration.key === pair!.claim &&
    option.declaration.kind === 'pair' &&
    option.declaration.primaryRank === 5,
  ));
});

test('guandan hints: every suggestion revalidates and beats the live claim', () => {
  const level = 9;
  const deck = createGuandanDeck();
  const hand = deck.slice(0, 27);
  const wilds = hand.filter((card) => isGuandanWild(card, level));
  assert.ok(wilds.length <= 2);
  const hints = guandanHints(hand, level, null);
  assert.ok(hints.length > 0);
  const ids = new Set(hand.map((card) => card.id));
  for (const hint of hints) {
    assert.ok(hint.cards.every((id) => ids.has(id)));
    const cards = hand.filter((card) => hint.cards.includes(card.id));
    const options = enumerateGuandanPlays(cards, level);
    assert.ok(options.some((option) => option.declaration.key === hint.claim), 'claim revalidates');
  }
  // Leading is ordered by kind: the first play is a single, not a six-card run.
  assert.equal(hints[0]!.label, '单张');

  // A single 3 can only be followed by higher singles, a bomb or a bomb-tier play.
  const lead = hand.find((card) => card.rank === 3)!;
  const previous = enumerateGuandanPlays([lead], level)[0]!.declaration;
  const following = guandanHints(hand, level, previous);
  for (const hint of following) {
    const cards = hand.filter((card) => hint.cards.includes(card.id));
    const options = enumerateGuandanPlays(cards, level);
    const chosen = options.find((option) => option.declaration.key === hint.claim);
    assert.ok(chosen, 'claim revalidates');
    assert.ok(canBeatGuandan(chosen!.declaration, previous, level), 'hint beats the cursor');
  }
});

test('guandan hints: preserve a natural bomb before using it on a single', () => {
  const level = 9;
  const deck = createGuandanDeck();
  const sixes = deck.filter((card) => card.rank === 6).slice(0, 4);
  const seven = deck.find((card) => card.rank === 7)!;
  const five = deck.find((card) => card.rank === 5)!;
  const hand = [...sixes, seven];
  const previous = enumerateGuandanPlays([five], level)[0]!.declaration;
  const hints = guandanHints(hand, level, previous);
  assert.ok(hints.length > 0);
  assert.equal(hints[0]!.label, '单张');
  assert.deepEqual(hints[0]!.cards, [seven.id], 'play the natural 7 instead of breaking four 6s');
  assert.ok(hints.some((hint) => hint.label === '炸弹'), 'the bomb remains available last');
});
