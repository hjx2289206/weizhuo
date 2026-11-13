import { randomUUID } from 'node:crypto'
import type { Card, StoneGameFields } from '../../shared/protocol'
import { GO_SIZES, gomokuLine, playGo, scoreGo, stoneCoordinate, stoneGroup, stonePositionKey, stoneSideName, validStonePoint, type StoneBoard, type StoneKind, type StoneMove, type StoneSide } from '../../shared/stones'
import type { GameCommandType, GameResult, RoomGame } from './types'

/** Trusted local diagrams for tests/tutorials only. Room payloads never reach this constructor. */
export interface StoneSetup { size?: number; board?: StoneBoard; turn?: StoneSide; history?: string[] }
export class StoneGame implements RoomGame {
  readonly seatCount = 2 as const
  phase: 'lobby' | 'playing' | 'finished' = 'lobby'
  private size: number
  private board: StoneBoard
  private turn: StoneSide
  private positions: Set<string>
  private moves: StoneMove[] = []
  private round = 1
  private roundId = randomUUID()
  private stage: 'play' | 'scoring' = 'play'
  private passes = 0
  private captured: [number, number] = [0,0]
  private dead = new Set<number>()
  private confirmed: [boolean, boolean] = [false,false]
  private scoreRevision = 0
  private winner: StoneSide | null = null
  private draw = false
  private reason = ''
  private winningLine: number[] = []
  constructor(readonly kind: StoneKind, setup: StoneSetup = {}) {
    this.size = setup.size ?? (kind === 'go' ? 9 : 15)
    if (kind === 'go' ? !GO_SIZES.includes(this.size as 9) : this.size !== 15) throw new Error('棋盘大小无效')
    this.board = setup.board ? [...setup.board] : Array(this.size ** 2).fill(null)
    if (this.board.length !== this.size ** 2 || this.board.some(side => side !== null && side !== 0 && side !== 1)) throw new Error('教学棋盘无效')
    this.turn = setup.turn ?? 0
    this.positions = new Set([...(setup.history ?? []), stonePositionKey(this.board)])
  }
  setSize(size: unknown): GameResult {
    if (this.kind !== 'go' || this.phase !== 'lobby' || !GO_SIZES.includes(size as 9)) return { ok: false, message: '只能在围棋准备页选择 9、13、19 路' }
    this.size = size as number; this.board = Array(this.size ** 2).fill(null); this.positions = new Set([stonePositionKey(this.board)])
    return { ok: true }
  }
  start(): void { if (this.phase === 'lobby') this.phase = 'playing' }
  command(seat: number, type: GameCommandType, payload: Record<string, unknown>): GameResult {
    const fail = (message: string): GameResult => ({ ok: false, message })
    if (seat !== 0 && seat !== 1) return fail('只有入座玩家可以落子')
    if (this.phase !== 'playing') return fail('请先准备并开始对局')
    if (type === 'stoneResign') { this.finish(seat === 0 ? 1 : 0, `${stoneSideName(seat)}认输`); return { ok: true } }
    if (type === 'stoneScore') {
      if (this.kind !== 'go' || this.stage !== 'scoring') return fail('双方连续停一手后才能确认死子')
      if (payload.action === 'resume') { this.stage = 'play'; this.passes = 0; this.dead.clear(); this.confirmed = [false,false]; this.scoreRevision++; return { ok: true } }
      if (payload.action === 'mark') {
        if (!validStonePoint(payload.point, this.size) || this.board[payload.point] === null) return fail('请点击一块需要标记或取消的棋子')
        const group = stoneGroup(this.board, payload.point, this.size).points, marked = this.dead.has(payload.point)
        group.forEach(p => marked ? this.dead.delete(p) : this.dead.add(p)); this.confirmed = [false,false]; this.scoreRevision++
        return { ok: true }
      }
      if (payload.action !== 'confirm') return fail('结算操作无效')
      if (payload.roundId !== this.roundId || payload.revision !== this.scoreRevision) return fail('死子或结算结果已经更新，请查看当前盘面后重新确认')
      this.confirmed[seat] = true
      if (this.confirmed.every(Boolean)) {
        const score = scoreGo(this.board, this.size, [...this.dead]), diff = score.total[0] - score.total[1]
        this.finish(diff === 0 ? null : diff > 0 ? 0 : 1, `数子结算：黑 ${score.total[0]} 点，白 ${score.total[1]} 点（含贴 ${score.komi} 点）`)
      }
      return { ok: true }
    }
    if (type !== 'stoneMove' && type !== 'stonePass') return fail('本游戏不支持这个操作')
    if (this.stage !== 'play') return fail('正在确认死子；如有争议，请点“继续下棋”')
    if (seat !== this.turn) return fail('还没轮到你落子')
    if (type === 'stonePass') {
      if (this.kind !== 'go') return fail('五子棋不能停一手')
      this.moves.push({ ply: this.moves.length + 1, side: seat, point: null, captured: [], notation: '停一手' })
      this.turn = seat === 0 ? 1 : 0; this.passes++
      if (this.passes >= 2) { this.stage = 'scoring'; this.dead.clear(); this.confirmed = [false,false]; this.scoreRevision++ }
      return { ok: true }
    }
    const point = payload.point
    if (!validStonePoint(point, this.size) || this.board[point] !== null) return fail('请在空的交叉点落子')
    let captured: number[] = []
    if (this.kind === 'go') {
      const result = playGo(this.board, point, seat, this.size)
      if (typeof result === 'string') return fail(result)
      const key = stonePositionKey(result.board)
      if (this.positions.has(key)) return fail('打劫／同形再现：不能落成此前出现过的盘面，请先在别处行棋')
      this.board = result.board; captured = result.captured; this.positions.add(key); this.captured[seat] += captured.length
    } else this.board[point] = seat
    this.moves.push({ ply: this.moves.length + 1, side: seat, point, captured, notation: `${stoneCoordinate(point, this.size)}${captured.length ? ` · 提 ${captured.length} 子` : ''}` })
    this.passes = 0; this.turn = seat === 0 ? 1 : 0
    if (this.kind === 'gomoku') {
      this.winningLine = gomokuLine(this.board, point, this.size)
      if (this.winningLine.length) this.finish(seat, `${stoneSideName(seat)}连成 ${this.winningLine.length} 子`)
      else if (this.board.every(side => side !== null)) this.finish(null, '棋盘已满，双方均未连成五子')
    }
    return { ok: true }
  }
  private finish(winner: StoneSide | null, reason: string): void { this.phase = 'finished'; this.winner = winner; this.draw = winner === null; this.reason = reason }
  view(): StoneGameFields {
    return { game: this.kind, phase: this.phase, turn: this.phase === 'playing' && this.stage === 'play' ? this.turn : null, lastPlay: null, tablePlays: [], trickStartIndex: 0,
      stones: structuredClone({ round: this.round, roundId: this.roundId, size: this.size, board: this.board, moves: this.moves, stage: this.stage, passes: this.passes,
        captured: this.captured, dead: [...this.dead].sort((a,b) => a-b), confirmed: this.confirmed, scoreRevision: this.scoreRevision,
        score: this.kind === 'go' && this.stage === 'scoring' ? scoreGo(this.board, this.size, [...this.dead]) : null,
        winner: this.winner, draw: this.draw, reason: this.reason, winningLine: this.winningLine }) }
  }
  restart(): GameResult {
    if (this.phase !== 'finished') return { ok: false, message: '本局结束后才能重新开局' }
    this.round++; this.roundId = randomUUID(); this.phase = 'lobby'; this.stage = 'play'; this.board = Array(this.size ** 2).fill(null); this.turn = 0
    this.positions = new Set([stonePositionKey(this.board)]); this.moves = []; this.passes = 0; this.captured = [0,0]; this.dead.clear(); this.confirmed = [false,false]; this.scoreRevision = 0
    this.winner = null; this.draw = false; this.reason = ''; this.winningLine = []
    return { ok: true }
  }
  handOf(_seat: number): readonly Card[] { return [] }
  passedAt(_seat: number): boolean { return false }
  requiresConnection(_seat: number): boolean { return this.phase === 'playing' }
  hint() { return { ok: false, message: '点击空交叉点预选，再点“确认落子”', plays: [] } }
  timeoutAction() { return null }
  statusText(self: number | null, name: (seat: number) => string): string {
    if (this.phase === 'finished') return `${this.draw ? '和棋' : `${stoneSideName(this.winner!)}获胜`} · ${this.reason}`
    if (this.stage === 'scoring') return '请双方确认死子和数子结果；有争议可继续下棋'
    return self === this.turn ? '轮到你落子' : `等待${name(this.turn)}落子`
  }
}
