// Guandan engine: two full decks, 2→A match progression, tribute/return exchange and trick flow.
// The shared room owns identity, transport and authority; this engine owns one table's cards,
// legality, deal/trick/level progression, exchange escrow, public history and results.

import { randomInt } from 'node:crypto';
import type {
  Card,
  GuandanExchange,
  GuandanExchangePair,
  GuandanGameFields,
  GuandanPhase,
  GuandanPrivateAction,
  GuandanRoundResult,
  LastPlay,
  TablePlay,
  GuandanDeclaration,
} from '../../shared/protocol';
import {
  GUANDAN_LEVELS,
  canBeatGuandan,
  createGuandanDeck,
  enumerateGuandanPlays,
  guandanRankStrength,
  guandanReturnEligible,
  guandanTributeEligible,
  sortGuandanHand,
  strongestGuandanOption,
  type GuandanOption,
} from '../../shared/guandan';
import type { GameCommandType, GameContext, GameResult, HintResult, RoomGame, TimeoutAction } from './types';
import { guandanHints } from '../hints';

const SEAT_COUNT = 4;
const TEAM_COUNT = 2;
const HAND_SIZE = 27;

/** Raw rank of the 2: the first deal of every match is played at level 2. */
const LEVEL_TWO = 15;
/** Raw rank of A: the only level that can be passed, and the cap of every upgrade. */
const LEVEL_ACE = 14;
const BIG_JOKER = 17;

/** The opposite seat, i.e. the fixed partner of a two-against-two match. */
function partnerOf(seat: number): number {
  return (seat + 2) % SEAT_COUNT;
}

/** Teams are seat parity: 0+2 against 1+3. */
function teamOf(seat: number): 0 | 1 {
  return seat % TEAM_COUNT === 0 ? 0 : 1;
}

/** Advance one team's level by an upgrade, capped at A: reaching A is not passing A. */
function advanceLevel(level: number, upgrade: number): number {
  const index = Math.max(0, GUANDAN_LEVELS.indexOf(level));
  return GUANDAN_LEVELS[Math.min(index + upgrade, GUANDAN_LEVELS.length - 1)];
}

/** Fisher-Yates over the 108 physical cards using the platform CSPRNG. */
function shuffleDeck(deck: Card[]): Card[] {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const swap = deck[i];
    deck[i] = deck[j];
    deck[j] = swap;
  }
  return deck;
}

function countBigJokers(hand: readonly Card[]): number {
  let total = 0;
  for (const card of hand) {
    if (card.rank === BIG_JOKER) total += 1;
  }
  return total;
}

function emptyExchange(): GuandanExchange {
  return { stage: 'none', givers: [], submitted: [], pairs: [], leader: null };
}

export class GuandanGame implements RoomGame {
  readonly kind = 'guandan' as const;
  readonly seatCount = 4 as const;

  /** Internal state for trusted server and test fixtures after `instanceof` narrowing. */
  readonly hands: Card[][] = [[], [], [], []];
  /** Per-team levels as raw ranks (15 === 2 … 14 === A); a team is `seat % 2`. */
  readonly levels: [number, number] = [LEVEL_TWO, LEVEL_TWO];
  /** Level of the deal in play, i.e. the level the previous deal's winner reached. */
  playedLevel = LEVEL_TWO;
  /** 1-based deal number inside the current match; reset only by a rematch. */
  deal = 0;
  /** Result of the most recent finished deal; it feeds the next deal's tribute and is kept. */
  result: GuandanRoundResult | null = null;
  matchWinner: 0 | 1 | null = null;
  /** Tribute/return bookkeeping of the deal in play; public shape, private faces. */
  exchange: GuandanExchange = emptyExchange();
  /** Seats that actually emptied their hand this deal, in finishing order. */
  finishOrder: number[] = [];

