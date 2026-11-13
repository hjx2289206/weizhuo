// Permanent Guandan card-rule tests: legality, sequence windows, wildcard semantics, the strict
// comparator and the tribute/return eligibility helpers. Pure module, no server or DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card, Suit } from '../shared/protocol';
import {
  GUANDAN_CARD_COUNT,
  GUANDAN_HAND_SIZE,
  GUANDAN_LEVELS,
  canBeatGuandan,
  createGuandanDeck,
  enumerateGuandanPlays,
  guandanRankStrength,
  guandanReturnEligible,
  guandanTributeEligible,
  isGuandanWild,
  sortGuandanHand,
  type GuandanDeclaration,
  strongestGuandanOption,
  type GuandanOption,
} from '../shared/guandan';

const SUIT_CHAR: Record<Suit, string> = { spade: 's', heart: 'h', club: 'c', diamond: 'd', joker: 'j' };
const LEVEL = 9; // playing 9: every 9 is a level card, the two heart 9s are wildcards

let seq = 0;
function card(rank: number, suit: Suit = 'spade'): Card {
  seq += 1;
  return { id: `${SUIT_CHAR[suit]}${rank}#${seq}`, rank, suit };
}
function wild(level = LEVEL): Card {
  return card(level, 'heart');
}
function options(cards: Card[], level = LEVEL): GuandanOption[] {
  return enumerateGuandanPlays(cards, level);
}
function kinds(cards: Card[], level = LEVEL): string[] {
  return options(cards, level).map((option) => option.declaration.kind);
}
function keys(cards: Card[], level = LEVEL): string[] {
  return options(cards, level).map((option) => option.declaration.key);
}
/** First reading of the given kind; fails loudly when the kind is not offered. */
function declarationOf(cards: Card[], kind: string, level = LEVEL): GuandanDeclaration {
  const found = options(cards, level).find((option) => option.declaration.kind === kind);
  assert.ok(found, `expected a ${kind} reading of ${cards.map((c) => c.rank).join(',')}`);
  return found.declaration;
}
function deck() {
  return createGuandanDeck();
}
function rankCards(rank: number, count: number, level = LEVEL): Card[] {
  // Real ids from a real deck, so face-uniqueness stays honest.
  const pool = deck().filter((c) => c.rank === rank && !isGuandanWild(c, level));
  assert.ok(pool.length >= count, `deck holds ${pool.length} plain ${rank}s`);
  return pool.slice(0, count);
}
function wildCards(count = 2, level = LEVEL): Card[] {
  const pool = deck().filter((c) => isGuandanWild(c, level));
  assert.equal(pool.length, 2);
  return pool.slice(0, count);
}

test('deck: two full decks, 108 unique physical ids, two per face', () => {
  const cards = deck();
  assert.equal(cards.length, GUANDAN_CARD_COUNT);
  assert.equal(new Set(cards.map((c) => c.id)).size, GUANDAN_CARD_COUNT);
  const faces = new Map<string, number>();
  for (const item of cards) {
    const face = `${item.suit}:${item.rank}`;
    faces.set(face, (faces.get(face) ?? 0) + 1);
  }
  for (const [face, count] of faces) assert.equal(count, 2, face);
  assert.equal(cards.filter((c) => c.suit === 'joker').length, 4);
  for (const rank of GUANDAN_LEVELS) assert.equal(cards.filter((c) => c.rank === rank).length, 8, `rank ${rank}`);
  // Guandan ids must not collide with the Doudizhu deck's `s3`/`j16` style ids.
  assert.equal(cards.filter((c) => c.id.startsWith('g')).length, GUANDAN_CARD_COUNT);
});

test('rank strength: 2 is the weakest card, the level rank sits above A, jokers on top', () => {
  assert.equal(guandanRankStrength(15, LEVEL), 2);
  assert.equal(guandanRankStrength(3, LEVEL), 3);
  assert.equal(guandanRankStrength(14, LEVEL), 14);
  assert.equal(guandanRankStrength(LEVEL, LEVEL), 15);
  assert.equal(guandanRankStrength(16, LEVEL), 16);
  assert.equal(guandanRankStrength(17, LEVEL), 17);
  // With the level on 2 the same raw rank is the boosted one instead.
  assert.equal(guandanRankStrength(15, 15), 15);
  assert.equal(guandanRankStrength(3, 15), 3);
});

