import { randomInt, randomUUID } from 'node:crypto';
import type { Card, JunqiGameFields } from '../../shared/protocol';
import { JUNQI_COUNTS, canDeployJunqi, junqiCombat, junqiCoordinate, junqiDestinations, junqiTeam, junqiTeamName, junqiSideName, validJunqiPoint, type JunqiBoard, type JunqiRank, type JunqiSide, type JunqiMove, type JunqiVariant } from '../../shared/junqi';
import { junqiMovePath } from '../../shared/junqiMovePath';
import type { GameCommandType, GameResult, RoomGame } from './types';

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) { const j = randomInt(i + 1); [items[i], items[j]] = [items[j]!, items[i]!]; }
  return items;
}

export class JunqiGame implements RoomGame {
  readonly kind = 'junqi' as const;
  constructor(private variant: JunqiVariant = 'two', private readonly fixedBoard?: () => JunqiBoard) { this.resetBoard(); if (fixedBoard) this.roundId = 'teaching-round-1'; }
  get seatCount(): 2 | 4 { return this.variant === 'four' ? 4 : 2; }
  phase: 'lobby' | 'deploying' | 'playing' | 'finished' = 'lobby';
  private board: JunqiBoard = Array(60).fill(null);
  private deployed: boolean[] = [];
  private revealed: boolean[] = [];
  private eliminated: boolean[] = [];
  private eliminationReasons: string[] = [];
  private turn: JunqiSide | null = null;
  private winner: JunqiSide | null = null;
  private winnerTeam: 0 | 1 | null = null;
  private draw = false;
  private reason = '';
  private moves: JunqiMove[] = [];
  private quietPlies = 0;
  private round = 1;
  private roundId: string = randomUUID();

  /** Room authorizes roster changes first. No change is possible after deployment starts. */
  setVariant(variant: JunqiVariant): GameResult {
    if (this.phase !== 'lobby') return { ok: false, message: '只能在准备阶段切换军棋模式' };
    this.variant = variant;
    this.resetBoard();
    return { ok: true };
  }

  private resetBoard(): void {
    this.board = Array(this.variant === 'four' ? 129 : 60).fill(null);
    this.deployed = Array(this.seatCount).fill(false);
    this.revealed = Array(this.seatCount).fill(false);
    this.eliminated = Array(this.seatCount).fill(false);
    this.eliminationReasons = Array(this.seatCount).fill('');
  }

  start(): void {
    if (this.phase !== 'lobby') return;
    this.resetBoard();
    if (this.fixedBoard) {
      const source = this.fixedBoard();
      if (source.length !== this.board.length) throw new Error('教学棋盘大小不正确');
      if (new Set(source.filter(Boolean).map(piece => piece!.id)).size !== this.seatCount * 25) throw new Error('教学棋子身份重复');
      for (let side = 0; side < this.seatCount; side++) {
        for (const [rank, count] of Object.entries(JUNQI_COUNTS)) {
          if (source.filter(piece => piece?.side === side && piece.rank === rank).length !== count) throw new Error('教学棋子数量不正确');
        }
      }
      source.forEach((piece, point) => { if (piece && (!piece.rank || !canDeployJunqi(piece.rank, piece.side, point, this.variant))) throw new Error('教学初始阵形不合法'); });
      this.board = source.map(piece => piece ? { ...piece } : null);
    } else for (let side = 0; side < this.seatCount; side++) this.arrange(side as JunqiSide);
    this.phase = 'deploying';
  }

  private arrange(side: JunqiSide): void {
    this.board = this.board.map(p => p?.side === side ? null : p);
    // Constrained pieces first; rank never appears in an id sent over the wire.
    for (const rank of ['flag', 'mine', 'bomb', 'commander', 'general', 'division', 'brigade', 'regiment', 'battalion', 'company', 'platoon', 'engineer'] as JunqiRank[]) {
      for (let n = 0; n < JUNQI_COUNTS[rank]; n++) {
        const positions = shuffle(Array.from({ length: this.board.length }, (_, p) => p).filter(p => !this.board[p] && canDeployJunqi(rank, side, p, this.variant)));
        const position = positions[0];
        if (position === undefined) throw new Error('无法生成合法布阵');
        this.board[position] = { id: randomUUID(), side, rank };
      }
    }
  }

