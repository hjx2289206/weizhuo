// Authoritative Doudizhu card, play-type, comparison and scoring rules.
// Pure functions; no I/O so they are directly testable.
import type { Card, Suit } from './protocol';

const SUITS: Suit[] = ['spade', 'heart', 'club', 'diamond'];
const SUIT_CHAR: Record<Suit, string> = { spade: 's', heart: 'h', club: 'c', diamond: 'd', joker: 'j' };

/** Highest rank usable inside runs (straights / consecutive pairs / triples). */
export const RUN_MAX_RANK = 14; // A === 14; 15 (2) and jokers are excluded from runs.

/** Lowest joker rank; jokers never form pairs, triples or bombs. */
export const JOKER_MIN_RANK = 16;

export const DECK_SIZE = 54;
export const HAND_SIZE = 17;
export const BOTTOM_SIZE = 3;

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 3; rank <= 15; rank += 1) {
      deck.push({ id: `${SUIT_CHAR[suit]}${rank}`, rank, suit });
    }
  }
  deck.push({ id: 'j16', rank: 16, suit: 'joker' });
  deck.push({ id: 'j17', rank: 17, suit: 'joker' });
  return deck;
}

const SUIT_ORDER: Record<Suit, number> = { spade: 0, heart: 1, club: 2, diamond: 3, joker: 4 };

/** Big cards first; ties broken by suit order so hands render deterministically. */
export function sortHand(cards: Card[]): Card[] {
  return cards.slice().sort((a, b) => b.rank - a.rank || SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit]);
}

export interface PlayKind {
  kind: string;
  /** Rank that decides comparison: the single/pair/triple rank or the run's top rank. */
  main: number;
  length: number;
  /** 1 for bomb and rocket (doubles the multiplier), 0 otherwise. */
  bombs: number;
}

