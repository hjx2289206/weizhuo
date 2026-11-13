// Permanent tests for the pure 记牌器 maths. Inputs are public accepted plays plus the viewer's own
// hand, so the counter must report all three ownership buckets honestly (public history, my hand,
// outside) and must not clamp an impossible input into a plausible-looking count.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card, Suit, TablePlay } from '../shared/protocol';
import { createDeck } from '../server/rules';
import { buildCardCounter } from '../src/cardCounter';
import type { CardCounterEntry } from '../src/cardCounter';

let seq = 0;

function card(rank: number, suit: Suit = 'spade'): Card {
  seq += 1;
  return { id: `${suit[0]}${rank}_${seq}`, rank, suit };
}

/** `hand([3, 3, 4])` -> three cards with distinct ids. */
function hand(ranks: number[]): Card[] {
  return ranks.map((rank) => card(rank));
}

/** Minimal accepted-play shape: the counter only reads `cards`. */
function play(cards: Card[]): Pick<TablePlay, 'cards'> {
  return { cards };
}

const RANKS = [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3];

const SINGLE_DECK_TOTAL: Record<number, number> = {
  17: 1, 16: 1, 15: 4, 14: 4, 13: 4, 12: 4, 11: 4, 10: 4, 9: 4, 8: 4, 7: 4, 6: 4, 5: 4, 4: 4, 3: 4,
};

function entryOf(entries: CardCounterEntry[], rank: number): CardCounterEntry {
  const found = entries.find((entry) => entry.rank === rank);
  assert.ok(found, `rank ${rank} row missing`);
  return found;
}

test('single deck, nothing played: all fifteen ranks report their honest full totals', () => {
  const entries = buildCardCounter([], []);
  assert.equal(entries.length, 15);
  for (const rank of RANKS) {
    const total = SINGLE_DECK_TOTAL[rank];
    assert.deepEqual(entryOf(entries, rank), { rank, total, played: 0, inHand: 0, remaining: total, outside: total });
  }
});

test('mid-game state: every rank splits public played / my hand / outside correctly', () => {
  const entries = buildCardCounter(hand([17, 15, 15, 9]), [play(hand([16])), play(hand([14, 14, 14])), play(hand([9, 9]))]);
  const expected: Record<number, Omit<CardCounterEntry, 'rank'>> = {
    17: { total: 1, played: 0, inHand: 1, remaining: 1, outside: 0 },
    16: { total: 1, played: 1, inHand: 0, remaining: 0, outside: 0 },
    15: { total: 4, played: 0, inHand: 2, remaining: 4, outside: 2 },
    14: { total: 4, played: 3, inHand: 0, remaining: 1, outside: 1 },
    13: { total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 },
    12: { total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 },
    11: { total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 },
    10: { total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 },
    9: { total: 4, played: 2, inHand: 1, remaining: 2, outside: 1 },
    8: { total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 },
    7: { total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 },
    6: { total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 },
    5: { total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 },
    4: { total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 },
    3: { total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 },
  };
  assert.equal(entries.length, 15);
  for (const rank of RANKS) {
    assert.deepEqual(entryOf(entries, rank), { rank, ...expected[rank] });
  }
});

test('my own play moves a card from my hand into public history, leaving my outside count unchanged', () => {
  const seven = card(7);
  const before = buildCardCounter([seven], []);
  const after = buildCardCounter([], [play([seven])]);
  assert.deepEqual(entryOf(before, 7), { rank: 7, total: 4, played: 0, inHand: 1, remaining: 4, outside: 3 });
  assert.deepEqual(entryOf(after, 7), { rank: 7, total: 4, played: 1, inHand: 0, remaining: 3, outside: 3 });
  assert.equal(entryOf(after, 7).outside, entryOf(before, 7).outside);
});

test('an opponent play decrements outside without touching my hand', () => {
  const mine = card(7);
  const before = buildCardCounter([mine], []);
  const after = buildCardCounter([mine], [play([card(9)])]);
  assert.deepEqual(entryOf(before, 9), { rank: 9, total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 });
  assert.deepEqual(entryOf(after, 9), { rank: 9, total: 4, played: 1, inHand: 0, remaining: 3, outside: 3 });
  assert.deepEqual(entryOf(after, 7), { rank: 7, total: 4, played: 0, inHand: 1, remaining: 4, outside: 3 });
});