  private readonly ctx: GameContext;
  private phaseValue: GuandanPhase = 'lobby';
  private turnSeat: number | null = null;
  private lastPlayValue: LastPlay | null = null;
  private history: TablePlay[] = [];
  /** Server-only trick context: a seat can be visited twice before it borrows the lead. */
  private playLeads: boolean[] = [];
  private trickStartValue = 0;
  private readonly passFlags = [false, false, false, false];
  private passCount = 0;
  /** Card each giver committed this deal; never leaves the engine before the reveal. */
  private readonly tributeCards = new Map<number, Card>();
  /** Card each receiver committed; revealed only when every return is in. */
  private readonly returnCards = new Map<number, Card>();
  /** Previous deal's head (上游) and its partner, the two tribute receivers. */
  private headSeat: number | null = null;
  private partnerSeat: number | null = null;
  /** Leader of the deal in play when no exchange decides it (first deal, or 抗贡). */
  private dealLeader = 0;
  /**
   * Read-only deal-start facts for the automation replay bridge, captured at the exact moment
   * this deal's playing phase opens: the four hands after all tribute/return transfers, the
   * leading seat and the `history` index where this deal's rows begin. Null in the lobby and
   * during an exchange; never used by engine rules, only by server-side robots.
   */
  dealSeed: {
    hands: Card[][];
    leader: number;
    playStart: number;
    playedLevel: number;
    teamLevels: [number, number];
  } | null = null;

  private captureDealSeed(leader: number): void {
    this.dealSeed = {
      hands: this.hands.map((hand) => hand.slice()),
      leader,
      playStart: this.history.length,
      playedLevel: this.playedLevel,
      teamLevels: [this.levels[0], this.levels[1]],
    };
  }

  constructor(ctx: GameContext) {
    this.ctx = ctx;
  }

  get phase(): GuandanPhase {
    return this.phaseValue;
  }

  /** The accepted declaration survives trick clearing and deal settlement for command collection. */
  get lastAcceptedClaim(): GuandanDeclaration | null {
    return this.history.at(-1)?.claim ?? null;
  }

  /** Deal the first deal of the match; the room has already passed its start gate. */
  start(): void {
    if (this.phaseValue !== 'lobby') return;
    this.deal += 1;
    const previous = this.result;
    this.playedLevel = previous === null ? LEVEL_TWO : this.levels[previous.winnerTeam];
    this.dealCards();
    this.history = [];
    this.playLeads = [];
    this.trickStartValue = 0;
    this.lastPlayValue = null;
    this.passFlags.fill(false);
    this.passCount = 0;
    this.finishOrder = [];
    this.dealLeader = previous === null ? this.ctx.firstSeat ?? randomInt(SEAT_COUNT) : previous.order[0];
    this.beginExchange();
    this.ctx.onDeal?.(SEAT_COUNT, HAND_SIZE);
  }

  /**
   * Open this deal's exchange from the previous deal's result and the current hands.
   * Called by `start()` right after dealing; re-runnable by the trusted server and by test
   * fixtures that place hands directly.
   */
  beginExchange(): void {
    this.tributeCards.clear();
    this.returnCards.clear();
    this.exchange = emptyExchange();
    this.lastPlayValue = null;
    this.passFlags.fill(false);
    this.passCount = 0;
    const previous = this.result;
    if (previous === null) {
      // First deal of the match: nothing is owed, one uniform random seat leads.
      this.phaseValue = 'playing';
      this.turnSeat = this.dealLeader;
      this.captureDealSeed(this.dealLeader);
      return;
    }
    const head = previous.order[0];
    this.headSeat = head;
    this.partnerSeat = partnerOf(head);
    const givers = previous.doubleDown
      ? [0, 1, 2, 3].filter((seat) => seat !== head && seat !== this.partnerSeat)
      : [previous.order[previous.order.length - 1]];
    // 抗贡: the losing side holds both big jokers, so nothing is exchanged and the head leads.
    let bigJokers = 0;
    for (const seat of givers) bigJokers += countBigJokers(this.hands[seat]);
    if (bigJokers >= 2) {
      this.exchange = { stage: 'resisted', givers, submitted: [], pairs: [], leader: head };
      this.phaseValue = 'playing';
      this.turnSeat = head;
      this.captureDealSeed(head);
      return;
    }
    this.exchange = { stage: 'tribute', givers, submitted: [], pairs: [], leader: null };
    this.phaseValue = 'tribute';
    this.turnSeat = null;
  }

  command(seatId: number, type: GameCommandType, payload: Record<string, unknown>): GameResult {
    switch (type) {
      case 'tribute':
        return this.tribute(seatId, payload);
      case 'returnTribute':
        return this.returnTribute(seatId, payload);
      case 'play':
        return this.play(seatId, payload);
      case 'pass':
        return this.pass(seatId);
      default:
        // Guandan owns no bid; anything else is not a Guandan action.
        return { ok: false, message: '未知的操作类型' };
    }
  }

