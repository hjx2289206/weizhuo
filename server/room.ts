// In-memory room: shared authority for one table of any supported game.
//
// The room owns identity/roster/host rights/approvals/expiry and the exact-private-hand slot; the
// game engine owns cards, phases, turn order, legality, results and public play history. This file
// never contains a rule of a specific game, and the engine never sees a peer, socket or token.

import { randomBytes } from 'node:crypto';
import { supportsRoomMode, isBlackFirstGame, isBoardGame, GAME_DEFINITIONS } from '../shared/gameCatalog';
import { dealDuration } from '../shared/dealAnimation';
import {
  BOARD_CLOCK_PRESETS, boardClockBudget, boardClockOptions, initialBoardClockTime, spendBoardClock,
  type BoardClockPreset, type BoardClockSide, type BoardClockTime, type BoardClockView,
} from '../shared/boardClock';
import type {
  Card,
  DoudizhuGameFields,
  ErrorCode,
  GameKind,
  GameView,
  GuandanGameFields,
  Phase,
  PhraseMessage,
  Position,
  RoomAutomation,
  RoomMode,
  RoomRole,
  RoomSnapshotFields,
  RoomSummary,
  Seat,
  SeatRequest,
  ServerMessage,
  Snapshot,
} from '../shared/protocol';
import { guandanRankStrength } from '../shared/guandan';
import { quickPhrase } from '../shared/phrases';
import { douZeroPolicy, type DouZeroPolicy, type DouZeroState } from './bots/douzero';
import {
  defaultGuandanAgent,
  guandanPolicy,
  type GuandanAgentKey,
  type GuandanPolicy,
  type GuandanTurnInput,
} from './bots/guandan';
import { guandanCollector } from './collect/collector';
import { DoudizhuGame } from './games/doudizhu';
import { JunqiGame } from './games/junqi';
import { XiangqiGame } from './games/xiangqi';
import { ChessGame } from './games/chess';
import { StoneGame } from './games/stones';
import { ReversiGame } from './games/reversi';
import { stoneSideName } from '../shared/stones';
import { BOARD_AI_DIFFICULTIES, boardAiLabel, isBoardAiDifficulty, isBoardAiGame, type BoardAiConfig } from '../shared/boardAi';
import { boardUndoTarget, type BoardUndoSide } from '../shared/boardUndo';
import { analysisRecord, isAnalyzableView, type AnalyzableView, type AnalysisPosition, type BoardAnalysisResult } from '../shared/boardAnalysis';
import { boardAnalysisPolicy, type BoardAnalysisPolicy } from './bots/boardAnalysis';
import { boardAiPolicy, type BoardAiPolicy } from './bots/boardAi';
import { BOARD_AI_ADAPTERS, boardAiContext } from './bots/boardAiAdapters';
import { GuandanGame } from './games/guandan';
import { createPlayStamper } from './games/playLog';
import type { GameCommandType, GameContext, RoomGame } from './games/types';

const MAX_REMEMBERED_ACTIONS = 256;
const MAX_REMEMBERED_REQUESTS = 64;
const MAX_SPECTATORS = 8;
const ANALYSIS_PROGRESS_MS = 500;

interface PendingBoardAnalysis {
  roundId: string;
  controller: AbortController;
  positions: AnalysisPosition[];
  lastPublishedAt: number;
}

/** Retain the server's single slot until the policy has closed its engine session. */
let activeBoardAnalysis: PendingBoardAnalysis | null = null;
/** The separator is outside the alphabet of player and table credentials. */
const SPECTATOR_PREFIX = 'spectator:';

/** Bot action cadence: a visible, cancellable gap between two automatic actions. */
const AUTOMATION_INTERVAL_MS = 600;
/** Guandan keeps a short readable pause without adding 600ms to every model call. */
const GUANDAN_AUTOMATION_INTERVAL_MS = 250;
/** Hard cap on one inference round trip before the room gives up and reports it. */
const AUTOMATION_TIMEOUT_MS = 20_000;
/** Quick phrases are human-paced; this only suppresses accidental double taps. */
const PHRASE_COOLDOWN_MS = 900;

/** One socket owns one identity: a bound connection returns to the hall before taking another. */
const BOUND_ELSEWHERE = '你已经在一个房间里，请先返回大厅';

const ENGINE_FACTORIES: Record<GameKind, (context: GameContext) => RoomGame> = {
  doudizhu: (context) => new DoudizhuGame(context),
  guandan: (context) => new GuandanGame(context),
  xiangqi: () => new XiangqiGame(),
  go: () => new StoneGame('go'),
  gomoku: () => new StoneGame('gomoku'),
  reversi: () => new ReversiGame(),
  chess: () => new ChessGame(),
  junqi: () => new JunqiGame(),
};

const TWO_SEATS: readonly Position[] = [{ x: .5, y: .88, angle: 0 }, { x: .5, y: .12, angle: 180 }];

/**
 * Canonical phone seats per game, in seat order, following the table convention
 * (bottom 0deg, left 90deg, top 180deg, right -90deg): Doudizhu bottom/left/right,
 * Guandan bottom/right/top/left so that next=right and partner=opposite.
 */
const PHONE_SEATS: Record<GameKind, readonly Position[]> = {
  chess: TWO_SEATS,
  go: TWO_SEATS,
  gomoku: TWO_SEATS,
  reversi: TWO_SEATS,
  xiangqi: TWO_SEATS,
  junqi: TWO_SEATS,
  doudizhu: [
    { x: 0.5, y: 0.88, angle: 0 },
    { x: 0.1, y: 0.5, angle: 90 },
    { x: 0.9, y: 0.5, angle: -90 },
  ],
  guandan: [
    { x: 0.5, y: 0.88, angle: 0 },
    { x: 0.9, y: 0.5, angle: -90 },
    { x: 0.5, y: 0.12, angle: 180 },
    { x: 0.1, y: 0.5, angle: 90 },
  ],
};

/** Chinese seat words so the start refusal reads naturally for three and four seats. */
const SEAT_WORDS: Record<2 | 3 | 4, string> = { 2: '两', 3: '三', 4: '四' };

/** Transport-agnostic connection handle owned by the socket layer. */
export interface Peer {
  id: string;
  role: RoomRole;
  seatId: number | null;
  token: string | null;
  /** Room this peer is bound to; set by the bind* methods below. */
  room: Room | null;
  /**
   * Room holding this still-unbound connection's pending seat request, so the socket layer can
   * cancel the request when the socket closes. Null for bound peers and idle waiters.
   */
  requestRoom: Room | null;
  send(message: ServerMessage): void;
  /** Close the underlying socket when a fresher connection resumes the same identity. */
  supersede(): void;
}

/** Roster/identity/automation only: cards and per-seat play state belong to the game engine. */
interface Player {
  seatId: number;
  name: string;
  token: string;
  ready: boolean;
  connected: boolean;
  peer: Peer | null;
  /** Host-added DouZero robot: no socket, and never granted host rights. */
  isBot: boolean;
  /** Played automatically by Room: a bot, or a human who opted into 托管 themselves. */
  autoPlay: boolean;
  /** Guandan bots only: which DanLM bundle plays this seat (strong transformer or the small ONNX). */
  botAgent?: GuandanAgentKey;
  /** Both games: the difficulty tier the host chose for this robot. */
  botStrength?: 'strong' | 'easy';
}

interface Spectator {
  peer: Peer | null;
  lastPhraseAt: number;
}

/** One scheduled or in-flight automatic action; the room keeps at most one at a time. */
interface PendingDecision {
  seatId: number;
  /** Room automation generation when this decision was authorised. */
  generation: number;
  phase: 'bidding' | 'playing' | 'tribute';
  turn: number | null;
  version: number;
  historyLength: number;
  trickStartIndex: number;
  handSignature: string;
  token: string;
  /** Guandan exchange decisions only: which owed card this seat still owes. */
  tributeKind?: 'tribute' | 'return';
  eligibleSignature?: string;
  timer: NodeJS.Timeout | undefined;
  guard: NodeJS.Timeout | undefined;
  controller: AbortController | null;
}

interface PendingBoardAi {
  controller: AbortController;
  timer?: NodeJS.Timeout;
  guard?: NodeJS.Timeout;
  roundId: string;
  ply: number;
  side: 0 | 1;
  epoch: number;
  difficulty: BoardAiConfig['difficulty'];
}

/** One open replacement request; kept after the decision so repeats stay idempotent. */
/** One human decision covered by the host's turn clock. */
interface TurnTimerTarget {
  seatId: number;
  kind: 'bid' | 'play' | 'tribute' | 'return';
  /** Credential of the occupant: a seat takeover starts a fresh clock. */
  token: string;
  /** Guandan exchange choices only: exact eligible set, so a hand change re-arms. */
  eligibleSignature: string;
}

interface SeatRequestRecord {
  id: string;
  peer: Peer;
  seatId: number;
  name: string;
  previousName: string;
  /** Occupant token when the request was filed; a newer occupant makes the request stale. */
  previousToken: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  message: string;
}

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Free-form display name: trimmed, capped at 8 chars, seat default when empty. */
function normalizeName(raw: unknown, seatId: number): string {
  const trimmed = typeof raw === 'string' ? raw.trim().slice(0, 8) : '';
  return trimmed.length > 0 ? trimmed : `玩家${seatId + 1}`;
}

export class Room {
  private boardAiConfig: BoardAiConfig | null = null;
  private boardAiError: string | null = null;
  private pendingBoardAi: PendingBoardAi | null = null;
  private dealSequence = 0;
  private dealPresentation: { id: number; startedAt: number; seatCount: number; cardsPerSeat: number } | null = null;
  readonly code: string;
  readonly roomMode: RoomMode;
  /** Room age only: expiry is driven by continuous empty time, never by this. */
  readonly createdAt = Date.now();
  /** Seats in this room, taken from the engine (3 for Doudizhu, 4 for Guandan). */
  get seatCount(): 2 | 3 | 4 { return this.engine.seatCount; }
  /** The game engine for this room: gameplay, never identity. */
  readonly engine: RoomGame;
  version = 0;
  /** Index === seat id. Guandan and phone rooms always use canonical positions. */
  positions: Position[] = [];
  players: (Player | null)[];
  hostToken = newToken();
  hostPeer: Peer | null = null;
  /** Owner seat of a phone room, or null when nobody connected holds host rights. */
  hostSeatId: number | null = null;
  private seenActions = new Map<string, true>();
  private seenOrder: string[] = [];
  /** Last accepted quick phrase per seat, used only as a local anti-spam guard. */
  private readonly lastPhraseAt = [0, 0, 0, 0];
  private readonly spectators = new Map<string, Spectator>();
  private spectatorPhrases = true;
  /** Socket-layer hook: after a successful dissolution the global registry drops this room. */
  onDissolve: ((room: Room) => void) | null = null;
  private requests = new Map<string, SeatRequestRecord>();
  private requestOrder: string[] = [];
  /** When the room last became continuously empty; null while anybody is bound. */
  private emptySince: number | null;
  private readonly policy: DouZeroPolicy;
  /** Guandan runtime for bots and 托管; injected like the Doudizhu one for tests. */
  private readonly guandanPolicy: GuandanPolicy;
  /** Public runtime failure for this room; null until automation actually fails here. */
  private automationFailure: string | null = null;
  /** Opt-in collection bookkeeping: which dealSeed instance and deal already recorded a result. */
  private collectSeedRef: object | null = null;
  private collectFinishDeal = -1;
  /** Room-local instance counter of observed deal seeds; joins deals rows with commands. */
  private collectDealSeq = 0;
  /** Bumped whenever pending automation must be discarded (toggle, takeover, restart, ...). */
  private automationEpoch = 0;
  private pendingDecision: PendingDecision | null = null;
  private nextAutomationAt = 0;
  /** Host-selected per-decision clock; 0 keeps the previous untimed behaviour. */
  private turnLimitSeconds = 0;
  private turnTimer: NodeJS.Timeout | null = null;
  private turnTimerDeadline: number | null = null;
  private turnTimerSeat: number | null = null;
  private turnTimerSignature: string | null = null;
  /** Bumped whenever the armed timer is cleared, so a queued callback cannot act twice. */
  private turnTimerEpoch = 0;

  private boardClockPreset: BoardClockPreset = 'off';
  private boardClockTimes: [BoardClockTime, BoardClockTime] = [initialBoardClockTime('off'), initialBoardClockTime('off')];
  private boardClockRun: { side: BoardClockSide; startedAt: number } | null = null;
  private boardClockTimer: NodeJS.Timeout | null = null;
  private pendingBoardAnalysis: PendingBoardAnalysis | null = null;
  private boardAnalysis: BoardAnalysisResult | null = null;

