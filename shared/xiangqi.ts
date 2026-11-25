/** Public, deterministic Chinese-chess rules. Red is seat 0 and moves toward smaller rows. */
import type { BoardUndoView } from './boardUndo'

export type XiangqiSide = 0 | 1
export type XiangqiRank = 'general' | 'advisor' | 'elephant' | 'horse' | 'rook' | 'cannon' | 'soldier'
export interface XiangqiPiece { id: string; side: XiangqiSide; rank: XiangqiRank }
export type XiangqiBoard = (XiangqiPiece | null)[]
export interface XiangqiMove { ply: number; side: XiangqiSide; from: number; to: number; piece: XiangqiPiece; captured: XiangqiPiece | null; check: boolean; notation: string }
export interface XiangqiView extends BoardUndoView { round: number; roundId: string; board: XiangqiBoard; moves: XiangqiMove[]; check: XiangqiSide | null; winner: XiangqiSide | null; draw: boolean; reason: string; drawOffer: XiangqiSide | null; quietPlies: number }
export const XIANGQI_NAMES: Record<XiangqiRank, readonly [string, string]> = { general: ['帅', '将'], advisor: ['仕', '士'], elephant: ['相', '象'], horse: ['马', '马'], rook: ['车', '车'], cannon: ['炮', '砲'], soldier: ['兵', '卒'] }
export const xiangqiSideName = (side: number) => side === 0 ? '红方' : '黑方'
export const xiangqiName = (piece: XiangqiPiece) => XIANGQI_NAMES[piece.rank][piece.side]
export const validXiangqiPoint = (point: unknown): point is number => typeof point === 'number' && Number.isInteger(point) && point >= 0 && point < 90
export const xiangqiCoordinate = (point: number) => `${'ABCDEFGHI'[point % 9]}${10 - Math.floor(point / 9)}`

export function rewindXiangqiBoard(board: readonly (XiangqiPiece | null)[], moves: readonly XiangqiMove[]): XiangqiBoard {
  const restored = [...board]
  for (let index = moves.length - 1; index >= 0; index--) {
    const { from, to, piece, captured } = moves[index]!
    restored[from] = { ...piece }
    restored[to] = captured ? { ...captured } : null
  }
  return restored
}
export function initialXiangqiBoard(): XiangqiBoard {
  const board: XiangqiBoard = Array(90).fill(null)
  const back: XiangqiRank[] = ['rook', 'horse', 'elephant', 'advisor', 'general', 'advisor', 'elephant', 'horse', 'rook']
  const put = (side: XiangqiSide, rank: XiangqiRank, row: number, col: number) => { const p = row * 9 + col; board[p] = { id: `xq-${side}-${p}`, side, rank } }
  for (const side of [0, 1] as const) {
    back.forEach((rank, col) => put(side, rank, side === 0 ? 9 : 0, col))
    for (const col of [1, 7]) put(side, 'cannon', side === 0 ? 7 : 2, col)
    for (const col of [0, 2, 4, 6, 8]) put(side, 'soldier', side === 0 ? 6 : 3, col)
  }
  return board
}
const palace = (row: number, col: number, side: XiangqiSide) => col >= 3 && col <= 5 && (side === 0 ? row >= 7 && row <= 9 : row >= 0 && row <= 2)
function between(board: readonly (XiangqiPiece | null)[], from: number, to: number): number {
  if (from % 9 !== to % 9 && Math.floor(from / 9) !== Math.floor(to / 9)) return -1
  const step = from % 9 === to % 9 ? Math.sign(to - from) * 9 : Math.sign(to - from)
  let count = 0
  for (let p = from + step; p !== to; p += step) if (board[p]) count++
  return count
}
/** Movement geometry only; no recursive check/king-safety search. */
export function xiangqiPseudoDestinations(board: readonly (XiangqiPiece | null)[], from: number): number[] {
  if (!validXiangqiPoint(from) || board.length !== 90) return []
  const piece = board[from]; if (!piece) return []
  const row = Math.floor(from / 9), col = from % 9, result: number[] = []
  for (let to = 0; to < 90; to++) {
    if (to === from || board[to]?.side === piece.side) continue
    const r = Math.floor(to / 9), c = to % 9, dr = r - row, dc = c - col, ar = Math.abs(dr), ac = Math.abs(dc)
    let legal = false
    switch (piece.rank) {
      case 'rook': legal = between(board, from, to) === 0; break
      case 'cannon': legal = between(board, from, to) === (board[to] ? 1 : 0); break
      case 'horse': legal = ar === 2 && ac === 1 && !board[(row + Math.sign(dr)) * 9 + col] || ar === 1 && ac === 2 && !board[row * 9 + col + Math.sign(dc)]; break
      case 'elephant': legal = ar === 2 && ac === 2 && (piece.side === 0 ? r >= 5 : r <= 4) && !board[(row + dr / 2) * 9 + col + dc / 2]; break
      case 'advisor': legal = ar === 1 && ac === 1 && palace(r, c, piece.side); break
      case 'general': legal = ar + ac === 1 && palace(r, c, piece.side) || dc === 0 && board[to]?.rank === 'general' && between(board, from, to) === 0; break
      case 'soldier': legal = dc === 0 && dr === (piece.side === 0 ? -1 : 1) || dr === 0 && ac === 1 && (piece.side === 0 ? row <= 4 : row >= 5); break
    }
    if (legal) result.push(to)
  }
  return result
}
export function xiangqiInCheck(board: readonly (XiangqiPiece | null)[], side: XiangqiSide): boolean {
  const king = board.findIndex(piece => piece?.side === side && piece.rank === 'general')
  return king < 0 || board.some((piece, from) => piece?.side !== side && piece !== null && xiangqiPseudoDestinations(board, from).includes(king))
}
export function xiangqiDestinations(board: readonly (XiangqiPiece | null)[], from: number): number[] {
  const piece = board[from]; if (!piece) return []
  return xiangqiPseudoDestinations(board, from).filter(to => { const next = [...board]; next[from] = null; next[to] = piece; return !xiangqiInCheck(next, piece.side) })
}
export function xiangqiHasMove(board: readonly (XiangqiPiece | null)[], side: XiangqiSide): boolean { return board.some((piece, from) => piece?.side === side && xiangqiDestinations(board, from).length > 0) }
export function xiangqiPositionKey(board: readonly (XiangqiPiece | null)[], turn: XiangqiSide): string { return `${turn}:${board.map(piece => piece ? `${piece.side}${piece.rank[0]}${piece.rank === 'general' ? 'g' : ''}` : '.').join(',')}` }
export function xiangqiNotation(piece: XiangqiPiece, from: number, to: number): string {
  const r = Math.floor(from / 9), c = from % 9, nr = Math.floor(to / 9), nc = to % 9
  const glyph = (n: number) => piece.side === 0 ? '一二三四五六七八九'[n - 1] : String(n)
  const file = (col: number) => piece.side === 0 ? 9 - col : col + 1
  const action = r === nr ? '平' : (piece.side === 0 ? nr < r : nr > r) ? '进' : '退'
  const end = r === nr || ['horse', 'elephant', 'advisor'].includes(piece.rank) ? file(nc) : Math.abs(nr - r)
  return `${xiangqiName(piece)}${glyph(file(c))}${action}${glyph(end)}`
}
