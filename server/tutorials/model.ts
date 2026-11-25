import type { Card, GameKind, Snapshot } from '../../shared/protocol'
import type { TeachingAction } from '../../shared/tutorialProtocol'
import type { RoomGame } from '../games/types'
import { enumerateGuandanPlays, strongestGuandanOption } from '../../shared/guandan'

export interface LessonText { id: string; title: string; instruction: string; explanation: string; tags: string[]; span?: number }
export interface ScriptStep { action: TeachingAction | { type: 'start' | 'restart' | 'junqiSetup'; seat: number; payload: Record<string, unknown> }; lesson?: LessonText }
export interface TeachingMatch { id: string; title: string; player: number; create: () => RoomGame; steps: ScriptStep[] }
export interface TeachingCourse { game: GameKind; matches: TeachingMatch[] }
export const clone = <T>(value: T): T => structuredClone(value)

export function execute(engine: RoomGame, action: ScriptStep['action']): void {
  if (action.type === 'start') { engine.start(); return }
  if (action.type === 'restart') { const result = engine.restart(); if (!result.ok) throw new Error(result.message); return }
  if (action.type === 'continue') return
  const result = engine.command(action.seat, action.type, action.payload)
  if (!result.ok) throw new Error(`${engine.kind}/${action.type}/${action.seat}: ${result.message}`)
}

export function snapshot(engine: RoomGame, seat: number, code: string, version = 0): Snapshot {
  const view = engine.view(seat)
  if (view.game === 'reversi') view.reversi.roundId = `${code}:round:${view.reversi.round}`
  if (view.game === 'chess') view.chess.roundId = `${code}:round:${view.chess.round}`
  if (view.game === 'xiangqi') view.xiangqi.roundId = `${code}:round:${view.xiangqi.round}`
  if (view.game === 'go' || view.game === 'gomoku') view.stones.roundId = `${code}:round:${view.stones.round}`
  return clone({ ...view, code, roomMode: 'phone', role: 'player', selfSeat: seat,
    hand: [...engine.handOf(seat)], isHost: false, hostSeatId: null, hostConnected: true,
    seats: Array.from({ length: engine.seatCount }, (_, id) => ({ id, name: id === seat ? '我' : `教学对手 ${id + 1}`, connected: true, ready: true,
      count: engine.handOf(id).length, passed: engine.passedAt(id), isBot: false, autoPlay: false,
      x: .5, y: .5, angle: 0 })),
    turnLimitSeconds: 0, turnRemainingMs: null, turnSeatId: null, seatRequests: [],
    automation: { available: false, message: '教学对手按固定剧本行动' }, message: engine.statusText(seat, id => id === seat ? '你' : `${id + 1} 号位`), version,
  } as Snapshot)
}

export class Author {
  readonly engine: RoomGame
  readonly steps: ScriptStep[] = []
  constructor(readonly create: () => RoomGame) { this.engine = create() }
  add(action: ScriptStep['action'], lesson?: LessonText): void { execute(this.engine, action); this.steps.push({ action: clone(action), ...(lesson ? { lesson } : {}) }) }
  start(): void { this.add({ type: 'start', seat: 0, payload: {} }) }
  play(seat: number, cards: readonly Card[], lesson?: LessonText, kind?: string): void {
    let claim: string | undefined
    if (this.engine.kind === 'guandan') {
      // Imported below by the authoring helpers; all claims are computed from these physical cards.
      claim = guandanClaim(this.engine, cards, kind)
    }
    this.add({ type: 'play', seat, payload: { cards: cards.map(card => card.id), ...(claim ? { claim } : {}) } }, lesson)
  }
  pass(seat: number, lesson?: LessonText): void { this.add({ type: 'pass', seat, payload: {} }, lesson) }
  clear(): void {
    for (let i = 0; i < 8 && this.engine.phase === 'playing' && this.engine.view(0).lastPlay; i++) {
      const turn = this.engine.view(0).turn
      if (turn === null) break
      this.pass(turn)
    }
  }
}

function guandanClaim(engine: RoomGame, cards: readonly Card[], kind?: string): string {
  const view = engine.view(0)
  if (view.game !== 'guandan') throw new Error('not guandan')
  const option = strongestGuandanOption(
    enumerateGuandanPlays(cards, view.guandan.playedLevel), view.guandan.playedLevel, view.lastPlay?.claim ?? null,
  )
  if (!option || (kind && option.declaration.kind !== kind)) throw new Error(`没有教学牌型 ${kind}: ${cards.map(c => c.rank).join(',')}`)
  return option.declaration.key
}