  constructor(
    code: string,
    roomMode: RoomMode,
    game: GameKind,
    policy: DouZeroPolicy = douZeroPolicy,
    guandanBridge: GuandanPolicy = guandanPolicy,
    private readonly boardPolicy: BoardAiPolicy = boardAiPolicy,
    private readonly boardNow: () => number = () => performance.now(),
    private readonly analysisPolicy: BoardAnalysisPolicy = boardAnalysisPolicy,
  ) {
    if (!supportsRoomMode(game, roomMode)) throw new Error(`${GAME_DEFINITIONS[game].name}不支持公共平板模式`);
    this.code = code;
    this.roomMode = roomMode;
    this.emptySince = Date.now();
    this.policy = policy;
    this.guandanPolicy = guandanBridge;
    const context = createPlayStamper(code);
    context.onDeal = (seatCount, cardsPerSeat) => {
      this.dealPresentation = { id: ++this.dealSequence, startedAt: Date.now(), seatCount, cardsPerSeat };
    };
    this.engine = ENGINE_FACTORIES[game](context);
    this.players = Array.from({ length: this.seatCount }, () => null);
    if (roomMode === 'phone' || game !== 'doudizhu') this.positions = PHONE_SEATS[game].map((seat) => ({ ...seat }));
  }

  /** Two local people share one authenticated tablet; neither occupies a remote seat. */
  private get sharedChess(): boolean { return this.roomMode === 'tablet' && isBoardGame(this.engine.kind) && this.engine.kind !== 'junqi'; }

  get phase(): Phase {
    return this.engine.phase;
  }

  /**
   * Expiry input: a room is empty when no human socket is bound and no automatic action is
   * scheduled, so a progressing all-managed round is never swept while a bot-only lobby still is.
   */
  get empty(): boolean {
    if (this.hostPeer !== null) return false;
    if (this.pendingDecision !== null) return false;
    return this.players.every((p) => p === null || p.isBot || !p.connected);
  }

  get hostConnected(): boolean {
    if (this.roomMode === 'tablet') return this.hostPeer !== null;
    const host = this.hostSeatId === null ? null : (this.players[this.hostSeatId] ?? null);
    return host !== null && host.connected && !host.isBot;
  }

  /**
   * Continuous-empty expiry: a long-lived room that just lost its last connection keeps the full
   * `ttlMs` retention, while any legitimate bind resets the clock.
   */
  isExpired(now: number, ttlMs: number): boolean {
    if (!this.empty) return false;
    return this.emptySince !== null && now - this.emptySince >= ttlMs;
  }

  // ---------------------------------------------------------------- binding

  /** Tablet creation: the caller becomes the shared table screen. */
  bindHost(peer: Peer, requestId: string): void {
    if (this.roomMode !== 'tablet') {
      this.fail(peer, requestId, '手机开一桌由玩家创建，没有独立的桌面端');
      return;
    }
    // One socket owns one identity: it may re-bind the host it already is, never a second one.
    if (peer.room !== null && !(peer.room === this && this.isHost(peer))) {
      this.fail(peer, requestId, BOUND_ELSEWHERE);
      return;
    }
    if (this.hostPeer && this.hostPeer !== peer) this.hostPeer.supersede();
    this.claimPeer(peer);
    this.hostPeer = peer;
    peer.room = this;
    peer.role = 'table';
    peer.seatId = null;
    peer.token = this.hostToken;
    peer.send({
      type: 'session',
      id: requestId,
      code: this.code,
      game: this.engine.kind,
      roomMode: this.roomMode,
      token: this.hostToken,
      role: 'table',
      seatId: null,
    });
    peer.send({ type: 'ack', id: requestId });
    this.touchAndBroadcast();
  }

  /**
   * Creation for both modes: a phone room gives the creator seat 0, a real private hand and the
   * host rights of that seat, exactly like any other player otherwise.
   */
  bindCreator(peer: Peer, requestId: string, name?: string): void {
    if (peer.room !== null) {
      this.fail(peer, requestId, BOUND_ELSEWHERE);
      return;
    }
    if (this.roomMode === 'tablet') {
      this.bindHost(peer, requestId);
      return;
    }
    if (this.players[0]) {
      this.fail(peer, requestId, '房间已经创建');
      return;
    }
    this.players[0] = this.newPlayer(0, normalizeName(name, 0), peer);
    this.hostSeatId = 0;
    this.bindPlayer(peer, this.players[0], requestId);
  }

  bindJoin(peer: Peer, seatId: number, name: string, requestId: string): void {
    if (this.sharedChess) { this.fail(peer, requestId, '这是同屏象棋，两人直接在平板上行棋，无需手机入座'); return; }
    // A socket that already holds a seat here (or a room elsewhere) must leave before joining:
    // silently taking a second seat would leave the first one bound to a dead connection.
    if (peer.room !== null && !this.spectatorFor(peer)) {
      this.fail(peer, requestId, BOUND_ELSEWHERE);
      return;
    }
    if (this.engine.phase !== 'lobby') {
      this.fail(peer, requestId, '本局已经开始，无法加入');
      return;
    }
    if (!Number.isInteger(seatId) || seatId < 0 || seatId >= this.seatCount) {
      this.fail(peer, requestId, '座位号无效');
      return;
    }
    if (this.players[seatId]) {
      this.fail(peer, requestId, '该座位已被占用，可向房主申请顶替', 'SEAT_OCCUPIED');
      return;
    }
    if (seatId >= this.positions.length) {
      this.fail(peer, requestId, '该座位尚未放置');
      return;
    }
    this.players[seatId] = this.newPlayer(seatId, normalizeName(name, seatId), peer);
    this.bindPlayer(peer, this.players[seatId], requestId);
  }

  private get spectatorCount(): number {
    return [...this.spectators.values()].filter(spectator => spectator.peer !== null).length;
  }

  bindSpectator(peer: Peer, requestId: string): void {
    if (peer.room !== null) {
      if (!this.spectatorFor(peer)) { this.fail(peer, requestId, BOUND_ELSEWHERE); return; }
      this.sendSpectatorSession(peer, requestId);
      peer.send({ type: 'state', state: this.snapshotFor(peer) });
      return;
    }
    if (this.spectatorCount >= MAX_SPECTATORS) {
      this.fail(peer, requestId, '房间旁观人数已满（最多 8 人）');
      return;
    }
    // Retain disconnected credentials for refreshes. A new viewer can reuse a vacant slot.
    if (this.spectators.size >= MAX_SPECTATORS) {
      for (const [token, spectator] of this.spectators) {
        if (spectator.peer === null) { this.spectators.delete(token); break; }
      }
    }
    const token = SPECTATOR_PREFIX + newToken();
    this.spectators.set(token, { peer, lastPhraseAt: 0 });
    this.attachSpectator(peer, token, requestId);
  }

  private attachSpectator(peer: Peer, token: string, requestId: string): void {
    this.claimPeer(peer);
    peer.room = this;
    peer.role = 'spectator';
    peer.seatId = null;
    peer.token = token;
    this.sendSpectatorSession(peer, requestId);
    this.publishSpectators();
  }

  private sendSpectatorSession(peer: Peer, requestId: string): void {
    peer.send({ type: 'session', id: requestId, code: this.code, game: this.engine.kind,
      roomMode: this.roomMode, token: peer.token!, role: 'spectator', seatId: null });
    peer.send({ type: 'ack', id: requestId });
  }

  private resumeSpectator(peer: Peer, token: string, requestId: string): void {
    const spectator = this.spectators.get(token);
    if (!spectator) {
      this.fail(peer, requestId, '旁观凭证已失效，请重新进入旁观', 'INVALID_CREDENTIAL');
      return;
    }
    if (peer.room !== null && this.spectatorFor(peer) !== spectator) {
      this.fail(peer, requestId, BOUND_ELSEWHERE);
      return;
    }
    if (spectator.peer === peer) {
      this.sendSpectatorSession(peer, requestId);
      peer.send({ type: 'state', state: this.snapshotFor(peer) });
      return;
    }
    const previous = spectator.peer;
    spectator.peer = peer;
    if (previous) {
      this.cancelRequestsOf(previous);
      previous.supersede();
    }
    this.attachSpectator(peer, token, requestId);
  }

  bindResume(peer: Peer, token: string, requestId: string): void {
    if (typeof token !== 'string' || token.length === 0) {
      this.fail(peer, requestId, '凭证无效', 'INVALID_CREDENTIAL');
      return;
    }
    if (token.startsWith(SPECTATOR_PREFIX)) {
      this.resumeSpectator(peer, token, requestId);
      return;
    }
    if (this.roomMode === 'tablet' && token === this.hostToken) {
      this.bindHost(peer, requestId);
      return;
    }
    const player = this.players.find((p) => p !== null && p.token === token) ?? null;
    if (!player) {
      this.fail(peer, requestId, '房间凭证已失效，请重新加入或申请顶替', 'INVALID_CREDENTIAL');
      return;
    }
    // Same identity on the same socket stays allowed; switching seats or rooms needs a leave.
    if (peer.room !== null && !(peer.room === this && this.playerFor(peer) === player)) {
      this.fail(peer, requestId, BOUND_ELSEWHERE);
      return;
    }
    if (player.peer && player.peer !== peer) player.peer.supersede();
    player.peer = peer;
    player.connected = true;
    // Nobody connected holds host rights: the first legitimate resume takes them. A resume never
    // takes rights back from a live host.
    if (this.roomMode === 'phone' && this.hostSeatId === null) this.hostSeatId = player.seatId;
    this.bindPlayer(peer, player, requestId);
  }

  /** Called by the socket layer when a bound connection drops. */
  detach(peer: Peer): void {
    let changed = this.cancelRequestsOf(peer);
    const spectator = this.spectatorFor(peer);
    if (spectator) {
      spectator.peer = null;
      this.publishSpectators();
      return;
    }
    if (this.hostPeer === peer) {
      this.hostPeer = null;
      changed = true;
    } else {
      const player = peer.seatId !== null ? this.players[peer.seatId] : null;
      // Only the live occupant may detach a seat: a superseded socket must not disturb the peer
      // that replaced it.
      if (player && player.peer === peer) {
        player.peer = null;
        player.connected = false;
        if (this.roomMode === 'phone' && this.hostSeatId === player.seatId) this.reassignHost();
        changed = true;
      }
    }
    if (changed) this.touchAndBroadcast();
  }

  // ---------------------------------------------------------------- seat replacement

  /**
   * Register a newcomer's request to replace the occupant of `seatId`. Nothing about the target
   * changes until the host approves: hand, name, token, counters and connection all stay put.
   */
  requestSeat(peer: Peer, seatId: number, name: string, requestId: string): void {
    if (this.boardAiConfig?.side === seatId) { this.fail(peer, requestId, '这是电脑座位，请房主先关闭人机对弈'); return; }
    if (this.sharedChess) { this.fail(peer, requestId, '这是同屏象棋，无需申请座位'); return; }
    if (!requestId) {
      this.fail(peer, requestId, '申请编号无效');
      return;
    }
    const known = this.requests.get(requestId);
    if (known) {
      if (known.peer !== peer) {
        this.fail(peer, requestId, '申请编号冲突，请重试');
        return;
      }
      // Idempotent repeat: replay the recorded outcome instead of filing a second request.
      this.replayRequest(peer, known, requestId);
      return;
    }
    if (peer.room && !this.spectatorFor(peer)) {
      this.fail(peer, requestId, peer.room === this ? '你已经在这个房间中，无需申请' : '你已经在一个房间中');
      return;
    }
    if (!Number.isInteger(seatId) || seatId < 0 || seatId >= this.seatCount) {
      this.fail(peer, requestId, '座位号无效');
      return;
    }
    const target = this.players[seatId];
    if (!target) {
      this.fail(peer, requestId, '该座位还没有玩家，可直接加入');
      return;
    }
    // One connection waits in exactly one room and holds at most one slot in that room's queue. A
    // valid new request therefore retires the pending intent this socket was still waiting on — in
    // another host's queue or in this one — before the pointer moves and the new record is filed,
    // so no queue can later approve a seat to a socket that no longer waits there. Invalid requests
    // return earlier, so they cannot destroy a still-current intent.
    const previous = peer.requestRoom;
    if (previous && previous !== this) previous.cancelSeatRequest(peer);
    this.cancelSeatRequest(peer);
    const record: SeatRequestRecord = {
      id: requestId,
      peer,
      seatId,
      name: normalizeName(name, seatId),
      previousName: target.name,
      previousToken: target.token,
      status: 'pending',
      message: '已提交申请，等待房主确认',
    };
    this.requests.set(requestId, record);
    this.requestOrder.push(requestId);
    this.pruneRequests();
    peer.requestRoom = this;
    peer.send(this.seatRequestMessage(requestId, seatId, 'pending', record.message));
    peer.send({ type: 'ack', id: requestId });
    this.touchAndBroadcast();
  }

  /** Called by the socket layer when an unbound waiting connection closes. */
  cancelSeatRequest(peer: Peer): void {
    if (this.cancelRequestsOf(peer)) this.touchAndBroadcast();
  }

  // ---------------------------------------------------------------- commands