test('jokers hold one copy per deck, regular ranks four', () => {
  const single = buildCardCounter([], []);
  for (const rank of [17, 16]) assert.equal(entryOf(single, rank).total, 1);
  for (const rank of [15, 10, 3]) assert.equal(entryOf(single, rank).total, 4);

  const doubled = buildCardCounter([], [], 2);
  for (const rank of [17, 16]) assert.equal(entryOf(doubled, rank).total, 2);
  for (const rank of [15, 10, 3]) assert.equal(entryOf(doubled, rank).total, 8);
});

test('a real 54-card deal conserves: total === played + my hand + outside, per rank and in sum', () => {
  const deck = createDeck();
  const myHand = deck.slice(0, 17);
  const publicCards = deck.slice(17, 51);
  assert.equal(myHand.length, 17);
  assert.equal(publicCards.length, 34);
  const entries = buildCardCounter(myHand, [play(publicCards.slice(0, 9)), play(publicCards.slice(9, 20)), play(publicCards.slice(20, 34))]);

  assert.equal(entries.reduce((acc, entry) => acc + entry.total, 0), 54);
  assert.equal(entries.reduce((acc, entry) => acc + entry.played, 0), 34);
  assert.equal(entries.reduce((acc, entry) => acc + entry.inHand, 0), 17);
  assert.equal(entries.reduce((acc, entry) => acc + entry.outside, 0), 3); // undealt cards stay outside
  for (const entry of entries) {
    assert.equal(entry.remaining, entry.total - entry.played, `rank ${entry.rank} remaining`);
    assert.equal(entry.outside, entry.remaining - entry.inHand, `rank ${entry.rank} outside`);
    assert.equal(entry.played + entry.inHand + entry.outside, entry.total, `rank ${entry.rank} buckets`);
  }
});

test('double-deck arithmetic conserves 108 cards (generic deck maths)', () => {
  const doubled = [...createDeck(), ...createDeck()];
  const myHand = doubled.slice(0, 17);
  const publicCards = doubled.slice(17, 51);
  const entries = buildCardCounter(myHand, [play(publicCards)], 2);

  assert.equal(entries.reduce((acc, entry) => acc + entry.total, 0), 108);
  assert.equal(entries.reduce((acc, entry) => acc + entry.played, 0), 34);
  assert.equal(entries.reduce((acc, entry) => acc + entry.inHand, 0), 17);
  assert.equal(entries.reduce((acc, entry) => acc + entry.outside, 0), 57);
});

test('a new round only reflects its own inputs; the previous round leaves no residue', () => {
  const round1 = buildCardCounter(hand([5, 5, 5]), [play(hand([6])), play(hand([6, 6]))]);
  assert.deepEqual(entryOf(round1, 6), { rank: 6, total: 4, played: 3, inHand: 0, remaining: 1, outside: 1 });
  assert.deepEqual(entryOf(round1, 5), { rank: 5, total: 4, played: 0, inHand: 3, remaining: 4, outside: 1 });

  const round2 = buildCardCounter(hand([3]), []);
  assert.deepEqual(entryOf(round2, 6), { rank: 6, total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 });
  assert.deepEqual(entryOf(round2, 5), { rank: 5, total: 4, played: 0, inHand: 0, remaining: 4, outside: 4 });
  assert.deepEqual(entryOf(round2, 3), { rank: 3, total: 4, played: 0, inHand: 1, remaining: 4, outside: 3 });
});

test('an impossible state is reported verbatim, never clamped into a plausible count', () => {
  // Five 5s cannot exist in one deck; the honest report shows a negative outside, not zero.
  const entries = buildCardCounter(hand([5, 5, 5, 5, 5]), []);
  assert.deepEqual(entryOf(entries, 5), { rank: 5, total: 4, played: 0, inHand: 5, remaining: 4, outside: -1 });
});
