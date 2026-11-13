import type { Card, Suit } from '../../shared/protocol'
import { createDeck } from '../../shared/doudizhu'
import { createGuandanDeck } from '../../shared/guandan'
import type { GameContext } from '../games/types'
export type Face = number | readonly [number, Suit]

/** Allocate an entire real deck, including each physical copy, then fill unspecified slots. */
export function fixedDeck(game: 'doudizhu' | 'guandan', wishes: readonly (readonly Face[])[], fillHigh: readonly number[] = []): Card[] {
  const pool = game === 'doudizhu' ? createDeck() : createGuandanDeck()
  const size = game === 'doudizhu' ? 17 : 27
  const hands = Array.from({ length: game === 'doudizhu' ? 4 : 4 }, () => [] as Card[])
  wishes.forEach((faces, seat) => {
    for (const face of faces) {
      const rank = typeof face === 'number' ? face : face[0]
      const index = pool.findIndex(card => card.rank === rank && (typeof face === 'number' || card.suit === face[1]))
      if (index < 0) throw new Error(`固定发牌重复使用 ${JSON.stringify(face)}`)
      hands[seat]!.push(pool.splice(index, 1)[0]!)
    }
  })
  for (const seat of [...fillHigh, ...hands.map((_, i) => i).filter(i => !fillHigh.includes(i))]) {
    const limit = game === 'doudizhu' && seat === 3 ? 3 : size
    if (hands[seat]!.length > limit) throw new Error(`固定手牌过多 ${seat}`)
    while (hands[seat]!.length < limit) {
      const index = fillHigh.includes(seat) ? pool.findIndex(card => card.rank >= 11 && card.rank !== 15) : 0
      if (index < 0 || !pool[index]) throw new Error('固定发牌余牌不足')
      hands[seat]!.push(pool.splice(index, 1)[0]!)
    }
  }
  if (pool.length) throw new Error('牌组不完整')
  return hands.flat().map(card => ({ ...card }))
}

export function context(decks: readonly Card[][], firstSeat = 0): GameContext {
  let deal = 0, play = 0
  return { firstSeat, dealDeck: () => {
    const source = decks[deal++]
    if (!source) throw new Error(`教学发牌耗尽，第 ${deal} 副`)
    return source.map(card => ({ ...card }))
  }, stampPlay: (seatId, cards, kind, claim) => ({ id: `teaching-play-${++play}`, seatId, cards: cards.map(card => ({ ...card })), kind,
    ...(claim ? { claim } : {}), scatter: { x: 0, y: 0, angle: 0 } }) }
}

export function select(hand: readonly Card[], faces: readonly Face[]): Card[] {
  const remaining = [...hand]
  return faces.map(face => {
    const index = remaining.findIndex(card => card.rank === (typeof face === 'number' ? face : face[0]) && (typeof face === 'number' || card.suit === face[1]))
    if (index < 0) throw new Error(`教学手牌缺少 ${JSON.stringify(face)}`)
    return remaining.splice(index, 1)[0]!
  })
}
