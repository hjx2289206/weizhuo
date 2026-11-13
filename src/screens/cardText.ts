import type { Card } from '../../shared/protocol'

/** Ranks 3..9 print as their digit; 10 and the faces get their card glyphs. */
const RANK_GLYPH: Record<number, string> = { 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' }
/** Jokers carry no suit, so they print as their name instead of a glyph. */
const JOKER_GLYPH: Record<number, string> = { 16: '小王', 17: '大王' }
const SUIT_GLYPH: Record<Card['suit'], string> = { spade: '♠', heart: '♥', club: '♣', diamond: '♦', joker: '' }

/**
 * Printed rank of one card, jokers included. The single source of truth for rank text: levels,
 * claim notes and card faces all print the same glyphs.
 */
export function rankGlyph(rank: number): string {
  return RANK_GLYPH[rank] ?? JOKER_GLYPH[rank] ?? String(rank)
}

/** Suit glyph only; jokers have none. */
export function suitGlyph(suit: Card['suit']): string {
  return SUIT_GLYPH[suit]
}

/**
 * Text for one compact public bottom card, sized for a 32x24 tag: rank plus a single suit
 * glyph (`10♣`, `A♠`). Jokers have no suit, so they read 小王 / 大王 rather than a redundant one.
 * `red` matches the printed card art: hearts, diamonds and the big joker (rank 17) are red ink.
 */
export function bottomCardText(card: Card): { text: string; red: boolean } {
  if (card.suit === 'joker') return { text: rankGlyph(card.rank), red: card.rank === 17 }
  return {
    text: `${rankGlyph(card.rank)}${SUIT_GLYPH[card.suit]}`,
    red: card.suit === 'heart' || card.suit === 'diamond',
  }
}