  /** Route an in-room command. Sends ack + audience snapshot on success. */
  command(peer: Peer, type: string, payload: Record<string, unknown>, requestId: string): void {
    // Identity first: a superseded or unbound socket may neither replay nor read any snapshot.
    if (!this.authenticated(peer)) {
      peer.send({
        type: 'error',
        id: requestId || undefined,
        message: '连接已失效，请重新进入房间',
        code: 'INVALID_CREDENTIAL',
      });
      return;
    }
    if (peer.role === 'spectator' && type !== 'phrase') {
      this.fail(peer, requestId, '旁观者不能操作对局');
      return;
    }
    // Dissolution tears the room down and unblocks every peer's credential, so it cannot run
    // through the normal success path (which would broadcast a snapshot of a dead room).
    if (type === 'dissolve') {
      this.dissolve(peer, requestId);
      return;
    }
    if (requestId && this.seenActions.has(requestId)) {
      peer.send({ type: 'ack', id: requestId });
      peer.send({ type: 'state', state: this.snapshotFor(peer) });
      return;
    }
    const readOnly = type === 'hint' || type === 'phrase';
    const arrivedAt = this.boardNow();
    if (!readOnly && this.expireBoardClock(arrivedAt)) {
      this.fail(peer, requestId, '用时已耗尽，本局已结束');
      this.version += 1;
      this.broadcast();
      return;
    }
    if (!this.dispatch(peer, type, payload, requestId)) return;
    if (requestId) {
      this.seenActions.set(requestId, true);
      this.seenOrder.push(requestId);
      while (this.seenOrder.length > MAX_REMEMBERED_ACTIONS) {
        const oldest = this.seenOrder.shift();
        if (oldest !== undefined) this.seenActions.delete(oldest);
      }
      peer.send({ type: 'ack', id: requestId });
    }
    // Hints are private reads and phrases are ephemeral messages: neither mutates the table, so
    // neither bumps the version or broadcasts a layout-triggering snapshot.
    if (readOnly) return;
    this.version += 1;
    if (type === 'chessMove' || type === 'xiangqiMove' || type === 'stoneMove' || type === 'reversiMove' || type === 'stonePass') {
      this.completeBoardClockTurn(arrivedAt);
    }
    this.refreshBoardClock(arrivedAt);
    this.refreshAutomation();
    this.refreshTurnTimer();
    this.broadcast();
  }

  private dispatch(peer: Peer, type: string, payload: Record<string, unknown>, id: string): boolean {
    switch (type) {
      case 'chessUndo':
      case 'xiangqiUndo':
      case 'stoneUndo':
      case 'reversiUndo':
        return this.boardUndo(peer, type, payload.action, id);
      case 'boardAnalyze':
        return this.analyzeBoard(peer, payload.action, id);
      case 'boardAi':
        return this.configureBoardAi(peer, payload, id);
      case 'boardAiRetry':
        if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以重试电脑行棋');
        if (!this.boardAiConfig || this.phase !== 'playing' || !this.boardAiError) return this.fail(peer, id, '当前没有需要重试的电脑行棋');
        this.boardAiError = null;
        return true;
      case 'junqiMode':
        return this.setJunqiMode(peer, payload, id);
      case 'stoneSetup': {
        if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以设置棋盘或规则');
        if (!(this.engine instanceof StoneGame)) return this.fail(peer, id, '当前不是围棋或五子棋房间');
        const result = this.engine.kind === 'gomoku' ? this.engine.setRule(payload.rule) : this.engine.setSize(payload.size);
        if (!result.ok) return this.fail(peer, id, result.message);
        for (const player of this.players) if (player && !player.isBot) player.ready = false;
        return true;
      }
      case 'seats':
        return this.configureSeats(peer, payload, id);
      case 'ready':
        return this.setReady(peer, payload, id);
      case 'rename':
        return this.renameSelf(peer, payload, id);
      case 'decideSeat':
        return this.decideSeat(peer, payload, id);
      case 'start':
        return this.start(peer, id);
      case 'again':
        return this.again(peer, id);
      case 'addBot':
        return this.addBot(peer, payload, id);
      case 'removeBot':
        return this.removeBot(peer, payload, id);
      case 'autoPlay':
        return this.setAutoPlay(peer, payload, id);
      case 'hint':
        return this.hint(peer, id);
      case 'phrase':
        return this.sayPhrase(peer, payload, id);
      case 'spectatorPhrases':
        if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以设置旁观快捷语');
        if (typeof payload.enabled !== 'boolean') return this.fail(peer, id, '快捷语设置无效');
        this.spectatorPhrases = payload.enabled;
        return true;
      case 'removeOffline':
        return this.removeOfflineSeats(peer, id);
      case 'transferHost':
        return this.transferHost(peer, payload, id);
      case 'clearEmptySeats':
        return this.clearEmptySeats(peer, id);
      case 'turnTimer':
        return this.setTurnTimer(peer, payload, id);
      case 'boardClock':
        return this.configureBoardClock(peer, payload.preset, id);
      case 'bid':
      case 'chessMove':
      case 'stoneMove':
      case 'reversiMove':
      case 'reversiResign':
      case 'stonePass':
      case 'stoneResign':
      case 'stoneScore':
      case 'chessResign':
      case 'chessDraw':
      case 'xiangqiMove':
      case 'xiangqiResign':
      case 'xiangqiDraw':
      case 'junqiSetup':
      case 'junqiMove':
      case 'junqiResign':
      case 'play':
      case 'pass':
      case 'tribute':
      case 'returnTribute':
        return this.gameCommand(peer, type, payload, id);
      default:
        return this.fail(peer, id, '未知的操作类型');
    }
  }

  private boardUndo(peer: Peer, type: 'chessUndo' | 'xiangqiUndo' | 'stoneUndo' | 'reversiUndo', action: unknown, id: string): boolean {
    if (action === 'direct') return this.fail(peer, id, '请使用悔棋请求');
    const view = this.engine.view(null);
    const board = view.game === 'chess' && type === 'chessUndo' ? view.chess
      : view.game === 'xiangqi' && type === 'xiangqiUndo' ? view.xiangqi
      : view.game === 'reversi' && type === 'reversiUndo' ? view.reversi
      : (view.game === 'go' || view.game === 'gomoku') && type === 'stoneUndo' ? view.stones : null;
    if (!board) return this.fail(peer, id, '本游戏不支持这个操作');

    const computer = this.boardAiConfig;
    let seat: BoardUndoSide | undefined;
    if (this.sharedChess) {
      if (!this.isHost(peer)) return this.fail(peer, id, '请在创建本局的平板上操作');
      seat = computer ? (computer.side === 0 ? 1 : 0) : board.moves[boardUndoTarget(board.moves)]?.side;
    } else {
      const player = this.requiredPlayer(peer, id);
      if (!player) return false;
      if (this.isManaged(player)) return this.fail(peer, id, '托管中，请先取消托管');
      if (this.paused()) return this.fail(peer, id, '有玩家掉线，等待重连');
      if (player.seatId === 0 || player.seatId === 1) seat = player.seatId;
    }

    const immediate = this.sharedChess || computer !== null;
    if (immediate && action !== 'request') return this.fail(peer, id, '当前对局没有协商悔棋请求');
    if (seat === undefined) return this.fail(peer, id, '本局还没有可以撤销的着法');
    // A request can race a computer reply. Stop the search before changing its history.
    if (computer && boardUndoTarget(board.moves, seat) >= 0) this.cancelBoardAi();
    const result = this.engine.command(seat, type, { action: immediate ? 'direct' : action }, { unlimitedUndo: computer !== null });
    if (!result.ok) {
      if (computer) this.refreshBoardAi();
      return this.fail(peer, id, result.message);
    }
    if (immediate || action === 'accept') {
      if (computer) this.boardAiError = null;
      this.invalidateAutomation();
      // The command success path refreshes automation before publishing the new snapshot.
    }
    return true;
  }

  /** Authoritative command facts for the opt-in collector; any error stays inside the collector. */
  private recordCommand(seatId: number | null, type: GameCommandType, payload: Record<string, unknown>): void {
    if (!guandanCollector.enabled || isBoardGame(this.engine.kind)) return;
    const seed: GuandanGame | null = this.engine instanceof GuandanGame ? this.engine : null;
    guandanCollector.command({
      roomCode: this.code,
      game: this.engine.kind,
      phase: this.engine.phase,
      dealSeq: this.collectDealSeq,
      deal: seed ? seed.deal : null,
      seatId,
      type,
      payload: seed && type === 'play' ? { ...payload, claim: seed.lastAcceptedClaim!.key } : payload,
    });
  }

  /**
   * Delegated game action: identity first, then the room's pause policy, then the engine. The engine
   * never receives a request id, so a replayed command cannot reach it twice.
   */
  private gameCommand(peer: Peer, type: GameCommandType, payload: Record<string, unknown>, id: string): boolean {
    const computer = this.boardAiConfig, kind = this.engine.kind;
    if (computer && isBoardAiGame(kind)) {
      if (type === 'chessDraw' || type === 'xiangqiDraw') return this.fail(peer, id, '人机对弈按棋规自动判和，不提供协议和棋');
      const adapter = BOARD_AI_ADAPTERS[kind];
      if (this.sharedChess && type === adapter.move && this.engine.view(null).turn === computer.side) return this.fail(peer, id, '轮到电脑行棋，请稍候');
      if (this.sharedChess && type === adapter.resign && payload.side === computer.side) return this.fail(peer, id, '只能替自己认输');
    }
    if (this.sharedChess && this.engine instanceof ReversiGame) {
      if (!this.isHost(peer)) return this.fail(peer, id, '请在创建本局的平板上操作');
      if (type !== 'reversiMove' && type !== 'reversiResign') return this.fail(peer, id, '黑白棋不支持这个操作');
      const side = type === 'reversiMove' ? this.engine.view().turn : payload.side;
      if (side !== 0 && side !== 1) return this.fail(peer, id, '请选择操作的一方');
      const result = this.engine.command(side, type, payload);
      return result.ok || this.fail(peer, id, result.message);
    }
    if (this.sharedChess && this.engine instanceof StoneGame) {
      if (!this.isHost(peer)) return this.fail(peer, id, '请在创建本局的平板上操作');
      if (!['stoneMove', 'stonePass', 'stoneResign', 'stoneScore'].includes(type)) return this.fail(peer, id, '本游戏不支持这个操作');
      const side = type === 'stoneMove' || type === 'stonePass' ? this.engine.view().turn : payload.side;
      if (side !== 0 && side !== 1) return this.fail(peer, id, '请选择操作的一方');
      const result = this.engine.command(side, type, payload);
      return result.ok || this.fail(peer, id, result.message);
    }
    if (this.sharedChess && (this.engine instanceof XiangqiGame || this.engine instanceof ChessGame)) {
      if (!this.isHost(peer)) return this.fail(peer, id, '请在创建本局的平板上行棋');
      const view = this.engine.view();
      if (view.phase !== 'playing') return this.fail(peer, id, '请先开始对弈');
      // Same-screen agreement still passes through the engine's offer/accept rules.
      const prefix = view.game === 'chess' ? 'chess' : 'xiangqi';
      if (type === `${prefix}Draw` && payload.action === 'agree') {
        const offering = view.game === 'chess' ? view.chess.drawOffer : view.xiangqi.drawOffer;
        if (offering === null) {
          const offer = this.engine.command(0, type, { action: 'offer' });
          if (!offer.ok) return this.fail(peer, id, offer.message);
        }
        const result = this.engine.command(offering === 1 ? 0 : 1, type, { action: 'accept' });
        return result.ok || this.fail(peer, id, result.message);
      }
      if (type !== `${prefix}Move` && type !== `${prefix}Resign` && type !== `${prefix}Draw`) return this.fail(peer, id, '同屏象棋不支持这个操作');
      const side = type === `${prefix}Move` ? view.turn : payload.side;
      if (side !== 0 && side !== 1) return this.fail(peer, id, '请选择行棋一方');
      const result = this.engine.command(side, type, payload);
      return result.ok || this.fail(peer, id, result.message);
    }
    const player = this.requiredPlayer(peer, id);
    if (!player) return false;
    // A managed seat is played by Room: manual bid/play/pass is refused until 托管 is cancelled.
    if (this.isManaged(player)) return this.fail(peer, id, '托管中，请先取消托管');
    if (this.paused()) return this.fail(peer, id, '有玩家掉线，等待重连');
    const result = this.engine.command(player.seatId, type, payload);
    if (!result.ok) return this.fail(peer, id, result.message);
    this.recordCommand(player.seatId, type, payload);
    return true;
  }

  /**
   * Private, read-only suggestion channel. The engine sees only the requesting seat's hand; the
   * room sends the list to that peer alone and deliberately skips version/broadcast.
   */
  private hint(peer: Peer, id: string): boolean {
    const player = this.requiredPlayer(peer, id);
    if (!player) return false;
    if (this.isManaged(player)) return this.fail(peer, id, '托管中，请先取消托管');
    const result = this.engine.hint(player.seatId);
    if (!result.ok) return this.fail(peer, id, result.message ?? '暂时无法提示');
    peer.send({ type: 'hint', id, plays: result.plays });
    return true;
  }

  /**
   * Fixed-preset quick phrase. The server accepts only a whitelisted id, so there is no field a
   * client could use for free-form chat. Delivery is ephemeral and deliberately not in snapshots.
   */
  private sayPhrase(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    const spectator = this.spectatorFor(peer);
    if (spectator && !this.spectatorPhrases) return this.fail(peer, id, '房主已关闭旁观快捷语');
    const player = spectator ? null : this.requiredPlayer(peer, id);
    if (!spectator && !player) return false;
    const phrase = quickPhrase(payload.phraseId);
    if (!phrase) return this.fail(peer, id, '快捷语无效');
    const now = Date.now();
    const last = player ? this.lastPhraseAt[player.seatId] ?? 0 : spectator!.lastPhraseAt;
    if (now - last < PHRASE_COOLDOWN_MS) {
      return this.fail(peer, id, '快捷语发得太快了，请稍后再试');
    }
    if (player) this.lastPhraseAt[player.seatId] = now;
    else spectator!.lastPhraseAt = now;
    const message: PhraseMessage = {
      type: 'phrase',
      seatId: player?.seatId ?? null,
      name: player?.name ?? '旁观者',
      phraseId: phrase.id,
      text: `${phrase.emoji} ${phrase.text}`,
      at: now,
    };
    this.sendToAudience(message);
    return true;
  }

