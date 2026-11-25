import { Chess, type Square, type PieceSymbol } from 'chess.js'
import type { BoardUndoView } from './boardUndo'

/** a8 = 0, h1 = 63. White is seat 0. The server owns the complete move history. */
export type ChessSide = 0 | 1
export type ChessRank = PieceSymbol
export type ChessPromotion = 'q' | 'r' | 'b' | 'n'
export interface ChessPiece { id: string; side: ChessSide; rank: ChessRank }
export type ChessBoard = (ChessPiece | null)[]
export interface ChessMove {
  ply: number; side: ChessSide; from: number; to: number; piece: ChessPiece
  captured: ChessPiece | null; capturePoint: number | null; check: boolean; notation: string
  promotion?: ChessPromotion; castle?: { from: number; to: number; piece: ChessPiece }
}
export interface ChessView extends BoardUndoView {
  round: number; roundId: string; startFen: string; fen: string; board: ChessBoard; moves: ChessMove[]
  check: ChessSide | null; winner: ChessSide | null; draw: boolean; reason: string
  drawOffer: ChessSide | null; quietPlies: number
}
export const CHESS_NAMES: Record<ChessRank, string> = { k: '王', q: '后', r: '车', b: '象', n: '马', p: '兵' }
export const CHESS_PROMOTIONS: readonly ChessPromotion[] = ['q', 'r', 'b', 'n']
export const chessSideName = (side: number) => side === 0 ? '白方' : '黑方'
export const chessName = (piece: ChessPiece) => CHESS_NAMES[piece.rank]
export const validChessPoint = (p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 0 && p < 64
export const chessCoordinate = (p: number): Square => `${'abcdefgh'[p % 8]}${8 - Math.floor(p / 8)}` as Square
export const chessIndex = (square: string) => (8 - Number(square[1])) * 8 + 'abcdefgh'.indexOf(square[0]!)
export function chessBoard(engine: Chess): ChessBoard {
  return engine.board().flat().map((piece, point) => piece ? { id: `chess-${point}`, side: piece.color === 'w' ? 0 : 1, rank: piece.type } : null)
}
export function chessDestinations(fen: string, from: number): number[] {
  if (!validChessPoint(from)) return []
  return [...new Set(new Chess(fen).moves({ square: chessCoordinate(from), verbose: true }).map(move => chessIndex(move.to)))]
}
export function chessPoint(point: number, side: number | null = 0) {
  const p = side === 1 ? 63 - point : point
  return { x: 50 + p % 8 * 56, y: 50 + Math.floor(p / 8) * 56 }
}
