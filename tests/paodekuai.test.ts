import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createDeck } from '../shared/doudizhu';
import {
  DEFAULT_PAODEKUAI_OPTIONS,
  canPaodekuaiPass,
  choosePaodekuaiPlay,
  createPaodekuaiDeck,
  detectPaodekuaiPlays,
  enumeratePaodekuaiPlays,
  scorePaodekuaiRound,
  scorePaodekuaiTrick,
  validatePaodekuaiPlay,
  type PaodekuaiOptions,
  type PaodekuaiPlay,
  type PaodekuaiScores,
  type PaodekuaiTurn,
} from '../shared/paodekuai';
import type { Card } from '../shared/protocol';

const deck = createPaodekuaiDeck();
const options = DEFAULT_PAODEKUAI_OPTIONS;
const threeAces = { ...options, threeAceBomb: true };
const optionalPass = { ...options, mustBeat: false };
const zero: PaodekuaiScores = [0, 0, 0];
const seats = [0, 1, 2] as const;

function face(id: string): Card {
  const card = deck.find((item) => item.id === id);
  assert.ok(card, `Fixture card ${id} is in the deck`);
  return card;
}

function cardsOf(...ranks: number[]): Card[] {
  const used = new Set<string>();
  return ranks.map((rank) => {
    const card = deck.find((item) => item.rank === rank && !used.has(item.id));
    assert.ok(card, `Fixture has a physical card at rank ${rank}`);
    used.add(card.id);
    return card;
  });
}

function turnWith(hand: readonly Card[], settings: Partial<Omit<PaodekuaiTurn, 'hand'>> = {}): PaodekuaiTurn {
  return { hand, previous: null, firstPlay: false, nextSeatSingle: false, options, ...settings };
}

function reading(cards: readonly Card[], lastHand = false, settings: Readonly<PaodekuaiOptions> = options): PaodekuaiPlay {
  const result = detectPaodekuaiPlays(cards, lastHand, settings);
  assert.equal(result.length, 1, `Expected a unique reading for ${cards.map((card) => card.id).join(' ')}`);
  return result[0];
}

function specification(play: PaodekuaiPlay): string {
  return `${play.kind}/${play.mainRank}/${play.groups}/${play.wings}/${play.cardCount}`;
}

function* nonemptySubsets<T>(items: readonly T[]): Generator<T[]> {
  for (let mask = 1; mask < 2 ** items.length; mask += 1) {
    const subset: T[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if ((mask & (1 << index)) !== 0) subset.push(items[index]);
    }
    yield subset;
  }
}

// Independent enumeration of physical IDs. Validation uses the public recognizer and turn rules,
// so the oracle has no knowledge of the candidate generator's shape and suit shortcuts.
function assertMatchesSubsets(turn: PaodekuaiTurn, label: string): void {
  const handById = new Map(turn.hand.map((card) => [card.id, card]));
  const expected = new Set<string>();
  const expectedRanks = new Set<string>();
  for (const ids of nonemptySubsets([...handById.keys()])) {
    const result = validatePaodekuaiPlay(turn, ids);
    if (!result.ok) continue;
    expected.add(specification(result.play));
    expectedRanks.add(ids.map((id) => handById.get(id)!.rank).sort((a, b) => a - b).join(','));
  }
  const candidates = enumeratePaodekuaiPlays(turn);
  const actual = new Set<string>();
  const actualRanks = new Set<string>();
  for (const candidate of candidates) {
    const result = validatePaodekuaiPlay(turn, candidate.cards);
    assert.ok(result.ok, `${label}: invalid candidate ${candidate.cards.join(' ')}`);
    assert.deepEqual(candidate.play, result.play, label);
    actual.add(specification(candidate.play));
    const rankSelection = candidate.cards.map((id) => handById.get(id)!.rank).sort((a, b) => a - b).join(',');
    assert.ok(!actualRanks.has(rankSelection), `${label}: duplicate suit permutation for ${rankSelection}`);
    actualRanks.add(rankSelection);
  }
  assert.equal(candidates.length > 0, expected.size > 0, label);
  assert.deepEqual(actual, expected, `${label}: reading coverage`);
  assert.deepEqual(actualRanks, expectedRanks, `${label}: rank selection coverage`);
  for (const mustBeat of [true, false]) {
    const expectedPass = turn.previous !== null && (!mustBeat || expected.size === 0);
    assert.equal(canPaodekuaiPass({ ...turn, options: { ...turn.options, mustBeat } }), expectedPass, label);
  }
}

