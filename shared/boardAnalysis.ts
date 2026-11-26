import type { ChessPromotion } from './chess'
import type { ChessGameFields, GameView, XiangqiGameFields } from './protocol'
import type { UciBoardAiGame } from './boardAi'

export type AnalyzableView = ChessGameFields | XiangqiGameFields
export type AnalysisSide = 0 | 1
export type AnalysisScore = { evalCp: number; mate?: never } | { mate: number; evalCp?: never }
export interface AnalysisMove { from: number; to: number; promotion?: ChessPromotion }
export type AnalysisPosition = AnalysisScore & { ply: number; turn: AnalysisSide; bestMove: AnalysisMove | null }
export interface BoardAnalysisResult {
  roundId: string
  status: 'idle' | 'running' | 'done' | 'failed'
  total: number
  completed: number
  positions: AnalysisPosition[]
  error: string | null
}
export interface BoardAnalysisView extends BoardAnalysisResult {
  available: boolean
  unavailableReason: string | null
}
export type BoardAnalyzeAction = 'start' | 'cancel'

export function isAnalyzableGame(game: string): game is UciBoardAiGame {
  return game === 'chess' || game === 'xiangqi'
}

export function isAnalyzableView(view: GameView): view is AnalyzableView {
  return isAnalyzableGame(view.game)
}

export function analysisRecord(view: AnalyzableView) {
  return view.game === 'chess' ? view.chess : view.xiangqi
}

export const ANALYSIS_GRADES = [
  { id: 'blunder', minimum: 300, label: '大失误', color: '#a02c25' },
  { id: 'mistake', minimum: 150, label: '失误', color: '#a95317' },
  { id: 'inaccuracy', minimum: 70, label: '欠佳', color: '#74601d' },
] as const

export const ANALYSIS_CURVE_LIMIT = 1_000
const LOSS_LIMIT = 1_500

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value))
}

/** Mate zero is the UCI score of a side already checkmated. */
export function analysisScoreFor(position: AnalysisScore & { turn: AnalysisSide }, perspective: AnalysisSide): number {
  const score = position.mate === undefined ? position.evalCp
    : (position.mate > 0 ? 1 : -1) * (10_000 - Math.abs(position.mate) * 10)
  return position.turn === perspective ? score : -score
}

export function analysisLoss(before: AnalysisPosition, after: AnalysisPosition, mover: AnalysisSide): number {
  return Math.max(0, clamp(analysisScoreFor(before, mover), LOSS_LIMIT) - clamp(analysisScoreFor(after, mover), LOSS_LIMIT))
}

export function analysisGrade(loss: number) {
  return ANALYSIS_GRADES.find(grade => loss >= grade.minimum) ?? null
}

export function analysisCurveValue(position: AnalysisPosition): number {
  return clamp(analysisScoreFor(position, 0), ANALYSIS_CURVE_LIMIT)
}