test('automatic wildcard recognition selects the level fullhouse and never a weaker triple', () => {
  const cards = [card(12), card(12, 'club'), card(15, 'club'), card(15, 'diamond'), wild(15)];
  const chosen = strongestGuandanOption(options(cards, 15), 15);
  assert.equal(chosen?.declaration.kind, 'triplePair');
  assert.equal(chosen?.declaration.primaryRank, 15);
  assert.equal(chosen?.declaration.secondaryRank, 12);
  const kings = [card(13), card(13), card(13, 'club'), card(15, 'club'), card(15, 'diamond')];
  assert.equal(strongestGuandanOption(options(kings, 15), 15, chosen!.declaration), null);
});

test('automatic wildcard recognition prefers the highest straight flush over ordinary and lower windows', () => {
  const cards = [card(3), card(4), card(5), card(6), wild(15)];
  const readings = options(cards, 15);
  const chosen = strongestGuandanOption(readings, 15);
  assert.equal(chosen?.declaration.kind, 'straightFlush');
  assert.equal(chosen?.declaration.low, 3);
  assert.equal(chosen?.declaration.primaryRank, 7);
  const previous = declarationOf([card(10, 'club'), card(11), card(12), card(13), card(14)], 'straight', 15);
  assert.equal(strongestGuandanOption(readings, 15, previous)?.declaration.key, chosen?.declaration.key);
  const higherFlush = declarationOf([card(4), card(5), card(6), card(7), card(8)], 'straightFlush', 15);
  assert.equal(strongestGuandanOption(readings, 15, higherFlush), null);
});

test('two wildcards automatically form the level pair, not the highest natural rank', () => {
  assert.equal(strongestGuandanOption(options(wildCards(2), LEVEL), LEVEL)?.declaration.primaryRank, LEVEL);
});

test('hand sort: jokers, then level cards, then the natural ladder; input untouched', () => {
  const input = [card(3), card(15), card(LEVEL), card(17, 'joker'), card(14)];
  const snapshot = input.map((c) => c.id);
  const sorted = sortGuandanHand(input, LEVEL);
  assert.deepEqual(input.map((c) => c.id), snapshot);
  assert.deepEqual(sorted.map((c) => c.rank), [17, 9, 14, 3, 15]);
  // Equal strength keeps the caller's order.
  const ties = [card(4, 'club'), card(4, 'diamond')];
  assert.deepEqual(sortGuandanHand(ties, LEVEL).map((c) => c.id), ties.map((c) => c.id));
  assert.equal(GUANDAN_HAND_SIZE, 27);
});

test('every option consumes the whole selection and has a unique stable key', () => {
  const cases: Card[][] = [
    [card(3)],
    [wild(), card(9, 'spade')],
    [wild(), wild()],
    rankCards(3, 3).concat(wildCards(2)),
    [wild(), card(4, 'spade'), card(5, 'spade'), card(6, 'spade'), card(7, 'spade')],
    wildCards(2).concat(rankCards(7, 2), rankCards(8, 2)),
    rankCards(7, 4),
    deck().filter((c) => c.rank === 16 || c.rank === 17),
  ];
  for (const cards of cases) {
    const list = options(cards);
    assert.ok(list.length > 0, `expected readings for ${cards.length} cards`);
    const keySet = new Set<string>();
    for (const option of list) {
      assert.equal(option.declaration.count, cards.length);
      assert.equal(option.cards.length, cards.length);
      assert.deepEqual(
        option.cards.map((c) => c.id).sort(),
        cards.map((c) => c.id).sort(),
      );
      assert.ok(option.declaration.label.length > 0);
      keySet.add(option.declaration.key);
    }
    assert.equal(keySet.size, list.length, 'keys must not repeat');
  }
});

test('reading keys are independent of the order the same cards were selected in', () => {
  const selection = [wild(), card(4, 'spade'), card(5, 'spade'), card(6, 'spade'), card(7, 'spade')];
  const reversed = [...selection].reverse();
  assert.deepEqual(keys(reversed).sort(), keys(selection).sort());
  const pair = [wild(), wild()];
  assert.deepEqual(keys([...pair].reverse()), keys(pair));
});

