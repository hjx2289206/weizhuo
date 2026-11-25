/** Black is seat 0. Coordinates are fixed for both viewers: A1 is the upper-left intersection. */
import type { BoardUndoView } from './boardUndo'

export type StoneSide = 0 | 1
export type StoneKind = 'go' | 'gomoku'
export type StoneBoard = (StoneSide | null)[]
export type GomokuRule = 'freestyle' | 'renju'
export type RenjuForbidden = 'double-three' | 'double-four' | 'overline'
export const GOMOKU_RULES = { freestyle: '无禁手', renju: '黑方禁手' } as const satisfies Record<GomokuRule, string>
export const RENJU_FORBIDDEN_NAMES = { 'double-three': '三三', 'double-four': '四四', overline: '长连' } as const satisfies Record<RenjuForbidden, string>
export const isGomokuRule = (rule: unknown): rule is GomokuRule => rule === 'freestyle' || rule === 'renju'
export const renjuForbiddenText = (reason: RenjuForbidden) => `禁手：${RENJU_FORBIDDEN_NAMES[reason]}`
export interface StoneMove { ply: number; side: StoneSide; point: number | null; captured: number[]; notation: string }
export interface GoScore {
  stones: [number, number]; territory: [number, number]; total: [number, number]
  ownership: (StoneSide | null)[]; komi: number
}
export interface StoneView extends BoardUndoView {
  round: number; roundId: string; size: number; board: StoneBoard; moves: StoneMove[]
  rule?: GomokuRule
  stage: 'play' | 'scoring'; passes: number; captured: [number, number]
  dead: number[]; confirmed: [boolean, boolean]; scoreRevision: number; score: GoScore | null
  winner: StoneSide | null; draw: boolean; reason: string; winningLine: number[]
}
export const GO_SIZES = [9, 13, 19] as const
export const GO_KOMI = 7.5
export const stoneSideName = (side: number) => side === 0 ? '黑方' : '白方'
export const stoneCoordinate = (p: number, size: number) => `${'ABCDEFGHJKLMNOPQRST'[p % size]}${Math.floor(p / size) + 1}`
export const validStonePoint = (p: unknown, size: number): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 0 && p < size * size
export const stonePositionKey = (board: StoneBoard) => board.map(side => side === null ? '.' : String(side)).join('')
export function stoneNeighbors(point: number, size: number): number[] {
  const row = Math.floor(point / size), col = point % size
  return [row > 0 ? point - size : -1, row < size - 1 ? point + size : -1, col > 0 ? point - 1 : -1, col < size - 1 ? point + 1 : -1].filter(p => p >= 0)
}
export function stoneGroup(board: StoneBoard, point: number, size: number): { points: number[]; liberties: number[] } {
  const side = board[point], points = new Set<number>(), liberties = new Set<number>(), queue = [point]
  if (side === null || side === undefined) return { points: [], liberties: [] }
  while (queue.length) {
    const p = queue.pop()!
    if (points.has(p)) continue
    points.add(p)
    for (const n of stoneNeighbors(p, size)) {
      if (board[n] === null) liberties.add(n)
      else if (board[n] === side && !points.has(n)) queue.push(n)
    }
  }
  return { points: [...points], liberties: [...liberties] }
}
/** Capture first, then check the placed group. A capture into apparent suicide may be legal. */
export function playGo(board: StoneBoard, point: number, side: StoneSide, size: number): { board: StoneBoard; captured: number[] } | string {
  if (!validStonePoint(point, size) || board[point] !== null) return '请在空的交叉点落子'
  const next = [...board], captured: number[] = []
  next[point] = side
  for (const n of stoneNeighbors(point, size)) {
    if (next[n] !== 1 - side) continue
    const group = stoneGroup(next, n, size)
    if (!group.liberties.length) for (const p of group.points) { next[p] = null; captured.push(p) }
  }
  if (!stoneGroup(next, point, size).liberties.length) return '禁入点：不能让自己的整块棋无气，除非先提掉对方棋子'
  return { board: next, captured }
}
const GOMOKU_AXES = [[1, 0], [0, 1], [1, 1], [1, -1]] as const

