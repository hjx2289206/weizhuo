// Guandan card rules: pure, shared by the server authority and the Vue client.
//
// Rank encoding is the shared encoding from `protocol.ts`: 3..15 (15 === 2), 16 small joker,
// 17 big joker. Natural order is 2,3,...,A, i.e. raw 15,3,4,...,14.
//
// Scope (frozen contract): the ten card kinds, sequence windows, the level-card boost, the heart
// level-card wildcard, the strict comparator and the tribute/return eligibility helpers. Match
// progression, dealing, tribute pairing and room state live elsewhere.
//
// No Node imports: the browser bundle imports this module for the exact same candidate
// enumeration the server revalidates with.
// `GuandanKind` / `GuandanDeclaration` are owned by protocol.ts (one definition, re-exported here)
// so the server can hand a declaration straight into `TablePlay.claim`.
import type { Card, GuandanDeclaration, GuandanKind, Suit } from './protocol';

export type { GuandanDeclaration, GuandanKind };

export type GuandanSuit = Exclude<Suit, 'joker'>;

/** One wildcard used as a rank/suit other than its own printed card. */
type GuandanSubstitution = GuandanDeclaration['substitutions'][number];

export interface GuandanOption {
  declaration: GuandanDeclaration;
  /** The selected physical cards, ordered by the declared slots. */
  cards: Card[];
}

const RANK_TWO = 15;
const SMALL_JOKER = 16;
const BIG_JOKER = 17;

const SUIT_ORDER: readonly GuandanSuit[] = ['spade', 'heart', 'club', 'diamond'];
const SUIT_CHAR: Record<Suit, string> = { spade: 's', heart: 'h', club: 'c', diamond: 'd', joker: 'j' };

export const GUANDAN_DECK_COUNT = 2;
export const GUANDAN_CARD_COUNT = 108;
export const GUANDAN_HAND_SIZE = 27;
/** A bomb is 4..10 equal-rank cards; 10 needs both wildcards on top of all eight natural copies. */
export const GUANDAN_BOMB_MIN = 4;
export const GUANDAN_BOMB_MAX = 10;

/** Playable levels low to high: 2,3,4,5,6,7,8,9,10,J,Q,K,A as raw ranks. */
export const GUANDAN_LEVELS: readonly number[] = [RANK_TWO, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/** Natural window sizes per sequence kind and their highest `low` index. */
const SEQUENCE_SPAN: Record<'straight' | 'straightFlush' | 'threePairs' | 'twoTriples', number> = {
  straight: 5,
  straightFlush: 5,
  threePairs: 3,
  twoTriples: 2,
};
const SEQUENCE_LOW_MAX: Record<'straight' | 'straightFlush' | 'threePairs' | 'twoTriples', number> = {
  straight: 10,
  straightFlush: 10,
  threePairs: 12,
  twoTriples: 13,
};
/** Cards required per window rank (1 for a straight, 2 for a pair run, 3 for a triple run). */
const SEQUENCE_PER_RANK: Record<'straight' | 'straightFlush' | 'threePairs' | 'twoTriples', number> = {
  straight: 1,
  straightFlush: 1,
  threePairs: 2,
  twoTriples: 3,
};

const KIND_ORDER: Record<GuandanKind, number> = {
  single: 0,
  pair: 1,
  triple: 2,
  triplePair: 3,
  straight: 4,
  threePairs: 5,
  twoTriples: 6,
  bomb: 7,
  straightFlush: 8,
  fourJokers: 9,
};

const KIND_LABELS: Record<GuandanKind, string> = {
  single: '单张',
  pair: '对子',
  triple: '三张',
  triplePair: '三带二',
  straight: '顺子',
  threePairs: '三连对',
  twoTriples: '钢板',
  bomb: '炸弹',
  straightFlush: '同花顺',
  fourJokers: '四大天王',
};

/** The two heart level cards. Every other level card is an ordinary level card. */
export function isGuandanWild(card: Card, level: number): boolean {
  return card.rank === level && card.suit === 'heart';
}

/**
 * Comparison strength: jokers 17/16, any level card 15 (above A), otherwise the natural value with
 * `2` counting as 2. Used for group ranks and bombs, never for sequence slots.
 */
export function guandanRankStrength(rank: number, level: number): number {
  if (rank === BIG_JOKER) return 17;
  if (rank === SMALL_JOKER) return 16;
  if (rank === level) return 15;
  return rank === RANK_TWO ? 2 : rank;
}

/** Two full decks, 108 unique physical ids. Discards the input array, mutates nothing else. */
export function createGuandanDeck(): Card[] {
  const deck: Card[] = [];
  for (let d = 0; d < GUANDAN_DECK_COUNT; d += 1) {
    for (const suit of SUIT_ORDER) {
      for (let rank = 3; rank <= RANK_TWO; rank += 1) {
        deck.push({ id: `g${d}-${SUIT_CHAR[suit]}${rank}`, rank, suit });
      }
    }
    deck.push({ id: `g${d}-${SUIT_CHAR.joker}${SMALL_JOKER}`, rank: SMALL_JOKER, suit: 'joker' });
    deck.push({ id: `g${d}-${SUIT_CHAR.joker}${BIG_JOKER}`, rank: BIG_JOKER, suit: 'joker' });
  }
  return deck;
}

/** Group strength descending, ties stable in the input order. Never mutates the input. */
export function sortGuandanHand(cards: readonly Card[], level: number): Card[] {
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => guandanRankStrength(b.card.rank, level) - guandanRankStrength(a.card.rank, level) || a.index - b.index)
    .map((entry) => entry.card);
}

