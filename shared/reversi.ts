import type { BoardUndoSide, BoardUndoView } from './boardUndo'

export type ReversiSide = BoardUndoSide
export type ReversiBoard = (ReversiSide | null)[]

export interface ReversiMove {
  ply: number
  side: ReversiSide
  point: number | null
  flipped: number[]
  notation: string
}

export interface ReversiView extends BoardUndoView {
  round: number
  roundId: string
  board: ReversiBoard
  moves: ReversiMove[]
  legal: number[]
  counts: [number, number]
  winner: ReversiSide | null
  draw: boolean
  reason: string
}

export const REVERSI_SIZE = 8
export const REVERSI_FLIP_MS = 900
export const REVERSI_AREA = REVERSI_SIZE ** 2
export const reversiSideName = (side: number) => side === 0 ? '黑方' : '白方'
export const reversiCoordinate = (point: number) => 'ABCDEFGH'[point % REVERSI_SIZE] + String(Math.floor(point / REVERSI_SIZE) + 1)
export const validReversiPoint = (point: unknown): point is number => typeof point === 'number' && Number.isInteger(point) && point >= 0 && point < REVERSI_AREA
export const otherReversiSide = (side: ReversiSide): ReversiSide => side === 0 ? 1 : 0
export const reversiPassText = (side: ReversiSide) => reversiSideName(side) + '无处可下，停一手'

export function initialReversiBoard(): ReversiBoard {
  const board: ReversiBoard = Array(REVERSI_AREA).fill(null)
  board[27] = board[36] = 1
  board[28] = board[35] = 0
  return board
}

// Bit zero is A1. Mask edge files before each shift to prevent wrapping into the next row.
export const REVERSI_FULL = (1n << 64n) - 1n
const NOT_A = 0xfefefefefefefefen
const NOT_H = 0x7f7f7f7f7f7f7f7fn
const SHIFTS = [
  (bits: bigint) => (bits & NOT_H) << 1n,
  (bits: bigint) => (bits & NOT_A) >> 1n,
  (bits: bigint) => (bits << 8n) & REVERSI_FULL,
  (bits: bigint) => bits >> 8n,
  (bits: bigint) => ((bits & NOT_H) << 9n) & REVERSI_FULL,
  (bits: bigint) => ((bits & NOT_A) << 7n) & REVERSI_FULL,
  (bits: bigint) => (bits & NOT_A) >> 9n,
  (bits: bigint) => (bits & NOT_H) >> 7n,
] as const
export const REVERSI_BITS = Array.from({ length: REVERSI_AREA }, (_, point) => 1n << BigInt(point))

export function reversiBits(board: readonly (ReversiSide | null)[]): [bigint, bigint] {
  const bits: [bigint, bigint] = [0n, 0n]
  board.forEach((side, point) => { if (side !== null) bits[side] |= REVERSI_BITS[point]! })
  return bits
}

export function reversiPoints(mask: bigint): number[] {
  const points: number[] = []
  while (mask) {
    const bit = mask & -mask
    const low = Number(bit & 0xffffffffn)
    points.push(low ? 31 - Math.clz32(low) : 63 - Math.clz32(Number(bit >> 32n)))
    mask ^= bit
  }
  return points
}

export function reversiBitCount(bits: bigint): number {
  bits -= (bits >> 1n) & 0x5555555555555555n
  bits = (bits & 0x3333333333333333n) + ((bits >> 2n) & 0x3333333333333333n)
  bits = (bits + (bits >> 4n)) & 0x0f0f0f0f0f0f0f0fn
  return Number(((bits * 0x0101010101010101n) >> 56n) & 0xffn)
}

export function reversiLegalMask(own: bigint, opponent: bigint): bigint {
  let targets = 0n
  for (const shift of SHIFTS) {
    let run = shift(own) & opponent
    // Flood contiguous opponent runs. A captured line is at most six disks long.
    for (let step = 0; run && step < 5; step++) {
      const more = (shift(run) & opponent) & ~run
      if (!more) break
      run |= more
    }
    targets |= shift(run)
  }
  return targets & (REVERSI_FULL ^ (own | opponent))
}

export function reversiFlipMask(own: bigint, opponent: bigint, bit: bigint): bigint {
  let flipped = 0n
  for (const shift of SHIFTS) {
    let next = shift(bit), line = 0n
    while (next & opponent) {
      line |= next
      next = shift(next)
    }
    if (next & own) flipped |= line
  }
  return flipped
}

export function legalMoves(board: ReversiBoard, side: ReversiSide): number[] {
  const bits = reversiBits(board)
  return reversiPoints(reversiLegalMask(bits[side], bits[otherReversiSide(side)]))
}

export function applyMove(board: ReversiBoard, side: ReversiSide, point: unknown): { board: ReversiBoard; flipped: number[] } | null {
  if (!validReversiPoint(point) || board[point] !== null) return null
  const bits = reversiBits(board)
  const flipped = reversiPoints(reversiFlipMask(bits[side], bits[otherReversiSide(side)], REVERSI_BITS[point]!))
  if (!flipped.length) return null
  const next = [...board]
  next[point] = side
  for (const cell of flipped) next[cell] = side
  return { board: next, flipped }
}

export function score(board: ReversiBoard): [number, number] {
  const counts: [number, number] = [0, 0]
  for (const cell of board) if (cell !== null) counts[cell]++
  return counts
}