test('lone wildcard is only its natural level single, never an arbitrary weaker single', () => {
  const list = options([wild()]);
  assert.equal(list.length, 1);
  assert.equal(list[0].declaration.kind, 'single');
  assert.equal(list[0].declaration.primaryRank, LEVEL);
  assert.deepEqual(list[0].declaration.substitutions, []);
});

test('pairs: wildcard inherits the natural rank, never a joker, two wildcards pick a rank', () => {
  assert.deepEqual(kinds([card(4), card(4, 'club')]), ['pair']);
  const withWild = options([wild(), card(4)]);
  assert.equal(withWild.length, 1);
  assert.equal(withWild[0].declaration.primaryRank, 4);
  assert.deepEqual(withWild[0].declaration.substitutions, [{ cardId: withWild[0].cards[1].id, rank: 4, suit: 'heart' }]);
  assert.deepEqual(options([wild(), card(17, 'joker')]), []);
  assert.deepEqual(kinds([card(16, 'joker'), card(16, 'joker')]), ['pair']);
  assert.deepEqual(options([card(16, 'joker'), card(17, 'joker')]), []);
  const twoWilds = options([wild(), wild()]);
  assert.equal(twoWilds.length, GUANDAN_LEVELS.length);
  assert.deepEqual(
    twoWilds.map((o) => o.declaration.primaryRank).sort((a, b) => a - b),
    [...GUANDAN_LEVELS].sort((a, b) => a - b),
  );
  const natural = twoWilds.find((o) => o.declaration.primaryRank === LEVEL);
  assert.ok(natural);
  assert.deepEqual(natural.declaration.substitutions, []);
  assert.equal(twoWilds[0].declaration.primaryRank, LEVEL);
  // A wildcard beside a plain level card is a natural level pair, not a substitution.
  const levelPair = options([wild(), card(LEVEL, 'club')]);
  assert.deepEqual(levelPair.map((o) => o.declaration.key), [`pair|2|${LEVEL}|x|x|x`]);
  assert.deepEqual(levelPair[0].declaration.substitutions, []);
  assert.equal(guandanRankStrength(levelPair[0].declaration.primaryRank, LEVEL), 15);
  // ... while a heart level card used in a non-level pair is recorded as a substitution.
  const offLevelPair = options([wild(), card(8, 'club')]);
  assert.deepEqual(offLevelPair[0].declaration.substitutions, [
    { cardId: offLevelPair[0].cards[1].id, rank: 8, suit: 'heart' },
  ]);
});

test('triples: two wildcards add to a natural rank, jokers can never be a triple', () => {
  const list = options([wild(), wild(), card(3)]);
  assert.equal(list.length, 1);
  assert.equal(list[0].declaration.kind, 'triple');
  assert.equal(list[0].declaration.primaryRank, 3);
  assert.deepEqual(kinds([card(5), card(5, 'club'), wild()]), ['triple']);
  assert.deepEqual(options([card(16, 'joker'), card(16, 'joker'), wild()]), []);
  assert.deepEqual(options([card(5), card(5, 'club'), card(6)]), []);
});

test('sequences: exactly five consecutive slots, A can be low, K-A-2 never wraps', () => {
  const a2345 = declarationOf([card(14), card(15, 'heart'), card(3, 'club'), card(4, 'diamond'), card(5)], 'straight');
  assert.equal(a2345.low, 1);
  assert.equal(a2345.primaryRank, 5);
  const tenToAce = declarationOf(
    [card(10), card(11, 'heart'), card(12, 'club'), card(13, 'diamond'), card(14)],
    'straight',
  );
  assert.equal(tenToAce.low, 10);
  assert.equal(tenToAce.primaryRank, 14);
  // J-Q-K-A-2 and K-A-2 shapes are not sequences.
  assert.deepEqual(options([card(11), card(12), card(13), card(14), card(15)]), []);
  assert.deepEqual(options([card(13), card(14), card(15), card(3), card(4)]), []);
  // Four cards are not a straight; six cards are not a straight.
  assert.deepEqual(kinds([card(3), card(4), card(5), card(6)]), []);
  assert.equal(keys([card(3), card(4), card(5), card(6), card(7), card(8)]).length, 0);
});

