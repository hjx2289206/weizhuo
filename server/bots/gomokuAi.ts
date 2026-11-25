import type { BoardAiDifficulty } from '../../shared/boardAi'
import { createRenjuAnalyzer, type GomokuRule, type RenjuThreat, type StoneBoard, type StoneSide } from '../../shared/stones'

export interface GomokuPosition {
  board: StoneBoard
  size: number
  toMove: StoneSide
  history: number[]
  rule?: GomokuRule
}

export const GOMOKU_PROFILES = {
  beginner: { candidates: 8, depth: 1, vcf: 0, milliseconds: 100 },
  easy: { candidates: 10, depth: 2, vcf: 0, milliseconds: 200 },
  normal: { candidates: 12, depth: 4, vcf: 0, milliseconds: 500 },
  hard: { candidates: 15, depth: 6, vcf: 8, milliseconds: 1000 },
  challenge: { candidates: 20, depth: Infinity, vcf: 14, milliseconds: 2000 },
} as const satisfies Record<BoardAiDifficulty, { candidates: number; depth: number; vcf: number; milliseconds: number }>

const SHAPE = { none: 0, closedTwo: 1, openTwo: 2, closedThree: 3, openThree: 4, four: 5, openFour: 6, five: 7 } as const
const SHAPE_WEIGHT = [0, 6, 34, 100, 430, 1800, 15000, 50000]
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]] as const
const WINDOWS = [31, 62, 124, 248, 496]
const CENTER = 1 << 4
const FIVE = 1 << 9
const MATE = 1_000_000
const INFINITY = MATE * 2
const TABLE_LIMIT = 32_768
const POWERS = Array.from({ length: 8 }, (_, index) => 3 ** index)
const SHAPES = new Int8Array(3 ** 8).fill(-1)

function multiple(bits: number): boolean { return (bits & (bits - 1)) !== 0 }

function completions(stones: number, empty: number): number {
  const available = stones | empty
  let wins = 0
  for (const window of WINDOWS) {
    if ((available & window) !== window) continue
    const missing = window & empty
    if (!missing) return FIVE
    if (!multiple(missing)) wins |= missing
  }
  return wins
}

/** A live three must extend to a four with two distinct winning points on the same line. */
function threeShape(stones: number, empty: number): number {
  let closed = false
  for (let remaining = empty; remaining; remaining &= remaining - 1) {
    const point = remaining & -remaining
    const wins = completions(stones | point, empty ^ point)
    if (multiple(wins)) return SHAPE.openThree
    closed ||= wins !== 0
  }
  return closed ? SHAPE.closedThree : SHAPE.none
}

function classify(stones: number, empty: number): number {
  if (!multiple(stones)) return SHAPE.none
  const wins = completions(stones, empty)
  if (wins === FIVE) return SHAPE.five
  if (wins) return multiple(wins) ? SHAPE.openFour : SHAPE.four
  const three = threeShape(stones, empty)
  if (three) return three
  const available = stones | empty
  const canMakeFive = WINDOWS.some(window => (available & window) === window && multiple(stones & window))
  if (!canMakeFive) return SHAPE.none
  for (let remaining = empty; remaining; remaining &= remaining - 1) {
    const point = remaining & -remaining
    if (threeShape(stones | point, empty ^ point) === SHAPE.openThree) return SHAPE.openTwo
  }
  return SHAPE.closedTwo
}

function shape(code: number): number {
  const known = SHAPES[code]!
  if (known >= 0) return known
  let stones = CENTER, empty = 0, digits = code
  for (let index = 0; index < 9; index++) {
    if (index === 4) continue
    const digit = digits % 3
    if (digit === 0) empty |= 1 << index
    else if (digit === 1) stones |= 1 << index
    digits = Math.floor(digits / 3)
  }
  const value = classify(stones, empty)
  SHAPES[code] = value
  return value
}

interface PointGeometry {
  lines: number[][]
  neighbors: number[]
  center: number
}