  view(selfSeat: number | null): GuandanGameFields {
    return {
      game: 'guandan',
      phase: this.phaseValue,
      turn: this.turnSeat,
      lastPlay: this.lastPlayValue === null ? null : {
        seatId: this.lastPlayValue.seatId,
        cards: this.lastPlayValue.cards.slice(),
        kind: this.lastPlayValue.kind,
        ...(this.lastPlayValue.claim ? { claim: this.lastPlayValue.claim } : {}),
      },
      tablePlays: this.history.slice(),
      trickStartIndex: this.trickStartValue,
      guandan: {
        deal: this.deal,
        levels: [this.levels[0], this.levels[1]],
        playedLevel: this.playedLevel,
        finishOrder: this.finishOrder.slice(),
        result: this.result,
        matchWinner: this.matchWinner,
        exchange: this.copyExchange(),
      },
      privateAction: this.privateActionFor(selfSeat),
    };
  }

  handOf(seatId: number): readonly Card[] {
    return this.hands[seatId] ?? [];
  }

  /** Read-only suggestions; the play path recomputes every declaration before accepting one. */
  hint(seatId: number): HintResult {
    if (this.phaseValue !== 'playing') return { ok: false, message: '当前不是出牌阶段', plays: [] };
    if (this.turnSeat !== seatId) return { ok: false, message: '还没轮到你出牌', plays: [] };
    const hand = this.hands[seatId] ?? [];
    if (hand.length === 0) return { ok: false, message: '你已经出完牌了', plays: [] };
    const last = this.lastPlayValue !== null && this.lastPlayValue.seatId !== seatId
      ? this.lastPlayValue.claim ?? null
      : null;
    return { ok: true, plays: guandanHints(hand, this.playedLevel, last) };
  }

  /**
   * Turn-clock fallback. During the exchange, hand over the weakest eligible card (the tribute
   * rule already limits the choice to the required strength). While playing, pass when following;
   * a lead plays the first hint with its declaration key.
   */
  timeoutAction(seatId: number): TimeoutAction | null {
    if (this.phaseValue === 'tribute') {
      const action = this.privateActionFor(seatId);
      if (!action || action.committed !== null) return null;
      const eligible = new Set(action.eligibleIds);
      let weakest: Card | null = null;
      for (const card of this.hands[seatId] ?? []) {
        if (!eligible.has(card.id)) continue;
        if (
          weakest === null ||
          guandanRankStrength(card.rank, this.playedLevel) <
            guandanRankStrength(weakest.rank, this.playedLevel)
        ) {
          weakest = card;
        }
      }
      if (weakest === null) return null;
      return {
        type: action.kind === 'tribute' ? 'tribute' : 'returnTribute',
        payload: { cardId: weakest.id },
      };
    }
    if (this.phaseValue !== 'playing' || this.turnSeat !== seatId) return null;
    const following = this.lastPlayValue !== null && this.lastPlayValue.seatId !== seatId;
    if (following) return { type: 'pass', payload: {} };
    const hint = guandanHints(this.hands[seatId] ?? [], this.playedLevel, null)[0];
    if (!hint) return null;
    return {
      type: 'play',
      payload: {
        cards: hint.cards,
        ...(hint.claim ? { claim: hint.claim } : {}),
      },
    };
  }

  /** Accepted plays with the context needed to replay passes without guessing trick boundaries. */
  replayRows(): { seat: number; cards: readonly Card[]; claim: GuandanDeclaration; leading?: boolean }[] {
    return this.history.map((row, index) => ({
      seat: row.seatId,
      cards: row.cards,
      claim: row.claim!,
      // Undefined only for a deal already in memory when this fix was installed.
      leading: this.playLeads?.[index],
    }));
  }

  passedAt(seatId: number): boolean {
    return this.passFlags[seatId] ?? false;
  }

  /** Every seat still holding cards during the exchange or play must stay connected. */
  requiresConnection(seatId: number): boolean {
    if (this.phaseValue !== 'tribute' && this.phaseValue !== 'playing') return false;
    return (this.hands[seatId] ?? []).length > 0;
  }

