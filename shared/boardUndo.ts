export const BOARD_UNDO_LIMIT = 3

export type BoardUndoSide = 0 | 1
export type BoardUndoClientAction = 'request' | 'accept' | 'decline' | 'cancel'
export type BoardUndoAction = BoardUndoClientAction | 'direct'

export interface BoardUndoView {
  undoOffer: BoardUndoSide | null
  undoUsed: [number, number]
}

/** The index of the requester's last recorded hand, which is the first hand to remove. */
export function boardUndoTarget(moves: readonly { side: BoardUndoSide }[], side: BoardUndoSide): number {
  for (let index = moves.length - 1; index >= 0; index--) {
    if (moves[index]?.side === side) return index
  }
  return -1
}