function geometry(size: number): PointGeometry[] {
  const center = Math.floor(size / 2)
  const index = (x: number, y: number) => x >= 0 && x < size && y >= 0 && y < size ? y * size + x : -1
  return Array.from({ length: size ** 2 }, (_, point) => {
    const x = point % size, y = Math.floor(point / size)
    const lines = DIRECTIONS.map(([dx, dy]) => [-4, -3, -2, -1, 1, 2, 3, 4].map(i => index(x + i * dx, y + i * dy)))
    const neighbors: number[] = []
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const neighbor = index(x + dx, y + dy)
      if ((dx || dy) && neighbor >= 0) neighbors.push(neighbor)
    }
    return { lines, neighbors, center: size - Math.max(Math.abs(x - center), Math.abs(y - center)) }
  })
}

function other(side: StoneSide): StoneSide { return side === 0 ? 1 : 0 }

interface Threat {
  win: boolean
  replies: number
  openThrees: number
  openFours: number
  score: number
}
const NO_THREAT: Threat = { win: false, replies: 0, openThrees: 0, openFours: 0, score: 0 }

interface RatedMove {
  point: number
  legal: boolean
  attack: Threat
  defense: Threat
  order: number
}

interface TableEntry {
  depth: number
  score: number
  bound: 'exact' | 'lower' | 'upper'
  point: number
}

function zobristKeys(length: number): bigint[] {
  let seed = 0x4e67c6a7
  function next(): number {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
  }
  return Array.from({ length }, () => (BigInt(next()) << 32n) | BigInt(next()))
}

class GomokuSearch {
  private readonly board: Uint8Array
  private readonly points: PointGeometry[]
  private readonly nearby: Int16Array
  private readonly keys: bigint[]
  private readonly center: number
  private readonly renju?: ReturnType<typeof createRenjuAnalyzer>
  private readonly table = new Map<bigint, TableEntry>()
  private hash = 0n
  private occupied = 0

  constructor(
    position: GomokuPosition,
    private readonly profile: typeof GOMOKU_PROFILES[BoardAiDifficulty],
    private readonly difficulty: BoardAiDifficulty,
    private readonly now: () => number,
    private readonly deadline: number,
  ) {
    this.board = new Uint8Array(position.board.length)
    this.center = Math.floor(position.size / 2) * (position.size + 1)
    this.points = geometry(position.size)
    this.nearby = new Int16Array(this.board.length)
    this.keys = zobristKeys(this.board.length * 2 + 1)
    position.board.forEach((side, point) => { if (side !== null) this.place(point, side) })
    if (position.rule === 'renju') this.renju = createRenjuAnalyzer(position.size, p => {
      const token = this.board[p]
      return token === 1 ? 0 : token === 2 ? 1 : null
    })
  }

  private place(point: number, side: StoneSide): void {
    this.board[point] = side + 1
    this.occupied++
    this.hash ^= this.keys[point * 2 + side]!
    for (const neighbor of this.points[point]!.neighbors) this.nearby[neighbor]!++
  }

  private remove(point: number, side: StoneSide): void {
    this.board[point] = 0
    this.occupied--
    this.hash ^= this.keys[point * 2 + side]!
    for (const neighbor of this.points[point]!.neighbors) this.nearby[neighbor]!--
  }

  private threat(point: number, side: StoneSide, renju?: RenjuThreat): Threat {
    if (renju?.forbidden) return NO_THREAT
    if (renju?.win) return { ...NO_THREAT, win: true, score: SHAPE_WEIGHT[SHAPE.five]! }
    let win = false, replies = 0, openThrees = 0, openFours = 0, score = 0
    for (const [axis, line] of this.points[point]!.lines.entries()) {
      let code = 0
      for (let index = 0; index < POWERS.length; index++) {
        const token = this.board[line[index]!]
        if (token !== 0) code += (token === side + 1 ? 1 : 2) * POWERS[index]!
      }
      const raw = shape(code)
      // Keep the freestyle heuristics for short patterns, but take Renju forcing patterns
      // from the same full-board analysis that controls black's move legality.
      const pattern = !renju ? raw : renju.replies[axis] === 2 ? SHAPE.openFour
        : renju.replies[axis] === 1 ? SHAPE.four : renju.openThrees[axis] ? SHAPE.openThree
        : raw <= SHAPE.openTwo ? raw : SHAPE.none
      score += SHAPE_WEIGHT[pattern]!
      if (pattern === SHAPE.five) win = true
      if (pattern === SHAPE.openFour) { replies += 2; openFours++ }
      if (pattern === SHAPE.four) replies++
      if (pattern === SHAPE.openThree) openThrees++
    }
    if (replies >= 2) score += 14000
    if (openThrees >= 2) score += 1000
    return { win, replies, openThrees, openFours, score }
  }