  statusText(selfSeat: number | null, nameOf: (seatId: number) => string): string {
    if (this.phaseValue === 'tribute') {
      if (this.exchange.stage === 'tribute') {
        const mine = selfSeat !== null && this.exchange.givers.includes(selfSeat);
        if (!mine) return '等待进贡';
        return this.tributeCards.has(selfSeat) ? '已进贡，等待对手' : '请选择进贡的牌';
      }
      if (this.exchange.stage === 'return') {
        const mine = selfSeat !== null && this.exchange.pairs.some((pair) => pair.receiver === selfSeat);
        if (!mine) return '等待还贡';
        return this.returnCards.has(selfSeat) ? '已还贡，等待对手' : '请选择还贡的牌';
      }
      return '';
    }
    if (this.phaseValue === 'playing') {
      if (this.turnSeat === null) return '';
      const yours = selfSeat === this.turnSeat;
      if (this.exchange.stage === 'resisted') {
        return yours ? '对方抗贡，轮到你出牌' : `等待 ${nameOf(this.turnSeat)} 出牌`;
      }
      if (this.lastPlayValue === null) return yours ? '轮到你出牌' : `等待 ${nameOf(this.turnSeat)} 出牌`;
      return yours ? '轮到你出牌或过牌' : `等待 ${nameOf(this.turnSeat)} 出牌`;
    }
    if (this.phaseValue === 'finished') {
      if (this.matchWinner === null) return '本副结束，等待房主开始下一副';
      return `${this.matchWinner === 0 ? '0、2' : '1、3'} 号位一方过 A 获胜`;
    }
    return '';
  }

