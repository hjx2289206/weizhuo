import type { GameController } from './useGame'

/** Gameplay only. Room ownership and transport remain outside the reusable playing surface. */
export type GamePlayController = Pick<GameController,
  'state' | 'connected' | 'busy' | 'error' | 'selected' | 'playSelected' | 'clearSelection' | 'toggleCard' |
  'nextHint' | 'tribute' | 'returnTribute' | 'pass' | 'bid' | 'junqiMove' | 'junqiResign'
> & Partial<Pick<GameController, 'addBot' | 'removeBot' | 'setAutoPlay'>>