  private rated(side: StoneSide, ignoreOpenThree = false): RatedMove[] {
    const rated: RatedMove[] = []
    const rate = (point: number): RatedMove => {
      const black = this.renju?.analyze(point)
      const legal = side === 1 || !black?.forbidden
      const attack = this.threat(point, side, side === 0 ? black : undefined)
      const defense = this.threat(point, other(side), side === 1 ? black : undefined)
      let defenseScore = defense.score
      if (ignoreOpenThree) {
        // An existing live three receives its highest score at the point that extends it to an open four.
        defenseScore -= defense.openFours * SHAPE_WEIGHT[SHAPE.openFour]! + (defense.openFours ? 14000 : 0)
        defenseScore -= defense.openThrees * SHAPE_WEIGHT[SHAPE.openThree]! + (defense.openThrees >= 2 ? 1000 : 0)
      }
      const order = attack.score + defenseScore * 1.08 + this.points[point]!.center
      return { point, legal, attack, defense, order }
    }
    for (let point = 0; point < this.board.length; point++) {
      if (this.board[point] === 0 && this.nearby[point] !== 0) rated.push(rate(point))
    }
    if (this.renju && side === 0 && !rated.some(move => move.legal)) {
      for (let point = 0; point < this.board.length; point++) {
        if (this.board[point] === 0 && this.nearby[point] === 0) rated.push(rate(point))
      }
    }
    rated.sort((a, b) => b.order - a.order || a.point - b.point)
    return rated
  }

  private candidates(rated: RatedMove[], side: StoneSide): RatedMove[] {
    const moves = this.renju && side === 0 ? rated.filter(move => move.legal) : rated
    if (this.difficulty === 'beginner') return moves
    const ownWins = moves.filter(move => move.attack.win)
    if (ownWins.length) return ownWins
    const defenses = moves.filter(move => move.defense.win)
    if (defenses.length) return defenses
    const forks = moves.filter(move => move.attack.replies >= 2)
    if (forks.length) return forks
    if (this.difficulty === 'easy') return moves

    // Blocking an open three can mean covering its extension or taking one of its future ends.
    const threats = rated.filter(move => move.defense.replies >= 2)
    if (!threats.length) return moves
    const responses = moves.filter(move => {
      // A four forces a reply and can buy time to win or answer the open three.
      if (move.attack.replies > 0) return true
      this.board[move.point] = side + 1
      const blocked = threats.every(threat => threat.point === move.point ||
        this.threat(threat.point, other(side), side === 1 ? this.renju?.analyze(threat.point) : undefined).replies < 2)
      this.board[move.point] = 0
      return blocked
    })
    if (responses.length) return responses
    const blocks = threats.filter(move => move.legal)
    return blocks.length ? blocks : moves
  }

  private evaluate(moves: RatedMove[]): number {
    const own = Math.max(0, ...moves.map(move => move.attack.score))
    const opponent = Math.max(0, ...moves.map(move => move.defense.score))
    return own - Math.round(opponent * 0.9)
  }

  private search(side: StoneSide, depth: number, alpha: number, beta: number, ply: number): number {
    if (this.now() >= this.deadline) return 0
    if (this.occupied === this.board.length) return 0
    const key = side === 0 ? this.hash : this.hash ^ this.keys.at(-1)!
    const entry = this.table.get(key)
    if (entry && entry.depth >= depth && (entry.bound === 'exact' ||
      (entry.bound === 'lower' && entry.score >= beta) || (entry.bound === 'upper' && entry.score <= alpha))) return entry.score

    const moves = this.rated(side)
    if (moves.some(move => move.attack.win)) return MATE - ply
    const threats = moves.filter(move => move.defense.win)
    if (threats.length >= 2 || threats.some(move => !move.legal)) return -MATE + ply + 1
    if (depth === 0) return this.evaluate(moves)

    const candidates = this.candidates(moves, side).slice(0, this.profile.candidates)
    if (!candidates.length) return 0
    const preferred = candidates.findIndex(move => move.point === entry?.point)
    if (preferred > 0) candidates.unshift(candidates.splice(preferred, 1)[0]!)
    const initialAlpha = alpha
    let score = -INFINITY, point = candidates[0]!.point
    for (const move of candidates) {
      this.place(move.point, side)
      const value = -this.search(other(side), depth - 1, -beta, -alpha, ply + 1)
      this.remove(move.point, side)
      if (this.now() >= this.deadline) return 0
      if (value > score) { score = value; point = move.point }
      alpha = Math.max(alpha, score)
      if (alpha >= beta) break
    }
    if (this.table.size < TABLE_LIMIT || entry) this.table.set(key, {
      depth, score, point, bound: score >= beta ? 'lower' : score <= initialAlpha ? 'upper' : 'exact',
    })
    return score
  }