  command(seatId: number, type: GameCommandType, payload: Record<string, unknown>): GameResult {
    const fail = (message: string): GameResult => ({ ok: false, message });
    if (!Number.isInteger(seatId) || seatId < 0 || seatId >= this.seatCount) return fail('只有入座玩家可以操作');
    const side = seatId as JunqiSide;
    if (type === 'junqiSetup') {
      if (this.phase !== 'deploying') return fail('当前不是布阵阶段');
      if (this.deployed[seatId]) return fail('已确认布阵，等待对方');
      if (payload.action === 'shuffle') this.arrange(side);
      else if (payload.action === 'confirm') {
        this.deployed[seatId] = true;
        if (this.deployed.every(Boolean)) { this.phase = 'playing'; this.turn = 0; }
      } else if (payload.action === 'swap') {
        const { from, to } = payload;
        if (!validJunqiPoint(from, this.variant) || !validJunqiPoint(to, this.variant) || from === to) return fail('请选择两个不同的己方棋子');
        const a = this.board[from], b = this.board[to];
        if (a?.side !== seatId || b?.side !== seatId || !a.rank || !b.rank) return fail('只能交换自己的棋子');
        if (!canDeployJunqi(a.rank, side, to, this.variant) || !canDeployJunqi(b.rank, side, from, this.variant)) return fail('布阵不合法：军旗在大本营、地雷在后两排、炸弹不能在第一排');
        [this.board[from], this.board[to]] = [b, a];
      } else return fail('布阵操作无效');
      return { ok: true };
    }
    if (this.phase !== 'playing') return fail('所有玩家确认布阵后才能行棋');
    if (this.eliminated[seatId]) return fail('你已出局，可以继续观战');
    if (type === 'junqiResign') {
      if (this.variant === 'two') this.finish(seatId === 0 ? 1 : 0, '对方认输');
      else { this.eliminate(side, '认输'); this.advance(side); }
      return { ok: true };
    }
    if (type !== 'junqiMove') return fail('军棋不支持这个操作');
    if (this.turn !== seatId) return fail('还没有轮到你行棋');
    const { from, to } = payload;
    if (!validJunqiPoint(from, this.variant) || !validJunqiPoint(to, this.variant)) return fail('棋盘位置无效');
    const attacker = this.board[from], defender = this.board[to];
    if (attacker?.side !== seatId || !attacker.rank) return fail('请选择自己的棋子');
    const path = this.route(from, to);
    if (!path.length) return fail('不能走到这里：请检查队友、铁路阻挡、行营和大本营规则');
    const outcome = defender?.rank ? junqiCombat(attacker.rank, defender.rank) : 'move';
    this.board[from] = null;
    if (outcome === 'move' || outcome === 'attacker') this.board[to] = attacker;
    else if (outcome === 'both') this.board[to] = null;
    if ((outcome === 'defender' || outcome === 'both') && attacker.rank === 'commander') this.revealed[seatId] = true;
    if ((outcome === 'attacker' || outcome === 'both') && defender?.rank === 'commander') this.revealed[defender.side] = true;
    this.moves.push({ ply: this.moves.length + 1, side, from, to, path, outcome });
    this.quietPlies = defender ? 0 : this.quietPlies + 1;
    const next: JunqiSide = seatId === 0 ? 1 : 0;
    if (this.variant === 'four') {
      if (defender?.rank === 'flag') this.eliminate(defender.side, '军旗被夺');
      this.advance(side);
    }
    else if (defender?.rank === 'flag') this.finish(side, '夺取对方军旗');
    else if (!this.hasMove(next)) this.finish(side, '对方无棋可走');
    else if (this.quietPlies >= 70) { this.draw = true; this.finish(null, '连续 70 步没有交战，和棋'); }
    else this.turn = next;
    return { ok: true };
  }

  /** Public routes prefer what an ordinary piece could travel; engineer-only turns are the fallback. */
  private route(from: number, to: number): number[] {
    const piece = this.board[from];
    if (!piece || piece.rank !== 'engineer') return junqiMovePath(this.board, from, to, this.variant);
    const ordinary = this.board.slice();
    ordinary[from] = { ...piece, rank: 'company' };
    const path = junqiMovePath(ordinary, from, to, this.variant);
    return path.length ? path : junqiMovePath(this.board, from, to, this.variant);
  }