  /**
   * Next deal (host 下一副) or rematch (host 再来一场). Hands and the deal's public history are
   * cleared; both teams' levels and the previous round result are kept so the next deal can be
   * played for tribute. A rematch also resets levels to 2 and drops the previous result.
   */
  restart(): GameResult {
    if (this.phaseValue !== 'finished') return { ok: false, message: '本副尚未结束' };
    if (this.matchWinner !== null) {
      this.levels[0] = LEVEL_TWO;
      this.levels[1] = LEVEL_TWO;
      this.playedLevel = LEVEL_TWO;
      this.result = null;
      this.matchWinner = null;
      this.deal = 0;
    }
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      this.hands[seat] = [];
      this.passFlags[seat] = false;
    }
    this.finishOrder = [];
    this.history = [];
    this.playLeads = [];
    this.trickStartValue = 0;
    this.lastPlayValue = null;
    this.passCount = 0;
    this.turnSeat = null;
    this.exchange = emptyExchange();
    this.tributeCards.clear();
    this.returnCards.clear();
    this.headSeat = null;
    this.partnerSeat = null;
    this.dealLeader = 0;
    this.phaseValue = 'lobby';
    return { ok: true };
  }

  // --------------------------------------------------------------- exchange

  /**
   * Commit one tribute card. The force is `max(hand \ heart level cards)`, but ties in rank are the
   * player's strategic choice, so the engine never picks for them; it only validates.
   */
  private tribute(seatId: number, payload: Record<string, unknown>): GameResult {
    if (this.phaseValue !== 'tribute' || this.exchange.stage !== 'tribute') {
      return { ok: false, message: '当前不是进贡阶段' };
    }
    if (!this.exchange.givers.includes(seatId)) return { ok: false, message: '这一副你不需要进贡' };
    if (this.tributeCards.has(seatId)) return { ok: false, message: '你已经进贡过了' };
    const cardId = payload.cardId;
    if (typeof cardId !== 'string') return { ok: false, message: '请选择进贡的牌' };
    const eligible = guandanTributeEligible(this.hands[seatId] ?? [], this.playedLevel);
    const card = eligible.find((candidate) => candidate.id === cardId);
    if (!card) return { ok: false, message: '进贡必须是手中最大的牌（红心级牌除外）' };

    this.tributeCards.set(seatId, card);
    this.exchange.submitted.push(seatId);
    if (this.exchange.submitted.length === this.exchange.givers.length) this.resolveTribute();
    return { ok: true };
  }

  /** Every giver is in: pair the cards, hand them over and open the return stage. */
  private resolveTribute(): void {
    const head = this.headSeat ?? this.exchange.givers[0];
    const partner = this.partnerSeat ?? partnerOf(head);
    const givers = this.exchange.givers;
    const committed: { seat: number; card: Card }[] = [];
    for (const seat of givers) {
      const card = this.tributeCards.get(seat);
      if (card !== undefined) committed.push({ seat, card });
    }
    const first = committed[0];
    let toHead = first;
    let toPartner = first;
    if (committed.length > 1) {
      const second = committed[1];
      const firstStrength = guandanRankStrength(first.card.rank, this.playedLevel);
      const secondStrength = guandanRankStrength(second.card.rank, this.playedLevel);
      if (firstStrength === secondStrength) {
        // Equal rank: the head's next seat (its right) hands to the head and leads the first trick.
        toHead = first.seat === (head + 1) % SEAT_COUNT ? first : second;
      } else {
        toHead = firstStrength > secondStrength ? first : second;
      }
      toPartner = toHead === first ? second : first;
    }

    const ordered = committed.length > 1
      ? [{ ...toHead, receiver: head }, { ...toPartner, receiver: partner }]
      : [{ ...toHead, receiver: head }];
    const pairs: GuandanExchangePair[] = [];
    for (const entry of ordered) {
      this.moveCard(entry.seat, entry.receiver, entry.card);
      pairs.push({ giver: entry.seat, receiver: entry.receiver, tribute: entry.card, returned: null });
    }
    this.tributeCards.clear();
    this.exchange = { stage: 'return', givers, submitted: [], pairs, leader: null };
  }

  /**
   * Commit one return card. Eligibility is `strength <= 10` in rank order (so level cards, which
   * rank above A, are out); when the whole hand is stronger than 10 the minimum ties are used.
   * Which eligible card is handed back is the receiver's decision.
   */
  private returnTribute(seatId: number, payload: Record<string, unknown>): GameResult {
    if (this.phaseValue !== 'tribute' || this.exchange.stage !== 'return') {
      return { ok: false, message: '当前不是还贡阶段' };
    }
    if (!this.exchange.pairs.some((pair) => pair.receiver === seatId)) {
      return { ok: false, message: '这一副你不需要还贡' };
    }
    if (this.returnCards.has(seatId)) return { ok: false, message: '你已经还贡过了' };
    const cardId = payload.cardId;
    if (typeof cardId !== 'string') return { ok: false, message: '请选择还贡的牌' };
    const eligible = guandanReturnEligible(this.hands[seatId] ?? [], this.playedLevel);
    const card = eligible.find((candidate) => candidate.id === cardId);
    if (!card) return { ok: false, message: '还贡必须是10以下的牌（没有则还最小牌）' };

    this.returnCards.set(seatId, card);
    this.exchange.submitted.push(seatId);
    if (this.exchange.submitted.length === this.exchange.pairs.length) {
      const returns: { pair: GuandanExchangePair; card: Card }[] = [];
      for (const pair of this.exchange.pairs) {
        const committed = this.returnCards.get(pair.receiver);
        if (committed !== undefined) returns.push({ pair, card: committed });
      }
      this.resolveReturn(returns);
    }
    return { ok: true };
  }

  /** Every return is in: reveal them together, hand them back and start the deal. */
  private resolveReturn(returns: { pair: GuandanExchangePair; card: Card }[]): void {
    const pairs = this.exchange.pairs;
    for (const entry of returns) {
      entry.pair.returned = entry.card;
      this.moveCard(entry.pair.receiver, entry.pair.giver, entry.card);
    }
    const head = this.headSeat ?? pairs[0].receiver;
    const headPair = pairs.find((pair) => pair.receiver === head) ?? pairs[0];
    const leader = headPair.giver;
    this.returnCards.clear();
    this.exchange = { stage: 'complete', givers: this.exchange.givers.slice(), submitted: [], pairs, leader };
    this.phaseValue = 'playing';
    this.turnSeat = leader;
    this.captureDealSeed(leader);
    this.lastPlayValue = null;
    this.trickStartValue = this.history.length;
  }

  /** One physical card changes hands; the receiver's hand keeps its display order. */
  private moveCard(from: number, to: number, card: Card): void {
    this.hands[from] = (this.hands[from] ?? []).filter((candidate) => candidate.id !== card.id);
    this.hands[to] = sortGuandanHand([...(this.hands[to] ?? []), card], this.playedLevel);
  }

  private copyExchange(): GuandanExchange {
    return {
      stage: this.exchange.stage,
      givers: this.exchange.givers.slice(),
      submitted: this.exchange.submitted.slice(),
      pairs: this.exchange.pairs.map((pair) => ({ ...pair })),
      leader: this.exchange.leader,
    };
  }

  /** Eligible ids and the own committed card, for exactly one seat, only while it is their turn. */
  private privateActionFor(seat: number | null): GuandanPrivateAction | null {
    if (seat === null || seat < 0 || seat >= SEAT_COUNT) return null;
    if (this.phaseValue !== 'tribute') return null;
    if (this.exchange.stage === 'tribute') {
      if (!this.exchange.givers.includes(seat)) return null;
      return {
        kind: 'tribute',
        eligibleIds: guandanTributeEligible(this.hands[seat] ?? [], this.playedLevel).map((card) => card.id),
        committed: this.tributeCards.get(seat) ?? null,
      };
    }
    if (this.exchange.stage === 'return') {
      if (!this.exchange.pairs.some((pair) => pair.receiver === seat)) return null;
      return {
        kind: 'return',
        eligibleIds: guandanReturnEligible(this.hands[seat] ?? [], this.playedLevel).map((card) => card.id),
        committed: this.returnCards.get(seat) ?? null,
      };
    }
    return null;
  }

  // ------------------------------------------------------------------- play

  /**
   * Play a selection. The wire carries the raw physical ids plus the claim key; the engine
   * recomputes every reading of that selection from the shared rule module and never trusts a
   * client-supplied strength. Without an explicit claim, the strongest legal reading is selected.
   */
  private play(seatId: number, payload: Record<string, unknown>): GameResult {
    if (this.phaseValue !== 'playing') return { ok: false, message: '当前不是出牌阶段' };
    if (this.turnSeat !== seatId) return { ok: false, message: '还没轮到你出牌' };
    const hand = this.hands[seatId] ?? [];
    if (hand.length === 0) return { ok: false, message: '你已经出完牌了' };
    const ids = payload.cards;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((value) => typeof value === 'string')) {
      return { ok: false, message: '出牌数据无效' };
    }
    const uniqueIds = new Set(ids as string[]);
    if (uniqueIds.size !== ids.length) return { ok: false, message: '出牌数据重复' };
    const cards = hand.filter((card) => uniqueIds.has(card.id));
    if (cards.length !== ids.length) return { ok: false, message: '你没有这些牌' };

    const options = enumerateGuandanPlays(cards, this.playedLevel);
    if (options.length === 0) return { ok: false, message: '牌型不合法' };
    const claimKey = payload.claim;
    if (claimKey !== undefined && typeof claimKey !== 'string') {
      return { ok: false, message: '牌型说明无效' };
    }
    let chosen: GuandanOption | null = null;
    if (claimKey === undefined) {
      chosen = strongestGuandanOption(options, this.playedLevel, this.lastPlayValue?.claim ?? null);
      if (chosen === null) return { ok: false, message: '管不上上家' };
    } else {
      chosen = options.find((option) => option.declaration.key === claimKey) ?? null;
      if (chosen === null) return { ok: false, message: '选择的牌型与牌张不符' };
    }
    if (this.lastPlayValue !== null) {
      const previous = this.lastPlayValue.claim;
      if (!previous || !canBeatGuandan(chosen.declaration, previous, this.playedLevel)) {
        return { ok: false, message: '管不上上家' };
      }
    }

    this.hands[seatId] = hand.filter((card) => !uniqueIds.has(card.id));
    this.passFlags[seatId] = false;
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other !== seatId) this.passFlags[other] = false;
    }
    (this.playLeads ??= [])[this.history.length] = this.lastPlayValue === null;
    this.lastPlayValue = {
      seatId,
      cards: chosen.cards,
      kind: chosen.declaration.label,
      claim: chosen.declaration,
    };
    this.passCount = 0;
    // Accepted play: stamped exactly once, before a finishing play can end the deal.
    this.history.push(this.ctx.stampPlay(seatId, chosen.cards, chosen.declaration.label, chosen.declaration));
    if ((this.hands[seatId] ?? []).length === 0) this.finishOrder.push(seatId);

    if (!this.settleDeal()) this.turnSeat = this.nextActiveSeat(seatId);
    return { ok: true };
  }

  private pass(seatId: number): GameResult {
    if (this.phaseValue !== 'playing') return { ok: false, message: '当前不是出牌阶段' };
    if (this.turnSeat !== seatId) return { ok: false, message: '还没轮到你出牌' };
    if ((this.hands[seatId] ?? []).length === 0) return { ok: false, message: '你已经出完牌了' };
    if (this.lastPlayValue === null) return { ok: false, message: '领出牌不能过' };

    this.passFlags[seatId] = true;
    this.passCount += 1;
    if (this.passCount >= this.passThreshold()) {
      this.clearTrick();
      return { ok: true };
    }
    this.turnSeat = this.nextActiveSeat(seatId);
    return { ok: true };
  }

  /**
   * How many consecutive passes clear the trick: every other seat still holding cards, plus the
   * last actor itself when it has already finished (then the lead is borrowed by its partner).
   */
  private passThreshold(): number {
    let active = 0;
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      if ((this.hands[seat] ?? []).length > 0) active += 1;
    }
    const actor = this.lastPlayValue?.seatId ?? -1;
    const actorActive = actor >= 0 && (this.hands[actor] ?? []).length > 0;
    return Math.max(1, active - (actorActive ? 1 : 0));
  }

  /** Trick cleared: the last actor leads again, or its partner borrows the lead (对家接风). */
  private clearTrick(): void {
    const actor = this.lastPlayValue?.seatId ?? this.turnSeat ?? 0;
    this.lastPlayValue = null;
    this.passFlags.fill(false);
    this.passCount = 0;
    this.trickStartValue = this.history.length;
    const partner = partnerOf(actor);
    if ((this.hands[actor] ?? []).length > 0) this.turnSeat = actor;
    else if ((this.hands[partner] ?? []).length > 0) this.turnSeat = partner;
    else this.turnSeat = this.nextActiveSeat(actor);
  }

  private nextActiveSeat(from: number): number {
    for (let step = 1; step <= SEAT_COUNT; step += 1) {
      const seat = (from + step) % SEAT_COUNT;
      if ((this.hands[seat] ?? []).length > 0) return seat;
    }
    return from;
  }

  /**
   * End the deal as soon as one team owns the first two places (双下), otherwise when the third
   * player empties. The last seat still holding cards is the 下游.
   */
  private settleDeal(): boolean {
    const first = this.finishOrder[0];
    const second = this.finishOrder[1];
    if (first !== undefined && second !== undefined && teamOf(first) === teamOf(second)) {
      this.endDeal(true);
      return true;
    }
    if (this.finishOrder.length >= 3) {
      this.endDeal(false);
      return true;
    }
    return false;
  }

  private endDeal(doubleDown: boolean): void {
    const order = doubleDown
      ? [this.finishOrder[0], this.finishOrder[1]]
      : [this.finishOrder[0], this.finishOrder[1], this.finishOrder[2], this.remainingSeat()];
    const head = order[0];
    const winnerTeam = teamOf(head);
    const partnerIndex = order.indexOf(partnerOf(head));
    const upgrade = (partnerIndex === 1 ? 3 : partnerIndex === 2 ? 2 : 1) as 1 | 2 | 3;
    const levelsBefore: [number, number] = [this.levels[0], this.levels[1]];
    const levelsAfter: [number, number] = [levelsBefore[0], levelsBefore[1]];
    levelsAfter[winnerTeam] = advanceLevel(levelsBefore[winnerTeam], upgrade);
    // Passing A requires the deal to have been played at A by a team already at A, with the
    // partner second or third; reaching A is not enough, and a failed A never demotes.
    const passedAce = this.playedLevel === LEVEL_ACE
      && levelsBefore[winnerTeam] === LEVEL_ACE
      && partnerIndex <= 2;

    this.levels[0] = levelsAfter[0];
    this.levels[1] = levelsAfter[1];
    this.result = { order, doubleDown, winnerTeam, upgrade, levelsBefore, levelsAfter };
    this.matchWinner = passedAce ? winnerTeam : null;
    this.phaseValue = 'finished';
    this.turnSeat = null;
    this.lastPlayValue = null;
    this.passFlags.fill(false);
    this.passCount = 0;
    this.exchange = emptyExchange();
    this.tributeCards.clear();
    this.returnCards.clear();
    this.headSeat = null;
    this.partnerSeat = null;
    this.dealSeed = null;
  }

  private remainingSeat(): number {
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      if ((this.hands[seat] ?? []).length > 0) return seat;
    }
    return this.finishOrder[this.finishOrder.length - 1];
  }

  private dealCards(): void {
    const deck = this.ctx.dealDeck?.() ?? shuffleDeck(createGuandanDeck());
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      this.hands[seat] = sortGuandanHand(
        deck.slice(seat * HAND_SIZE, (seat + 1) * HAND_SIZE),
        this.playedLevel,
      );
    }
  }
}
