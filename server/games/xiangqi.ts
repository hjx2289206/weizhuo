import { randomUUID } from 'node:crypto'
import type { Card, XiangqiGameFields } from '../../shared/protocol'
import { initialXiangqiBoard, validXiangqiPoint, xiangqiDestinations, xiangqiInCheck, xiangqiHasMove, xiangqiNotation, xiangqiPositionKey, xiangqiSideName, type XiangqiBoard, type XiangqiMove, type XiangqiSide } from '../../shared/xiangqi'
import type { GameCommandType, GameResult, RoomGame } from './types'

export class XiangqiGame implements RoomGame {
  readonly kind = 'xiangqi' as const
  readonly seatCount = 2 as const
  phase: 'lobby' | 'playing' | 'finished' = 'lobby'
  private board: XiangqiBoard
  private turn: XiangqiSide | null = null
  private round = 1
  private roundId = randomUUID()
  private moves: XiangqiMove[] = []
  private winner: XiangqiSide | null = null
  private draw = false
  private reason = ''
  private check: XiangqiSide | null = null
  private drawOffer: XiangqiSide | null = null
  private lastOffer = [-1, -1]
  private quietPlies = 0
  private positions: string[] = []
  /** Fixed positions are trusted, server-only fixtures. Room never reads them from a client. */
  constructor(private readonly fixedBoard?: () => XiangqiBoard) { this.board = this.makeBoard() }
  private makeBoard(): XiangqiBoard {
    const board = structuredClone(this.fixedBoard?.() ?? initialXiangqiBoard())
    if (board.length !== 90 || new Set(board.filter(Boolean).map(piece => piece!.id)).size !== board.filter(Boolean).length || [0, 1].some(side => board.filter(piece => piece?.side === side && piece.rank === 'general').length !== 1)) throw new Error('象棋起始棋盘无效')
    return board
  }
  start(): void {
    if (this.phase !== 'lobby') return
    this.phase = 'playing'; this.turn = 0; this.check = xiangqiInCheck(this.board, 0) ? 0 : null
    this.positions = [xiangqiPositionKey(this.board, 0)]
    if (!xiangqiHasMove(this.board, 0)) this.finish(1, this.check === 0 ? '红方被将死' : '红方无棋可走（困毙）')
  }
  command(seat: number, type: GameCommandType, payload: Record<string, unknown>): GameResult {
    const fail = (message: string): GameResult => ({ ok: false, message })
    if (seat !== 0 && seat !== 1) return fail('只有入座玩家可以行棋')
    if (this.phase !== 'playing') return fail('请先准备并开始对局')
    if (type === 'xiangqiResign') { this.finish(seat === 0 ? 1 : 0, `${xiangqiSideName(seat)}认输`); return { ok: true } }
    if (type === 'xiangqiDraw') {
      if (payload.action === 'offer') {
        if (this.drawOffer !== null) return fail('已有和棋请求，请先处理')
        if (this.lastOffer[seat] === this.moves.length) return fail('本步已经提过和棋，请继续行棋')
        this.drawOffer = seat; this.lastOffer[seat] = this.moves.length; return { ok: true }
      }
      if (payload.action !== 'accept' && payload.action !== 'decline') return fail('和棋操作无效')
      if (this.drawOffer === null || this.drawOffer === seat) return fail('没有对方发来的和棋请求')
      if (payload.action === 'accept') this.finish(null, '双方同意和棋')
      else this.drawOffer = null
      return { ok: true }
    }
    if (type !== 'xiangqiMove') return fail('中国象棋不支持这个操作')
    if (this.turn !== seat) return fail('还没轮到你行棋')
    const { from, to } = payload
    if (!validXiangqiPoint(from) || !validXiangqiPoint(to) || from === to) return fail('请选择棋子和另一个落点')
    const piece = this.board[from], captured = this.board[to]
    if (piece?.side !== seat) return fail('请先选自己的棋子')
    if (captured?.side === seat) return fail('不能吃自己的棋子')
    if (!xiangqiDestinations(this.board, from).includes(to)) return fail('这一步不能走：检查棋子走法、挡子，以及是否让自己的将帅被吃')
    this.board[from] = null; this.board[to] = piece
    const next: XiangqiSide = seat === 0 ? 1 : 0
    const checked = xiangqiInCheck(this.board, next)
    this.moves.push({ ply: this.moves.length + 1, side: seat, from, to, piece: { ...piece }, captured: captured ? { ...captured } : null, check: checked, notation: xiangqiNotation(piece, from, to) })
    this.quietPlies = captured ? 0 : this.quietPlies + 1; this.drawOffer = null; this.turn = next; this.check = checked ? next : null
    const key = xiangqiPositionKey(this.board, next); this.positions.push(key)
    if (captured?.rank === 'general' || !xiangqiHasMove(this.board, next)) this.finish(seat, checked ? `${xiangqiSideName(next)}被将死` : `${xiangqiSideName(next)}无棋可走（困毙）`)
    else {
      const repeats = this.positions.flatMap((value, index) => value === key ? [index] : [])
      if (repeats.length >= 3) {
        const cycle = this.moves.slice(repeats.at(-3)!)
        const perpetual = ([0, 1] as const).filter(side => { const own = cycle.filter(move => move.side === side); return own.length > 0 && own.every(move => move.check) })
        if (perpetual.length === 1) this.finish(perpetual[0] === 0 ? 1 : 0, `${xiangqiSideName(perpetual[0]!)}长将，判负`)
        else this.finish(null, '同一局面三次重复，和棋')
      } else if (this.quietPlies >= 120) this.finish(null, '连续 120 步没有吃子，和棋')
    }
    return { ok: true }
  }
  private finish(winner: XiangqiSide | null, reason: string): void { this.phase = 'finished'; this.winner = winner; this.draw = winner === null; this.reason = reason; this.turn = null; this.drawOffer = null }
  view(): XiangqiGameFields {
    return { game: 'xiangqi', phase: this.phase, turn: this.turn, lastPlay: null, tablePlays: [], trickStartIndex: 0,
      xiangqi: structuredClone({ round: this.round, roundId: this.roundId, board: this.board, moves: this.moves, check: this.check, winner: this.winner, draw: this.draw, reason: this.reason, drawOffer: this.drawOffer, quietPlies: this.quietPlies }) }
  }
  handOf(_seat: number): readonly Card[] { return [] }
  passedAt(_seat: number): boolean { return false }
  requiresConnection(_seat: number): boolean { return this.phase === 'playing' }
  hint() { return { ok: false, message: '点选自己的棋子，即可看到可以走的位置', plays: [] } }
  timeoutAction() { return null }
  statusText(self: number | null, name: (seat: number) => string): string { return this.phase === 'finished' ? `${this.draw ? '和棋' : `${name(this.winner!)}获胜`} · ${this.reason}` : `${this.turn === self ? '轮到你行棋' : `等待${name(this.turn ?? 0)}行棋`}${this.check !== null ? ` · ${xiangqiSideName(this.check)}正在被将军，必须应将` : ''}` }
  restart(): GameResult {
    if (this.phase !== 'finished') return { ok: false, message: '本局结束后才能重新开局' }
    this.board = this.makeBoard(); this.round++; this.roundId = randomUUID(); this.phase = 'lobby'; this.turn = null; this.moves = []; this.winner = null; this.draw = false; this.reason = ''; this.check = null; this.drawOffer = null; this.lastOffer = [-1, -1]; this.quietPlies = 0; this.positions = []
    return { ok: true }
  }
}