test('a wildcard fills a gap at either end and the slots are ordered low to high', () => {
  const list = options([wild(), card(4), card(5, 'club'), card(6, 'diamond'), card(7)]);
  const straights = list.filter((o) => o.declaration.kind === 'straight');
  assert.deepEqual(
    straights.map((o) => o.declaration.low ?? 0).sort((a, b) => a - b),
    [3, 4],
  );
  const lowWindow = straights.find((o) => o.declaration.low === 3);
  assert.ok(lowWindow);
  assert.deepEqual(lowWindow.cards.map((c) => c.rank), [LEVEL, 4, 5, 6, 7]);
  const highWindow = straights.find((o) => o.declaration.low === 4);
  assert.ok(highWindow);
  assert.deepEqual(highWindow.cards.map((c) => c.rank), [4, 5, 6, 7, LEVEL]);
  // One gap is covered by the wildcard; two separate gaps are not.
  assert.equal(kinds([wild(), card(4), card(5), card(7), card(8)]).includes('straight'), true);
  assert.deepEqual(kinds([wild(), card(3), card(4), card(6), card(8)]), []);
  // Duplicate ranks never form a straight.
  assert.deepEqual(kinds([card(4), card(4, 'club'), card(5), card(6), card(7)]), []);
});

test('straight flush: natural same-suit five is never downgraded, a wildcard offers both readings', () => {
  const natural = options([card(4, 'spade'), card(5, 'spade'), card(6, 'spade'), card(7, 'spade'), card(8, 'spade')]);
  assert.deepEqual(natural.map((o) => o.declaration.kind), ['straightFlush']);
  assert.equal(natural[0].declaration.suit, 'spade');
  const mixed = options([card(4, 'spade'), card(5, 'heart'), card(6, 'club'), card(7, 'diamond'), card(8, 'spade')]);
  assert.deepEqual(mixed.map((o) => o.declaration.kind), ['straight']);

  const withWild = options([wild(), card(4, 'spade'), card(5, 'spade'), card(6, 'spade'), card(7, 'spade')]);
  assert.deepEqual(new Set(withWild.map((o) => o.declaration.kind)), new Set(['straight', 'straightFlush']));
  for (const option of withWild) {
    assert.deepEqual(
      option.cards.map((c) => c.rank).sort((a, b) => a - b),
      [4, 5, 6, 7, LEVEL],
    );
  }
  const flush = withWild.find((o) => o.declaration.kind === 'straightFlush' && o.declaration.low === 4);
  assert.ok(flush);
  assert.equal(flush.declaration.suit, 'spade');
  assert.deepEqual(flush.declaration.substitutions, [{ cardId: flush.cards[4].id, rank: 8, suit: 'spade' }]);
  // The ordinary reading fills the same slot in another suit, so the substitution is still recorded.
  const ordinary = withWild.find((o) => o.declaration.kind === 'straight' && o.declaration.low === 4);
  assert.ok(ordinary);
  assert.deepEqual(ordinary.declaration.substitutions, [{ cardId: ordinary.cards[4].id, rank: 8, suit: 'heart' }]);
});

test('a wildcard at its own rank but in another suit is still a substitution', () => {
  const list = options([card(7, 'spade'), card(8, 'spade'), wild(), card(10, 'spade'), card(11, 'spade')]);
  const flush = list.find((o) => o.declaration.kind === 'straightFlush');
  assert.ok(flush);
  assert.deepEqual(flush.declaration.substitutions, [{ cardId: flush.cards[2].id, rank: LEVEL, suit: 'spade' }]);
  const ordinary = list.find((o) => o.declaration.kind === 'straight');
  assert.ok(ordinary);
  assert.deepEqual(ordinary.declaration.substitutions, []);
});

test('three pairs: AA2233 low 1, QQKKAA low 12, K-A-2 rejected, deficits must match the wildcards', () => {
  const low = declarationOf([card(14), card(14, 'club'), card(15), card(15, 'club'), card(3), card(3, 'club')], 'threePairs');
  assert.equal(low.low, 1);
  assert.equal(low.primaryRank, 3);
  const high = declarationOf(
    [card(12), card(12, 'club'), card(13), card(13, 'club'), card(14), card(14, 'club')],
    'threePairs',
  );
  assert.equal(high.low, 12);
  assert.deepEqual(options([card(13), card(13, 'club'), card(14), card(14, 'club'), card(15), card(15, 'club')]), []);
  const filled = options([wild(), wild(), card(7), card(7, 'club'), card(8), card(8, 'club')]);
  assert.deepEqual(
    filled.filter((o) => o.declaration.kind === 'threePairs').map((o) => o.declaration.low ?? 0).sort((a, b) => a - b),
    [6, 7],
  );
  assert.deepEqual(kinds([wild(), card(7), card(7, 'club'), card(8), card(8, 'club'), card(10)]), []);
  // 7,7,8,8 with a 9 and a wildcard is a complete 7-8-9 pair run.
  assert.deepEqual(kinds([wild(), card(7), card(7, 'club'), card(8), card(8, 'club'), card(9)]), ['threePairs']);
});

