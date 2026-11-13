import type { Card, GameKind, Snapshot } from './protocol'
import type { JunqiRank } from './junqi'

export const TUTORIAL_VERSION = 'animation-clips-v2'
/** Authoring commands are server-owned. The viewing socket never accepts these commands. */
export type TeachingCommand = 'bid' | 'play' | 'pass' | 'tribute' | 'returnTribute' | 'junqiMove' | 'junqiResign' | 'xiangqiMove' | 'xiangqiResign' | 'xiangqiDraw' | 'chessMove' | 'chessResign' | 'chessDraw' | 'stoneMove' | 'stonePass' | 'stoneScore' | 'stoneResign' | 'continue'
export type TeachingLevel = 'basic' | 'advanced'
export interface TeachingSource { title: string; url: string; note: string }
export interface TeachingAction { type: TeachingCommand; seat: number; payload: Record<string, unknown> }
export interface TeachingFocus { points: number[]; overview: boolean }
export interface TeachingFrame {
  snapshot: Snapshot
  action?: TeachingAction
  path?: number[]
  combat?: { attacker: JunqiRank; defender: JunqiRank; outcome: 'attacker' | 'defender' | 'both' }
  cards: Card[]
  caption: string
  duration: number
  focus?: TeachingFocus
  /** A rejected engine command. Its snapshot must equal the preceding snapshot. */
  rejected?: string
  kind?: 'deal' | 'result'
}
export interface TeachingClipSummary { id: string; title: string; chapter: string; tags: string[]; level?: TeachingLevel }
export interface TeachingClip extends TeachingClipSummary { explanation: string; snapshot: Snapshot; frames: TeachingFrame[]; sources?: TeachingSource[] }
export interface TeachingState {
  type: 'tutorial-state'; id: string; version: number; courseVersion: string; game: GameKind
  index: number; total: number; clips: TeachingClipSummary[]; clip: TeachingClip
  level?: TeachingLevel
}
export interface TeachingRequest {
  id: string; type: 'start' | 'scene' | 'exit'
  version?: number; game?: GameKind; courseVersion?: string; clipId?: string
  level?: TeachingLevel
}
export type TeachingResponse = TeachingState | { type: 'tutorial-error'; message: string; id?: string; version?: number }
