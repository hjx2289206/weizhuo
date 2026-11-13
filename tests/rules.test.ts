// Permanent rule tests for the authoritative Doudizhu engine (pure functions).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card, Suit } from '../shared/protocol';
import { DECK_SIZE, canBeat, createDeck, detectPlay, scoreGame } from '../server/rules';

let seq = 0;
function card(rank: number, suit: Suit = 'spade'): Card {
  seq += 1;
  return { id: `${suit[0]}${rank}_${seq}`, rank, suit };
}

/** `hand([3, 3, 4])` -> three cards with distinct ids. */
function hand(ranks: number[]): Card[] {
  return ranks.map((rank) => card(rank));
}

function kindOf(ranks: number[]): string | null {
  return detectPlay(hand(ranks))?.kind ?? null;
}

test('deck has 54 unique cards: four of each 3..15 plus two jokers', () => {
  const deck = createDeck();
  assert.equal(deck.length, DECK_SIZE);
  assert.equal(new Set(deck.map((c) => c.id)).size, DECK_SIZE);
  for (let rank = 3; rank <= 15; rank += 1) {
    assert.equal(deck.filter((c) => c.rank === rank).length, 4, `rank ${rank}`);
  }
  assert.equal(deck.filter((c) => c.rank === 16).length, 1);
  assert.equal(deck.filter((c) => c.rank === 17).length, 1);
  assert.equal(deck.filter((c) => c.suit === 'joker').length, 2);
});

test('basic shapes: single, pair, triple, bomb, rocket', () => {
  assert.equal(kindOf([3]), 'single');
  assert.equal(kindOf([3, 15]), null); // junk two cards
  assert.equal(kindOf([9, 9]), 'pair');
  assert.equal(kindOf([9, 9, 9]), 'triple');
  assert.equal(kindOf([9, 9, 9, 9]), 'bomb');
  assert.equal(kindOf([16, 17]), 'rocket');
  assert.equal(kindOf([16, 16]), null); // two small jokers are never a pair
  assert.equal(kindOf([17, 17]), null); // two big jokers are never a pair
  assert.equal(kindOf([16, 16, 17]), null);
  assert.equal(kindOf([16, 16, 16, 16]), null); // jokers are never a bomb
  assert.equal(kindOf([15, 16]), null); // 2 + joker is not a pair
});

test('triple with wings: triple+single and triple+pair', () => {
  assert.equal(kindOf([7, 7, 7, 3]), 'triple_single');
  assert.equal(kindOf([7, 7, 7, 3, 3]), 'triple_pair');
  assert.equal(kindOf([7, 7, 7, 3, 4]), null); // 3+2 of different ranks is not a pair wing
});

test('straight requires >=5 consecutive singles and excludes 2 and jokers', () => {
  assert.equal(kindOf([3, 4, 5, 6, 7]), 'straight');
  assert.equal(kindOf([10, 11, 12, 13, 14]), 'straight');
  assert.equal(kindOf([3, 4, 5, 6]), null); // too short
  assert.equal(kindOf([3, 4, 5, 6, 8]), null); // not consecutive
  assert.equal(kindOf([11, 12, 13, 14, 15]), null); // contains 2
  assert.equal(kindOf([11, 12, 13, 14, 15, 16]), null); // contains 2 and joker
});

test('consecutive pairs require >=3 pairs and exclude 2', () => {
  assert.equal(kindOf([3, 3, 4, 4, 5, 5]), 'pairs_run');
  assert.equal(kindOf([3, 3, 4, 4]), null); // too short
  assert.equal(kindOf([13, 13, 14, 14, 15, 15]), null); // contains 2
});

test('consecutive triples (airplane body) require >=2 runs and exclude 2', () => {
  assert.equal(kindOf([3, 3, 3, 4, 4, 4]), 'triples_run');
  assert.equal(kindOf([3, 3, 3, 4, 4, 4, 5, 5, 5]), 'triples_run');
  assert.equal(kindOf([3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6]), 'triples_run');
  assert.equal(kindOf([14, 14, 14, 15, 15, 15]), null); // contains 2
});

