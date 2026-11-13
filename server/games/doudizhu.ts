// Doudizhu engine: cards, bidding, play/pass, trick cursor, scoring and results for one table.
// Extracted verbatim from the phase-1 Room so the shared room keeps only identity/authority.

import type { Card, DoudizhuGameFields, DoudizhuPhase, LastPlay, TablePlay } from '../../shared/protocol';
import {
  BOTTOM_SIZE,
  HAND_SIZE,
  canBeat,
  createDeck,
  detectPlay,
  scoreGame,
  shuffle,
  sortHand,
  type PlayKind,
} from '../rules';
import type { GameCommandType, GameContext, GameResult, HintResult, RoomGame, TimeoutAction } from './types';
import { doudizhuHints } from '../hints';

const SEAT_COUNT = 3;

export class DoudizhuGame implements RoomGame {
  readonly kind = 'doudizhu' as const;
  readonly seatCount = 3 as const;
  /** Internal state for trusted server and test fixtures after `instanceof` narrowing. */
  readonly hands: Card[][] = [[], [], []];

  private readonly ctx: GameContext;
  private phaseValue: DoudizhuPhase = 'lobby';
  private bottomCards: Card[] = [];
  private landlordSeat: number | null = null;
  private turnSeat: number | null = null;
  private bidValue = 0;
  private winnerSide: 'landlord' | 'farmers' | null = null;
  private multiplierValue = 1;
  private readonly scoreBoard = [0, 0, 0];
  private lastPlayValue: LastPlay | null = null;
  private lastPlayKind: PlayKind | null = null;
  private history: TablePlay[] = [];
  private trickStartValue = 0;
  private passCount = 0;
  private readonly bidCounts = [0, 0, 0];
  private readonly bidValues = [0, 0, 0];
  private readonly playCounts = [0, 0, 0];
  private readonly passFlags = [false, false, false];

  constructor(ctx: GameContext) {
    this.ctx = ctx;
  }

  get phase(): DoudizhuPhase {
    return this.phaseValue;
  }

  /** Deal the first round; the room has already checked seats, readiness and connections. */
  start(): void {
    this.deal();
  }

  command(seatId: number, type: GameCommandType, payload: Record<string, unknown>): GameResult {
    switch (type) {
      case 'bid':
        return this.bid(seatId, payload);
      case 'play':
        return this.play(seatId, payload);
      case 'pass':
        return this.pass(seatId);
      default:
        // Doudizhu owns no exchange commands; anything else is not a Doudizhu action.
        return { ok: false, message: '未知的操作类型' };
    }
  }

  view(_selfSeat: number | null): DoudizhuGameFields {
    const revealBottom = this.phaseValue === 'playing' || this.phaseValue === 'finished';
    return {
      game: 'doudizhu',
      phase: this.phaseValue,
      turn: this.turnSeat,
      lastPlay: this.lastPlayValue,
      tablePlays: this.history.slice(),
      trickStartIndex: this.trickStartValue,
      landlord: this.landlordSeat,
      bid: this.bidValue,
      bottom: revealBottom ? this.bottomCards.slice() : [],
      winner: this.winnerSide,
      multiplier: this.multiplierValue,
      scores: [...this.scoreBoard],
    };
  }

  handOf(seatId: number): readonly Card[] {
    return this.hands[seatId] ?? [];
  }

  /** Read-only suggestions; the normal play path still owns validation and state changes. */
  hint(seatId: number): HintResult {
    if (this.phaseValue !== 'playing') return { ok: false, message: '当前不是出牌阶段', plays: [] };
    if (this.turnSeat !== seatId) return { ok: false, message: '还没轮到你出牌', plays: [] };
    const hand = this.hands[seatId] ?? [];
    if (hand.length === 0) return { ok: false, message: '你已经出完牌了', plays: [] };
    // A last play by this seat is the lead after a trick clear; treat it as a fresh lead.
    const last = this.lastPlayValue !== null && this.lastPlayValue.seatId !== seatId
      ? this.lastPlayKind
      : null;
    return { ok: true, plays: doudizhuHints(hand, last) };
  }

  /**
   * Turn-clock fallback: passing is always legal while following; a lead must play, so use the
   * first (cheapest, bomb-preserving) hint. Bidding times out as 不叫 rather than guessing a bid.
   */
  timeoutAction(seatId: number): TimeoutAction | null {
    if (this.phaseValue === 'bidding') {
      if (this.turnSeat !== seatId) return null;
      return { type: 'bid', payload: { value: 0 } };
    }
    if (this.phaseValue !== 'playing' || this.turnSeat !== seatId) return null;
    const following = this.lastPlayValue !== null && this.lastPlayValue.seatId !== seatId;
    if (following) return { type: 'pass', payload: {} };
    const hint = doudizhuHints(this.hands[seatId] ?? [], null)[0];
    if (!hint) return null;
    return { type: 'play', payload: { cards: hint.cards } };
  }