export function gomokuLine(board: StoneBoard, point: number, size = 15, rule: GomokuRule = 'freestyle'): number[] {
  const side = board[point]
  if (side === null || side === undefined) return []
  for (const [dx,dy] of GOMOKU_AXES) {
    const line = [point]
    for (const direction of [-1,1]) {
      let x = point % size + dx! * direction, y = Math.floor(point / size) + dy! * direction
      while (x >= 0 && x < size && y >= 0 && y < size && board[y * size + x] === side) {
        if (direction === -1) line.unshift(y * size + x); else line.push(y * size + x)
        x += dx * direction; y += dy * direction
      }
    }
    if (rule === 'renju' && side === 0 ? line.length === 5 : line.length >= 5) return line
  }
  return []
}

interface RenjuLine {
  points: readonly number[]
  black: number
  empty: number
  run: number
}

interface RenjuFour {
  stones: number
  ends: number
}

export interface RenjuThreat {
  win: boolean
  forbidden: RenjuForbidden | null
  /** Winning intersections per axis, in the same order as gomokuLine. */
  replies: readonly number[]
  openThrees: readonly boolean[]
}

const RENJU_CENTER = 5
const RENJU_NO_REPLIES = [0, 0, 0, 0] as const
const RENJU_NO_THREES = [false, false, false, false] as const
const RENJU_CLEAR: RenjuThreat = { win: false, forbidden: null, replies: RENJU_NO_REPLIES, openThrees: RENJU_NO_THREES }
const RENJU_WIN: RenjuThreat = { ...RENJU_CLEAR, win: true }
const RENJU_REJECTED: Record<RenjuForbidden, RenjuThreat> = {
  'double-three': { ...RENJU_CLEAR, forbidden: 'double-three' },
  'double-four': { ...RENJU_CLEAR, forbidden: 'double-four' },
  overline: { ...RENJU_CLEAR, forbidden: 'overline' },
}
const renjuGeometry = new Map<number, readonly (readonly (readonly number[])[])[]>()

function renjuAxes(size: number) {
  let axes = renjuGeometry.get(size)
  if (!axes) {
    axes = Array.from({ length: size ** 2 }, (_, point) => GOMOKU_AXES.map(([dx, dy]) =>
      Array.from({ length: 11 }, (_, index) => {
        const x = point % size + (index - RENJU_CENTER) * dx
        const y = Math.floor(point / size) + (index - RENJU_CENTER) * dy
        return x >= 0 && x < size && y >= 0 && y < size ? y * size + x : -1
      })))
    renjuGeometry.set(size, axes)
  }
  return axes
}

function singleBit(bits: number): boolean { return bits !== 0 && (bits & (bits - 1)) === 0 }

function renjuFours({ black, empty }: RenjuLine): RenjuFour[] {
  const groups: RenjuFour[] = []
  for (let start = 1; start <= RENJU_CENTER; start++) {
    const window = 0b11111 << start
    const gap = window & empty
    if (!singleBit(gap) || (window & (black | empty)) !== window) continue
    // At this end the completed five must not extend into another black stone.
    if (black & ((1 << (start - 1)) | (1 << (start + 5)))) continue
    const stones = window ^ gap
    const existing = groups.find(group => group.stones === stones)
    if (existing) existing.ends |= gap
    else groups.push({ stones, ends: gap })
  }
  return groups
}

function renjuThreeExtensions({ points, black, empty }: RenjuLine): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  for (let start = 2; start <= RENJU_CENTER; start++) {
    const window = 0b1111 << start
    const gap = window & empty
    const ends = (1 << (start - 1)) | (1 << (start + 4))
    if (!singleBit(gap) || ((black | empty) & window) !== window || (empty & ends) !== ends) continue
    if (black & ((1 << (start - 2)) | (1 << (start + 5)))) continue
    const stones = window ^ gap
    const extension = points[31 - Math.clz32(gap)]!
    const existing = groups.get(stones)
    if (existing) existing.push(extension)
    else groups.set(stones, [extension])
  }
  return groups
}