test('two triples: AAA222 low 1, KKKAAA low 13, and 7788 with both wildcards is also a three-pair run', () => {
  const low = declarationOf([card(14), card(14, 'club'), card(14, 'diamond'), card(15), card(15, 'club'), card(15, 'diamond')], 'twoTriples');
  assert.equal(low.low, 1);
  assert.equal(low.primaryRank, 15);
  const high = declarationOf(
    [card(13), card(13, 'club'), card(13, 'diamond'), card(14), card(14, 'club'), card(14, 'diamond')],
    'twoTriples',
  );
  assert.equal(high.low, 13);
  const ambiguous = options([wild(), wild(), card(7), card(7, 'club'), card(8), card(8, 'club')]);
  assert.deepEqual(new Set(ambiguous.map((o) => o.declaration.kind)), new Set(['threePairs', 'twoTriples']));
  const steel = ambiguous.find((o) => o.declaration.kind === 'twoTriples');
  assert.ok(steel);
  assert.deepEqual(steel.cards.map((c) => c.rank), [7, 7, LEVEL, 8, 8, LEVEL]);
});

test('bombs: 4 to 10 cards, count first, level rank capped at the eight level cards', () => {
  assert.deepEqual(kinds(rankCards(7, 4)), ['bomb']);
  assert.deepEqual(kinds(rankCards(7, 6)), ['bomb']);
  const tenBomb = options(rankCards(8, 8).concat(wildCards(2)));
  assert.deepEqual(tenBomb.map((o) => o.declaration.key), ['bomb|10|8|x|x|x']);
  const levelBomb = options(deck().filter((c) => c.rank === LEVEL));
  assert.deepEqual(levelBomb.map((o) => o.declaration.key), [`bomb|8|${LEVEL}|x|x|x`]);
  assert.deepEqual(levelBomb[0].declaration.substitutions, []);
  const nineCards = options(rankCards(8, 8).concat(wildCards(2)).slice(0, 9));
  assert.deepEqual(nineCards.map((o) => o.declaration.count), [9]);
  // Three wildcards cannot exist; a selection with a repeated face is invalid input.
  assert.throws(() => options([...wildCards(2), wild()]), /more than 2 copies/);
});

test('five equal cards are a bomb only, never a 3+2 with the same triple and pair rank', () => {
  const five = options(rankCards(7, 5));
  assert.deepEqual(five.map((o) => o.declaration.kind), ['bomb']);
  const withWilds = options(rankCards(3, 2).concat(wildCards(2)));
  assert.deepEqual(withWilds.map((o) => o.declaration.kind), ['bomb']);
  assert.equal(withWilds[0].declaration.count, 4);
});

test('three with two: triple and pair ranks stay distinct, joker pairs allowed, wildcards never jokers', () => {
  const list = options([card(6), card(6, 'club'), card(6, 'diamond'), card(13), card(13, 'club')]);
  assert.deepEqual(list.map((o) => o.declaration.key), ['triplePair|5|6|13|x|x']);
  const jokerPair = options([card(6), card(6, 'club'), card(6, 'diamond'), card(17, 'joker'), card(17, 'joker')]);
  assert.deepEqual(jokerPair.map((o) => o.declaration.key), ['triplePair|5|6|17|x|x']);
  // One wildcard can never complete a pair of jokers.
  const wildJoker = options([wild(), card(6), card(6, 'club'), card(6, 'diamond'), card(17, 'joker')]);
  assert.deepEqual(wildJoker, []);
  // The wildcard may complete either group, so 666+KK and KKK+66 are both offered.
  const wildTriple = options([wild(), card(6), card(6, 'club'), card(13), card(13, 'club')]);
  assert.deepEqual(
    wildTriple.map((o) => o.declaration.key).sort(),
    ['triplePair|5|13|6|x|x', 'triplePair|5|6|13|x|x'],
  );
  const sixTriple = wildTriple.find((o) => o.declaration.primaryRank === 6);
  assert.ok(sixTriple);
  assert.deepEqual(sixTriple.declaration.substitutions, [{ cardId: sixTriple.cards[2].id, rank: 6, suit: 'heart' }]);
  const kingTriple = wildTriple.find((o) => o.declaration.primaryRank === 13);
  assert.ok(kingTriple);
  assert.deepEqual(kingTriple.declaration.substitutions, [{ cardId: kingTriple.cards[2].id, rank: 13, suit: 'heart' }]);
});