/** Raw ranks of a sequence window. `low === 1` is the A-as-1 window (A2345 / AA2233 / AAA222). */
function windowRanks(low: number, span: number): number[] {
  if (low === 1) {
    const ranks = [14];
    for (let i = 0; i < span - 1; i += 1) ranks.push(GUANDAN_LEVELS[i]);
    return ranks;
  }
  const start = low - 2;
  const ranks: number[] = [];
  for (let i = 0; i < span; i += 1) ranks.push(GUANDAN_LEVELS[start + i]);
  return ranks;
}

function declarationKey(parts: {
  kind: GuandanKind;
  count: number;
  primaryRank: number;
  secondaryRank: number | null;
  low: number | null;
  suit: GuandanSuit | null;
}): string {
  return [parts.kind, parts.count, parts.primaryRank, parts.secondaryRank ?? 'x', parts.low ?? 'x', parts.suit ?? 'x'].join('|');
}

function makeOption(
  parts: {
    kind: GuandanKind;
    count: number;
    primaryRank: number;
    secondaryRank: number | null;
    low: number | null;
    suit: GuandanSuit | null;
    substitutions: GuandanSubstitution[];
  },
  cards: Card[],
): GuandanOption {
  return {
    declaration: {
      key: declarationKey(parts),
      kind: parts.kind,
      label: KIND_LABELS[parts.kind],
      count: parts.count,
      primaryRank: parts.primaryRank,
      secondaryRank: parts.secondaryRank,
      low: parts.low,
      suit: parts.suit,
      substitutions: parts.substitutions,
    },
    cards,
  };
}

function substitutionOf(card: Card, rank: number, suit: GuandanSuit = 'heart'): GuandanSubstitution {
  return { cardId: card.id, rank, suit };
}

function groupByRank(cards: readonly Card[]): Map<number, Card[]> {
  const byRank = new Map<number, Card[]>();
  for (const card of cards) {
    const bucket = byRank.get(card.rank);
    if (bucket) bucket.push(card);
    else byRank.set(card.rank, [card]);
  }
  return byRank;
}

