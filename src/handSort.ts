// Local hand ordering. The server's hand order is authoritative for nothing except initial
// display: reordering cards here changes only how this browser paints them, never selection ids
// or the play payload. The chosen mode is remembered per game in localStorage.

import type { Card, GameKind } from '../shared/protocol';
import { GUANDAN_LEVELS, guandanRankStrength, isGuandanWild } from '../shared/guandan';
import type { StorageLike } from './sessionStore';

export type HandSortMode = 'rank' | 'suit' | 'combo';

export const HAND_SORT_MODES: readonly HandSortMode[] = ['rank', 'suit', 'combo'];

export const HAND_SORT_LABELS: Record<HandSortMode, string> = {
  rank: '点数',
  suit: '花色',
  combo: '组合',
};

const SUIT_ORDER: Record<Card['suit'], number> = {
  spade: 0,
  heart: 1,
  club: 2,
  diamond: 3,
  joker: 4,
};

const STORAGE_PREFIX = 'ddz:hand-sort:';

export function isHandSortMode(value: unknown): value is HandSortMode {
  return value === 'rank' || value === 'suit' || value === 'combo';
}

export function handSortStorageKey(game: GameKind): string {
  return `${STORAGE_PREFIX}${game}`;
}

/** Read a saved mode, falling back to rank order for missing, corrupt or foreign values. */
export function readHandSortMode(game: GameKind, store: StorageLike | null): HandSortMode {
  if (!store) return 'rank';
  try {
    const raw = store.getItem(handSortStorageKey(game));
    return isHandSortMode(raw) ? raw : 'rank';
  } catch {
    return 'rank';
  }
}

export function writeHandSortMode(game: GameKind, mode: HandSortMode, store: StorageLike | null): void {
  if (!store) return;
  try {
    store.setItem(handSortStorageKey(game), mode);
  } catch {
    /* private mode or quota: the in-memory mode still works for this session */
  }
}

export function nextHandSortMode(mode: HandSortMode): HandSortMode {
  const index = HAND_SORT_MODES.indexOf(mode);
  return HAND_SORT_MODES[(index + 1) % HAND_SORT_MODES.length] ?? 'rank';
}

function strength(card: Card, game: GameKind, level: number | null): number {
  return game === 'guandan' ? guandanRankStrength(card.rank, level ?? GUANDAN_LEVELS[0]) : card.rank;
}

/** Natural sequence order, used only inside the combo grouping for straight runs. */
function naturalOrder(card: Card, game: GameKind): number {
  if (game === 'guandan') {
    const index = GUANDAN_LEVELS.indexOf(card.rank);
    return index >= 0 ? index : -1;
  }
  return card.rank >= 3 && card.rank <= 14 ? card.rank : -1;
}

/**
 * Ranks that form a run of at least five singles. Pairs/triples/bombs are deliberately excluded:
 * combo order prioritizes keeping real combinations intact over finding every possible straight.
 */
function straightRanks(counts: ReadonlyMap<number, number>, game: GameKind): Set<number> {
  const marked = new Set<number>();
  const isSingle = (rank: number) => counts.get(rank) === 1;

  if (game === 'guandan') {
    // Natural linear order 2,3,...,A; the special A2345 window is checked separately below.
    let run: number[] = [];
    for (const rank of GUANDAN_LEVELS) {
      if (isSingle(rank)) run.push(rank);
      else {
        if (run.length >= 5) run.forEach((entry) => marked.add(entry));
        run = [];
      }
    }
    if (run.length >= 5) run.forEach((entry) => marked.add(entry));
    // The A-as-1 window wraps around the array.
    const wrap = [14, 15, 3, 4, 5];
    if (wrap.every(isSingle)) wrap.forEach((entry) => marked.add(entry));
    return marked;
  }

  let run: number[] = [];
  for (let rank = 3; rank <= 14; rank += 1) {
    if (isSingle(rank)) run.push(rank);
    else {
      if (run.length >= 5) run.forEach((entry) => marked.add(entry));
      run = [];
    }
  }
  if (run.length >= 5) run.forEach((entry) => marked.add(entry));
  return marked;
}

/**
 * Display order for one hand. Ties fall back to suit and then physical id so two identical
 * rank sets never flicker between renders.
 */
export function sortHandForDisplay(
  cards: readonly Card[],
  mode: HandSortMode,
  game: GameKind,
  level: number | null = null,
): Card[] {
  const copy = [...cards];
  const byId = (a: Card, b: Card) => a.id.localeCompare(b.id);
  const byStrength = (a: Card, b: Card) => strength(b, game, level) - strength(a, game, level);
  const bySuit = (a: Card, b: Card) => SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];

  if (mode === 'rank') {
    return copy.sort((a, b) => byStrength(a, b) || bySuit(a, b) || byId(a, b));
  }

  if (mode === 'suit') {
    return copy.sort((a, b) => bySuit(a, b) || byStrength(a, b) || byId(a, b));
  }

  // Combo: wildcards, bombs, triples, pairs, straight-run singles, then plain singles.
  const counts = new Map<number, number>();
  for (const card of copy) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  const straight = straightRanks(counts, game);

  function category(card: Card): number {
    if (game === 'guandan' && isGuandanWild(card, level ?? GUANDAN_LEVELS[0])) return 0;
    const smallJokers = counts.get(16) ?? 0;
    const bigJokers = counts.get(17) ?? 0;
    // Doudizhu's two jokers are a rocket, the strongest combination in the hand.
    if (game === 'doudizhu' && card.rank >= 16 && smallJokers > 0 && bigJokers > 0) return 0;
    // Guandan's four jokers are a bomb even though they are split across two ranks.
    if (game === 'guandan' && card.rank >= 16 && smallJokers === 2 && bigJokers === 2) return 1;
    const count = counts.get(card.rank) ?? 0;
    if (count >= 4) return 1;
    if (count === 3) return 2;
    if (count === 2) return 3;
    if (straight.has(card.rank)) return 4;
    return 5;
  }

  function within(a: Card, b: Card): number {
    const cat = category(a);
    if (cat !== category(b)) return cat - category(b);
    if (cat === 1) {
      const countA = counts.get(a.rank) ?? 0;
      const countB = counts.get(b.rank) ?? 0;
      if (countA !== countB) return countB - countA;
    }
    if (cat === 4) {
      const order = naturalOrder(b, game) - naturalOrder(a, game);
      if (order !== 0) return order;
    } else {
      const order = byStrength(a, b);
      if (order !== 0) return order;
    }
    return bySuit(a, b) || byId(a, b);
  }

  return copy.sort(within);
}