  /** VCF: every non-winning attack must give a check, and the defender must answer it. */
  private forcingWin(side: StoneSide, depth: number, expired: () => boolean, rated?: RatedMove[]): number | null {
    if (depth <= 0 || expired()) return null
    const moves = rated ?? this.rated(side)
    const win = moves.find(move => move.attack.win)
    if (win) return win.point
    if (depth < 3) return null
    const counters = moves.filter(move => move.defense.win)
    if (counters.length > 1) return null
    const attacks = moves.filter(move => move.legal && move.attack.replies && (!counters.length || move.point === counters[0]!.point))
    for (const { point } of attacks.slice(0, this.profile.candidates)) {
      if (expired()) return null
      this.place(point, side)
      const responses = this.rated(other(side))
      const winningReplies = responses.filter(move => move.defense.win)
      let proven = false
      if (!responses.some(move => move.attack.win)) {
        if (winningReplies.length >= 2 || winningReplies.some(move => !move.legal)) proven = true
        else if (winningReplies.length === 1) {
          const block = winningReplies[0]!.point
          this.place(block, other(side))
          proven = this.forcingWin(side, depth - 2, expired) !== null
          this.remove(block, other(side))
        }
      }
      this.remove(point, side)
      if (proven) return point
    }
    return null
  }

  choose(side: StoneSide, random: () => number): number | null {
    if (!this.occupied) return this.center
    if (this.occupied === this.board.length) return null
    const beginner = this.difficulty === 'beginner', easy = this.difficulty === 'easy'
    const rated = this.rated(side, beginner && random() < 0.3)
    const moves = this.candidates(rated, side).slice(0, this.profile.candidates)
    if (!moves.length) return null
    if (moves.length === 1) return moves[0]!.point
    if (beginner) {
      const weights = [4, 3, 2, 1].slice(0, moves.length)
      let draw = random() * weights.reduce((total, weight) => total + weight, 0)
      return moves[weights.findIndex(weight => (draw -= weight) < 0)]!.point
    }
    if (moves[0]!.attack.win || moves.every(move => move.defense.win || move.attack.replies >= 2)) {
      return moves[easy ? Math.floor(random() * Math.min(2, moves.length)) : 0]!.point
    }
    if (this.profile.vcf) {
      const vcfDeadline = Math.min(this.deadline, this.now() + this.profile.milliseconds * 0.35)
      const win = this.forcingWin(side, this.profile.vcf, () => this.now() >= vcfDeadline, rated)
      if (win !== null) return win
    }

    let ordered = moves
    for (let depth = 1; depth <= this.profile.depth && depth <= this.board.length - this.occupied; depth++) {
      let best = -INFINITY
      const results: { move: RatedMove; score: number }[] = []
      for (const move of ordered) {
        if (this.now() >= this.deadline) break
        this.place(move.point, side)
        const score = -this.search(other(side), depth - 1, -INFINITY, easy ? INFINITY : -best, 1)
        this.remove(move.point, side)
        if (this.now() >= this.deadline) break
        results.push({ move, score })
        best = Math.max(best, score)
      }
      if (results.length !== ordered.length) break
      results.sort((a, b) => b.score - a.score)
      ordered = results.map(result => result.move)
      if (Math.abs(best) >= MATE - this.board.length) break
    }
    return ordered[easy ? Math.floor(random() * Math.min(2, ordered.length)) : 0]!.point
  }
}

export function chooseGomokuMove(
  position: GomokuPosition,
  difficulty: BoardAiDifficulty,
  { random = Math.random, now = () => performance.now() }: { random?: () => number; now?: () => number } = {},
): number | null {
  const profile = GOMOKU_PROFILES[difficulty]
  const deadline = now() + profile.milliseconds
  return new GomokuSearch(position, profile, difficulty, now, deadline).choose(position.toMove, random)
}