function randomIntSource(seed: number): (upperBound: number) => number {
  return (upperBound) => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * upperBound);
  };
}

function shuffledDeck(randomInt: (upperBound: number) => number): Card[] {
  const shuffled = deck.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

test('Paodekuai uses the confirmed 48-card deck and rule defaults', () => {
  const ids = new Set(deck.map((card) => card.id));
  assert.equal(deck.length, 48);
  assert.equal(ids.size, 48);
  assert.deepEqual(createDeck().filter((card) => !ids.has(card.id)).map((card) => card.id).sort(),
    ['j16', 'j17', 'h15', 'c15', 'd15', 's14'].sort());
  assert.ok(ids.has('s3') && ids.has('s15'));
  assert.deepEqual(deck.filter((card) => card.rank === 14).map((card) => card.id).sort(), ['c14', 'd14', 'h14']);
  for (let rank = 3; rank <= 15; rank += 1) {
    assert.equal(deck.filter((card) => card.rank === rank).length, rank === 15 ? 1 : rank === 14 ? 3 : 4);
  }
  assert.deepEqual(options, { mustBeat: true, threeAceBomb: false });
  assert.deepEqual(createPaodekuaiDeck(), deck);
  assert.notEqual(createPaodekuaiDeck()[0], deck[0]);
});

test('Paodekuai recognizes singles, pairs and natural runs with exact limits', () => {
  assert.equal(reading(cardsOf(15)).kind, 'single');
  assert.deepEqual(reading(cardsOf(7, 7)), { kind: 'pair', mainRank: 7, groups: 1, wings: 0, cardCount: 2 });
  assert.deepEqual(reading(cardsOf(7, 7, 8, 8)), { kind: 'pairRun', mainRank: 8, groups: 2, wings: 0, cardCount: 4 });
  assert.equal(reading(cardsOf(13, 13, 14, 14)).mainRank, 14);
  assert.equal(reading(cardsOf(10, 11, 12, 13, 14)).kind, 'straight');
  assert.equal(reading(cardsOf(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14)).groups, 12);
  assert.equal(reading(['h7', 'h8', 'h9', 'h10', 'h11'].map(face)).kind, 'straight');
  for (const ranks of [[3, 4, 5, 6], [11, 12, 13, 14, 15], [14, 15, 3, 4, 5], [7, 7, 9, 9], [7, 7, 8]]) {
    assert.deepEqual(detectPaodekuaiPlays(cardsOf(...ranks), true), []);
  }
  assert.deepEqual(detectPaodekuaiPlays([face('s3'), face('s3')], true), []);
  assert.deepEqual(detectPaodekuaiPlays([{ ...face('s3'), rank: 4 }], true), []);
  assert.deepEqual(detectPaodekuaiPlays(createDeck().filter((card) => card.id === 'j17'), true), []);
});

test('Paodekuai restricts three-card bodies and attachments to the confirmed shapes', () => {
  const triple = cardsOf(7, 7, 7);
  const tripleSingle = cardsOf(7, 7, 7, 8);
  assert.equal(reading(triple, true).kind, 'triple');
  assert.equal(reading(tripleSingle, true).kind, 'tripleSingle');
  assert.deepEqual(detectPaodekuaiPlays(triple, false), []);
  assert.deepEqual(detectPaodekuaiPlays(tripleSingle, false), []);
  for (const wings of [[8, 9], [8, 8], [8, 15]]) {
    assert.deepEqual(reading(cardsOf(7, 7, 7, ...wings)), {
      kind: 'tripleTwo', mainRank: 7, groups: 1, wings: 2, cardCount: 5,
    });
  }
  const fourWithThree = reading(cardsOf(7, 7, 7, 7, 8, 9, 10));
  assert.deepEqual(fourWithThree, { kind: 'fourWithThree', mainRank: 7, groups: 1, wings: 3, cardCount: 7 });
  assert.deepEqual(scorePaodekuaiTrick({ seat: 0, play: fourWithThree }), zero);
  for (const wings of [[8], [8, 8], [8, 8, 8]]) {
    assert.deepEqual(detectPaodekuaiPlays(cardsOf(7, 7, 7, 7, ...wings), true), []);
  }
  const aces = cardsOf(14, 14, 14);
  assert.deepEqual(detectPaodekuaiPlays(aces, false), []);
  assert.equal(reading(aces, true).kind, 'triple');
  assert.equal(reading(aces, false, threeAces).kind, 'bomb');
  assert.equal(reading(aces, true, threeAces).kind, 'bomb');
  assert.equal(reading(cardsOf(14, 14, 14, 3, 4), false, threeAces).kind, 'tripleTwo');
  assert.equal(reading(cardsOf(13, 13, 13, 14, 14, 14), false, threeAces).kind, 'airplane');
});

test('Paodekuai airplane reading is unique because triples cannot be wings', () => {
  const bare = cardsOf(3, 3, 3, 4, 4, 4);
  assert.deepEqual(reading(bare), { kind: 'airplane', mainRank: 4, groups: 2, wings: 0, cardCount: 6 });
  const full = [...bare, ...['d5', 's6', 'h7', 'c7'].map(face)];
  assert.deepEqual(reading(full), { kind: 'airplane', mainRank: 4, groups: 2, wings: 4, cardCount: 10 });
  assert.deepEqual(detectPaodekuaiPlays(full.slice().reverse(), false), [reading(full)]);
  const short = [...bare, face('d5')];
  assert.equal(reading(short, true).wings, 1);
  assert.deepEqual(detectPaodekuaiPlays(short, false), []);
  assert.equal(validatePaodekuaiPlay(turnWith(short), short.map((card) => card.id)).ok, true);
  assert.equal(validatePaodekuaiPlay(turnWith([...short, face('s8')]), short.map((card) => card.id)).ok, false);
  for (const extra of [[9, 9, 9, 6], [5, 6, 7, 8, 9]]) {
    const invalid = [...bare, ...cardsOf(...extra)];
    assert.deepEqual(detectPaodekuaiPlays(invalid, false), []);
    assert.deepEqual(detectPaodekuaiPlays(invalid, true), []);
  }
  assert.deepEqual(detectPaodekuaiPlays(cardsOf(3, 3, 3, 3, 4, 4, 4, 5, 6, 7), true), []);
});

test('Paodekuai 3334445556 is a three-group airplane only as a last hand', () => {
  const cards = cardsOf(3, 3, 3, 4, 4, 4, 5, 5, 5, 6);
  // AAA is unrelated here. In either option, 555 must be body: treating it as wings exceeds two.
  for (const settings of [options, threeAces]) {
    assert.deepEqual(detectPaodekuaiPlays(cards, true, settings), [
      { kind: 'airplane', mainRank: 5, groups: 3, wings: 1, cardCount: 10 },
    ]);
    assert.deepEqual(detectPaodekuaiPlays(cards, false, settings), []);
  }
});

test('Paodekuai comparison selects a beating reading with the same ordinary specification', () => {
  const pairRun = reading(cardsOf(7, 7, 8, 8));
  const higherPairRun = reading(cardsOf(8, 8, 9, 9));
  const longerPairRun = reading(cardsOf(8, 8, 9, 9, 10, 10));
  assert.equal(choosePaodekuaiPlay([longerPairRun, higherPairRun], pairRun), higherPairRun);
  assert.equal(choosePaodekuaiPlay([longerPairRun], pairRun), null);
  assert.equal(choosePaodekuaiPlay([higherPairRun, longerPairRun], null), higherPairRun);
  assert.equal(choosePaodekuaiPlay([], null), null);
  assert.equal(choosePaodekuaiPlay([reading([face('h8')])], reading([face('s8')])), null);
  assert.equal(choosePaodekuaiPlay([reading(cardsOf(8, 8, 8), true)], reading(cardsOf(7, 7, 7, 9, 10))), null);
  const fullPlane = reading(cardsOf(3, 3, 3, 4, 4, 4, 8, 9, 10, 11));
  const shortPlane = reading(cardsOf(5, 5, 5, 6, 6, 6, 7), true);
  const sameSizeDifferentBody = reading(cardsOf(5, 5, 5, 6, 6, 6, 7, 7, 7, 8), true);
  assert.equal(choosePaodekuaiPlay([shortPlane, sameSizeDifferentBody], fullPlane), null);
  const higherTriple = reading(cardsOf(8, 8, 8, 3, 4));
  assert.equal(choosePaodekuaiPlay([higherTriple], reading(cardsOf(7, 7, 7, 14, 15))), higherTriple);
  const threeBomb = reading(cardsOf(3, 3, 3, 3));
  const kingBomb = reading(cardsOf(13, 13, 13, 13));
  const aceBomb = reading(cardsOf(14, 14, 14), true, threeAces);
  const ordinaryFour = reading(cardsOf(7, 7, 7, 7, 8, 9, 10));
  assert.equal(choosePaodekuaiPlay([threeBomb], ordinaryFour), threeBomb);
  assert.equal(choosePaodekuaiPlay([ordinaryFour], threeBomb), null);
  assert.equal(choosePaodekuaiPlay([kingBomb], threeBomb), kingBomb);
  assert.equal(choosePaodekuaiPlay([threeBomb, kingBomb], kingBomb), null);
  assert.equal(choosePaodekuaiPlay([aceBomb], kingBomb), aceBomb);
  assert.equal(choosePaodekuaiPlay([kingBomb, aceBomb], aceBomb), null);
});

test('Paodekuai validates ownership, opening s3, maximum singles and voluntary passes', () => {
  const hand = ['s3', 'h3', 's8', 'h8', 'h14', 'c14'].map(face);
  const opener = turnWith(hand, { firstPlay: true, nextSeatSingle: true });
  assert.deepEqual(validatePaodekuaiPlay(opener, ['h3']), { ok: false, message: '第一手须带黑桃 3' });
  assert.equal(validatePaodekuaiPlay(opener, ['s3']).ok, true);
  assert.equal(validatePaodekuaiPlay(opener, ['s3', 'h3']).ok, true);
  assert.equal(canPaodekuaiPass(opener), false);
  assert.equal(canPaodekuaiPass({ ...opener, options: optionalPass }), false);
  const reported = turnWith(hand, { nextSeatSingle: true });
  assert.deepEqual(validatePaodekuaiPlay(reported, ['s8']), { ok: false, message: '下家报单，出单张须出最大单张' });
  for (const ids of [['h14'], ['c14'], ['s8', 'h8']]) assert.equal(validatePaodekuaiPlay(reported, ids).ok, true);
  assert.deepEqual(validatePaodekuaiPlay(reported, ['s8', 's8']), { ok: false, message: '出牌包含重复的牌' });
  assert.deepEqual(validatePaodekuaiPlay(reported, ['d8']), { ok: false, message: '你没有这些牌' });
  assert.deepEqual(validatePaodekuaiPlay(reported, []), { ok: false, message: '请选择要出的牌' });
  const follows = { ...reported, previous: reading([face('s13')]) };
  assert.equal(canPaodekuaiPass(follows), false);
  assert.equal(canPaodekuaiPass({ ...follows, options: optionalPass }), true);
  assert.equal(canPaodekuaiPass({ ...follows, previous: reading([face('d14')]) }), true);
});

test('Paodekuai candidates match physical subsets at opening, bomb, reporting and wing boundaries', () => {
  const splitBomb = [...cardsOf(7, 7, 7, 7), face('s3')];
  const opener = turnWith(['h3', 's3', 'c3', 'h4', 'c4', 's5', 'h6', 's7', 'c8', 's9', 'd10', 'h11', 's12', 'c13', 'd14', 's15'].map(face),
    { firstPlay: true });
  const wings = cardsOf(6, 6, 6, 7, 7, 7, 8, 9, 9, 10, 15);
  const wingFollow = turnWith(wings, { previous: reading(cardsOf(3, 3, 3, 4, 4, 4, 5, 11, 12, 13)) });
  const openingWing = turnWith(['s3', 'h3', 's7', 'h7', 'c7', 's8'].map(face), { firstPlay: true });
  const short = cardsOf(4, 4, 4, 5, 5, 5, 6);
  const aces = cardsOf(14, 14, 14);
  const fixtures = [
    opener,
    { ...opener, nextSeatSingle: true },
    turnWith(splitBomb, { previous: reading(cardsOf(6)) }),
    turnWith(splitBomb, { previous: reading(cardsOf(11)) }),
    turnWith(['h14', 'c14', 's13', 's7'].map(face), { previous: reading(cardsOf(12)), nextSeatSingle: true }),
    turnWith(wings),
    wingFollow,
    openingWing,
    turnWith(short),
    turnWith([...short, face('s9')]),
    turnWith(aces),
    turnWith(aces, { options: threeAces }),
    turnWith(aces, { previous: reading(cardsOf(13, 13, 13, 13)) }),
    turnWith(aces, { previous: reading(cardsOf(13, 13, 13, 13)), options: threeAces }),
  ];
  for (const [index, fixture] of fixtures.entries()) assertMatchesSubsets(fixture, `fixture ${index}`);
  const candidates = enumeratePaodekuaiPlays(opener);
  assert.ok(candidates.some((candidate) => candidate.play.kind === 'tripleTwo' && candidate.cards.includes('s3')));
  assert.ok(candidates.some((candidate) => candidate.play.kind === 'straight' && candidate.cards.includes('s3')));
  assert.deepEqual(enumeratePaodekuaiPlays({ ...opener, hand: opener.hand.slice().reverse() }), candidates);
  assert.ok(enumeratePaodekuaiPlays(fixtures[2]).some((candidate) => candidate.play.kind === 'single' && candidate.play.mainRank === 7));
  assert.deepEqual(enumeratePaodekuaiPlays(fixtures[3]).map((candidate) => candidate.play.kind), ['bomb']);
  assert.deepEqual(enumeratePaodekuaiPlays(fixtures[4]).map((candidate) => candidate.cards), [['h14']]);
  assert.ok(enumeratePaodekuaiPlays(wingFollow).every((candidate) => candidate.play.wings === 4));
  assert.ok(enumeratePaodekuaiPlays(wingFollow).length > 1);
  assert.ok(enumeratePaodekuaiPlays(openingWing).some((candidate) => candidate.cards.includes('s3') &&
    candidate.play.kind === 'tripleTwo' && candidate.play.mainRank === 7));
});

test('Paodekuai candidates and passes match full subset enumeration in 2,048 seeded turns', () => {
  const randomInt = randomIntSource(0x10a6e5);
  for (let index = 0; index < 2048; index += 1) {
    const shuffled = shuffledDeck(randomInt);
    const hand = shuffled.slice(0, 1 + randomInt(12));
    const settings = { mustBeat: randomInt(2) === 0, threeAceBomb: randomInt(2) === 0 };
    const leading = randomInt(3) === 0;
    let previous: PaodekuaiPlay | null = null;
    if (!leading) {
      // Sample legal, nonterminal plays from a different seat's deal. Group by specification
      // before sampling so suit permutations cannot drown out rare table plays.
      const priorReads = new Map<string, PaodekuaiPlay>();
      for (const subset of nonemptySubsets(shuffled.slice(16, 22 + randomInt(5)))) {
        for (const play of detectPaodekuaiPlays(subset, false, settings)) priorReads.set(specification(play), play);
      }
      const choices = [...priorReads.values()];
      previous = choices[randomInt(choices.length)];
    }
    const turn = turnWith(hand, {
      previous,
      firstPlay: leading && hand.some((card) => card.id === 's3') && randomInt(2) === 0,
      nextSeatSingle: randomInt(3) === 0,
      options: settings,
    });
    assertMatchesSubsets(turn, `seed 0x10a6e5 turn ${index}`);
  }
});

function addScores(a: PaodekuaiScores, b: PaodekuaiScores): PaodekuaiScores {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

test('Paodekuai round scoring charges each loser independently, including one card and spring', () => {
  const cases: { remaining: PaodekuaiScores; moves: PaodekuaiScores; springs: boolean[]; scores: PaodekuaiScores }[] = [
    { remaining: [0, 8, 6], moves: [4, 3, 2], springs: [false, false, false], scores: [14, -8, -6] },
    { remaining: [0, 8, 1], moves: [4, 3, 2], springs: [false, false, false], scores: [9, -8, -1] },
    { remaining: [0, 16, 1], moves: [4, 0, 2], springs: [false, true, false], scores: [33, -32, -1] },
    { remaining: [0, 16, 16], moves: [4, 0, 0], springs: [false, true, true], scores: [64, -32, -32] },
  ];
  for (const example of cases) {
    const result = scorePaodekuaiRound({
      winner: 0, remainingCards: example.remaining, playCounts: example.moves, bombScores: zero, previousScores: zero,
    });
    assert.deepEqual(result.map((seat) => seat.remainingCards), example.remaining);
    assert.deepEqual(result.map((seat) => seat.spring), example.springs);
    assert.deepEqual(result.map((seat) => seat.remainingScore), example.scores);
    assert.deepEqual(result.map((seat) => seat.bombScore), zero);
    assert.deepEqual(result.map((seat) => seat.roundScore), example.scores);
    assert.deepEqual(result.map((seat) => seat.totalScore), example.scores);
  }
});

test('Paodekuai scores only the last bomb of each trick and counts the final bomb once', () => {
  const trick = seats.map((seat) => ({ seat, play: reading(cardsOf(...Array<number>(4).fill(3 + seat))) }));
  assert.equal(choosePaodekuaiPlay([trick[1].play], trick[0].play), trick[1].play);
  assert.equal(choosePaodekuaiPlay([trick[2].play], trick[1].play), trick[2].play);
  const covered = scorePaodekuaiTrick(trick[2]);
  assert.deepEqual(covered, [-5, -5, 10]);
  assert.deepEqual(scorePaodekuaiTrick(null), zero);
  const final = scorePaodekuaiTrick({ seat: 0, play: reading(cardsOf(13, 13, 13, 13)) });
  assert.deepEqual(final, [10, -5, -5]);
  const example = scorePaodekuaiRound({
    winner: 0, remainingCards: [0, 16, 1], playCounts: [4, 0, 2], bombScores: final, previousScores: zero,
  });
  assert.deepEqual(example.map((seat) => seat.roundScore), [43, -37, -6]);
  const multiple = scorePaodekuaiRound({
    winner: 0, remainingCards: [0, 8, 1], playCounts: [4, 3, 2],
    bombScores: addScores(covered, final), previousScores: [7, -4, -3],
  });
  assert.deepEqual(multiple.map((seat) => seat.bombScore), [5, -10, 5]);
  assert.deepEqual(multiple.map((seat) => seat.roundScore), [14, -18, 4]);
  assert.deepEqual(multiple.map((seat) => seat.totalScore), [21, -22, 1]);
  assert.deepEqual(scorePaodekuaiTrick({ seat: 1, play: reading(cardsOf(14, 14, 14), false, threeAces) }), [-5, 10, -5]);
});

test('Paodekuai remaining, bomb, round and accumulated scores are zero-sum', () => {
  const randomInt = randomIntSource(0xc0de16);
  const bomb = reading(cardsOf(5, 5, 5, 5));
  let previousScores = zero;
  for (let index = 0; index < 500; index += 1) {
    const winner = seats[randomInt(3)];
    const remainingCards: [number, number, number] = [1 + randomInt(16), 1 + randomInt(16), 1 + randomInt(16)];
    remainingCards[winner] = 0;
    const countPlays = (count: number): number => count === 16 ? 0 : 1 + randomInt(16 - count);
    const playCounts: PaodekuaiScores = [countPlays(remainingCards[0]), countPlays(remainingCards[1]), countPlays(remainingCards[2])];
    let bombScores = zero;
    for (let trick = randomInt(6); trick > 0; trick -= 1) {
      bombScores = addScores(bombScores, scorePaodekuaiTrick({ seat: seats[randomInt(3)], play: bomb }));
    }
    const result = scorePaodekuaiRound({ winner, remainingCards, playCounts, bombScores, previousScores });
    for (const key of ['remainingScore', 'bombScore', 'roundScore', 'totalScore'] as const) {
      assert.equal(result.reduce((sum, score) => sum + score[key], 0), 0);
    }
    previousScores = [result[0].totalScore, result[1].totalScore, result[2].totalScore];
  }
});

test('Paodekuai logs candidate generation timing for a 16-card hand', (t) => {
  const turn = turnWith(cardsOf(3, 3, 3, 4, 4, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14));
  for (let warmup = 0; warmup < 10; warmup += 1) enumeratePaodekuaiPlays(turn);
  const start = performance.now();
  for (let repetition = 0; repetition < 100; repetition += 1) enumeratePaodekuaiPlays(turn);
  const average = (performance.now() - start) / 100;
  t.diagnostic(`Paodekuai candidate benchmark (16 cards, 100 runs): ${average.toFixed(3)} ms/run`);
});