  /**
   * Host removes every disconnected human seat in the lobby. Bots and opted-in 托管 seats are not
   * "offline"; they are already played by the room and stay. Positions are kept so newcomers can
   * still claim the now-empty seats.
   */
  private removeOfflineSeats(peer: Peer, id: string): boolean {
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以清理离线座位');
    if (this.engine.phase !== 'lobby') return this.fail(peer, id, '只能在准备阶段清理离线座位');
    const offline = this.players.filter(
      (player): player is Player => player !== null && !player.isBot && !player.autoPlay && !player.connected,
    );
    if (offline.length === 0) return this.fail(peer, id, '没有需要清理的离线座位');
    for (const player of offline) {
      this.cancelPendingSeat(player.seatId, '座位已被房主清理');
      this.players[player.seatId] = null;
    }
    this.invalidateAutomation();
    return true;
  }

  /**
   * Phone rooms hand host rights to another connected human. The table arrangement has no player
   * host, so it is refused there rather than inventing a hidden second owner.
   */
  private transferHost(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以转让房主');
    if (this.roomMode !== 'phone') return this.fail(peer, id, '平板房主是公共牌桌，无需转让');
    const seatId = payload.seatId;
    if (typeof seatId !== 'number' || !Number.isInteger(seatId) || seatId < 0 || seatId >= this.seatCount) {
      return this.fail(peer, id, '座位号无效');
    }
    const target = this.players[seatId] ?? null;
    if (!target) return this.fail(peer, id, '该座位没有玩家');
    if (target.isBot) return this.fail(peer, id, '不能把房主转让给机器人');
    if (!target.connected) return this.fail(peer, id, '只能转让给在线玩家');
    if (this.hostSeatId === target.seatId) return this.fail(peer, id, '你已经是房主');
    this.hostSeatId = target.seatId;
    return true;
  }

  /**
   * Tablet Doudizhu only: the host placed custom seats and wants to trim the empty positions at
   * the end. Occupied indexes never move, so no player's seat id changes under their feet.
   */
  private clearEmptySeats(peer: Peer, id: string): boolean {
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以清理空位');
    if (this.roomMode !== 'tablet') return this.fail(peer, id, '手机开一桌使用固定座位，不能清理空位');
    if (this.engine.kind !== 'doudizhu') return this.fail(peer, id, `${GAME_DEFINITIONS[this.engine.kind].name}使用固定座位，不能清理空位`);
    if (this.engine.phase !== 'lobby') return this.fail(peer, id, '只能在准备阶段清理空位');
    let end = this.positions.length;
    while (end > 0 && this.players[end - 1] === null) end -= 1;
    if (end === this.positions.length) return this.fail(peer, id, '没有空位需要清理');
    for (let seatId = end; seatId < this.positions.length; seatId += 1) {
      this.cancelPendingSeat(seatId, '座位已被房主清理');
    }
    this.positions = this.positions.slice(0, end);
    this.invalidateAutomation();
    return true;
  }

  /** Cancel one seat's still-pending replacement request because the seat itself disappeared. */
  private cancelPendingSeat(seatId: number, message: string): void {
    for (const record of this.requests.values()) {
      if (record.seatId !== seatId || record.status !== 'pending') continue;
      record.status = 'cancelled';
      record.message = message;
      this.releaseRequestPointer(record.peer);
      record.peer.send(this.seatRequestMessage(record.id, record.seatId, 'cancelled', message));
    }
  }

  /**
   * Host closes the room for everyone: all bound sockets receive `dissolved` first, then every
   * credential pointer is cleared so they may create or join another room without reconnecting.
   */
  private dissolve(peer: Peer, id: string): void {
    if (!this.isHost(peer)) {
      this.fail(peer, id, '只有房主可以解散房间');
      return;
    }
    const message: ServerMessage = { type: 'dissolved', code: this.code, message: '房主已解散房间' };
    if (id) peer.send({ type: 'ack', id });
    const notified = new Set<Peer>();
    const notify = (target: Peer | null): void => {
      if (!target || notified.has(target)) return;
      notified.add(target);
      target.send(message);
    };
    notify(this.hostPeer);
    for (const player of this.players) notify(player?.peer ?? null);
    for (const spectator of this.spectators.values()) notify(spectator.peer);
    for (const record of this.requests.values()) {
      if (record.status === 'pending') notify(record.peer);
    }
    for (const target of notified) {
      if (target.room === this) {
        target.room = null;
        target.role = 'table';
        target.seatId = null;
        target.token = null;
      }
      if (target.requestRoom === this) target.requestRoom = null;
    }
    this.hostPeer = null;
    this.players.fill(null);
    this.spectators.clear();
    this.requests.clear();
    this.requestOrder.length = 0;
    this.dispose();
    this.onDissolve?.(this);
  }

