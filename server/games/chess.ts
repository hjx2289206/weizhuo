import { randomUUID } from 'node:crypto'
import { Chess } from 'chess.js'
import type { Card, ChessGameFields } from '../../shared/protocol'
import { chessBoard, chessCoordinate, chessIndex, chessSideName, validChessPoint, CHESS_PROMOTIONS, type ChessBoard, type ChessMove, type ChessPromotion, type ChessSide } from '../../shared/chess'
import type { GameCommandType, GameResult, RoomGame } from './types'

export class ChessGame implements RoomGame {
  readonly kind = 'chess' as const
  readonly seatCount = 2 as const
  phase: 'lobby' | 'playing' | 'finished' = 'lobby'
  private engine: Chess
  private readonly startFen: string
  private board: ChessBoard
  private round = 1
  private roundId = randomUUID()
  private moves: ChessMove[] = []
  private winner: ChessSide | null = null
  private draw = false
  private reason = ''
  private drawOffer: ChessSide | null = null
  private lastOffer = [-1, -1]
  /** Trusted FEN for server-authored tutorials/tests; never populated by room payloads. */
  constructor(private readonly initialFen?: string) { this.engine = new Chess(initialFen); this.startFen = this.engine.fen(); this.board = chessBoard(this.engine) }
  private side(): ChessSide { return this.engine.turn() === 'w' ? 0 : 1 }
  start(): void { if (this.phase === 'lobby') { this.phase = 'playing'; this.adjudicate() } }
  command(seat: number, type: GameCommandType, payload: Record<string, unknown>): GameResult {
    const fail = (message: string): GameResult => ({ ok: false, message })
    if (seat !== 0 && seat !== 1) return fail('只有入座玩家可以行棋')
    if (this.phase !== 'playing') return fail('请先准备并开始对局')
    if (type === 'chessResign') { this.finish(seat === 0 ? 1 : 0, `${chessSideName(seat)}认输`); return { ok: true } }
    if (type === 'chessDraw') {
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
    if (type !== 'chessMove') return fail('国际象棋不支持这个操作')
    if (this.side() !== seat) return fail('还没轮到你行棋')
    const { from, to, promotion } = payload
    if (!validChessPoint(from) || !validChessPoint(to) || from === to) return fail('请选择棋子和另一个落点')
    const piece = this.board[from]
    if (!piece || piece.side !== seat) return fail('请先选自己的棋子')
    const promoting = piece.rank === 'p' && (to < 8 || to >= 56)
    if (promoting && !CHESS_PROMOTIONS.includes(promotion as ChessPromotion)) return fail('请选择升变为后、车、象或马')
    if (!promoting && promotion !== undefined) return fail('只有兵到达底线时才能升变')
    const legal = this.engine.moves({ square: chessCoordinate(from), verbose: true }).find(move => move.to === chessCoordinate(to) && (!promoting || move.promotion === promotion))
    if (!legal) return fail('这一步不能走：检查走法、挡子和王的安全')
    const capturePoint = legal.isEnPassant() ? to + (seat === 0 ? 8 : -8) : this.board[to] ? to : null
    const captured = capturePoint === null ? null : this.board[capturePoint]
    const castle = legal.isKingsideCastle() || legal.isQueensideCastle() ? { from: Math.floor(from / 8) * 8 + (legal.isKingsideCastle() ? 7 : 0), to: from + (legal.isKingsideCastle() ? 1 : -1) } : null
    const rook = castle ? this.board[castle.from]! : null
    this.engine.move({ from: legal.from, to: legal.to, ...(promoting ? { promotion: promotion as ChessPromotion } : {}) })
    this.board[from] = null
    if (capturePoint !== null) this.board[capturePoint] = null
    this.board[to] = { ...piece, ...(promoting ? { rank: promotion as ChessPromotion } : {}) }
    if (castle) { this.board[castle.from] = null; this.board[castle.to] = rook }
    this.moves.push({ ply: this.moves.length + 1, side: seat, from, to, piece: { ...piece }, captured: captured ? { ...captured } : null, capturePoint,
      check: this.engine.isCheck(), notation: legal.san, ...(promoting ? { promotion: promotion as ChessPromotion } : {}), ...(castle && rook ? { castle: { ...castle, piece: { ...rook } } } : {}) })
    this.drawOffer = null; this.adjudicate()
    return { ok: true }
  }
  private adjudicate(): void {
    if (this.engine.isCheckmate()) this.finish(this.side() === 0 ? 1 : 0, `${chessSideName(this.side())}被将死`)
    else if (this.engine.isStalemate()) this.finish(null, '无合法走法且未被将军（逼和）')
    else if (this.engine.isInsufficientMaterial()) this.finish(null, '子力不足以将死，和棋')
    // Casual room convention: claims are automatic and are documented in rules/tutorials.
    else if (this.engine.isThreefoldRepetition()) this.finish(null, '同一局面三次重复，自动和棋')
    else if (this.engine.isDrawByFiftyMoves()) this.finish(null, '连续 50 回合无吃子且无兵移动，自动和棋')
  }
  private finish(winner: ChessSide | null, reason: string): void { this.phase = 'finished'; this.winner = winner; this.draw = winner === null; this.reason = reason; this.drawOffer = null }
  view(): ChessGameFields {
    const checked = this.engine.isCheck() ? this.side() : null
    return { game: 'chess', phase: this.phase, turn: this.phase === 'playing' ? this.side() : null, lastPlay: null, tablePlays: [], trickStartIndex: 0,
      chess: structuredClone({ round: this.round, roundId: this.roundId, startFen: this.startFen, fen: this.engine.fen(), board: this.board, moves: this.moves, check: checked, winner: this.winner, draw: this.draw, reason: this.reason, drawOffer: this.drawOffer, quietPlies: Number(this.engine.fen().split(' ')[4]) }) }
  }
  handOf(_seat: number): readonly Card[] { return [] }
  passedAt(_seat: number): boolean { return false }
  requiresConnection(_seat: number): boolean { return this.phase === 'playing' }
  hint() { return { ok: false, message: '点选自己的棋子，即可看到可以走的位置', plays: [] } }
  timeoutAction() { return null }
  statusText(self: number | null, name: (seat: number) => string): string { return this.phase === 'finished' ? `${this.draw ? '和棋' : `${name(this.winner!)}获胜`} · ${this.reason}` : `${this.side() === self ? '轮到你行棋' : `等待${name(this.side())}行棋`}${this.engine.isCheck() ? ' · 正在被将军，必须应将' : ''}` }
  restart(): GameResult {
    if (this.phase !== 'finished') return { ok: false, message: '本局结束后才能重新开局' }
    this.engine = new Chess(this.initialFen); this.board = chessBoard(this.engine); this.round++; this.roundId = randomUUID(); this.phase = 'lobby'; this.moves = []; this.winner = null; this.draw = false; this.reason = ''; this.drawOffer = null; this.lastOffer = [-1, -1]
    return { ok: true }
  }
}