test('four jokers: only the four natural jokers, and it outranks every bomb', () => {
  const natural = options(deck().filter((c) => c.rank === 16 || c.rank === 17));
  assert.deepEqual(natural.map((o) => o.declaration.kind), ['fourJokers']);
  assert.deepEqual(natural[0].declaration.substitutions, []);
  assert.deepEqual(options([card(16, 'joker'), card(16, 'joker'), card(17, 'joker'), wild()]), []);
  assert.deepEqual(options([card(7), card(7, 'club'), card(7, 'diamond'), card(7, 'heart')]).map((o) => o.declaration.kind), ['bomb']);
});

test('comparator: four jokers > 6+ bombs (count first) > straight flush > 5 bomb > 4 bomb > ordinary', () => {
  const bomb4 = declarationOf(rankCards(7, 4), 'bomb');
  const bomb5 = declarationOf(rankCards(7, 5), 'bomb');
  const bomb6 = declarationOf(rankCards(7, 6), 'bomb');
  const bomb8 = declarationOf(rankCards(7, 8), 'bomb');
  const flush = declarationOf([card(4, 'spade'), card(5, 'spade'), card(6, 'spade'), card(7, 'spade'), card(8, 'spade')], 'straightFlush');
  const jokers = declarationOf(
    deck().filter((c) => c.rank === 16 || c.rank === 17),
    'fourJokers',
  );
  const pairA = declarationOf([card(14), card(14, 'club')], 'pair');

  assert.equal(canBeatGuandan(bomb5, bomb4, LEVEL), true);
  assert.equal(canBeatGuandan(bomb4, bomb5, LEVEL), false);
  assert.equal(canBeatGuandan(bomb6, bomb5, LEVEL), true);
  assert.equal(canBeatGuandan(bomb5, flush, LEVEL), false);
  assert.equal(canBeatGuandan(flush, bomb5, LEVEL), true);
  assert.equal(canBeatGuandan(bomb6, flush, LEVEL), true);
  assert.equal(canBeatGuandan(flush, bomb6, LEVEL), false);
  assert.equal(canBeatGuandan(bomb8, bomb6, LEVEL), true);
  assert.equal(canBeatGuandan(bomb6, bomb8, LEVEL), false);
  assert.equal(canBeatGuandan(jokers, bomb8, LEVEL), true);
  assert.equal(canBeatGuandan(bomb8, jokers, LEVEL), false);
  assert.equal(canBeatGuandan(jokers, jokers, LEVEL), false);
  assert.equal(canBeatGuandan(bomb4, pairA, LEVEL), true);
  assert.equal(canBeatGuandan(pairA, bomb4, LEVEL), false);
  // Equal never beats, and no suit tiebreak exists.
  assert.equal(canBeatGuandan(bomb4, bomb4, LEVEL), false);
});