/** Structural validation of a selection: ids unique, rank/suit coherent, at most two cards per face. */
function assertSelection(cards: readonly Card[], level: number): void {
  const ids = new Set<string>();
  const faces = new Map<string, number>();
  for (const card of cards) {
    if (ids.has(card.id)) throw new Error(`guandan: duplicate card id ${card.id}`);
    ids.add(card.id);
    if (!Number.isInteger(card.rank) || card.rank < 3 || card.rank > BIG_JOKER) {
      throw new Error(`guandan: illegal rank ${card.rank}`);
    }
    if (card.rank >= SMALL_JOKER) {
      if (card.suit !== 'joker') throw new Error(`guandan: joker rank ${card.rank} must use the joker suit`);
    } else if (card.suit === 'joker') {
      throw new Error(`guandan: rank ${card.rank} cannot use the joker suit`);
    }
    const face = `${card.suit}:${card.rank}`;
    const seen = (faces.get(face) ?? 0) + 1;
    faces.set(face, seen);
    if (seen > GUANDAN_DECK_COUNT) throw new Error(`guandan: more than ${GUANDAN_DECK_COUNT} copies of ${face}`);
  }
  if (cards.filter((card) => isGuandanWild(card, level)).length > GUANDAN_DECK_COUNT) {
    throw new Error('guandan: a deck holds only two wildcards');
  }
}

/** Bomb candidate for the whole selection: one non-joker rank plus wildcards on top. */
function tryBomb(plains: readonly Card[], wilds: readonly Card[], level: number, count: number): GuandanOption | null {
  if (count < GUANDAN_BOMB_MIN || count > GUANDAN_BOMB_MAX) return null;
  if (plains.length === 0) return null;
  const rank = plains[0].rank;
  if (rank >= SMALL_JOKER) return null;
  if (!plains.every((card) => card.rank === rank)) return null;
  // A level-rank bomb uses its own wildcards naturally, so it can never exceed the eight level
  // cards in the deck; every other rank tops out at eight natural copies plus two wildcards.
  const substitutions = rank === level ? [] : wilds.map((card) => substitutionOf(card, rank));
  return makeOption(
    { kind: 'bomb', count, primaryRank: rank, secondaryRank: null, low: null, suit: null, substitutions },
    [...plains, ...wilds],
  );
}

function tryFourJokers(plains: readonly Card[], wilds: readonly Card[]): GuandanOption | null {
  if (wilds.length !== 0 || plains.length !== 4) return null;
  const big = plains.filter((card) => card.rank === BIG_JOKER);
  const small = plains.filter((card) => card.rank === SMALL_JOKER);
  if (big.length !== 2 || small.length !== 2) return null;
  return makeOption(
    { kind: 'fourJokers', count: 4, primaryRank: BIG_JOKER, secondaryRank: null, low: null, suit: null, substitutions: [] },
    [...big, ...small],
  );
}

function rankGroupOption(
  kind: 'pair' | 'triple',
  rank: number,
  group: readonly Card[],
  level: number,
): GuandanOption {
  const naturals = group.filter((card) => !isGuandanWild(card, level));
  const wilds = group.filter((card) => isGuandanWild(card, level));
  const substitutions = rank === level ? [] : wilds.map((card) => substitutionOf(card, rank));
  return makeOption(
    { kind, count: group.length, primaryRank: rank, secondaryRank: null, low: null, suit: null, substitutions },
    [...naturals, ...wilds],
  );
}

function enumeratePairs(plains: readonly Card[], wilds: readonly Card[], level: number): GuandanOption[] {
  if (wilds.length === 0) {
    return plains[0].rank === plains[1].rank ? [rankGroupOption('pair', plains[0].rank, plains, level)] : [];
  }
  if (wilds.length === 1) {
    const natural = plains[0];
    if (natural.rank >= SMALL_JOKER) return []; // a wildcard can never stand in for a joker
    return [rankGroupOption('pair', natural.rank, [natural, wilds[0]], level)];
  }
  // Two wildcards form a pair of any rank below the jokers.
  return GUANDAN_LEVELS.map((rank) => rankGroupOption('pair', rank, [wilds[0], wilds[1]], level));
}

