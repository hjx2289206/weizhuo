import type { BoardAiDifficulty } from '../../shared/boardAi'
import {
  REVERSI_AREA, REVERSI_BITS, REVERSI_FULL, otherReversiSide, reversiBitCount, reversiBits,
  reversiFlipMask, reversiLegalMask, reversiPoints, type ReversiBoard, type ReversiSide,
} from '../../shared/reversi'

export interface ReversiPosition { board: ReversiBoard; toMove: ReversiSide }

export const REVERSI_PROFILES = {
  beginner: { candidates: 8, depth: 1, milliseconds: 100, choices: 4, solveEndgame: false },
  easy: { candidates: 10, depth: 2, milliseconds: 200, choices: 2, solveEndgame: false },
  normal: { candidates: 12, depth: 4, milliseconds: 500, choices: 1, solveEndgame: true },
  hard: { candidates: 15, depth: 6, milliseconds: 1000, choices: 1, solveEndgame: true },
  challenge: { candidates: 20, depth: Infinity, milliseconds: 2000, choices: 1, solveEndgame: true },
} as const

const ENDGAME_EMPTY = 12
const LIMIT = 100_000
const TIMEOUT = Symbol('search budget expired')
const WEIGHTS = [
  120, -24, 14,  6,  6, 14, -24, 120,
  -24, -44, -3, -3, -3, -3, -44, -24,
   14,  -3,  9,  3,  3,  9,  -3,  14,
    6,  -3,  3,  1,  1,  3,  -3,   6,
    6,  -3,  3,  1,  1,  3,  -3,   6,
   14,  -3,  9,  3,  3,  9,  -3,  14,
  -24, -44, -3, -3, -3, -3, -44, -24,
  120, -24, 14,  6,  6, 14, -24, 120,
]
const corners = [[0, 1, 8], [7, -1, 8], [56, 1, -8], [63, -1, -8]] as const
const cornerMask = corners.reduce((mask, [point]) => mask | REVERSI_BITS[point]!, 0n)
const weightMasks = [...new Set(WEIGHTS)].map(weight => ({
  weight, mask: WEIGHTS.reduce((mask, value, point) => value === weight ? mask | REVERSI_BITS[point]! : mask, 0n),
}))

/** Corner disks and contiguous same-color edge disks anchored to them are stable. */
function stableEdgeCount(own: bigint): number {
  let stable = 0n
  for (const [corner, row, column] of corners) {
    const anchor = REVERSI_BITS[corner]!
    if (!(own & anchor)) continue
    stable |= anchor
    for (const direction of [row, column]) {
      for (let distance = 1; distance < 8; distance++) {
        const bit = REVERSI_BITS[corner + direction * distance]!
        if (!(own & bit)) break
        stable |= bit
      }
    }
  }
  return reversiBitCount(stable)
}

function evaluate(own: bigint, opponent: bigint, legal: bigint, empty: number): number {
  let position = 0
  for (const { weight, mask } of weightMasks) {
    position += weight * (reversiBitCount(own & mask) - reversiBitCount(opponent & mask))
  }
  const mobility = reversiBitCount(legal) - reversiBitCount(reversiLegalMask(opponent, own))
  const stable = stableEdgeCount(own) - stableEdgeCount(opponent)
  const disks = reversiBitCount(own) - reversiBitCount(opponent)
  return position + 17 * mobility + 25 * stable + (empty <= 20 ? 3 * disks : -disks)
}

interface SearchMove { point: number; own: bigint; opponent: bigint; reply: bigint; order: number }
interface TableEntry { depth: number; value: number; bound: 'exact' | 'lower' | 'upper'; point: number }

class ReversiSearch {
  private readonly profile
  private readonly deadline
  private readonly table = new Map<bigint, TableEntry>()
  private nodes = 0

  constructor(
    difficulty: BoardAiDifficulty,
    private readonly exact: boolean,
    private readonly now: () => number,
  ) {
    this.profile = REVERSI_PROFILES[difficulty]
    this.deadline = now() + this.profile.milliseconds
  }

  private ordered(own: bigint, opponent: bigint, legal: bigint, preferred?: number): SearchMove[] {
    return reversiPoints(legal).map(point => {
      const bit = REVERSI_BITS[point]!
      const flipped = reversiFlipMask(own, opponent, bit)
      const nextOwn = own | bit | flipped, nextOpponent = opponent ^ flipped
      const reply = reversiLegalMask(nextOpponent, nextOwn)
      const order = WEIGHTS[point]! - 14 * reversiBitCount(reply) + (point === preferred ? 10_000 : 0)
      return { point, own: nextOwn, opponent: nextOpponent, reply, order }
    }).sort((a, b) => b.order - a.order || a.point - b.point)
  }

