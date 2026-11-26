import { createDeck, RUN_MAX_RANK, sortHand } from './doudizhu';
import type { Card } from './protocol';

const REMOVED_CARD_IDS = new Set(['j16', 'j17', 'h15', 'c15', 'd15', 's14']);
const OPENING_CARD_ID = 's3';
const MIN_RANK = 3;
const BOMB_PAYMENT = 5;

export interface PaodekuaiOptions {
  mustBeat: boolean;
  threeAceBomb: boolean;
}

export const DEFAULT_PAODEKUAI_OPTIONS: Readonly<PaodekuaiOptions> = Object.freeze({
  mustBeat: true,
  threeAceBomb: false,
});

export function createPaodekuaiDeck(): Card[] {
  return createDeck().filter((card) => !REMOVED_CARD_IDS.has(card.id));
}

const deckById = new Map(createPaodekuaiDeck().map((card) => [card.id, card]));

export type PaodekuaiKind = 'single' | 'pair' | 'straight' | 'pairRun' | 'triple' |
  'tripleSingle' | 'tripleTwo' | 'airplane' | 'fourWithThree' | 'bomb';

export interface PaodekuaiPlay {
  kind: PaodekuaiKind;
  /** Highest body rank for runs, or the rank of the single group. */
  mainRank: number;
  groups: number;
  wings: number;
  cardCount: number;
}

interface RankGroup {
  rank: number;
  count: number;
}

function isRun(groups: readonly RankGroup[]): boolean {
  return groups.every((group, index) => group.rank === groups[0].rank + index) &&
    groups[groups.length - 1].rank <= RUN_MAX_RANK;
}

/** Return all readings for the submitted cards. `lastHand` means they empty the player's hand. */
export function detectPaodekuaiPlays(
  cards: readonly Card[],
  lastHand: boolean,
  options: Readonly<PaodekuaiOptions> = DEFAULT_PAODEKUAI_OPTIONS,
): PaodekuaiPlay[] {
  const ids = new Set<string>();
  const counts = new Map<number, number>();
  for (const card of cards) {
    const face = deckById.get(card.id);
    if (!face || face.rank !== card.rank || face.suit !== card.suit || ids.has(card.id)) return [];
    ids.add(card.id);
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }
  const groups = [...counts].map(([rank, count]) => ({ rank, count })).sort((a, b) => a.rank - b.rank);
  const cardCount = cards.length;
  const readings: PaodekuaiPlay[] = [];
  function add(kind: PaodekuaiKind, mainRank: number, groupCount = 1, wings = 0): void {
    readings.push({ kind, mainRank, groups: groupCount, wings, cardCount });
  }

  // The current rules yield at most one reading. Counts 3 and 4 cannot be wings, so they
  // force the entire body of a triple, airplane, or four-card shape. Two potential bodies
  // would leave an overfull wing rank. With counts at most 2, a run must have uniformly
  // one or uniformly two cards per rank. The only overlapping shape, exact AAA with the
  // bomb option enabled, is defined exclusively as a bomb even on the last hand.
  if (groups.length === 1) {
    const { rank, count } = groups[0];
    if (count === 1) add('single', rank);
    if (count === 2) add('pair', rank);
    if (count === 4 || (count === 3 && rank === RUN_MAX_RANK && options.threeAceBomb)) add('bomb', rank);
    else if (count === 3 && lastHand) add('triple', rank);
    return readings;
  }

  const quads = groups.filter((group) => group.count === 4);
  const triples = groups.filter((group) => group.count === 3);
  if (quads.length > 0) {
    if (quads.length === 1 && triples.length === 0 && cardCount === 7) {
      add('fourWithThree', quads[0].rank, 1, 3);
    }
  } else if (triples.length === 1) {
    const wings = cardCount - 3;
    if (wings === 1 && lastHand) add('tripleSingle', triples[0].rank, 1, wings);
    if (wings === 2) add('tripleTwo', triples[0].rank, 1, wings);
  } else if (triples.length >= 2) {
    const wings = cardCount - 3 * triples.length;
    const fullWings = 2 * triples.length;
    if (isRun(triples) && (wings === 0 || wings === fullWings || (lastHand && wings < fullWings))) {
      add('airplane', triples[triples.length - 1].rank, triples.length, wings);
    }
  } else if (groups.length >= 2 && isRun(groups)) {
    const high = groups[groups.length - 1].rank;
    if (groups.length >= 5 && groups.every((group) => group.count === 1)) add('straight', high, groups.length);
    if (groups.every((group) => group.count === 2)) add('pairRun', high, groups.length);
  }
  return readings;
}