  /**
   * Host setting for the per-decision clock. It may only change between deals, so a host cannot
   * shorten or disable the clock a player is already racing. The UI offers conventional presets;
   * the server accepts any whole second up to five minutes.
   */
  private setTurnTimer(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以设置回合倒计时');
    if (this.engine.phase !== 'lobby' && this.engine.phase !== 'finished') {
      return this.fail(peer, id, '牌局进行中，不能修改回合倒计时');
    }
    const seconds = payload.seconds;
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 0 || seconds > 300) {
      return this.fail(peer, id, '倒计时秒数无效');
    }
    this.turnLimitSeconds = seconds;
    this.refreshTurnTimer();
    return true;
  }

  // ---------------------------------------------------------------- board clock

  private configureBoardClock(peer: Peer, choice: unknown, id: string): boolean {
    if (!this.engine.flag) return this.fail(peer, id, '当前游戏不支持棋钟');
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以设置棋钟');
    if (this.phase !== 'lobby') return this.fail(peer, id, '只能在准备阶段设置棋钟');
    const preset = boardClockOptions(this.engine.kind).find(option => option === choice);
    if (!preset) return this.fail(peer, id, '棋钟选项无效');
    if (preset === this.boardClockPreset) return true;
    this.boardClockPreset = preset;
    this.resetBoardClock();
    for (const player of this.players) if (player && !player.isBot) player.ready = false;
    return true;
  }

  private resetBoardClock(): void {
    this.stopBoardClock(this.boardNow());
    this.boardClockTimes = [initialBoardClockTime(this.boardClockPreset), initialBoardClockTime(this.boardClockPreset)];
  }

  private boardClockTime(side: BoardClockSide, at: number): BoardClockTime {
    const run = this.boardClockRun;
    const time = this.boardClockTimes[side];
    return run?.side === side
      ? spendBoardClock(time, at - run.startedAt, BOARD_CLOCK_PRESETS[this.boardClockPreset].periodMs)
      : { ...time };
  }

  private boardClockView(): BoardClockView {
    const at = this.boardNow();
    const time = (side: BoardClockSide) => this.boardClockPreset === 'off' || this.boardAiConfig?.side === side
      ? null : this.boardClockTime(side, at);
    return { preset: this.boardClockPreset, times: [time(0), time(1)], running: this.boardClockRun?.side ?? null };
  }

  private stopBoardClock(at: number): void {
    const run = this.boardClockRun;
    if (!run) return;
    this.boardClockTimes[run.side] = this.boardClockTime(run.side, at);
    this.boardClockRun = null;
    if (this.boardClockTimer !== null) clearTimeout(this.boardClockTimer);
    this.boardClockTimer = null;
  }

  private completeBoardClockTurn(at: number): void {
    const side = this.boardClockRun?.side;
    if (side === undefined) return;
    const preset = BOARD_CLOCK_PRESETS[this.boardClockPreset];
    this.stopBoardClock(at);
    const time = this.boardClockTimes[side];
    time.mainMs += preset.incrementMs;
    if (time.periodsLeft > 0) time.periodRemainingMs = preset.periodMs;
  }

  private refreshBoardClock(at = this.boardNow()): void {
    if (this.boardClockPreset === 'off') return;
    // A shared tablet's two local sides aren't in the phone roster checked by paused().
    const turn = this.phase === 'playing' && this.hostConnected && !this.paused() ? this.engine.view(null).turn : null;
    const side = (turn === 0 || turn === 1) && turn !== this.boardAiConfig?.side ? turn : null;
    if (side === (this.boardClockRun?.side ?? null)) return;
    this.stopBoardClock(at);
    if (side === null) return;
    this.boardClockRun = { side, startedAt: this.boardNow() };
    this.armBoardClock();
  }

  private armBoardClock(): void {
    const run = this.boardClockRun;
    if (!run) return;
    const now = this.boardNow();
    const remaining = boardClockBudget(this.boardClockTime(run.side, now), BOARD_CLOCK_PRESETS[this.boardClockPreset].periodMs);
    this.boardClockTimer = setTimeout(() => {
      if (this.boardClockRun !== run) return;
      this.boardClockTimer = null;
      if (!this.expireBoardClock(this.boardNow())) {
        this.armBoardClock();
        return;
      }
      this.version += 1;
      this.broadcast();
    }, Math.max(1, Math.ceil(remaining)));
    this.boardClockTimer.unref();
  }

  /** Both the deadline callback and the command path settle against the same monotonic clock. */
  private expireBoardClock(at: number): boolean {
    const run = this.boardClockRun;
    if (!run) return false;
    const remaining = this.boardClockTime(run.side, at);
    if (remaining.mainMs > 0 || remaining.periodsLeft > 0) return false;
    this.stopBoardClock(at);
    if (!this.engine.flag?.(run.side).ok) return false;
    this.invalidateAutomation();
    return true;
  }

  // ---------------------------------------------------------------- finished-board analysis

  private analyzeBoard(peer: Peer, action: unknown, id: string): boolean {
    const view = this.engine.view(null);
    if (!isAnalyzableView(view)) return this.fail(peer, id, '当前游戏不支持复盘分析');
    if (view.phase !== 'finished') return this.fail(peer, id, '对局结束后才能分析本局');
    if (!this.playerFor(peer) && !(this.sharedChess && this.isHost(peer))) return this.fail(peer, id, '只有入座玩家或同屏主机可以分析');
    const record = analysisRecord(view);
    if (action === 'cancel') {
      if (this.pendingBoardAnalysis?.roundId !== record.roundId) return this.fail(peer, id, '当前没有正在运行的分析');
      this.cancelBoardAnalysis();
      return true;
    }
    if (action !== 'start') return this.fail(peer, id, '分析操作无效');
    if (this.pendingBoardAnalysis) return this.fail(peer, id, '本局正在分析');
    if (activeBoardAnalysis) return this.fail(peer, id, '服务器正在分析其他对局，请稍后再试');
    const availability = this.analysisPolicy.availability(view.game);
    if (!availability.available) return this.fail(peer, id, availability.message ?? '棋类引擎不可用');

    const pending: PendingBoardAnalysis = {
      roundId: record.roundId, controller: new AbortController(), positions: [], lastPublishedAt: this.boardNow(),
    };
    this.pendingBoardAnalysis = activeBoardAnalysis = pending;
    this.boardAnalysis = this.analysisState(view, 'running');
    void this.runBoardAnalysis(pending, view);
    return true;
  }

  private analysisState(view: AnalyzableView, status: BoardAnalysisResult['status'],
    positions: AnalysisPosition[] = [], error: string | null = null): BoardAnalysisResult {
    const { roundId, moves } = analysisRecord(view);
    return { roundId, status, total: moves.length + 1, completed: positions.length, positions: [...positions], error };
  }

  private cancelBoardAnalysis(): void {
    const pending = this.pendingBoardAnalysis;
    this.pendingBoardAnalysis = null;
    this.boardAnalysis = null;
    pending?.controller.abort();
  }

  private analysisCurrent(pending: PendingBoardAnalysis): boolean {
    if (this.pendingBoardAnalysis !== pending || pending.controller.signal.aborted) return false;
    const view = this.engine.view(null);
    if (view.phase === 'finished' && isAnalyzableView(view) && analysisRecord(view).roundId === pending.roundId) return true;
    this.cancelBoardAnalysis();
    return false;
  }

  private async runBoardAnalysis(pending: PendingBoardAnalysis, view: AnalyzableView): Promise<void> {
    const publish = (status: BoardAnalysisResult['status'], error: string | null = null) => {
      this.boardAnalysis = this.analysisState(view, status, pending.positions, error);
      this.version += 1;
      this.broadcast();
    };
    try {
      // Let the command publish its acknowledgment and initial state before progress callbacks.
      await Promise.resolve();
      if (!this.analysisCurrent(pending)) return;
      await this.analysisPolicy.analyze(view, pending.controller.signal, position => {
        if (!this.analysisCurrent(pending)) return;
        pending.positions.push(position);
        const now = this.boardNow();
        if (now - pending.lastPublishedAt < ANALYSIS_PROGRESS_MS) return;
        pending.lastPublishedAt = now;
        publish('running');
      });
      if (this.analysisCurrent(pending)) publish('done');
    } catch (error) {
      if (this.analysisCurrent(pending)) publish('failed', error instanceof Error ? error.message : '棋类引擎异常');
    } finally {
      if (this.pendingBoardAnalysis === pending) this.pendingBoardAnalysis = null;
      if (activeBoardAnalysis === pending) activeBoardAnalysis = null;
    }
  }

  // ---------------------------------------------------------------- bots and 托管

  /** One computer opponent, configured only by the live host before a round starts. */
  private configureBoardAi(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    const kind = this.engine.kind;
    if (!isBoardAiGame(kind)) return this.fail(peer, id, '当前游戏不支持棋类电脑对弈');
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以设置人机对弈');
    if (this.phase !== 'lobby') return this.fail(peer, id, '请在开局前设置电脑和难度');
    if (typeof payload.enabled !== 'boolean') return this.fail(peer, id, '人机对弈参数无效');
    if (!payload.enabled) {
      if (this.boardAiConfig && !this.sharedChess && this.players[this.boardAiConfig.side]?.isBot) this.players[this.boardAiConfig.side] = null;
      this.boardAiConfig = null; this.boardAiError = null; this.invalidateAutomation();
      return true;
    }
    const side = payload.side, difficulty = payload.difficulty;
    if ((side !== 0 && side !== 1) || !isBoardAiDifficulty(difficulty)) return this.fail(peer, id, '请选择电脑执子和有效难度');
    const status = this.boardPolicy.availability(kind, difficulty);
    if (!status.available) return this.fail(peer, id, status.message ?? '这个难度的电脑暂不可用');
    if (!this.sharedChess) {
      const occupant = this.players[side];
      if (occupant && !occupant.isBot) return this.fail(peer, id, '该位置已有真人，不能替换成电脑');
      if (this.boardAiConfig && this.boardAiConfig.side !== side && this.players[this.boardAiConfig.side]?.isBot) this.players[this.boardAiConfig.side] = null;
      const bot = this.newBot(side, undefined, 'strong');
      delete bot.botStrength; bot.name = `电脑·${boardAiLabel(difficulty)}`;
      this.players[side] = bot;
      this.cancelPendingSeat(side, '该座位已设为电脑，请选择其他房间');
    }
    this.boardAiConfig = { side, difficulty }; this.boardAiError = null; this.invalidateAutomation();
    return true;
  }

  private cancelBoardAi(): void {
    const pending = this.pendingBoardAi;
    this.pendingBoardAi = null;
    if (!pending) return;
    clearTimeout(pending.timer); clearTimeout(pending.guard); pending.controller.abort();
  }

  private boardDecisionCurrent(pending: PendingBoardAi, view: GameView): boolean {
    if (this.pendingBoardAi !== pending || pending.epoch !== this.automationEpoch || !this.hostConnected || this.paused()) return false;
    if (this.boardAiConfig?.side !== pending.side || this.boardAiConfig.difficulty !== pending.difficulty || this.boardAiError) return false;
    if (view.phase !== 'playing' || view.turn !== pending.side) return false;
    const board = boardAiContext(view);
    return board?.roundId === pending.roundId && board.ply === pending.ply;
  }

  private refreshBoardAi(): void {
    const config = this.boardAiConfig;
    if (!config || this.boardAiError || !this.hostConnected || this.paused()) { this.cancelBoardAi(); return; }
    const view = this.engine.view(null), board = boardAiContext(view);
    if (!board || view.phase !== 'playing' || view.turn !== config.side) { this.cancelBoardAi(); return; }
    if (this.pendingBoardAi && this.boardDecisionCurrent(this.pendingBoardAi, view)) return;
    this.cancelBoardAi();
    const pending: PendingBoardAi = {
      controller: new AbortController(),
      roundId: board.roundId, ply: board.ply, side: config.side, epoch: this.automationEpoch, difficulty: config.difficulty,
    };
    this.pendingBoardAi = pending;
    pending.timer = setTimeout(() => void this.runBoardAi(pending), board.delayMs); pending.timer.unref();
    // Includes queue time: a busy or hung engine never leaves the UI thinking forever.
    pending.guard = setTimeout(() => { if (this.pendingBoardAi === pending) this.failBoardAi('电脑响应超时，请重试'); }, 15000); pending.guard.unref();
  }

  private async runBoardAi(pending: PendingBoardAi): Promise<void> {
    const view = this.engine.view(null), board = boardAiContext(view);
    if (!board || !this.boardDecisionCurrent(pending, view)) { if (this.pendingBoardAi === pending) this.cancelBoardAi(); return; }
    try {
      const move = await this.boardPolicy.chooseMove(board.position(), pending.difficulty, pending.controller.signal);
      if (!this.boardDecisionCurrent(pending, this.engine.view(null))) return;
      const { type, payload } = board.command(move);
      const result = this.engine.command(pending.side, type, payload);
      if (!result.ok) { this.failBoardAi(`电脑返回的走法无效：${result.message}`); return; }
      this.cancelBoardAi(); this.version++; this.refreshBoardClock(); this.refreshAutomation(); this.refreshTurnTimer(); this.broadcast();
    } catch (error) {
      if (this.pendingBoardAi === pending) this.failBoardAi(error instanceof Error ? error.message : '电脑行棋失败');
    }
  }

  private failBoardAi(message: string): void {
    this.cancelBoardAi(); this.boardAiError = message; this.version++; this.broadcast();
  }

  /** Host adds a robot to an empty, already-placed seat in the lobby (either game). */
  private addBot(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    if (isBoardGame(this.engine.kind)) return this.fail(peer, id, isBoardAiGame(this.engine.kind) ? '请在棋类准备页设置人机对弈' : this.engine.kind === 'junqi' ? '军棋仅支持真人联机' : '本游戏仅支持真人对弈');
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以添加机器人');
    const status = this.automationState();
    if (!status.available) return this.fail(peer, id, status.message ?? '机器人服务暂不可用');
    if (this.engine.phase !== 'lobby') return this.fail(peer, id, '只能在准备阶段添加机器人');
    const seatId = payload.seatId;
    if (!Number.isInteger(seatId) || typeof seatId !== 'number' || seatId < 0 || seatId >= this.seatCount) {
      return this.fail(peer, id, '座位号无效');
    }
    if (seatId >= this.positions.length) return this.fail(peer, id, '该座位尚未放置');
    if (this.players[seatId]) return this.fail(peer, id, '该座位已被占用', 'SEAT_OCCUPIED');
    // Guandan bots choose a brain: strong = DanLM transformer; easy = the small DanZero ONNX.
    let agentKey: GuandanAgentKey | undefined;
    if (this.engine.kind === 'guandan') {
      agentKey = payload.strength === 'easy' ? 'danzero_v1t' : defaultGuandanAgent();
    }
    // Doudizhu carries no second model: the tier switches how the pick is drawn from the
    // official ranked action values (strong = argmax, easy = value-weighted sampling).
    const strength: 'strong' | 'easy' = payload.strength === 'easy' ? 'easy' : 'strong';
    this.players[seatId] = this.newBot(seatId, agentKey, strength);
    return true;
  }

  /** Host removes a robot again; humans and mid-game seats are never touched. */
  private removeBot(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    if (isBoardGame(this.engine.kind)) return this.fail(peer, id, isBoardAiGame(this.engine.kind) ? '请在棋类准备页设置人机对弈' : this.engine.kind === 'junqi' ? '军棋仅支持真人联机' : '本游戏仅支持真人对弈');
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以移除机器人');
    if (this.engine.phase !== 'lobby') return this.fail(peer, id, '只能在准备阶段移除机器人');
    const seatId = payload.seatId;
    if (!Number.isInteger(seatId) || typeof seatId !== 'number' || seatId < 0 || seatId >= this.seatCount) {
      return this.fail(peer, id, '座位号无效');
    }
    const player = this.players[seatId];
    if (!player || !player.isBot) return this.fail(peer, id, '该座位没有机器人');
    this.players[seatId] = null;
    this.invalidateAutomation();
    return true;
  }

  /** 托管: the exact authenticated player opts their own seat into automatic play or cancels it. */
  private setAutoPlay(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    if (isBoardGame(this.engine.kind)) return this.fail(peer, id, isBoardAiGame(this.engine.kind) ? '请在棋类准备页设置人机对弈' : this.engine.kind === 'junqi' ? '军棋仅支持真人联机' : '本游戏仅支持真人对弈');
    const player = this.requiredPlayer(peer, id);
    if (!player) return false;
    if (typeof payload.enabled !== 'boolean') return this.fail(peer, id, '托管参数无效');
    if (!payload.enabled) {
      // Cancelling is always possible, even after a runtime failure.
      player.autoPlay = false;
      this.automationFailure = null;
      this.invalidateAutomation();
      return true;
    }
    const status = this.automationState();
    if (!status.available) return this.fail(peer, id, status.message ?? '托管服务暂不可用');
    if (this.engine.kind === 'guandan') {
      player.botAgent = 'danzero_v1t';
      player.botStrength = 'easy';
    }
    player.autoPlay = true;
    if (this.engine.phase === 'lobby') player.ready = true;
    return true;
  }

  /** A robot seat: no socket, always ready, managed from the start. */
  private newBot(seatId: number, agentKey: GuandanAgentKey | undefined, strength: 'strong' | 'easy'): Player {
    return {
      seatId,
      name: `机器人${seatId + 1}`,
      token: newToken(),
      ready: true,
      connected: false,
      peer: null,
      isBot: true,
      autoPlay: true,
      ...(agentKey ? { botAgent: agentKey } : {}),
      botStrength: strength,
    };
  }

  private configureSeats(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以调整座位');
    if (this.engine.kind === 'guandan') return this.fail(peer, id, '掼蛋固定四方座位，对家同队，无法自定义位置');
    if (isBoardGame(this.engine.kind)) return this.fail(peer, id, `${GAME_DEFINITIONS[this.engine.kind].name}使用固定座位，无法自定义位置`);
    if (this.roomMode === 'phone') return this.fail(peer, id, '手机开一桌的座位是固定的，无法调整');
    if (this.engine.phase !== 'lobby') return this.fail(peer, id, '只能在准备阶段调整座位');
    const positions = payload.positions;
    if (!Array.isArray(positions) || positions.length > this.seatCount) return this.fail(peer, id, '座位配置无效');
    const parsed: Position[] = [];
    for (const raw of positions) {
      const p = raw as Partial<Position> | null;
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.angle !== 'number') {
        return this.fail(peer, id, '座位配置无效');
      }
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.angle)) {
        return this.fail(peer, id, '座位配置无效');
      }
      parsed.push({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)), angle: p.angle });
    }
    if (this.players.some((p) => p !== null)) {
      // Seating has started: what is already placed is frozen, only append.
      if (parsed.length < this.positions.length) return this.fail(peer, id, '已有玩家入座，只能新增座位');
      for (let seat = 0; seat < this.positions.length; seat += 1) {
        const next = parsed[seat];
        const current = this.positions[seat];
        if (next.x !== current.x || next.y !== current.y || next.angle !== current.angle) {
          return this.fail(peer, id, '已有玩家入座，不能移动或删除已放置的座位');
        }
      }
    }
    this.positions = parsed;
    return true;
  }

  private setReady(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    const player = this.requiredPlayer(peer, id);
    if (!player) return false;
    if (this.engine.phase !== 'lobby') return this.fail(peer, id, '当前无法准备');
    if (typeof payload.ready !== 'boolean') return this.fail(peer, id, '准备状态无效');
    // A managed seat is ready by construction (a robot from its creation, a 托管 human on opting in),
    // so it may not unready itself and stall hosting: cancelling 托管 returns manual control first.
    if (!payload.ready && this.isManaged(player)) return this.fail(peer, id, '托管中，请先取消托管');
    player.ready = payload.ready;
    return true;
  }

  private renameSelf(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    const player = this.requiredPlayer(peer, id);
    if (!player) return false;
    const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 8) : '';
    if (name.length === 0) return this.fail(peer, id, '昵称无效');
    player.name = name;
    return true;
  }

  /** Host decision on a pending replacement request. Idempotent per request id. */
  private decideSeat(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以处理入座申请');
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (!requestId) return this.fail(peer, id, '申请编号无效');
    const record = this.requests.get(requestId);
    if (!record) return this.fail(peer, id, '该申请不存在或已处理');
    // Repeat decision: report success without touching tokens or seats a second time.
    if (record.status !== 'pending') return true;

    const target = this.players[record.seatId];
    if (!target || target.token !== record.previousToken) {
      record.status = 'cancelled';
      record.message = '该座位已被其他玩家使用，申请已作废';
      this.releaseRequestPointer(record.peer);
      record.peer.send(this.seatRequestMessage(record.id, record.seatId, 'cancelled', record.message));
      return true;
    }
    if (payload.approve !== true) {
      record.status = 'rejected';
      record.message = '房主拒绝了你的入座申请';
      this.releaseRequestPointer(record.peer);
      record.peer.send(this.seatRequestMessage(record.id, record.seatId, 'rejected', record.message));
      return true;
    }

    // Approval: rotate the credential, kick the old socket, keep every bit of game state, and hand
    // the requesting socket a normal session for exactly that seat. The binding itself claims the
    // socket, which cancels any queue it was still waiting in elsewhere.
    const requester = record.peer;
    if (target.peer) target.peer.supersede();
    target.token = newToken();
    target.peer = requester;
    target.name = record.name;
    target.connected = true;
    // A human takes this seat back: manual control, and any pending bot decision dies now, before
    // the session is revealed, so no stale inference can act for the new owner.
    target.isBot = false;
    target.autoPlay = false;
    this.invalidateAutomation();
    record.status = 'approved';
    record.message = '房主已同意你顶替该座位';
    this.sendSession(requester, target, record.id);
    return true;
  }

  private start(peer: Peer, id: string): boolean {
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以开始游戏');
    if (this.engine.phase !== 'lobby') return this.fail(peer, id, '游戏已经开始');
    if (!this.hostConnected) return this.fail(peer, id, '房主未连接');
    if (!this.sharedChess) {
      const seated = this.players.filter((p): p is Player => p !== null);
      if (seated.length !== this.seatCount) return this.fail(peer, id, `需要${SEAT_WORDS[this.seatCount]}名玩家入座`);
      // A managed seat (bot or 托管) may be offline: it is played by Room and needs no socket.
      if (!seated.every((p) => p.connected || this.isManaged(p))) return this.fail(peer, id, '有玩家掉线，等待重连');
      if (!seated.every((p) => p.ready)) return this.fail(peer, id, '有玩家尚未准备');
    }
    this.engine.start();
    return true;
  }

  private setJunqiMode(peer: Peer, payload: Record<string, unknown>, id: string): boolean {
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以切换军棋模式');
    if (!(this.engine instanceof JunqiGame)) return this.fail(peer, id, '当前不是军棋房间');
    if (this.phase !== 'lobby') return this.fail(peer, id, '只能在准备阶段切换军棋模式');
    const variant = payload.variant;
    if (variant !== 'two' && variant !== 'four') return this.fail(peer, id, '军棋模式无效');
    const size = variant === 'four' ? 4 : 2;
    if (size === this.seatCount) return true;
    if (size < this.seatCount && this.players.slice(size).some(Boolean)) return this.fail(peer, id, '请先让绿方、紫方离座，再切换双人模式');
    this.invalidateAutomation();
    for (let seat = size; seat < this.seatCount; seat++) this.cancelPendingSeat(seat, '军棋模式已切换，座位已取消');
    this.engine.setVariant(variant);
    this.players = Array.from({ length: size }, (_, seat) => this.players[seat] ?? null);
    for (const player of this.players) if (player) player.ready = this.isManaged(player);
    this.positions = (size === 4 ? [
      { x: .5, y: .88, angle: 0 }, { x: .12, y: .5, angle: 90 },
      { x: .5, y: .12, angle: 180 }, { x: .88, y: .5, angle: -90 },
    ] : PHONE_SEATS.junqi).map(p => ({ ...p }));
    return true;
  }

  private again(peer: Peer, id: string): boolean {
    if (!this.isHost(peer)) return this.fail(peer, id, '只有房主可以重开');
    const result = this.engine.restart();
    if (!result.ok) return this.fail(peer, id, result.message);
    for (const player of this.players) {
      if (!player) continue;
      // 托管 survives a new deal, and managed seats are ready for it again.
      player.ready = this.isManaged(player);
    }
    this.automationFailure = null;
    this.boardAiError = null;
    this.invalidateAutomation();
    this.resetBoardClock();
    this.cancelBoardAnalysis();
    this.seenActions.clear();
    this.seenOrder = [];
    return true;
  }

  // ---------------------------------------------------------------- snapshots

  /** Public read-only preview for `inspect`; no hands and no credentials. */
  summary(): RoomSummary {
    return {
      code: this.code,
      game: this.engine.kind,
      roomMode: this.roomMode,
      phase: this.engine.phase,
      seats: this.seatList(),
      hostSeatId: this.roomMode === 'phone' ? this.hostSeatId : null,
      hostConnected: this.hostConnected,
      spectatorCount: this.spectatorCount,
    };
  }

  snapshotFor(peer: Peer): Snapshot {
    // The private hand belongs to the exact live seat connection only: a superseded or foreign
    // socket gets an empty hand even if it still remembers a seat id.
    const self = this.playerFor(peer);
    const view = this.engine.view(self ? self.seatId : null);
    const kind = view.game;
    let boardAnalysis: RoomSnapshotFields['boardAnalysis'];
    if (isAnalyzableView(view)) {
      const { roundId } = analysisRecord(view);
      if (this.boardAnalysis && this.boardAnalysis.roundId !== roundId) this.cancelBoardAnalysis();
      const availability = this.analysisPolicy.availability(view.game);
      boardAnalysis = { ...(this.boardAnalysis ?? this.analysisState(view, 'idle')),
        available: availability.available, unavailableReason: availability.message };
    }
    const base: RoomSnapshotFields = {
      code: this.code,
      roomMode: this.roomMode,
      seats: this.seatList(),
      hand: self ? this.engine.handOf(self.seatId).slice() : [],
      selfSeat: self ? self.seatId : null,
      role: peer.role,
      spectatorCount: this.spectatorCount,
      spectatorPhrases: this.spectatorPhrases,
      isHost: this.isHost(peer),
      hostSeatId: this.roomMode === 'phone' ? this.hostSeatId : null,
      hostConnected: this.hostConnected,
      turnLimitSeconds: this.turnLimitSeconds,
      turnRemainingMs: this.turnTimerDeadline === null
        ? null
        : Math.max(0, this.turnTimerDeadline - Date.now()),
      turnSeatId: this.turnTimerSeat,
      ...(this.engine.flag ? { boardClock: this.boardClockView() } : {}),
      ...(boardAnalysis ? { boardAnalysis } : {}),
      seatRequests: this.isHost(peer) ? this.pendingRequests() : [],
      automation: this.automationState(),
      ...(isBoardAiGame(kind) ? { boardAi: {
        config: this.boardAiConfig ? { ...this.boardAiConfig } : null,
        levels: BOARD_AI_DIFFICULTIES.map(item => ({ ...item, ...this.boardPolicy.availability(kind, item.id) })),
        thinking: this.pendingBoardAi !== null, error: this.boardAiError,
      } } : {}),
      message: this.messageFor(peer),
      version: this.version,
      ...(this.dealPresentation && view.phase !== 'lobby' ? {
        dealAnimation: {
          id: this.dealPresentation.id,
          elapsedMs: Math.max(0, Date.now() - this.dealPresentation.startedAt),
          seatCount: this.dealPresentation.seatCount,
          cardsPerSeat: this.dealPresentation.cardsPerSeat,
        },
      } : {}),
    };
    // The engine's own fields decide the variant; spreading a union distributes the variants.
    return { ...base, ...view };
  }

  private seatList(): Seat[] {
    if (this.sharedChess) return this.positions.map((position, id) => ({
      id, name: this.boardAiConfig?.side === id ? `电脑·${boardAiLabel(this.boardAiConfig.difficulty)}` : isBlackFirstGame(this.engine.kind) ? stoneSideName(id) : id === 0 ? this.engine.kind === 'chess' ? '白方' : '红方' : '黑方', connected: this.hostConnected, ready: true,
      count: 0, passed: false, isBot: this.boardAiConfig?.side === id, autoPlay: this.boardAiConfig?.side === id, ...position,
    }));
    return this.positions.map((position, seat) => {
      const player = this.players[seat] ?? null;
      return {
        id: seat,
        name: player?.name ?? null,
        connected: this.boardAiConfig?.side === seat && player?.isBot ? true : player?.connected ?? false,
        ready: player?.ready ?? false,
        count: this.engine.handOf(seat).length,
        passed: this.engine.passedAt(seat),
        isBot: player?.isBot ?? false,
        ...(player?.botStrength ? { botTier: player.botStrength } : {}),
        autoPlay: player?.autoPlay ?? false,
        ...position,
      };
    });
  }

  private pendingRequests(): SeatRequest[] {
    const list: SeatRequest[] = [];
    for (const record of this.requests.values()) {
      if (record.status !== 'pending') continue;
      list.push({
        id: record.id,
        seatId: record.seatId,
        name: record.name,
        previousName: record.previousName,
        connected: this.players[record.seatId]?.connected ?? false,
      });
    }
    return list;
  }

  private messageFor(peer: Peer): string {
    if (this.boardAiConfig && this.phase === 'playing') {
      if (this.boardAiError) return `电脑行棋已暂停：${this.boardAiError}`;
      if (!this.hostConnected || this.paused()) return '等待玩家重连后继续';
      if (this.pendingBoardAi) return '电脑正在思考，请稍候';
    }
    if (this.engine.phase === 'lobby') {
      if (this.sharedChess) return '两人共用这块平板，直接开始对弈';
      if (this.positions.length < this.seatCount) return `请房主放置座位（${this.positions.length}/${this.seatCount}）`;
      const seated = this.players.filter((player) => player !== null).length;
      if (seated < this.seatCount) return `等待玩家入座（${seated}/${this.seatCount}）`;
      const allReady = this.players.every((player) => player === null || player.ready);
      return allReady ? '等待房主开始游戏' : '等待玩家准备';
    }
    if (this.paused()) return '有玩家掉线，等待重连';
    const self = this.playerFor(peer);
    return this.engine.statusText(self ? self.seatId : null, (seat) => this.sharedChess ? isBlackFirstGame(this.engine.kind) ? stoneSideName(seat) : seat === 0 ? this.engine.kind === 'chess' ? '白方' : '红方' : '黑方' : this.players[seat]?.name ?? `玩家${seat + 1}`);
  }

  // ---------------------------------------------------------------- identity helpers

  /**
   * True while a seat the engine still needs is offline: game commands wait for the reconnect. A
   * managed seat (bot or 托管) keeps playing while offline, so it never pauses the table.
   */
  private paused(): boolean {
    return this.players.some(
      (player) =>
        player !== null &&
        !this.isManaged(player) &&
        !player.connected &&
        this.engine.requiresConnection(player.seatId),
    );
  }

  /** The player this exact live connection owns, or null for tables, waiters and stale sockets. */
  private playerFor(peer: Peer): Player | null {
    if (peer.role !== 'player' || peer.seatId === null) return null;
    const player = this.players[peer.seatId];
    if (!player) return null;
    if (player.peer !== peer || player.token !== peer.token) return null;
    return player;
  }

  private isHost(peer: Peer): boolean {
    if (this.roomMode === 'tablet') {
      return peer.role === 'table' && this.hostPeer === peer && peer.seatId === null && peer.token === this.hostToken;
    }
    if (this.hostSeatId === null) return false;
    const player = this.playerFor(peer);
    return player !== null && player.seatId === this.hostSeatId;
  }

  private spectatorFor(peer: Peer): Spectator | null {
    if (peer.room !== this || peer.role !== 'spectator' || peer.seatId !== null || !peer.token) return null;
    const spectator = this.spectators.get(peer.token);
    return spectator?.peer === peer ? spectator : null;
  }

  private authenticated(peer: Peer): boolean {
    return peer.room === this && (this.isHost(peer) || this.playerFor(peer) !== null || this.spectatorFor(peer) !== null);
  }

  // ---------------------------------------------------------------- automation

  /** A seat Room plays by itself: a host-added bot, or a human who opted into 托管. */
  private isManaged(player: Player): boolean {
    return player.isBot || player.autoPlay;
  }

  /** Public automation status; the honest reason whenever this room cannot use bots. */
  private automationState(): RoomAutomation {
    if (this.automationFailure !== null) return { available: false, message: this.automationFailure };
    if (isBoardGame(this.engine.kind)) return { available: false, message: isBoardAiGame(this.engine.kind) ? '请在棋类准备页设置人机对弈' : this.engine.kind === 'junqi' ? '军棋仅支持真人联机' : '本游戏仅支持真人对弈' };
    const status = this.engine.kind === 'doudizhu' ? this.policy.availability() : this.guandanPolicy.availability();
    return { available: status.available, message: status.message };
  }

  /** Drop the pending decision, aborting an in-flight inference and its guard timers. */
  private cancelAutomation(): void {
    const pending = this.pendingDecision;
    if (!pending) return;
    this.pendingDecision = null;
    clearTimeout(pending.timer);
    clearTimeout(pending.guard);
    pending.controller?.abort();
  }

  /** Discard pending work because the state that authorised it changed. */
  private invalidateAutomation(): void {
    this.automationEpoch += 1;
    this.cancelAutomation();
    this.cancelBoardAi();
  }

  /** Re-arm after any change: cancel while the room is paused or unavailable, else look for a turn. */
  private refreshAutomation(): void {
    if (isBoardAiGame(this.engine.kind)) { this.refreshBoardAi(); return; }
    if (this.paused() || this.automationState().available === false) {
      this.cancelAutomation();
      return;
    }
    this.scheduleAutomation();
  }

  // ---------------------------------------------------------------- turn clock
  //
  // The room owns the deadline; engines only supply one legal fallback. A managed seat is omitted
  // because automation already drives it, and a disconnected required seat pauses the whole room,
  // so reconnect gets a fresh clock rather than losing time to an offline screen.

  /** The human decision that should be timed right now, or null. */
  private turnTimerTarget(): TurnTimerTarget | null {
    if (isBoardGame(this.engine.kind)) return null;
    if (this.turnLimitSeconds <= 0 || this.paused()) return null;
    const view = this.engine.view(null);
    if (view.game === 'doudizhu') {
      if (view.phase !== 'bidding' && view.phase !== 'playing') return null;
      const seatId = view.turn;
      if (seatId === null) return null;
      const player = this.players[seatId];
      if (!player || this.isManaged(player) || !player.connected) return null;
      return {
        seatId,
        kind: view.phase === 'bidding' ? 'bid' : 'play',
        token: player.token,
        eligibleSignature: '',
      };
    }
    if (view.phase === 'tribute') {
      // Guandan can owe two human picks at once. The first pending seat is timed, then the next.
      for (let seat = 0; seat < this.seatCount; seat += 1) {
        const player = this.players[seat];
        if (!player || this.isManaged(player) || !player.connected) continue;
        const scope = this.engine.view(seat);
        if (scope.game !== 'guandan' || scope.privateAction === null) continue;
        if (scope.privateAction.committed !== null) continue;
        return {
          seatId: seat,
          kind: scope.privateAction.kind,
          token: player.token,
          eligibleSignature: scope.privateAction.eligibleIds.join(','),
        };
      }
      return null;
    }
    if (view.phase !== 'playing' || view.turn === null) return null;
    const player = this.players[view.turn];
    if (!player || this.isManaged(player) || !player.connected) return null;
    return { seatId: view.turn, kind: 'play', token: player.token, eligibleSignature: '' };
  }

  /**
   * Identity of the current decision. Refresh keeps a running clock when this is unchanged, so a
   * rename or another player's non-turn action cannot be used to reset the countdown.
   */
  private turnTimerKey(target: TurnTimerTarget): string {
    const view = this.engine.view(null);
    return [
      this.turnLimitSeconds,
      this.dealPresentation?.id ?? 0,
      target.seatId,
      target.kind,
      target.token,
      target.eligibleSignature,
      view.phase,
      view.turn,
      view.tablePlays.length,
      view.trickStartIndex,
      this.engine.handOf(target.seatId).map((card) => card.id).join(','),
    ].join('|');
  }

  /** Re-evaluate the clock after any state change; keep an unchanged running deadline intact. */
  private refreshTurnTimer(): void {
    const target = this.turnTimerTarget();
    const signature = target === null ? null : this.turnTimerKey(target);
    if (signature !== null && signature === this.turnTimerSignature && this.turnTimer !== null) return;
    this.clearTurnTimer();
    if (target === null || signature === null) return;

    // The visible deal comes first; the player should get the full limit after the cards settle.
    const presentation = this.dealPresentation;
    const dealWait = presentation
      ? Math.max(0, presentation.startedAt + dealDuration(presentation.seatCount, presentation.cardsPerSeat) - Date.now())
      : 0;
    const delay = dealWait + this.turnLimitSeconds * 1000;
    const epoch = ++this.turnTimerEpoch;
    this.turnTimerSeat = target.seatId;
    this.turnTimerDeadline = Date.now() + delay;
    this.turnTimerSignature = signature;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      this.expireTurn(epoch, target.seatId);
    }, delay);
    this.turnTimer.unref();
  }

  private clearTurnTimer(): void {
    this.turnTimerEpoch += 1;
    if (this.turnTimer !== null) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnTimerDeadline = null;
    this.turnTimerSeat = null;
    this.turnTimerSignature = null;
  }

  /** One legal fallback from the engine, committed exactly like any other game command. */
  private expireTurn(epoch: number, seatId: number): void {
    if (epoch !== this.turnTimerEpoch || this.turnTimerSeat !== seatId) return;
    const target = this.turnTimerTarget();
    if (target === null || target.seatId !== seatId) {
      this.refreshTurnTimer();
      return;
    }
    const action = this.engine.timeoutAction(seatId);
    if (action !== null) {
      const result = this.engine.command(seatId, action.type, action.payload);
      if (result.ok) this.recordCommand(seatId, action.type, action.payload);
    }
    // Publish the next deadline even when the engine returned no action (for example the seat
    // changed at the same instant), otherwise every client would sit at zero.
    this.version += 1;
    this.refreshAutomation();
    this.refreshTurnTimer();
    this.broadcast();
  }

  /** True while a fresh decision may still be committed; identity, generation and public state. */
  private decisionIsCurrent(decision: PendingDecision): boolean {
    if (this.pendingDecision !== decision) return false;
    if (decision.generation !== this.automationEpoch) return false;
    const player = this.players[decision.seatId];
    if (!player || !this.isManaged(player) || player.token !== decision.token) return false;
    if (this.paused()) return false;
    const view = this.engine.view(null);
    if (isBoardGame(view.game)) return false;
    if (view.game === 'guandan') {
      if (view.phase !== decision.phase) return false;
      if (view.phase === 'tribute') {
        if (decision.tributeKind === undefined) return false;
        const scope = this.engine.view(decision.seatId);
        if (scope.game !== 'guandan' || scope.privateAction === null) return false;
        const action = scope.privateAction;
        if (action.kind !== decision.tributeKind || action.committed !== null) return false;
        return action.eligibleIds.join(',') === decision.eligibleSignature;
      }
      if (view.turn !== decision.seatId) return false;
      if (view.tablePlays.length !== decision.historyLength) return false;
      if (view.trickStartIndex !== decision.trickStartIndex) return false;
      return this.engine.handOf(decision.seatId).map((card) => card.id).join(',') === decision.handSignature;
    }
    if (view.game !== 'doudizhu') return false;
    if (view.phase !== decision.phase || view.turn !== decision.seatId) return false;
    if (view.tablePlays.length !== decision.historyLength) return false;
    if (view.trickStartIndex !== decision.trickStartIndex) return false;
    return this.engine.handOf(decision.seatId).map((card) => card.id).join(',') === decision.handSignature;
  }

  /** Schedule at most one automatic action, spaced by the visible action cadence. */
  private scheduleAutomation(): void {
    if (this.pendingDecision !== null) return;
    if (this.paused()) return;
    if (this.automationState().available === false) return;
    const view = this.engine.view(null);
    if (isBoardGame(view.game)) return;
    if (view.game === 'guandan') {
      this.scheduleGuandanTurn(view);
      return;
    }
    if (view.game !== 'doudizhu') return;
    if (view.phase !== 'bidding' && view.phase !== 'playing') return;
    const turn = view.turn;
    if (turn === null) return;
    const player = this.players[turn];
    if (!player || !this.isManaged(player)) return;
    this.armDecision({
      seatId: turn,
      generation: this.automationEpoch,
      phase: view.phase,
      turn,
      version: this.version,
      historyLength: view.tablePlays.length,
      trickStartIndex: view.trickStartIndex,
      handSignature: this.engine.handOf(turn).map((card) => card.id).join(','),
      token: player.token,
      timer: undefined,
      guard: undefined,
      controller: null,
    });
  }

  /** Guandan: one play/pass decision in `playing`, or the next owed exchange pick in `tribute`. */
  private scheduleGuandanTurn(view: GuandanGameFields): void {
    let seatId: number | null = null;
    let tributeKind: 'tribute' | 'return' | undefined;
    let eligibleSignature: string | undefined;
    if (view.phase === 'tribute') {
      for (let seat = 0; seat < this.seatCount; seat += 1) {
        const player = this.players[seat];
        if (!player || !this.isManaged(player)) continue;
        const scope = this.engine.view(seat);
        if (scope.game !== 'guandan' || scope.privateAction === null) continue;
        if (scope.privateAction.committed !== null) continue;
        seatId = seat;
        tributeKind = scope.privateAction.kind;
        eligibleSignature = scope.privateAction.eligibleIds.join(',');
        break;
      }
      if (seatId === null) return;
    } else if (view.phase === 'playing') {
      seatId = view.turn;
      if (seatId === null) return;
    } else {
      return;
    }
    const player = this.players[seatId];
    if (!player || !this.isManaged(player)) return;
    this.armDecision({
      seatId,
      generation: this.automationEpoch,
      phase: view.phase,
      turn: view.turn,
      version: this.version,
      historyLength: view.tablePlays.length,
      trickStartIndex: view.trickStartIndex,
      handSignature: this.engine.handOf(seatId).map((card) => card.id).join(','),
      token: player.token,
      timer: undefined,
      guard: undefined,
      controller: null,
      ...(tributeKind !== undefined ? { tributeKind, eligibleSignature } : {}),
    });
  }

  /** Publish one scheduled decision and arm its visible delay; shared by both games. */
  private armDecision(decision: PendingDecision): void {
    this.pendingDecision = decision;
    const presentation = this.dealPresentation;
    const dealWait = presentation ? presentation.startedAt + dealDuration(presentation.seatCount, presentation.cardsPerSeat) - Date.now() : 0;
    const interval = this.engine.kind === 'guandan' ? GUANDAN_AUTOMATION_INTERVAL_MS : AUTOMATION_INTERVAL_MS;
    const delay = Math.max(dealWait, Math.min(Math.max(interval, this.nextAutomationAt - Date.now()), interval * 5));
    decision.timer = setTimeout(() => {
      decision.timer = undefined;
      void this.runAutomation(decision);
    }, delay);
    decision.timer.unref();
  }

  /** Run one automatic action: local rule bidding, or one runtime inference for card play. */
  private async runAutomation(decision: PendingDecision): Promise<void> {
    if (!this.decisionIsCurrent(decision) || decision.generation !== this.automationEpoch) {
      if (this.pendingDecision === decision) this.cancelAutomation();
      return;
    }
    const view = this.engine.view(null);
    if (isBoardGame(view.game)) return;
    if (view.game === 'guandan') {
      if (view.phase !== decision.phase) {
        this.cancelAutomation();
        return;
      }
      if (view.phase === 'tribute') {
        // Deterministic local picks: DanLM covers accepted plays, not the tribute exchange.
        this.applyGuandanTribute(decision);
        return;
      }
      if (view.phase !== 'playing') {
        this.cancelAutomation();
        return;
      }
      await this.runGuandanPlay(decision, view);
      return;
    }
    if (view.game !== 'doudizhu' || view.phase !== decision.phase) {
      this.cancelAutomation();
      return;
    }
    if (view.phase === 'bidding') {
      // DouZero ships no bidding net: this is a clearly named deterministic local rule policy.
      this.applyAutomation(decision.seatId, 'bid', { value: this.localBid(decision.seatId, view.bid) });
      return;
    }
    const controller = new AbortController();
    decision.controller = controller;
    decision.guard = setTimeout(() => {
      decision.guard = undefined;
      controller.abort();
      if (this.pendingDecision === decision) {
        this.failAutomation('机器人推理超时，已停止自动出牌');
      }
    }, AUTOMATION_TIMEOUT_MS);
    decision.guard.unref();
    let move: string[];
    try {
      move = await this.policy.chooseMove(
        this.runtimeState(decision.seatId, view),
        controller.signal,
        this.players[decision.seatId]?.botStrength ?? 'strong',
      );
    } catch {
      clearTimeout(decision.guard);
      decision.guard = undefined;
      if (this.pendingDecision === decision) this.failAutomation('机器人推理失败，已停止自动出牌');
      return;
    }
    clearTimeout(decision.guard);
    decision.guard = undefined;
    if (this.pendingDecision !== decision) return; // cancelled while the model was thinking
    if (!this.decisionIsCurrent(decision)) {
      this.cancelAutomation();
      return;
    }
    this.applyAutomation(decision.seatId, move.length === 0 ? 'pass' : 'play', move.length === 0 ? {} : { cards: move });
  }

  /**
   * One ready DanLM inference for the managed seat's play or pass. Failures park the seat
   * honestly (the 托管 status explains why) instead of falling back to a weaker bot.
   */
  private async runGuandanPlay(decision: PendingDecision, view: GuandanGameFields): Promise<void> {
    const controller = new AbortController();
    decision.controller = controller;
    decision.guard = setTimeout(() => {
      decision.guard = undefined;
      controller.abort();
      if (this.pendingDecision === decision) {
        this.failAutomation('机器人推理超时，已停止自动出牌');
      }
    }, AUTOMATION_TIMEOUT_MS);
    decision.guard.unref();
    let move: string[];
    try {
      move = await this.guandanPolicy.chooseTurn(this.guandanRuntimeState(decision.seatId, view), controller.signal);
    } catch (error) {
      clearTimeout(decision.guard);
      decision.guard = undefined;
      if (this.pendingDecision === decision) {
        console.error(`[guandan] room ${this.code} seat ${decision.seatId}: inference failed`, error);
        this.failAutomation('机器人推理失败，已停止自动出牌');
      }
      return;
    }
    clearTimeout(decision.guard);
    decision.guard = undefined;
    if (this.pendingDecision !== decision) return; // cancelled while the model was thinking
    if (!this.decisionIsCurrent(decision)) {
      this.cancelAutomation();
      return;
    }
    if (move.length === 0) {
      this.applyAutomation(decision.seatId, 'pass', {});
      return;
    }
    this.applyAutomation(decision.seatId, 'play', { cards: move });
  }

  /** Deterministic local picks for 纳贡/还贡, mirroring the localBid rule precedent. */
  private applyGuandanTribute(decision: PendingDecision): void {
    if (decision.tributeKind === undefined) {
      this.cancelAutomation();
      return;
    }
    const scope = this.engine.view(decision.seatId);
    const action = scope.game === 'guandan' ? scope.privateAction : null;
    if (action === null || action.kind !== decision.tributeKind || action.committed !== null) {
      this.cancelAutomation();
      return;
    }
    const hand = this.engine.handOf(decision.seatId);
    const faces = new Map(hand.map((card) => [card.id, card] as const));
    const eligible = action.eligibleIds.flatMap((id) => {
      const card = faces.get(id);
      return card ? [card] : [];
    });
    if (eligible.length === 0) {
      this.failAutomation('机器人无法交贡：没有可选的牌');
      return;
    }
    let cardId = eligible[0]!.id;
    if (action.kind === 'return') {
      // Give back what helps the receiver least: a face they hold fewest of first, then the
      // weakest strength (both engines keep hands strength-sorted, so ties stay deterministic).
      const seed: GuandanGame | null = this.engine instanceof GuandanGame ? this.engine : null;
      const mine = seed ? seed.exchange.pairs.find((pair) => pair.receiver === decision.seatId) : undefined;
      const level = seed ? seed.playedLevel : 15;
      const receiverFaces = new Map<number, number>();
      if (mine) {
        for (const card of this.engine.handOf(mine.giver)) {
          receiverFaces.set(card.rank, (receiverFaces.get(card.rank) ?? 0) + 1);
        }
      }
      const best = eligible
        .map((card, index) => ({ card, index }))
        .sort((a, b) =>
          (receiverFaces.get(a.card.rank) ?? 0) - (receiverFaces.get(b.card.rank) ?? 0) ||
          guandanRankStrength(a.card.rank, level) - guandanRankStrength(b.card.rank, level) ||
          a.index - b.index,
        )[0];
      if (best) cardId = best.card.id;
    }
    this.applyAutomation(decision.seatId, action.kind === 'tribute' ? 'tribute' : 'returnTribute', { cardId });
  }

  /** Public deal facts for the runtime: the captured deal seed plus this deal's official rows. */
  private guandanRuntimeState(seatId: number, view: GuandanGameFields): GuandanTurnInput {
    if (!(this.engine instanceof GuandanGame) || this.engine.dealSeed === null) {
      throw new Error('掼蛋机器人缺少本副重放上下文');
    }
    const seed = this.engine.dealSeed;
    const player = this.players[seatId];
    return {
      agent: player?.botAgent ?? defaultGuandanAgent(),
      level: seed.playedLevel,
      teamLevels: [seed.teamLevels[0], seed.teamLevels[1]],
      firstPlayer: seed.leader,
      dealHands: seed.hands,
      rows: this.engine.replayRows().slice(seed.playStart),
      tribute: this.engine.exchange.pairs,
      selfSeat: seatId,
      hand: this.engine.handOf(seatId),
      cursor: view.lastPlay,
    };
  }


  /** Private authority path: an automatic action from a managed seat, never a fabricated peer. */
  private applyAutomation(seatId: number, type: GameCommandType, payload: Record<string, unknown>): void {
    const player = this.players[seatId];
    if (!player || !this.isManaged(player)) {
      this.cancelAutomation();
      return;
    }
    const result = this.engine.command(seatId, type, payload);
    if (!result.ok) {
      this.failAutomation(`${player.name}：${result.message}`);
      return;
    }
    this.recordCommand(seatId, type, payload);
    this.nextAutomationAt = Date.now() + (this.engine.kind === 'guandan' ? GUANDAN_AUTOMATION_INTERVAL_MS : AUTOMATION_INTERVAL_MS);
    this.cancelAutomation();
    this.version += 1;
    this.refreshAutomation();
    this.refreshTurnTimer();
    this.broadcast();
  }

  /** Honest public failure: stop automatic progress here and tell the room why. */
  private failAutomation(reason: string): void {
    this.cancelAutomation();
    this.automationFailure = reason;
    this.version += 1;
    this.refreshTurnTimer();
    this.broadcast();
  }

  /** Deterministic local bidding: never passes at the opening bid, so no all-pass redeal loop. */
  private localBid(seatId: number, currentBid: number): 0 | 1 | 2 | 3 {
    if (currentBid === 0) return 1;
    let strength = 0;
    for (const card of this.engine.handOf(seatId)) {
      if (card.rank >= 15) strength += 1;
    }
    if (currentBid === 1) return strength >= 3 ? 2 : 0;
    if (currentBid === 2) return strength >= 4 ? 3 : 0;
    return 0;
  }

  /** Public snapshot of the table for the runtime: own hand plus public facts only. */
  private runtimeState(seatId: number, view: DoudizhuGameFields): DouZeroState {
    const counts = this.players.map((player) => (player ? this.engine.handOf(player.seatId).length : 0));
    return {
      selfSeat: seatId,
      turn: view.turn ?? seatId,
      landlord: view.landlord ?? seatId,
      hand: this.engine.handOf(seatId),
      bottom: view.bottom,
      counts: [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0],
      tablePlays: view.tablePlays,
      lastPlay: view.lastPlay,
    };
  }

  private newPlayer(seatId: number, name: string, peer: Peer): Player {
    return {
      seatId,
      name,
      token: newToken(),
      ready: false,
      connected: true,
      peer,
      isBot: false,
      autoPlay: false,
    };
  }

  /** Bind a socket to a seat and hand it the session for it. */
  private bindPlayer(peer: Peer, player: Player, requestId: string): void {
    this.sendSession(peer, player, requestId);
    this.touchAndBroadcast();
  }

  /** Session + ack for an existing seat; the caller owns version/broadcast timing. */
  private sendSession(peer: Peer, player: Player, requestId: string): void {
    // A socket holds one identity: an accepted seat ends any replacement request it was waiting in,
    // here or in another room, and clears the pointer.
    this.claimPeer(peer);
    if (this.spectatorFor(peer)) this.spectators.delete(peer.token!);
    peer.room = this;
    peer.role = 'player';
    peer.seatId = player.seatId;
    peer.token = player.token;
    peer.send({
      type: 'session',
      id: requestId,
      code: this.code,
      game: this.engine.kind,
      roomMode: this.roomMode,
      token: player.token,
      role: 'player',
      seatId: player.seatId,
    });
    peer.send({ type: 'ack', id: requestId });
  }

  private seatRequestMessage(
    requestId: string,
    seatId: number,
    status: 'pending' | 'rejected' | 'cancelled',
    message: string,
  ): ServerMessage {
    return { type: 'seat-request', id: requestId, requestId, code: this.code, seatId, status, message };
  }

  /** Re-answer a repeated requestSeat without filing or granting anything twice. */
  private replayRequest(peer: Peer, record: SeatRequestRecord, requestId: string): void {
    if (record.status === 'approved') {
      const occupant = this.players[record.seatId];
      if (occupant && occupant.peer === peer) {
        this.sendSession(peer, occupant, requestId);
        peer.send({ type: 'state', state: this.snapshotFor(peer) });
        return;
      }
      peer.send(this.seatRequestMessage(requestId, record.seatId, 'cancelled', '该座位的顶替已经完成'));
      peer.send({ type: 'ack', id: requestId });
      return;
    }
    if (record.status === 'pending') peer.requestRoom = this;
    else this.releaseRequestPointer(peer);
    peer.send(this.seatRequestMessage(requestId, record.seatId, record.status === 'pending' ? 'pending' : record.status, record.message));
    peer.send({ type: 'ack', id: requestId });
  }

  /**
   * One socket, one room: drop any pending seat request this socket filed elsewhere through that
   * room's own cancel path, so its queue cannot later approve and pull the socket back.
   */
  private claimPeer(peer: Peer): void {
    const other = peer.requestRoom;
    if (other && other !== this) other.cancelSeatRequest(peer);
    this.cancelRequestsOf(peer);
    peer.requestRoom = null;
  }

  /**
   * Drop this room's claim on the socket's pointer once the request it named is finished. A newer
   * request of the same socket may still be pending here (its id superseded the finished one), and
   * only that pending request owns the pointer — otherwise a close would cancel nothing while a
   * dead waiter stayed in the queue.
   */
  private releaseRequestPointer(peer: Peer): void {
    if (peer.requestRoom !== this) return;
    for (const record of this.requests.values()) {
      if (record.peer === peer && record.status === 'pending') return;
    }
    peer.requestRoom = null;
  }

  /** Mark every pending request of this socket cancelled; returns whether anything changed. */
  private cancelRequestsOf(peer: Peer): boolean {
    let changed = false;
    for (const record of this.requests.values()) {
      if (record.peer !== peer || record.status !== 'pending') continue;
      record.status = 'cancelled';
      record.message = '申请已取消';
      changed = true;
    }
    if (peer.requestRoom === this) peer.requestRoom = null;
    return changed;
  }

  private pruneRequests(): void {
    while (this.requests.size > MAX_REMEMBERED_REQUESTS) {
      const index = this.requestOrder.findIndex((id) => this.requests.get(id)?.status !== 'pending');
      if (index < 0) break;
      const [oldest] = this.requestOrder.splice(index, 1);
      if (oldest !== undefined) this.requests.delete(oldest);
    }
  }

  /** Hand host rights of a phone room to a connected player, or to nobody if all are offline. */
  private reassignHost(): void {
    // Robots never gain host rights: only a connected human may take the phone-room seat over.
    const next = this.players.find((p): p is Player => p !== null && p.connected && !p.isBot);
    this.hostSeatId = next ? next.seatId : null;
  }

  // ---------------------------------------------------------------- internals

  private requiredPlayer(peer: Peer, id: string): Player | null {
    if (peer.role !== 'player' || peer.seatId === null) {
      this.fail(peer, id, '只有玩家可以执行该操作');
      return null;
    }
    const player = this.playerFor(peer);
    if (!player) {
      this.fail(peer, id, '连接已失效，请重新进入房间', 'INVALID_CREDENTIAL');
      return null;
    }
    return player;
  }

  private fail(peer: Peer, id: string, message: string, code?: ErrorCode): false {
    peer.send({ type: 'error', id: id || undefined, message, ...(code ? { code } : {}) });
    return false;
  }

  private touchAndBroadcast(): void {
    if (this.empty) {
      if (this.emptySince === null) this.emptySince = Date.now();
    } else {
      this.emptySince = null;
    }
    this.version += 1;
    // Roster/connection changes decide whether automation and clocks may run at all.
    const now = this.boardNow();
    if (!this.expireBoardClock(now)) this.refreshBoardClock(now);
    this.refreshAutomation();
    this.refreshTurnTimer();
    this.broadcast();
  }

  /** Viewers affect the public roster count, never pause, clocks or room retention. */
  private publishSpectators(): void {
    this.version += 1;
    this.broadcast();
  }

  /** Stop every room-owned timer/work item: called before deletion and on process shutdown. */
  dispose(message = '房间已关闭'): void {
    this.invalidateAutomation();
    this.cancelBoardAnalysis();
    this.clearTurnTimer();
    this.stopBoardClock(this.boardNow());
    for (const spectator of this.spectators.values()) {
      const peer = spectator.peer;
      if (!peer) continue;
      this.cancelRequestsOf(peer);
      peer.send({ type: 'dissolved', code: this.code, message });
      peer.room = null;
      peer.role = 'table';
      peer.token = null;
    }
    this.spectators.clear();
  }

  broadcast(): void {
    this.collectObserve();
    if (this.hostPeer) this.hostPeer.send({ type: 'state', state: this.snapshotFor(this.hostPeer) });
    for (const player of this.players) {
      if (player?.peer) player.peer.send({ type: 'state', state: this.snapshotFor(player.peer) });
    }
    for (const spectator of this.spectators.values()) {
      if (spectator.peer) spectator.peer.send({ type: 'state', state: this.snapshotFor(spectator.peer) });
    }
  }

  /** One ephemeral message to every currently bound device. */
  private sendToAudience(message: ServerMessage): void {
    if (this.hostPeer) this.hostPeer.send(message);
    for (const player of this.players) {
      if (player?.peer) player.peer.send(message);
    }
    for (const spectator of this.spectators.values()) spectator.peer?.send(message);
  }

  /** The opt-in collector records one deal per seed instance and one result per finish. */
  private collectObserve(): void {
    if (!guandanCollector.enabled || !(this.engine instanceof GuandanGame)) return;
    const engine = this.engine;
    const seed = engine.dealSeed;
    if (seed !== null && seed !== this.collectSeedRef) {
      this.collectSeedRef = seed;
      this.collectFinishDeal = -1;
      this.collectDealSeq += 1;
      guandanCollector.deal(
        {
          roomCode: this.code,
          game: 'guandan',
          dealSeq: this.collectDealSeq,
          deal: engine.deal,
          level: seed.playedLevel,
          teamLevels: [seed.teamLevels[0], seed.teamLevels[1]],
          leader: seed.leader,
          hands: seed.hands,
          tribute: engine.exchange.pairs,
        },
        null,
      );
    }
    if (engine.phase === 'finished' && this.collectFinishDeal !== engine.deal) {
      this.collectFinishDeal = engine.deal;
      guandanCollector.dealResult(
        { roomCode: this.code, game: 'guandan', deal: engine.deal, dealSeq: this.collectDealSeq },
        engine.result,
      );
    }
  }
}
