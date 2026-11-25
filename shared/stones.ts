/** Black is seat 0. Coordinates are fixed for both viewers: A1 is the upper-left intersection. */
import type { BoardUndoView } from './boardUndo'

export type StoneSide = 0 | 1
export type StoneKind = 'go' | 'gomoku'
export type StoneBoard = (StoneSide | null)[]
export interface StoneMove { ply: number; side: StoneSide; point: number | null; captured: number[]; notation: string }
export interface GoScore {
  stones: [number, number]; territory: [number, number]; total: [number, number]
  ownership: (StoneSide | null)[]; komi: number
}
export interface StoneView extends BoardUndoView {
  round: number; roundId: string; size: number; board: StoneBoard; moves: StoneMove[]
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
/** Freestyle: five OR MORE contiguous stones, without Renju forbidden moves. */
export function gomokuLine(board: StoneBoard, point: number, size = 15): number[] {
  const side = board[point]
  if (side === null || side === undefined) return []
  for (const [dx,dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    const line = [point]
    for (const direction of [-1,1]) {
      let x = point % size + dx! * direction, y = Math.floor(point / size) + dy! * direction
      while (x >= 0 && x < size && y >= 0 && y < size && board[y * size + x] === side) {
        if (direction === -1) line.unshift(y * size + x); else line.push(y * size + x)
        x += dx! * direction; y += dy! * direction
      }
    }
    if (line.length >= 5) return line
  }
  return []
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