function enumerateTriples(plains: readonly Card[], wilds: readonly Card[], level: number): GuandanOption[] {
  if (wilds.length === 0) {
    const rank = plains[0].rank;
    return plains.every((card) => card.rank === rank) ? [rankGroupOption('triple', rank, plains, level)] : [];
  }
  const rank = plains[0].rank;
  if (rank >= SMALL_JOKER) return [];
  if (!plains.every((card) => card.rank === rank)) return [];
  return [rankGroupOption('triple', rank, [...plains, ...wilds], level)];
}

/** The triple keeps a distinct rank from the pair, so five equal cards are a bomb, never 3+2. */
function enumerateTriplePairs(plains: readonly Card[], wilds: readonly Card[], level: number): GuandanOption[] {
  const byRank = groupByRank(plains);
  const wildCount = wilds.length;
  const options: GuandanOption[] = [];
  const pairRanks = [...GUANDAN_LEVELS, SMALL_JOKER, BIG_JOKER];
  for (const tripleRank of GUANDAN_LEVELS) {
    const tripleNaturals = byRank.get(tripleRank) ?? [];
    const tripleFill = 3 - tripleNaturals.length;
    if (tripleFill < 0 || tripleFill > wildCount) continue;
    for (const pairRank of pairRanks) {
      if (pairRank === tripleRank) continue;
      const pairNaturals = byRank.get(pairRank) ?? [];
      const pairFill = 2 - pairNaturals.length;
      if (pairFill < 0) continue;
      if (tripleFill + pairFill !== wildCount) continue;
      if (pairRank >= SMALL_JOKER && pairFill > 0) continue; // wildcards can never be jokers
      if ([...byRank.keys()].some((rank) => rank !== tripleRank && rank !== pairRank)) continue;
      const tripleWilds = wilds.slice(0, tripleFill);
      const pairWilds = wilds.slice(tripleFill, tripleFill + pairFill);
      const substitutions: GuandanSubstitution[] = [];
      if (tripleRank !== level) for (const card of tripleWilds) substitutions.push(substitutionOf(card, tripleRank));
      if (pairRank !== level) for (const card of pairWilds) substitutions.push(substitutionOf(card, pairRank));
      options.push(
        makeOption(
          {
            kind: 'triplePair',
            count: 5,
            primaryRank: tripleRank,
            secondaryRank: pairRank,
            low: null,
            suit: null,
            substitutions,
          },
          [...tripleNaturals, ...tripleWilds, ...pairNaturals, ...pairWilds],
        ),
      );
    }
  }
  return options;
}

function enumerateSequence(
  plains: readonly Card[],
  wilds: readonly Card[],
  level: number,
  kind: 'straight' | 'straightFlush' | 'threePairs' | 'twoTriples',
): GuandanOption[] {
  if (plains.some((card) => card.rank >= SMALL_JOKER)) return []; // jokers never join a sequence
  const span = SEQUENCE_SPAN[kind];
  const perRank = SEQUENCE_PER_RANK[kind];
  if (plains.length + wilds.length !== span * perRank) return [];
  const byRank = groupByRank(plains);
  const naturalSuits = new Set(plains.map((card) => card.suit as GuandanSuit));
  const allOneSuit = plains.length > 0 && naturalSuits.size === 1;
  const options: GuandanOption[] = [];

  for (let low = 1; low <= SEQUENCE_LOW_MAX[kind]; low += 1) {
    const ranks = windowRanks(low, span);
    const inWindow = new Set(ranks);
    if ([...byRank.keys()].some((rank) => !inWindow.has(rank))) continue;
    let deficit = 0;
    let fits = true;
    for (const rank of ranks) {
      const have = byRank.get(rank)?.length ?? 0;
      if (have > perRank) {
        fits = false;
        break;
      }
      deficit += perRank - have;
    }
    if (!fits || deficit !== wilds.length) continue;

    const build = (slotSuit: GuandanSuit | null): GuandanOption => {
      const cards: Card[] = [];
      const substitutions: GuandanSubstitution[] = [];
      let wildIndex = 0;
      for (const rank of ranks) {
        const naturals = byRank.get(rank) ?? [];
        for (const card of naturals) cards.push(card);
        for (let slot = naturals.length; slot < perRank; slot += 1) {
          const wild = wilds[wildIndex];
          wildIndex += 1;
          cards.push(wild);
          // A wildcard is natural only at its own rank AND its own heart suit.
          const suit = slotSuit ?? 'heart';
          if (rank !== level || suit !== 'heart') substitutions.push(substitutionOf(wild, rank, suit));
        }
      }
      return makeOption(
        {
          kind,
          count: span * perRank,
          primaryRank: ranks[ranks.length - 1],
          secondaryRank: null,
          low,
          suit: kind === 'straightFlush' ? slotSuit : null,
          substitutions,
        },
        cards,
      );
    };

    if (kind === 'straightFlush') {
      if (allOneSuit) options.push(build(plains[0].suit as GuandanSuit));
      continue;
    }
    if (kind !== 'straight') {
      options.push(build('heart'));
      continue;
    }
    // A naturally all-one-suit set is a straight flush, never downgraded to an ordinary straight.
    if (wilds.length === 0 && allOneSuit) continue;
    // A wildcard in an ordinary straight must not turn the set into a flush.
    options.push(build(SUIT_ORDER.find((suit) => !naturalSuits.has(suit)) ?? SUIT_ORDER[0]));
  }
  return options;
}