  passedAt(seatId: number): boolean {
    return this.passFlags[seatId] ?? false;
  }

  /** Every Doudizhu seat holds cards and is required while bidding or playing. */
  requiresConnection(_seatId: number): boolean {
    return this.phaseValue === 'bidding' || this.phaseValue === 'playing';
  }

  statusText(selfSeat: number | null, nameOf: (seatId: number) => string): string {
    if (this.phaseValue === 'bidding') {
      if (this.turnSeat === null) return '';
      return selfSeat === this.turnSeat ? '轮到你叫地主' : `等待 ${nameOf(this.turnSeat)} 叫地主`;
    }
    if (this.phaseValue === 'playing') {
      if (this.turnSeat === null) return '';
      const yours = selfSeat === this.turnSeat;
      if (this.lastPlayValue === null) return yours ? '轮到你出牌' : `等待 ${nameOf(this.turnSeat)} 出牌`;
      return yours ? '轮到你出牌或过牌' : `等待 ${nameOf(this.turnSeat)} 出牌`;
    }
    return this.winnerSide === 'landlord' ? '地主获胜' : '农民获胜';
  }

  /** Back to the lobby: hands and round history cleared, accumulated scores kept. */
  restart(): GameResult {
    if (this.phaseValue !== 'finished') return { ok: false, message: '本局尚未结束' };
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      this.hands[seat] = [];
      this.passFlags[seat] = false;
      this.bidCounts[seat] = 0;
      this.bidValues[seat] = 0;
      this.playCounts[seat] = 0;
    }
    this.phaseValue = 'lobby';
    this.bottomCards = [];
    this.landlordSeat = null;
    this.turnSeat = null;
    this.bidValue = 0;
    this.winnerSide = null;
    this.multiplierValue = 1;
    this.lastPlayValue = null;
    this.lastPlayKind = null;
    this.history = [];
    this.trickStartValue = 0;
    this.passCount = 0;
    return { ok: true };
  }

  // ---------------------------------------------------------------- rules

  private deal(): void {
    const deck = this.ctx.dealDeck?.() ?? shuffle(createDeck());
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      this.hands[seat] = sortHand(deck.slice(seat * HAND_SIZE, (seat + 1) * HAND_SIZE));
      this.bidCounts[seat] = 0;
      this.bidValues[seat] = 0;
      this.playCounts[seat] = 0;
      this.passFlags[seat] = false;
    }
    this.bottomCards = deck.slice(SEAT_COUNT * HAND_SIZE, SEAT_COUNT * HAND_SIZE + BOTTOM_SIZE);
    this.phaseValue = 'bidding';
    this.turnSeat = 0;
    this.bidValue = 0;
    this.landlordSeat = null;
    this.winnerSide = null;
    this.multiplierValue = 1;
    this.lastPlayValue = null;
    this.lastPlayKind = null;
    this.history = [];
    this.trickStartValue = 0;
    this.passCount = 0;
    this.ctx.onDeal?.(SEAT_COUNT, HAND_SIZE);
  }

  private bid(seatId: number, payload: Record<string, unknown>): GameResult {
    if (this.phaseValue !== 'bidding') return { ok: false, message: '当前不是叫地主阶段' };
    if (this.turnSeat !== seatId) return { ok: false, message: '还没轮到你叫地主' };
    const value = payload.value;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) {
      return { ok: false, message: '叫分值无效' };
    }
    if (value !== 0 && value <= this.bidValue) return { ok: false, message: '叫分必须高于当前分值' };

    this.bidCounts[seatId] = (this.bidCounts[seatId] ?? 0) + 1;
    this.bidValues[seatId] = value;
    if (value > this.bidValue) this.bidValue = value;
    if (value === 3) {
      this.finishBidding(seatId);
      return { ok: true };
    }

    const next = this.bidCounts.findIndex((count) => count === 0);
    if (next >= 0) {
      this.turnSeat = next;
      return { ok: true };
    }
    let best = 0;
    for (let seat = 1; seat < SEAT_COUNT; seat += 1) {
      const candidate = this.bidValues[seat] ?? 0;
      const current = this.bidValues[best] ?? 0;
      if (candidate > current || (candidate === current && seat < best)) best = seat;
    }
    if ((this.bidValues[best] ?? 0) === 0) {
      // Everyone passed: redeal and rebid with the same ready players.
      this.deal();
      return { ok: true };
    }
    this.bidValue = this.bidValues[best] ?? 0;
    this.finishBidding(best);
    return { ok: true };
  }

  private play(seatId: number, payload: Record<string, unknown>): GameResult {
    if (this.phaseValue !== 'playing') return { ok: false, message: '当前不是出牌阶段' };
    if (this.turnSeat !== seatId) return { ok: false, message: '还没轮到你出牌' };
    const ids = payload.cards;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((value) => typeof value === 'string')) {
      return { ok: false, message: '出牌数据无效' };
    }
    const uniqueIds = new Set(ids as string[]);
    if (uniqueIds.size !== ids.length) return { ok: false, message: '出牌数据重复' };
    const hand = this.hands[seatId] ?? [];
    const cards = hand.filter((card) => uniqueIds.has(card.id));
    if (cards.length !== ids.length) return { ok: false, message: '你没有这些牌' };

    const play = detectPlay(cards);
    if (!play) return { ok: false, message: '牌型不合法' };
    const follows = this.lastPlayValue !== null && this.lastPlayValue.seatId !== seatId;
    if (follows && !canBeat(play, this.lastPlayKind)) return { ok: false, message: '管不上上家的牌' };

    const played = sortHand(cards);
    this.hands[seatId] = hand.filter((card) => !uniqueIds.has(card.id));
    this.passFlags[seatId] = false;
    this.playCounts[seatId] = (this.playCounts[seatId] ?? 0) + 1;
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other !== seatId) this.passFlags[other] = false;
    }
    this.lastPlayValue = { seatId, cards: played, kind: play.kind };
    this.lastPlayKind = play;
    this.passCount = 0;
    if (play.bombs > 0) this.multiplierValue *= 2;

    // Validated play: recorded exactly once, before a winning play can finish the round.
    this.history.push(this.ctx.stampPlay(seatId, played, play.kind));

    if (this.hands[seatId]!.length === 0) {
      this.finishGame(seatId);
      return { ok: true };
    }
    this.turnSeat = (seatId + 1 + SEAT_COUNT) % SEAT_COUNT;
    return { ok: true };
  }

  private pass(seatId: number): GameResult {
    if (this.phaseValue !== 'playing') return { ok: false, message: '当前不是出牌阶段' };
    if (this.turnSeat !== seatId) return { ok: false, message: '还没轮到你出牌' };
    if (this.lastPlayValue === null) return { ok: false, message: '首出不能过牌' };
    this.passFlags[seatId] = true;
    this.passCount += 1;
    if (this.passCount >= SEAT_COUNT - 1) {
      const leader = this.lastPlayValue.seatId;
      this.lastPlayValue = null;
      this.lastPlayKind = null;
      this.passCount = 0;
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) this.passFlags[seat] = false;
      // The next play opens a fresh trick: everything before it is finished public history.
      this.trickStartValue = this.history.length;
      this.turnSeat = leader;
      return { ok: true };
    }
    this.turnSeat = (seatId + 1 + SEAT_COUNT) % SEAT_COUNT;
    return { ok: true };
  }

  private finishBidding(landlordSeat: number): void {
    this.landlordSeat = landlordSeat;
    this.hands[landlordSeat] = sortHand([...(this.hands[landlordSeat] ?? []), ...this.bottomCards]);
    this.phaseValue = 'playing';
    this.turnSeat = landlordSeat;
    this.lastPlayValue = null;
    this.lastPlayKind = null;
    this.passCount = 0;
  }

  private finishGame(seatId: number): void {
    const landlordSeat = this.landlordSeat ?? seatId;
    const winner: 'landlord' | 'farmers' = seatId === landlordSeat ? 'landlord' : 'farmers';
    if (winner === 'landlord') {
      const farmersSure = this.playCounts.every((count, seat) => seat === landlordSeat || count === 0);
      if (farmersSure) this.multiplierValue *= 2; // spring
    } else if ((this.playCounts[landlordSeat] ?? 0) === 1) {
      this.multiplierValue *= 2; // reverse spring
    }
    const delta = scoreGame({
      winner,
      landlord: landlordSeat,
      bid: Math.max(1, this.bidValue),
      multiplier: this.multiplierValue,
    });
    for (let seat = 0; seat < this.scoreBoard.length; seat += 1) {
      this.scoreBoard[seat] = (this.scoreBoard[seat] ?? 0) + (delta[seat] ?? 0);
    }
    this.winnerSide = winner;
    this.phaseValue = 'finished';
    this.turnSeat = null;
  }
}
