import { Chess } from 'chess.js'
import { chessCoordinate } from '../../shared/chess'
import { rewindXiangqiBoard } from '../../shared/xiangqi'
import type { UciBoardAiGame } from '../../shared/boardAi'
import {
  type AnalyzableView, type AnalysisMove, type AnalysisPosition, type AnalysisScore, type AnalysisSide,
} from '../../shared/boardAnalysis'
import {
  boardAiPolicy, boardSearchPosition, decodeMove, fairyXiangqiMove, uciEngineOptions, uciEnginePosition,
  type AnalysisEngine, type UciSearchPosition,
} from './boardAi'
import { withUciSession, type RunUciSession } from './uci'

interface AnalysisFrame {
  ply: number
  turn: AnalysisSide
  position: UciSearchPosition
  terminal: AnalysisScore | null
}

function* analysisFrames(view: AnalyzableView): Generator<AnalysisFrame> {
  if (view.game === 'chess') {
    const engine = new Chess(view.chess.startFen)
    const moves = view.chess.moves
    for (let ply = 0; ply <= moves.length; ply++) {
      const turn = engine.turn() === 'w' ? 0 : 1
      const position = boardSearchPosition({ ...view, turn, chess: { ...view.chess, fen: engine.fen(), moves: moves.slice(0, ply) } })
      const terminal = position.legalMoves.length ? (engine.isInsufficientMaterial() ? { evalCp: 0 } : null)
        : engine.isCheck() ? { mate: 0 } : { evalCp: 0 }
      yield { ply, turn, terminal, position }
      const move = moves[ply]
      if (move) engine.move({ from: chessCoordinate(move.from), to: chessCoordinate(move.to), promotion: move.promotion })
    }
  } else {
    const moves = view.xiangqi.moves
    const board = rewindXiangqiBoard(view.xiangqi.board, moves)
    for (let ply = 0; ply <= moves.length; ply++) {
      const turn = moves[ply]?.side ?? (moves.at(-1)?.side === 0 ? 1 : 0)
      const position = boardSearchPosition({ ...view, turn, xiangqi: { ...view.xiangqi, board, moves: moves.slice(0, ply) } })
      yield { ply, turn, terminal: position.legalMoves.length ? null : { mate: 0 }, position }
      const move = moves[ply]
      if (move) { board[move.from] = null; board[move.to] = move.piece }
    }
  }
}

export interface BoardAnalysisPolicy {
  availability(game: UciBoardAiGame): { available: boolean; message: string | null }
  analyze(view: AnalyzableView, signal: AbortSignal, publish: (position: AnalysisPosition) => void): Promise<void>
}

export function createBoardAnalysisPolicy(
  engineFor: (game: UciBoardAiGame) => AnalysisEngine,
  run: RunUciSession = withUciSession,
): BoardAnalysisPolicy {
  return {
    availability(game) {
      const engine = engineFor(game)
      return { available: engine.available, message: engine.available ? null : engine.message }
    },
    async analyze(view, signal, publish) {
      const engine = engineFor(view.game)
      if (!engine.available) throw new Error(engine.message)
      const frames = analysisFrames(view)
      const start = frames.next()
      if (start.done) return
      if (start.value.terminal) {
        const { ply, turn, terminal } = start.value
        if (!signal.aborted) publish({ ply, turn, ...terminal, bestMove: null })
        return
      }

      const { binary, key, network } = engine
      await run({ binary, options: uciEngineOptions(key, network), requiredOptions: [], signal }, async search => {
        for (let next: IteratorResult<AnalysisFrame> = start; !next.done; next = frames.next()) {
          if (signal.aborted) return
          const { ply, turn, position, terminal } = next.value
          if (terminal) {
            publish({ ply, turn, ...terminal, bestMove: null })
            continue
          }
          const result = await search({ position: uciEnginePosition(key, position.position), go: 'go nodes 50000 movetime 150' })
          if (signal.aborted) return
          if (!result.score) throw new Error('棋类引擎未返回评分')
          let bestMove: AnalysisMove | null = null
          let recommendation = result.move
          if (key === 'fairy') {
            try { recommendation = fairyXiangqiMove(recommendation, -1) } catch { recommendation = '' }
          }
          if (position.legalMoves.includes(recommendation)) {
            const { from, to, promotion } = decodeMove(view.game, recommendation)
            bestMove = { from, to, ...(promotion ? { promotion } : {}) }
          }
          publish({ ply, turn, ...result.score, bestMove })
        }
      })
    },
  }
}

export const boardAnalysisPolicy = createBoardAnalysisPolicy(game => boardAiPolicy.analysisEngine(game))