function optionPower(option: GuandanOption, level: number): number {
  const { declaration } = option;
  switch (declaration.kind) {
    case 'bomb':
      return declaration.count * 100 + guandanRankStrength(declaration.primaryRank, level);
    case 'straight':
    case 'straightFlush':
    case 'threePairs':
    case 'twoTriples':
      return declaration.low ?? 0;
    default:
      return guandanRankStrength(declaration.primaryRank, level);
  }
}

function sortOptions(options: GuandanOption[], level: number): GuandanOption[] {
  return options.sort(
    (a, b) =>
      KIND_ORDER[a.declaration.kind] - KIND_ORDER[b.declaration.kind] ||
      optionPower(b, level) - optionPower(a, level) ||
      a.declaration.substitutions.length - b.declaration.substitutions.length ||
      (a.declaration.key < b.declaration.key ? -1 : a.declaration.key > b.declaration.key ? 1 : 0),
  );
}

/**
 * Every semantic reading of the selected cards, strongest first within each kind. Wildcard
 * interpretations are enumerated analytically (at most two wildcards), never by subset search, and
 * the returned keys are identical no matter what order the same cards were selected in.
 */
export function enumerateGuandanPlays(cards: readonly Card[], level: number): GuandanOption[] {
  assertSelection(cards, level);
  const count = cards.length;
  if (count === 0) return [];
  const wilds = cards.filter((card) => isGuandanWild(card, level));
  const plains = cards.filter((card) => !isGuandanWild(card, level));
  const options: GuandanOption[] = [];

  const bomb = tryBomb(plains, wilds, level, count);
  if (bomb) options.push(bomb);
  const fourJokers = tryFourJokers(plains, wilds);
  if (fourJokers) options.push(fourJokers);

  if (count === 1) {
    options.push(
      makeOption(
        { kind: 'single', count: 1, primaryRank: cards[0].rank, secondaryRank: null, low: null, suit: null, substitutions: [] },
        [cards[0]],
      ),
    );
  } else if (count === 2) {
    options.push(...enumeratePairs(plains, wilds, level));
  } else if (count === 3) {
    options.push(...enumerateTriples(plains, wilds, level));
  } else if (count === 5) {
    options.push(...enumerateSequence(plains, wilds, level, 'straight'));
    options.push(...enumerateSequence(plains, wilds, level, 'straightFlush'));
    options.push(...enumerateTriplePairs(plains, wilds, level));
  } else if (count === 6) {
    options.push(...enumerateSequence(plains, wilds, level, 'threePairs'));
    options.push(...enumerateSequence(plains, wilds, level, 'twoTriples'));
  }

  return sortOptions(options, level);
}

