// Pure counter maths for the Doudizhu 记牌器 (card counter).
//
// Inputs are strictly public facts plus the viewer's OWN current hand: the accepted public play
// history for this round and the local hand. The counter never reads an opponent hand and never
// infers hidden cards, so `outside` is honest about what is still unaccounted for outside the
// viewer's hand (other hands, undealt bottom, etc.). A bad input is reported as-is, never clamped
// into a plausible-looking count.
import type { Card, TablePlay } from '../shared/protocol';

/** Counter order, strongest first: big joker, small joker, then 2 (15) down to 3. */
const COUNTER_RANKS: readonly number[] = [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3];

/** Lowest joker rank; 16 small joker, 17 big joker, 3..15 regular ranks (15 === 2). */
const JOKER_MIN_RANK = 16;

export interface CardCounterEntry {
  /** Card rank: 3..15 (15 === 2), 16 small joker, 17 big joker. */
  rank: number;
  /** Copies of this rank a fresh deck holds: 4 for ranks 3..15, 1 per deck for each joker. */
  total: number;
  /** Copies already accepted in the public history this round. */
  played: number;
  /** Copies currently in the viewer's own hand. */
  inHand: number;
  /** total - played: copies not publicly played yet. */
  remaining: number;
  /** remaining - inHand: copies still unaccounted for outside the viewer's own hand. */
  outside: number;
}

function tallyRanks(cards: readonly Card[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return counts;
}

function tallyPlays(plays: readonly Pick<TablePlay, 'cards'>[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const play of plays) {
    for (const card of play.cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }
  return counts;
}

/**
 * Counter figures for every rank, ordered 17..3.
 *
 * `hand` is the viewer's own current hand; `plays` is the public accepted-play history (only
 * `cards` is read). In a valid authority state every physical copy is in exactly one of three
 * disjoint buckets — the public played history, the viewer's own hand, or somebody else's hand
 * (plus any undealt cards) — which is exactly the split reported per rank.
 */
export function buildCardCounter(
  hand: readonly Card[],
  plays: readonly Pick<TablePlay, 'cards'>[],
  deckCount: 1 | 2 = 1,
): CardCounterEntry[] {
  const inHand = tallyRanks(hand);
  const played = tallyPlays(plays);

  return COUNTER_RANKS.map((rank) => {
    // Regular ranks have 4 copies (one per suit); each joker is a single copy per deck.
    const total = rank >= JOKER_MIN_RANK ? deckCount : 4 * deckCount;
    const playedCount = played.get(rank) ?? 0;
    const handCount = inHand.get(rank) ?? 0;
    const remaining = total - playedCount;
    return {
      rank,
      total,
      played: playedCount,
      inHand: handCount,
      remaining,
      outside: remaining - handCount,
    };
  });
}
