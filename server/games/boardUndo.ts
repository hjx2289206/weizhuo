import { BOARD_UNDO_LIMIT, boardUndoTarget, type BoardUndoMove, type BoardUndoSide, type BoardUndoView } from '../../shared/boardUndo'
import type { GameResult } from './types'

export class BoardUndo implements BoardUndoView {
  undoOffer: BoardUndoSide | null = null
  undoUsed: [number, number] = [0, 0]

  command(
    seat: BoardUndoSide,
    action: unknown,
    moves: readonly BoardUndoMove[],
    rollback: (target: number) => void,
    unlimited: boolean,
  ): GameResult {
    if (action === 'cancel') {
      if (this.undoOffer !== seat) return { ok: false, message: '没有可以撤回的悔棋请求' }
      this.undoOffer = null
      return { ok: true }
    }
    if (action === 'accept' || action === 'decline') {
      if (this.undoOffer === null || this.undoOffer === seat) return { ok: false, message: '没有对方发来的悔棋请求' }
      if (action === 'decline') {
        this.undoOffer = null
        return { ok: true }
      }
      seat = this.undoOffer
    } else if (action === 'request' || action === 'direct') {
      if (this.undoOffer !== null) return { ok: false, message: '已有悔棋请求，请先处理' }
    } else return { ok: false, message: '悔棋操作无效' }

    const target = boardUndoTarget(moves, seat)
    if (target < 0) return { ok: false, message: '本局还没有你可以撤销的着法' }
    if (!unlimited && this.undoUsed[seat] >= BOARD_UNDO_LIMIT) return { ok: false, message: '本局的悔棋次数已用完' }
    if (action === 'request') this.undoOffer = seat
    else {
      rollback(target)
      this.undoUsed[seat]++
      this.undoOffer = null
    }
    return { ok: true }
  }
}
