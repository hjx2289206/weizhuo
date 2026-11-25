export const BOARD_UNDO_LIMIT = 3

export type BoardUndoSide = 0 | 1
export type BoardUndoClientAction = 'request' | 'accept' | 'decline' | 'cancel'
export type BoardUndoAction = BoardUndoClientAction | 'direct'

export interface BoardUndoView {
  undoOffer: BoardUndoSide | null
  undoUsed: [number, number]
}

export interface BoardUndoMove {
  side: BoardUndoSide
  undoable?: false
}

/** The first record to remove: the last eligible move, limited to the requester if given. */
export function boardUndoTarget(moves: readonly BoardUndoMove[], side?: BoardUndoSide): number {
  for (let index = moves.length - 1; index >= 0; index--) {
    const move = moves[index]!
    if (move.undoable !== false && (side === undefined || move.side === side)) return index
  }
  return -1
}