/** Select the first reading that beats the actual table play, or the first reading on a lead. */
export function choosePaodekuaiPlay(
  readings: readonly PaodekuaiPlay[],
  previous: PaodekuaiPlay | null,
): PaodekuaiPlay | null {
  if (!previous) return readings[0] ?? null;
  return readings.find((play) => {
    if (play.kind === 'bomb') return previous.kind !== 'bomb' || play.mainRank > previous.mainRank;
    return play.kind === previous.kind && play.cardCount === previous.cardCount &&
      play.groups === previous.groups && play.wings === previous.wings && play.mainRank > previous.mainRank;
  }) ?? null;
}

export interface PaodekuaiTurn {
  hand: readonly Card[];
  previous: PaodekuaiPlay | null;
  /** First play of the first round, requiring the physical spade 3. */
  firstPlay: boolean;
  nextSeatSingle: boolean;
  options: Readonly<PaodekuaiOptions>;
}

export type PaodekuaiValidation = { ok: true; play: PaodekuaiPlay } | { ok: false; message: string };

function resolvePlay(turn: PaodekuaiTurn, cards: readonly Card[]): PaodekuaiValidation {
  if (turn.firstPlay && !cards.some((card) => card.id === OPENING_CARD_ID)) {
    return { ok: false, message: '第一手须带黑桃 3' };
  }
  if (!turn.firstPlay && turn.nextSeatSingle && cards.length === 1 &&
      turn.hand.some((card) => card.rank > cards[0].rank)) {
    return { ok: false, message: '下家报单，出单张须出最大单张' };
  }
  const readings = detectPaodekuaiPlays(cards, cards.length === turn.hand.length, turn.options);
  if (readings.length === 0) return { ok: false, message: '牌型不合法' };
  const play = choosePaodekuaiPlay(readings, turn.previous);
  return play ? { ok: true, play } : { ok: false, message: '管不上前一手牌' };
}

/** Validate physical IDs against the current hand, then apply the rules of this turn. */
export function validatePaodekuaiPlay(turn: PaodekuaiTurn, cardIds: readonly string[]): PaodekuaiValidation {
  if (cardIds.length === 0) return { ok: false, message: '请选择要出的牌' };
  if (new Set(cardIds).size !== cardIds.length) return { ok: false, message: '出牌包含重复的牌' };
  const cards: Card[] = [];
  for (const id of cardIds) {
    const card = turn.hand.find((held) => held.id === id);
    if (!card) return { ok: false, message: '你没有这些牌' };
    cards.push(card);
  }
  return resolvePlay(turn, cards);
}

export interface PaodekuaiCandidate {
  cards: string[];
  play: PaodekuaiPlay;
}