/** Reuse geometry and scratch space while simulating moves on a caller-owned board. */
export function createRenjuAnalyzer(size: number, read: (point: number) => StoneSide | null | undefined) {
  const axes = renjuAxes(size)
  const trial = new Uint8Array(size ** 2)

  function line(points: readonly number[]): RenjuLine {
    let black = 0, empty = 0
    for (let index = 0; index < points.length; index++) {
      const point = points[index]!
      if (point < 0) continue
      const piece = trial[point] ? 0 : read(point)
      if (piece === 0) black |= 1 << index
      else if (piece === null) empty |= 1 << index
    }
    let run = 1
    for (const step of [-1, 1]) for (let index = RENJU_CENTER + step; black & (1 << index); index += step) run++
    return { points, black, empty, run }
  }

  function inspect(point: number, detail: boolean): RenjuThreat {
    const lines = axes[point]!.map(line)
    if (lines.some(axis => axis.run === 5)) return RENJU_WIN
    if (lines.some(axis => axis.run > 5)) return RENJU_REJECTED.overline

    const replies: number[] = []
    let fourCount = 0
    for (const axis of lines) {
      const fours = renjuFours(axis)
      fourCount += fours.length
      if (fourCount > 1) return RENJU_REJECTED['double-four']
      const ends = fours[0]?.ends ?? 0
      replies.push(singleBit(ends) ? 1 : ends ? 2 : 0)
    }

    const extensions = lines.map(renjuThreeExtensions)
    // Most recursive calls can prove legality without trying a continuation.
    if (!detail && extensions.reduce((total, groups) => total + groups.size, 0) < 2) return RENJU_CLEAR
    const openThrees = [false, false, false, false]
    let threeCount = 0
    for (const [axis, groups] of extensions.entries()) {
      for (const points of groups.values()) {
        if (points.some(extension => {
          const next = analyze(extension, false)
          return !next.forbidden && !next.win
        })) {
          openThrees[axis] = true
          if (++threeCount > 1) return RENJU_REJECTED['double-three']
        }
      }
    }
    return { win: false, forbidden: null, replies, openThrees }
  }

  function analyze(point: number, detail = true): RenjuThreat {
    if (!validStonePoint(point, size) || trial[point] || read(point) !== null) return RENJU_CLEAR
    trial[point] = 1
    try { return inspect(point, detail) }
    finally { trial[point] = 0 }
  }

  return { analyze, forbidden: (point: number) => analyze(point, false).forbidden }
}

export function renjuForbidden(board: readonly (StoneSide | null)[], point: number, size = 15): RenjuForbidden | null {
  return createRenjuAnalyzer(size, index => board[index]).forbidden(point)
}
/** Area scoring after the players agree on dead groups. Prisoners are not counted again. */
export function scoreGo(board: StoneBoard, size: number, dead: readonly number[] = [], komi = GO_KOMI): GoScore {
  const clean = [...board], ownership: (StoneSide | null)[] = Array(board.length).fill(null)
  for (const p of dead) if (validStonePoint(p, size)) clean[p] = null
  const stones: [number, number] = [0,0], territory: [number, number] = [0,0], seen = new Set<number>()
  clean.forEach((side,p) => { if (side !== null) { stones[side]++; ownership[p] = side } })
  for (let p = 0; p < clean.length; p++) {
    if (clean[p] !== null || seen.has(p)) continue
    const region: number[] = [], border = new Set<StoneSide>(), queue = [p]
    while (queue.length) {
      const n = queue.pop()!
      if (seen.has(n)) continue
      seen.add(n); region.push(n)
      for (const neighbor of stoneNeighbors(n, size)) {
        const side = clean[neighbor]!
        if (side === null) { if (!seen.has(neighbor)) queue.push(neighbor) }
        else border.add(side)
      }
    }
    if (border.size === 1) {
      const side = [...border][0]!
      territory[side] += region.length
      for (const n of region) ownership[n] = side
    }
  }
  return { stones, territory, total: [stones[0] + territory[0], stones[1] + territory[1] + komi], ownership, komi }
}