test('airplane single wings: one wing per triple, wing ranks repeat at most twice', () => {
  const played = detectPlay(hand([3, 3, 3, 4, 4, 4, 9, 10]));
  assert.equal(played?.kind, 'airplane_single');
  assert.equal(played?.main, 4);
  assert.equal(played?.length, 8);
  assert.equal(kindOf([3, 3, 3, 4, 4, 4, 9, 9]), 'airplane_single'); // a pair as two wings
  assert.equal(kindOf([3, 3, 3, 4, 4, 4, 9, 9, 9, 9]), null); // four-of-a-kind wing rejected
  assert.equal(kindOf([3, 3, 3, 4, 4, 4, 16, 16]), null); // two jokers never act as a single wing pair
  assert.equal(kindOf([3, 3, 3, 4, 4, 4, 16, 17]), 'airplane_single'); // one joker per wing is allowed
  assert.equal(kindOf([3, 3, 3, 4, 4, 4, 9]), null); // wrong wing count
});

test('airplane pair wings: one distinct pair per triple', () => {
  const played = detectPlay(hand([3, 3, 3, 4, 4, 4, 9, 9, 10, 10]));
  assert.equal(played?.kind, 'airplane_pair');
  assert.equal(played?.main, 4);
  assert.equal(played?.length, 10);
  assert.equal(kindOf([3, 3, 3, 4, 4, 4, 9, 9, 9, 10]), null); // wings are not all pairs
});

test('four with two cards: any two singles, exactly two pairs', () => {
  assert.equal(kindOf([6, 6, 6, 6, 3, 9]), 'four_two_single');
  assert.equal(kindOf([6, 6, 6, 6, 3, 3]), 'four_two_single'); // pair allowed as two singles
  assert.equal(kindOf([6, 6, 6, 6, 3, 3, 9, 9]), 'four_two_pair');
  assert.equal(kindOf([6, 6, 6, 6, 3, 3, 3, 3]), null); // not two pairs
  assert.equal(kindOf([6, 6, 6, 6, 3]), null); // wrong size
});

test('canBeat enforces same kind and length, with bomb and rocket precedence', () => {
  const single = (r: number) => detectPlay(hand([r]))!;
  const straight = (from: number) => detectPlay(hand([from, from + 1, from + 2, from + 3, from + 4]))!;
  const bomb = (r: number) => detectPlay(hand([r, r, r, r]))!;
  const rocket = detectPlay(hand([16, 17]))!;

  assert.equal(canBeat(single(5), single(4)), true);
  assert.equal(canBeat(single(4), single(5)), false);
  assert.equal(canBeat(single(4), null), true);
  assert.equal(canBeat(straight(4), straight(3)), true);
  assert.equal(canBeat(straight(4), straight(3)) && canBeat(straight(3), straight(4)), false);
  assert.equal(canBeat(straight(3), single(9)), false); // different kind
  assert.equal(canBeat(bomb(3), straight(3)), true);
  assert.equal(canBeat(bomb(3), bomb(4)), false);
  assert.equal(canBeat(bomb(5), bomb(4)), true);
  assert.equal(canBeat(bomb(5), rocket), false);
  assert.equal(canBeat(rocket, bomb(15)), true);
  assert.equal(canBeat(single(15), bomb(3)), false);
});

test('scoreGame is zero-sum and scales with bid and multiplier', () => {
  const landlordWin = scoreGame({ winner: 'landlord', landlord: 1, bid: 2, multiplier: 4 });
  assert.deepEqual(landlordWin, [-8, 16, -8]);
  assert.equal(landlordWin.reduce((a, b) => a + b, 0), 0);

  const farmersWin = scoreGame({ winner: 'farmers', landlord: 0, bid: 3, multiplier: 1 });
  assert.deepEqual(farmersWin, [-6, 3, 3]);
  assert.equal(farmersWin.reduce((a, b) => a + b, 0), 0);
});