/** Enumerate legal rank selections, without expanding equivalent suit permutations. */
export function enumeratePaodekuaiPlays(turn: PaodekuaiTurn): PaodekuaiCandidate[] {
  // Suit does not affect a reading, a maximum single, or whether a play empties the hand.
  // Take the first N cards of each rank in sortHand order for one physical representative.
  // Spades come first within their rank, so any selection of rank 3 includes s3 if held.
  const hand = sortHand([...turn.hand]);
  const byRank = new Map<number, Card[]>();
  for (const card of hand) {
    const bucket = byRank.get(card.rank);
    if (bucket) bucket.push(card);
    else byRank.set(card.rank, [card]);
  }
  const candidates: PaodekuaiCandidate[] = [];
  function add(cards: readonly Card[]): void {
    const result = resolvePlay(turn, cards);
    if (result.ok) candidates.push({ cards: cards.map((card) => card.id), play: result.play });
  }

  // Every short-wing or bare-triple exception that requires going out is tested by the full
  // hand once. The shape generators below only need to cover plays smaller than the hand.
  if (hand.length > 0) add(hand);
  function addPartial(cards: readonly Card[]): void {
    if (cards.length < hand.length) add(cards);
  }

  // Different wing rank counts are retained, even when the resulting reading is the same.
  function addWithWings(body: readonly Card[], wingCount: number): void {
    if (body.length + wingCount >= hand.length) return;
    const bodyRanks = new Set(body.map((card) => card.rank));
    const wingBuckets = [...byRank.values()].filter((bucket) => !bodyRanks.has(bucket[0].rank));
    const wings: Card[] = [];
    function chooseWings(start: number, remaining: number): void {
      if (remaining === 0) {
        add([...body, ...wings]);
        return;
      }
      for (let index = start; index < wingBuckets.length; index += 1) {
        const bucket = wingBuckets[index];
        const take = Math.min(bucket.length, remaining, 2);
        const before = wings.length;
        for (let count = 1; count <= take; count += 1) {
          wings.push(bucket[count - 1]);
          chooseWings(index + 1, remaining - count);
        }
        wings.length = before;
      }
    }
    chooseWings(0, wingCount);
  }

  for (const [rank, bucket] of byRank) {
    addPartial(bucket.slice(0, 1));
    if (bucket.length >= 2) addPartial(bucket.slice(0, 2));
    if (bucket.length >= 3) {
      const triple = bucket.slice(0, 3);
      if (rank === RUN_MAX_RANK && turn.options.threeAceBomb) addPartial(triple);
      addWithWings(triple, 2);
    }
    if (bucket.length === 4) {
      addPartial(bucket);
      addWithWings(bucket, 3);
    }
  }

  function addRuns(cardsPerRank: number, minGroups: number): void {
    for (let low = MIN_RANK; low <= RUN_MAX_RANK; low += 1) {
      const body: Card[] = [];
      for (let high = low; high <= RUN_MAX_RANK; high += 1) {
        const bucket = byRank.get(high);
        if (!bucket || bucket.length < cardsPerRank) break;
        body.push(...bucket.slice(0, cardsPerRank));
        const groups = high - low + 1;
        if (groups < minGroups) continue;
        addPartial(body);
        if (cardsPerRank === 3) addWithWings(body, 2 * groups);
      }
    }
  }
  addRuns(1, 5);
  addRuns(2, 2);
  addRuns(3, 2);
  return candidates;
}

export function canPaodekuaiPass(turn: PaodekuaiTurn): boolean {
  return turn.previous !== null && (!turn.options.mustBeat || enumeratePaodekuaiPlays(turn).length === 0);
}

export type PaodekuaiSeat = 0 | 1 | 2;
export type PaodekuaiScores = readonly [number, number, number];

/** Pass only the last actual play of a completed trick, including a round-ending play. */
export function scorePaodekuaiTrick(last: { seat: PaodekuaiSeat; play: PaodekuaiPlay } | null): PaodekuaiScores {
  if (last?.play.kind !== 'bomb') return [0, 0, 0];
  const scores: [number, number, number] = [-BOMB_PAYMENT, -BOMB_PAYMENT, -BOMB_PAYMENT];
  scores[last.seat] = BOMB_PAYMENT * 2;
  return scores;
}

export interface PaodekuaiRoundInput {
  winner: PaodekuaiSeat;
  remainingCards: PaodekuaiScores;
  playCounts: PaodekuaiScores;
  /** Sum of the completed trick deltas, including the terminal trick. */
  bombScores: PaodekuaiScores;
  previousScores: PaodekuaiScores;
}

export interface PaodekuaiSeatScore {
  seat: PaodekuaiSeat;
  remainingCards: number;
  spring: boolean;
  remainingScore: number;
  bombScore: number;
  roundScore: number;
  totalScore: number;
}

export function scorePaodekuaiRound(round: PaodekuaiRoundInput): PaodekuaiSeatScore[] {
  for (const scores of [round.bombScores, round.previousScores]) {
    if (scores[0] + scores[1] + scores[2] !== 0) throw new RangeError('三座得分之和必须为 0');
  }
  const seats = [0, 1, 2] as const;
  const remainingScores = [0, 0, 0];
  const springs = seats.map((seat) => seat !== round.winner && round.playCounts[seat] === 0);
  for (const seat of seats) {
    if (seat === round.winner) continue;
    const payment = round.remainingCards[seat] * (springs[seat] ? 2 : 1);
    remainingScores[seat] = -payment;
    remainingScores[round.winner] += payment;
  }
  return seats.map((seat) => {
    const remainingScore = remainingScores[seat];
    const bombScore = round.bombScores[seat];
    const roundScore = remainingScore + bombScore;
    return {
      seat,
      remainingCards: round.remainingCards[seat],
      spring: springs[seat],
      remainingScore,
      bombScore,
      roundScore,
      totalScore: round.previousScores[seat] + roundScore,
    };
  });
}
