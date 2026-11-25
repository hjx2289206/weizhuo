import { isBoardAiGame, type BoardAiGame } from '../../shared/boardAi'
import { REVERSI_FLIP_MS } from '../../shared/reversi'
import type { GameView } from '../../shared/protocol'
import type { GameCommandType } from '../games/types'
import { boardSearchPosition, type BoardAiMove, type BoardSearchPosition } from './boardAi'

type ViewOf<K extends BoardAiGame> = Extract<GameView, { game: K }>
type Command = { type: GameCommandType; payload: Record<string, unknown> }

interface BoardAiContext {
  roundId: string
  ply: number
  delayMs: number
  position: () => BoardSearchPosition
  command: (move: BoardAiMove) => Command
}

interface BoardAiAdapter {
  move: GameCommandType
  resign: GameCommandType
  read: (view: GameView) => BoardAiContext
}

function adapter<K extends BoardAiGame>(
  game: K,
  move: GameCommandType,
  resign: GameCommandType,
  board: (view: ViewOf<K>) => { roundId: string; moves: readonly unknown[] },
  position: (view: ViewOf<K>) => BoardSearchPosition,
  payload: (move: BoardAiMove) => Record<string, unknown>,
  delayMs = 300,
): BoardAiAdapter {
  return {
    move, resign,
    read(view) {
      if (view.game !== game) throw new Error('棋类搜索适配器与当前游戏不匹配')
      const gameView = view as ViewOf<K>
      const { roundId, moves } = board(gameView)
      return { roundId, ply: moves.length, delayMs, position: () => position(gameView), command: result => ({ type: move, payload: payload(result) }) }
    },
  }
}

function uciPayload(move: BoardAiMove): Record<string, unknown> {
  if (move.kind !== 'uci') throw new Error('引擎返回的走法类型无效')
  const { from, to, promotion } = move
  return { from, to, ...(promotion === undefined ? {} : { promotion }) }
}

export const BOARD_AI_ADAPTERS: Record<BoardAiGame, BoardAiAdapter> = {
  chess: adapter('chess', 'chessMove', 'chessResign', view => view.chess, boardSearchPosition, uciPayload),
  xiangqi: adapter('xiangqi', 'xiangqiMove', 'xiangqiResign', view => view.xiangqi, boardSearchPosition, uciPayload),
  gomoku: adapter('gomoku', 'stoneMove', 'stoneResign', view => view.stones, view => {
    if (view.turn !== 0 && view.turn !== 1) throw new Error('当前局面没有行棋方')
    const { board, size, moves, rule } = view.stones
    return { kind: 'gomoku', game: 'gomoku', board, size, rule, toMove: view.turn, history: moves.flatMap(move => move.point === null ? [] : [move.point]) }
  }, move => {
    if (move.kind !== 'gomoku') throw new Error('引擎返回的走法类型无效')
    return { point: move.point }
  }),
  reversi: adapter('reversi', 'reversiMove', 'reversiResign', view => view.reversi, view => {
    if (view.turn !== 0 && view.turn !== 1) throw new Error('当前局面没有行棋方')
    return { kind: 'reversi', game: 'reversi', board: view.reversi.board, toMove: view.turn }
  }, move => {
    if (move.kind !== 'reversi') throw new Error('引擎返回的走法类型无效')
    return { point: move.point }
  }, REVERSI_FLIP_MS),
}

export function boardAiContext(view: GameView): BoardAiContext | null {
  const game = view.game
  return isBoardAiGame(game) ? BOARD_AI_ADAPTERS[game].read(view) : null
}