test('comparator: boosted level groups, ordinary kinds only beat their own kind, sequences compare low', () => {
  const levelBomb = declarationOf(deck().filter((c) => c.rank === LEVEL && c.suit !== 'heart').slice(0, 4), 'bomb');
  const aceBomb = declarationOf(deck().filter((c) => c.rank === 14).slice(0, 4), 'bomb');
  assert.equal(canBeatGuandan(levelBomb, aceBomb, LEVEL), true);
  assert.equal(canBeatGuandan(aceBomb, levelBomb, LEVEL), false);

  const pairLevel = declarationOf([card(LEVEL), card(LEVEL, 'club')], 'pair');
  const pairAce = declarationOf([card(14), card(14, 'club')], 'pair');
  const pairSmallJoker = declarationOf([card(16, 'joker'), card(16, 'joker')], 'pair');
  assert.equal(canBeatGuandan(pairLevel, pairAce, LEVEL), true);
  assert.equal(canBeatGuandan(pairSmallJoker, pairLevel, LEVEL), true);
  assert.equal(canBeatGuandan(pairLevel, pairSmallJoker, LEVEL), false);

  const lowStraight = declarationOf([card(14), card(15, 'heart'), card(3, 'club'), card(4, 'diamond'), card(5)], 'straight');
  const highStraight = declarationOf(
    [card(10), card(11, 'heart'), card(12, 'club'), card(13, 'diamond'), card(14)],
    'straight',
  );
  assert.equal(canBeatGuandan(highStraight, lowStraight, LEVEL), true);
  assert.equal(canBeatGuandan(lowStraight, highStraight, LEVEL), false);
  assert.equal(canBeatGuandan(lowStraight, lowStraight, LEVEL), false);

  const triple = declarationOf([card(6), card(6, 'club'), card(6, 'diamond')], 'triple');
  assert.equal(canBeatGuandan(triple, pairAce, LEVEL), false);
  assert.equal(canBeatGuandan(pairAce, triple, LEVEL), false);

  // The 3+2 comparison uses the triple only, so pairs never decide it.
  const pairSix = declarationOf([card(6), card(6, 'club'), card(6, 'diamond'), card(13), card(13, 'club')], 'triplePair');
  const pairTwo = declarationOf([card(6), card(6, 'club'), card(6, 'diamond'), card(15), card(15, 'club')], 'triplePair');
  assert.equal(pairSix.secondaryRank, 13);
  assert.equal(pairTwo.secondaryRank, 15);
  assert.equal(canBeatGuandan(pairSix, pairTwo, LEVEL), false);
  assert.equal(canBeatGuandan(pairTwo, pairSix, LEVEL), false);
});

test('tribute eligibility: every highest-strength tie, wildcards excluded, level cards still eligible', () => {
  const hand = [
    card(17, 'joker'),
    card(17, 'joker'),
    card(16, 'joker'),
    card(14),
    card(LEVEL),
    card(LEVEL, 'club'),
    card(LEVEL, 'heart'),
  ];
  const eligible = guandanTributeEligible(hand, LEVEL);
  assert.deepEqual(eligible.map((c) => c.rank), [17, 17]);
  const noJokers = [card(14), card(14, 'club'), card(LEVEL), card(LEVEL, 'heart'), card(LEVEL, 'club')];
  const levelTies = guandanTributeEligible(noJokers, LEVEL);
  assert.deepEqual(levelTies.map((c) => c.suit), ['spade', 'club']);
  assert.deepEqual(guandanTributeEligible([wild(), wild()], LEVEL), []);
});

test('return eligibility: rank-order strength 10 or lower, level excluded, minimum ties as fallback', () => {
  const hand = [
    card(10),
    card(11, 'club'),
    card(12, 'diamond'),
    card(14),
    card(LEVEL),
    card(LEVEL, 'heart'),
    card(16, 'joker'),
  ];
  assert.deepEqual(guandanReturnEligible(hand, LEVEL).map((c) => c.rank), [10]);
  const withLow = [card(5), card(5, 'club'), card(15), card(14), card(LEVEL, 'heart')];
  // The raw-15 two counts as a low card; the A and the heart level wildcard do not.
  assert.deepEqual(guandanReturnEligible(withLow, LEVEL).map((c) => c.rank), [5, 5, 15]);
  // Nothing at or below 10: every minimum-strength tie is eligible instead.
  const highOnly = [card(11), card(11, 'club'), card(13), card(14), card(16, 'joker')];
  assert.deepEqual(guandanReturnEligible(highOnly, LEVEL).map((c) => c.suit), ['spade', 'club']);
  assert.deepEqual(guandanReturnEligible([], LEVEL), []);
});

test('invalid selections are rejected instead of silently producing a reading', () => {
  const duplicate = card(7);
  assert.throws(() => options([duplicate, duplicate]), /duplicate card id/);
  assert.throws(() => options([card(7), card(7), card(7)]), /more than 2 copies/);
  assert.throws(() => options([{ id: 'x', rank: 17, suit: 'spade' }]), /joker suit/);
  assert.throws(() => options([{ id: 'y', rank: 7, suit: 'joker' }]), /cannot use the joker suit/);
  assert.throws(() => options([{ id: 'z', rank: 2, suit: 'spade' }]), /illegal rank/);
  assert.deepEqual(options([]), []);
});
