// Local hand-order tests. Sorting is a pure display projection: no card may be dropped, added or
// duplicated, and each mode must be deterministic for equal ranks.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card, Suit } from '../shared/protocol';
import { createGuandanDeck, isGuandanWild } from '../shared/guandan';
import { createDeck } from '../server/rules';
import {
  handSortStorageKey,
  nextHandSortMode,
  readHandSortMode,
  sortHandForDisplay,
  writeHandSortMode,
  type HandSortMode,
} from '../src/handSort';
import type { StorageLike } from '../src/sessionStore';

const ddzDeck = createDeck();
function ddz(rank: number, suit: Suit = 'spade'): Card {
  const card = ddzDeck.find((entry) => entry.rank === rank && entry.suit === suit);
  if (!card) throw new Error(`missing ${rank}/${suit}`);
  return card;
}

function fakeStore(): StorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function ranks(cards: readonly Card[]): number[] {
  return cards.map((card) => card.rank);
}

test('hand sort: rank mode is descending strength with deterministic suit ties', () => {
  const hand = [
    ddz(3, 'spade'), ddz(15, 'club'), ddz(14, 'heart'), ddz(17, 'joker'),
    ddz(16, 'joker'), ddz(6, 'diamond'), ddz(9, 'heart'), ddz(9, 'spade'),
  ];
  const sorted = sortHandForDisplay(hand, 'rank', 'doudizhu');
  assert.deepEqual(ranks(sorted), [17, 16, 15, 14, 9, 9, 6, 3]);
  assert.equal(sorted[4]!.suit, 'spade', 'same rank breaks by suit order');
  assert.equal(sorted[5]!.suit, 'heart');
  assert.equal(sorted.length, hand.length);
});

test('hand sort: suit mode groups suits in the shared order', () => {
  const hand = [
    ddz(5, 'spade'), ddz(9, 'heart'), ddz(10, 'spade'), ddz(14, 'diamond'),
    ddz(17, 'joker'), ddz(3, 'club'),
  ];
  const sorted = sortHandForDisplay(hand, 'suit', 'doudizhu');
  assert.deepEqual(sorted.map((card) => `${card.suit}:${card.rank}`), [
    'spade:10', 'spade:5', 'heart:9', 'club:3', 'diamond:14', 'joker:17',
  ]);
});

test('hand sort: combo mode groups rocket, bombs, triples, pairs, straights, singles', () => {
  const hand = [
    ddz(6, 'spade'), ddz(6, 'heart'), ddz(6, 'club'), ddz(6, 'diamond'),
    ddz(8, 'spade'), ddz(8, 'heart'), ddz(8, 'club'),
    ddz(5, 'spade'), ddz(5, 'heart'),
    ddz(9, 'spade'), ddz(10, 'spade'), ddz(11, 'spade'), ddz(12, 'spade'), ddz(13, 'spade'),
    ddz(3, 'spade'),
    ddz(16, 'joker'), ddz(17, 'joker'),
  ];
  const sorted = sortHandForDisplay(hand, 'combo', 'doudizhu');
  assert.deepEqual(ranks(sorted), [
    17, 16, // rocket
    6, 6, 6, 6, // bomb
    8, 8, 8, // triple
    5, 5, // pair
    13, 12, 11, 10, 9, // straight run
    3, // plain single
  ]);
  assert.equal(sorted.length, hand.length);
  assert.deepEqual(new Set(sorted.map((card) => card.id)), new Set(hand.map((card) => card.id)));
});

test('hand sort: combo straight detection keeps pairs intact', () => {
  const hand = [
    ddz(3), ddz(4), ddz(5), ddz(6), ddz(7),
    ddz(8, 'spade'), ddz(8, 'heart'),
  ];
  const sorted = sortHandForDisplay(hand, 'combo', 'doudizhu');
  // The pair is a real combination, so it comes before the five single-card run.
  assert.deepEqual(ranks(sorted), [8, 8, 7, 6, 5, 4, 3]);
});

test('hand sort: guandan knows the level strength and puts wildcards first in combo order', () => {
  const level = 9;
  const deck = createGuandanDeck();
  const wilds = deck.filter((card) => isGuandanWild(card, level)).slice(0, 2);
  const levelBomb = deck.filter((card) => card.rank === level && !isGuandanWild(card, level)).slice(0, 4);
  const pair = deck.filter((card) => card.rank === 5).slice(0, 2);
  const straight = [10, 11, 12, 13, 14].map((rank) => deck.find((card) => card.rank === rank)!);
  const single = deck.find((card) => card.rank === 3)!;
  const hand = [...pair, ...straight, ...levelBomb, ...wilds, single];

  const sorted = sortHandForDisplay(hand, 'combo', 'guandan', level);
  assert.deepEqual(sorted.slice(0, 2).map((card) => card.id), wilds.map((card) => card.id));
  assert.deepEqual(ranks(sorted.slice(2, 6)), [9, 9, 9, 9]);
  assert.deepEqual(ranks(sorted.slice(6, 8)), [5, 5]);
  assert.deepEqual(ranks(sorted.slice(8, 13)), [14, 13, 12, 11, 10]);
  assert.deepEqual(ranks(sorted.slice(13)), [3]);

  const byRank = sortHandForDisplay(hand, 'rank', 'guandan', level);
  assert.equal(byRank[0]!.rank, 9, 'level 9 is stronger than A');
  assert.equal(byRank[1]!.rank, 9);
  assert.ok(byRank[byRank.length - 1]!.rank === 3 || byRank[byRank.length - 1]!.rank === 5);
});

test('hand sort: modes are stored per game and invalid values fall back to rank', () => {
  const store = fakeStore();
  assert.equal(readHandSortMode('doudizhu', store), 'rank');
  assert.equal(handSortStorageKey('doudizhu'), 'ddz:hand-sort:doudizhu');
  assert.equal(handSortStorageKey('guandan'), 'ddz:hand-sort:guandan');

  writeHandSortMode('doudizhu', 'combo', store);
  writeHandSortMode('guandan', 'suit', store);
  assert.equal(readHandSortMode('doudizhu', store), 'combo');
  assert.equal(readHandSortMode('guandan', store), 'suit');

  store.setItem(handSortStorageKey('doudizhu'), 'sideways');
  assert.equal(readHandSortMode('doudizhu', store), 'rank');

  const order: HandSortMode[] = ['rank', 'suit', 'combo', 'rank'];
  for (let index = 0; index < order.length - 1; index += 1) {
    assert.equal(nextHandSortMode(order[index]!), order[index + 1]);
  }
  // Storage failure never throws.
  const blocked: StorageLike = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  assert.equal(readHandSortMode('doudizhu', blocked), 'rank');
  assert.doesNotThrow(() => writeHandSortMode('doudizhu', 'combo', blocked));
});