const TIER_ORDINARY = 1;
const TIER_BOMB_FOUR = 2;
const TIER_BOMB_FIVE = 3;
const TIER_STRAIGHT_FLUSH = 4;
const TIER_BOMB_BIG = 5;
const TIER_FOUR_JOKERS = 6;

function tierOf(declaration: GuandanDeclaration): number {
  switch (declaration.kind) {
    case 'fourJokers':
      return TIER_FOUR_JOKERS;
    case 'bomb':
      if (declaration.count >= 6) return TIER_BOMB_BIG;
      return declaration.count === 5 ? TIER_BOMB_FIVE : TIER_BOMB_FOUR;
    case 'straightFlush':
      return TIER_STRAIGHT_FLUSH;
    default:
      return TIER_ORDINARY;
  }
}

/**
 * Strict `>`: four jokers > 6..10 bombs (count first) > straight flush > 5 bomb > 4 bomb > the seven
 * ordinary kinds. Ordinary kinds only beat their own kind; sequences compare their `low` index, and
 * groups compare the boosted rank, so a same-size level-rank bomb outranks an A bomb and a level
 * pair outranks a pair of A. Suits never break a tie, so an equal play never beats.
 */
export function canBeatGuandan(next: GuandanDeclaration, previous: GuandanDeclaration, level: number): boolean {
  const nextTier = tierOf(next);
  const previousTier = tierOf(previous);
  if (nextTier !== previousTier) return nextTier > previousTier;
  switch (nextTier) {
    case TIER_ORDINARY: {
      if (next.kind !== previous.kind) return false;
      if (next.kind === 'straight' || next.kind === 'threePairs' || next.kind === 'twoTriples') {
        return (next.low ?? 0) > (previous.low ?? 0);
      }
      return guandanRankStrength(next.primaryRank, level) > guandanRankStrength(previous.primaryRank, level);
    }
    case TIER_STRAIGHT_FLUSH:
      return (next.low ?? 0) > (previous.low ?? 0);
    case TIER_BOMB_FOUR:
    case TIER_BOMB_FIVE:
      return guandanRankStrength(next.primaryRank, level) > guandanRankStrength(previous.primaryRank, level);
    case TIER_BOMB_BIG:
      if (next.count !== previous.count) return next.count > previous.count;
      return guandanRankStrength(next.primaryRank, level) > guandanRankStrength(previous.primaryRank, level);
    default:
      return false; // two four-joker plays are equal
  }
}

/** Strongest legal interpretation of one physical selection; equal strength keeps the stable first reading. */
export function strongestGuandanOption(
  options: readonly GuandanOption[],
  level: number,
  previous: GuandanDeclaration | null = null,
): GuandanOption | null {
  let strongest: GuandanOption | null = null;
  for (const option of options) {
    if (previous && !canBeatGuandan(option.declaration, previous, level)) continue;
    if (!strongest || canBeatGuandan(option.declaration, strongest.declaration, level)) strongest = option;
  }
  return strongest;
}

/**
 * Tribute candidates: every card tied for the highest strength. Heart level cards are excluded by
 * rule; other level cards stay eligible and are the highest card below the jokers.
 */
export function guandanTributeEligible(hand: readonly Card[], level: number): Card[] {
  const eligible = hand.filter((card) => !isGuandanWild(card, level));
  if (eligible.length === 0) return [];
  const best = eligible.reduce((max, card) => Math.max(max, guandanRankStrength(card.rank, level)), 0);
  return eligible.filter((card) => guandanRankStrength(card.rank, level) === best);
}

/**
 * Return candidates: every card of rank-order strength 10 or lower. Level cards are excluded because
 * they rank above A. When the whole hand is above 10, every minimum-strength tie is eligible.
 */
export function guandanReturnEligible(hand: readonly Card[], level: number): Card[] {
  const low = hand.filter((card) => guandanRankStrength(card.rank, level) <= 10);
  if (low.length > 0) return low;
  if (hand.length === 0) return [];
  const min = hand.reduce((value, card) => Math.min(value, guandanRankStrength(card.rank, level)), Infinity);
  return hand.filter((card) => guandanRankStrength(card.rank, level) === min);
}