function countRanks(cards: Card[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return counts;
}

function isConsecutive(ranks: number[]): boolean {
  for (let i = 1; i < ranks.length; i += 1) {
    if (ranks[i] !== ranks[i - 1] + 1) return false;
  }
  return true;
}

/** Longest consecutive ascending run of run-eligible ranks. */
function longestRun(ranks: number[]): number[] {
  let best: number[] = [];
  let current: number[] = [];
  for (const rank of ranks) {
    if (rank > RUN_MAX_RANK) {
      current = [];
      continue;
    }
    if (current.length > 0 && rank === current[current.length - 1] + 1) current.push(rank);
    else current = [rank];
    if (current.length > best.length) best = current.slice();
  }
  return best;
}

/**
 * Identify the play type of a card set, or null if it is not a legal shape.
 *
 * Documented ambiguous-wing policy (asserted by tests):
 * - Runs (straight / consecutive pairs / consecutive triples / airplane body) only use ranks 3..14.
 * - Consecutive triples >= 2 with no wings is a legal "airplane" (`triples_run`).
 * - Airplane single wings: exactly one wing card per triple; a wing rank may repeat at most twice
 *   (so a pair may act as two wings) and may never be a four-of-a-kind.
 * - Airplane pair wings: exactly one pair per triple; each pair is a distinct rank (count === 2).
 * - Four-with-two-singles accepts any two remaining cards (including a pair or two jokers).
 * - Four-with-two-pairs requires exactly two distinct pairs.
 * - Jokers are excluded from runs entirely, only 16+17 forms the rocket, and no two or more
 *   same-rank jokers are ever a pair/triple/bomb; the only jokers allowed as wings are singles.
 */
export function detectPlay(cards: Card[]): PlayKind | null {
  const n = cards.length;
  if (n === 0) return null;
  const counts = countRanks(cards);
  const ranks = [...counts.keys()].sort((a, b) => a - b);
  const singles = ranks.filter((r) => counts.get(r) === 1);
  // Jokers never group: only 16+17 is legal (rocket). They may only appear as single wings.
  const pairs = ranks.filter((r) => counts.get(r) === 2 && r < JOKER_MIN_RANK);
  const triples = ranks.filter((r) => counts.get(r) === 3 && r < JOKER_MIN_RANK);
  const quads = ranks.filter((r) => counts.get(r) === 4 && r < JOKER_MIN_RANK);
  const top = ranks[ranks.length - 1];

  if (n === 2 && counts.size === 2 && counts.has(16) && counts.has(17)) {
    return { kind: 'rocket', main: 17, length: 2, bombs: 1 };
  }
  if (n === 1) return { kind: 'single', main: cards[0].rank, length: 1, bombs: 0 };
  if (n === 2 && pairs.length === 1) return { kind: 'pair', main: pairs[0], length: 2, bombs: 0 };
  if (n === 3 && triples.length === 1) return { kind: 'triple', main: triples[0], length: 3, bombs: 0 };
  if (n === 4) {
    if (quads.length === 1) return { kind: 'bomb', main: quads[0], length: 4, bombs: 1 };
    if (triples.length === 1 && singles.length === 1) {
      return { kind: 'triple_single', main: triples[0], length: 4, bombs: 0 };
    }
  }
  if (n === 5 && triples.length === 1 && pairs.length === 1) {
    return { kind: 'triple_pair', main: triples[0], length: 5, bombs: 0 };
  }
  if (n >= 5 && singles.length === ranks.length && top <= RUN_MAX_RANK && isConsecutive(ranks)) {
    return { kind: 'straight', main: top, length: n, bombs: 0 };
  }
  if (
    n >= 6 &&
    n % 2 === 0 &&
    pairs.length === ranks.length &&
    ranks.length >= 3 &&
    top <= RUN_MAX_RANK &&
    isConsecutive(ranks)
  ) {
    return { kind: 'pairs_run', main: top, length: n, bombs: 0 };
  }
  if (
    n >= 6 &&
    n % 3 === 0 &&
    triples.length === ranks.length &&
    ranks.length >= 2 &&
    top <= RUN_MAX_RANK &&
    isConsecutive(ranks)
  ) {
    return { kind: 'triples_run', main: top, length: n, bombs: 0 };
  }
  if (n === 6 && quads.length === 1) {
    return { kind: 'four_two_single', main: quads[0], length: 6, bombs: 0 };
  }
  if (n === 8 && quads.length === 1) {
    const rest = ranks.filter((r) => r !== quads[0]);
    if (rest.length === 2 && rest.every((r) => counts.get(r) === 2)) {
      return { kind: 'four_two_pair', main: quads[0], length: 8, bombs: 0 };
    }
  }
  const run = longestRun(triples);
  if (run.length >= 2) {
    const runRanks = new Set(run);
    const wings = cards.filter((c) => !runRanks.has(c.rank));
    const wingCounts = countRanks(wings);
    const k = run.length;
    const singleWingsOk = [...wingCounts.entries()].every(
      ([rank, count]) => count <= 2 && (rank < JOKER_MIN_RANK || count === 1),
    );
    if (wings.length === k && singleWingsOk) {
      return { kind: 'airplane_single', main: run[k - 1], length: n, bombs: 0 };
    }
    const pairWingsOk = [...wingCounts.entries()].every(([rank, count]) => count === 2 && rank < JOKER_MIN_RANK);
    if (wings.length === 2 * k && pairWingsOk) {
      return { kind: 'airplane_pair', main: run[k - 1], length: n, bombs: 0 };
    }
  }
  return null;
}

/** Whether `play` legally follows `last` (null === fresh lead, anything goes). */
export function canBeat(play: PlayKind, last: PlayKind | null): boolean {
  if (!last) return true;
  if (play.kind === 'rocket') return true;
  if (play.kind === 'bomb') {
    if (last.kind === 'rocket') return false;
    return last.kind !== 'bomb' || play.main > last.main;
  }
  if (last.kind === 'bomb' || last.kind === 'rocket') return false;
  return play.kind === last.kind && play.length === last.length && play.main > last.main;
}

export interface GameResult {
  winner: 'landlord' | 'farmers';
  landlord: number;
  bid: number;
  multiplier: number;
}

/** Zero-sum delta per seat index for one finished game. */
export function scoreGame(result: GameResult): number[] {
  const delta = [0, 0, 0];
  const base = result.bid * result.multiplier;
  if (result.winner === 'landlord') {
    delta[result.landlord] = 2 * base;
    for (let seat = 0; seat < delta.length; seat += 1) {
      if (seat !== result.landlord) delta[seat] = -base;
    }
  } else {
    delta[result.landlord] = -2 * base;
    for (let seat = 0; seat < delta.length; seat += 1) {
      if (seat !== result.landlord) delta[seat] = base;
    }
  }
  return delta;
}