  private checkClock(): void {
    if (!this.exact && this.now() >= this.deadline) throw TIMEOUT
  }

  private evaluateTree(own: bigint, opponent: bigint, legal: bigint, empty: number, depth: number, alpha: number, beta: number): number {
    if (++this.nodes % 64 === 0) this.checkClock()
    if (!legal) {
      const reply = reversiLegalMask(opponent, own)
      if (reply) return -this.evaluateTree(opponent, own, reply, empty, depth, -beta, -alpha)
      const margin = reversiBitCount(own) - reversiBitCount(opponent)
      return this.exact ? margin : Math.sign(margin) * 10_000 + margin
    }
    if (depth === 0) return evaluate(own, opponent, legal, empty)

    const key = (own << 64n) | opponent
    const entry = this.table.get(key)
    if (entry && entry.depth >= depth && (entry.bound === 'exact'
      || (entry.bound === 'lower' && entry.value >= beta) || (entry.bound === 'upper' && entry.value <= alpha))) return entry.value
    const ordered = this.ordered(own, opponent, legal, entry?.point)
    const candidates = this.exact ? ordered : ordered.slice(0, this.profile.candidates)
    let best = -LIMIT, point = candidates[0]!.point
    const initialAlpha = alpha
    for (const move of candidates) {
      const value = -this.evaluateTree(move.opponent, move.own, move.reply, empty - 1, depth - 1, -beta, -alpha)
      if (value > best) { best = value; point = move.point }
      alpha = Math.max(alpha, best)
      if (alpha >= beta) break
    }
    if (entry || this.table.size < 200_000) this.table.set(key, {
      depth, value: best, point, bound: best >= beta ? 'lower' : best <= initialAlpha ? 'upper' : 'exact',
    })
    return best
  }

  choose(own: bigint, opponent: bigint, legal: bigint, empty: number, random: () => number): number {
    let ordered = this.ordered(own, opponent, legal)
    if (ordered.length === 1) return ordered[0]!.point
    if (!this.exact) {
      if (this.profile.choices === 1 && legal & cornerMask) {
        return ordered.find(move => REVERSI_BITS[move.point]! & cornerMask)!.point
      }
      ordered = ordered.slice(0, this.profile.candidates)
    }
    const randomize = !this.exact && this.profile.choices > 1
    const maxDepth = this.exact ? empty : Math.min(empty, this.profile.depth)
    try {
      for (let depth = this.exact ? maxDepth : 1; depth <= maxDepth; depth++) {
        let best = -LIMIT
        const scored: { move: SearchMove; value: number }[] = []
        for (const move of ordered) {
          this.checkClock()
          const value = -this.evaluateTree(move.opponent, move.own, move.reply, empty - 1, depth - 1, -LIMIT, randomize ? LIMIT : -best)
          scored.push({ move, value })
          best = Math.max(best, value)
        }
        scored.sort((a, b) => b.value - a.value)
        ordered = scored.map(entry => entry.move)
      }
    } catch (error) {
      if (error !== TIMEOUT) throw error
      // Keep the last fully evaluated ordering if a deeper iteration did not finish.
    }
    if (!randomize) return ordered[0]!.point
    const count = Math.min(this.profile.choices, ordered.length)
    if (this.profile.choices === 2) return ordered[Math.floor(random() * count)]!.point
    let sample = random() * count * (count + 1) / 2
    for (let rank = 0; rank < count; rank++) if ((sample -= count - rank) < 0) return ordered[rank]!.point
    return ordered[count - 1]!.point
  }
}

export function chooseReversiMove(
  position: ReversiPosition,
  difficulty: BoardAiDifficulty,
  { random = Math.random, now = () => performance.now() }: { random?: () => number; now?: () => number } = {},
): number | null {
  const bits = reversiBits(position.board)
  const own = bits[position.toMove], opponent = bits[otherReversiSide(position.toMove)]
  const legal = reversiLegalMask(own, opponent)
  if (!legal) return null
  const empty = REVERSI_AREA - reversiBitCount((own | opponent) & REVERSI_FULL)
  const exact = REVERSI_PROFILES[difficulty].solveEndgame && empty <= ENDGAME_EMPTY
  return new ReversiSearch(difficulty, exact, now).choose(own, opponent, legal, empty, random)
}
