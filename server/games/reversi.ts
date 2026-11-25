import { randomUUID } from 'node:crypto'
import type { Card, ReversiGameFields } from '../../shared/protocol'
import {
  REVERSI_AREA, applyMove, initialReversiBoard, legalMoves, otherReversiSide,
  reversiCoordinate, reversiPassText, reversiSideName, score,
  type ReversiBoard, type ReversiMove, type ReversiSide,
} from '../../shared/reversi'
import { BoardUndo } from './boardUndo'
import type { GameCommandOptions, GameCommandType, GameResult, RoomGame } from './types'

/** Trusted positions for engine tests and authored tutorials. Rooms always use the standard setup. */
export interface ReversiSetup { board: ReversiBoard; turn: ReversiSide }

export class ReversiGame implements RoomGame {
  readonly kind = 'reversi' as const
  readonly seatCount = 2 as const
  phase: 'lobby' | 'playing' | 'finished' = 'lobby'
  private round = 1
  private roundId = randomUUID()
  private board: ReversiBoard
  private turn: ReversiSide
  private legal: number[] = []
  private moves: ReversiMove[] = []
  private winner: ReversiSide | null = null
  private draw = false
  private reason = ''
  private undo = new BoardUndo()
  private readonly initial: ReversiSetup

  constructor(setup: ReversiSetup = { board: initialReversiBoard(), turn: 0 }) {
    if (setup.board.length !== REVERSI_AREA || setup.board.some(cell => cell !== null && cell !== 0 && cell !== 1)) {
      throw new Error('黑白棋起始棋盘无效')
    }
    this.initial = { board: [...setup.board], turn: setup.turn }
    this.board = [...this.initial.board]
    this.turn = this.initial.turn
  }

  start(): void {
    if (this.phase !== 'lobby') return
    this.phase = 'playing'
    this.advance(this.turn)
  }

  private advance(next: ReversiSide): void {
    this.turn = next
    this.legal = legalMoves(this.board, next)
    if (this.legal.length) return
    const opponent = otherReversiSide(next)
    const reply = legalMoves(this.board, opponent)
    if (!reply.length) {
      const [black, white] = score(this.board)
      this.finish(black === white ? null : black > white ? 0 : 1,
        this.board.includes(null) ? '双方均无合法落点' : '棋盘已下满')
      return
    }
    this.moves.push({ ply: this.moves.length + 1, point: null, side: next, undoable: false, flipped: [], notation: reversiPassText(next) })
    this.turn = opponent
    this.legal = reply
  }

  command(seat: number, type: GameCommandType, payload: Record<string, unknown>, options?: GameCommandOptions): GameResult {
    if (seat !== 0 && seat !== 1) return { ok: false, message: '只有入座玩家可以落子' }
    if (this.phase !== 'playing') return { ok: false, message: '请先准备并开始对局' }
    if (type === 'reversiUndo') {
      return this.undo.command(seat, payload.action, this.moves, target => this.rewind(target), options?.unlimitedUndo === true)
    }
    if (type === 'reversiResign') {
      this.finish(otherReversiSide(seat), reversiSideName(seat) + '认输')
      return { ok: true }
    }
    if (type !== 'reversiMove') return { ok: false, message: '黑白棋不支持这个操作' }
    if (this.turn !== seat) return { ok: false, message: '还没轮到你落子' }
    const point = payload.point as number
    const placement = applyMove(this.board, seat, point)
    if (!placement) return { ok: false, message: '请在能夹住对方棋子的空格落子' }
    this.board = placement.board
    this.moves.push({ ply: this.moves.length + 1, point, side: seat, flipped: placement.flipped,
      notation: reversiCoordinate(point) + ' · 翻 ' + placement.flipped.length + ' 子' })
    this.undo.undoOffer = null
    this.advance(otherReversiSide(seat))
    return { ok: true }
  }

  private rewind(target: number): void {
    this.turn = this.moves[target]!.side
    const removed = this.moves.splice(target)
    for (const move of removed.reverse()) {
      if (move.point === null) continue
      this.board[move.point] = null
      for (const point of move.flipped) this.board[point] = otherReversiSide(move.side)
    }
    this.legal = legalMoves(this.board, this.turn)
  }

  flag(seat: number): GameResult {
    if ((seat !== 0 && seat !== 1) || this.phase !== 'playing' || this.turn !== seat) return { ok: false, message: '当前不能判超时' }
    this.finish(otherReversiSide(seat), `${reversiSideName(seat)}超时`)
    return { ok: true }
  }
  private finish(winner: ReversiSide | null, reason: string): void {
    this.phase = 'finished'
    this.winner = winner
    this.draw = winner === null
    this.reason = reason
    this.legal = []
    this.undo.undoOffer = null
  }

  view(): ReversiGameFields {
    return { game: this.kind, phase: this.phase, turn: this.phase === 'playing' ? this.turn : null,
      lastPlay: null, tablePlays: [], trickStartIndex: 0,
      reversi: structuredClone({ round: this.round, roundId: this.roundId, board: this.board, moves: this.moves,
        legal: this.legal, counts: score(this.board), winner: this.winner, draw: this.draw, reason: this.reason, ...this.undo }) }
  }

  restart(): GameResult {
    if (this.phase !== 'finished') return { ok: false, message: '本局结束后才能重新开局' }
    this.round++
    this.roundId = randomUUID()
    this.board = [...this.initial.board]
    this.turn = this.initial.turn
    this.phase = 'lobby'
    this.legal = []
    this.moves = []
    this.winner = null
    this.draw = false
    this.reason = ''
    this.undo = new BoardUndo()
    return { ok: true }
  }

  handOf(): readonly Card[] { return [] }
  passedAt(): boolean { return false }
  requiresConnection(): boolean { return this.phase === 'playing' }
  hint() { return { ok: false, message: '棋盘上的小圆点是合法落点', plays: [] } }
  timeoutAction() { return null }

  statusText(self: number | null, name: (seat: number) => string): string {
    if (this.phase === 'finished') return (this.draw ? '和棋' : name(this.winner!) + '获胜') + ' · ' + this.reason
    const last = this.moves.at(-1)
    const status = this.turn === self ? '轮到你落子' : '等待' + name(this.turn) + '落子'
    return last?.point === null ? last.notation + ' · ' + status : status
  }
}