  private hasMove(side: number): boolean { return this.board.some((p, point) => p?.side === side && junqiDestinations(this.board, point, this.variant).length > 0); }
  private eliminate(side: JunqiSide, reason: string): void {
    this.eliminated[side] = true;
    this.eliminationReasons[side] = reason;
    this.board = this.board.map(p => p?.side === side ? null : p);
  }
  private advance(after: JunqiSide): void {
    // Clear all newly immobile armies together, then decide teams. Removal may open railways.
    const stuck = [0, 1, 2, 3].filter(side => !this.eliminated[side] && !this.hasMove(side));
    for (const side of stuck) this.eliminate(side as JunqiSide, '无棋可走');
    const alive = [0, 1, 2, 3].filter(side => !this.eliminated[side]);
    const teams = new Set(alive.map(side => junqiTeam(side, this.variant)));
    if (teams.size === 0) { this.draw = true; this.finish(null, '各方均无棋可走，和棋'); return; }
    if (teams.size === 1) {
      this.finish(alive[0] as JunqiSide, `${junqiTeamName(1 - [...teams][0]!, this.variant)}全部出局`);
      return;
    }
    if (this.quietPlies >= 70) { this.draw = true; this.finish(null, '连续 70 步没有交战，和棋'); return; }
    // An out-of-turn resignation must not consume the current live player's turn.
    if (this.turn !== after && this.turn !== null && !this.eliminated[this.turn]) return;
    for (let offset = 1; offset <= 4; offset++) {
      const candidate = (after + offset) % 4;
      if (!this.eliminated[candidate]) { this.turn = candidate as JunqiSide; return; }
    }
  }

  private finish(winner: JunqiSide | null, reason: string): void { this.winner = winner; this.winnerTeam = winner === null ? null : junqiTeam(winner, this.variant); this.reason = reason; this.turn = null; this.phase = 'finished'; }

  view(selfSeat: number | null): JunqiGameFields {
    return {
      game: 'junqi', phase: this.phase, turn: this.turn, lastPlay: null, tablePlays: [], trickStartIndex: 0,
      junqi: {
        variant: this.variant, round: this.round, roundId: this.roundId,
        board: this.board.map(p => p ? { id: p.id, side: p.side, rank: p.side === selfSeat || this.phase === 'finished' || (p.rank === 'flag' && this.revealed[p.side]) ? p.rank : null } : null),
        deployed: [...this.deployed], revealedFlags: [...this.revealed], eliminated: [...this.eliminated], eliminationReasons: [...this.eliminationReasons], winner: this.winner, winnerTeam: this.winnerTeam, draw: this.draw, reason: this.reason,
        moves: this.moves.map(m => ({ ...m, path: [...m.path] })), quietPlies: this.quietPlies,
      },
    };
  }
  handOf(_seatId: number): readonly Card[] { return []; }
  passedAt(_seatId: number): boolean { return false; }
  requiresConnection(seatId: number): boolean { return this.phase === 'deploying' || (this.phase === 'playing' && !this.eliminated[seatId]); }
  hint() { return { ok: false, message: '点选己方棋子即可查看可走位置', plays: [] }; }
  timeoutAction() { return null; }
  statusText(self: number | null, nameOf: (seat: number) => string): string {
    if (this.phase === 'deploying') return self !== null && this.deployed[self] ? '布阵已确认，等待其他玩家' : `调整布阵，然后确认；${this.seatCount === 4 ? '四方' : '双方'}确认后红方先行`;
    if (this.phase === 'finished') return this.draw ? this.reason : `${this.variant === 'four' ? junqiTeamName(this.winnerTeam!, this.variant) : nameOf(this.winner!)}获胜 · ${this.reason}`;
    const last = this.moves.at(-1);
    return `${self !== null && this.eliminated[self] ? `${junqiSideName(self)}已出局，正在观战 · ` : ''}${this.turn === self ? '轮到你行棋' : `等待${nameOf(this.turn ?? 0)}行棋`}${last ? ` · 上一步 ${junqiCoordinate(last.from, this.variant)} → ${junqiCoordinate(last.to, this.variant)}` : ''}`;
  }
  restart(): GameResult {
    if (this.phase !== 'finished') return { ok: false, message: '本局结束后才能再来一局' };
    this.round++; this.roundId = this.fixedBoard ? `teaching-round-${this.round}` : randomUUID(); this.phase = 'lobby'; this.resetBoard();
    this.turn = null; this.winner = null; this.winnerTeam = null; this.draw = false; this.reason = ''; this.moves = []; this.quietPlies = 0;
    return { ok: true };
  }
}
