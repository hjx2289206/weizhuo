// Shared wire protocol between the server authority and the Vue client.
// Owned by the CoreFoundation slice; every other slice consumes these types verbatim.

import type { JunqiView } from './junqi';
import type { XiangqiView } from './xiangqi';
import type { ChessView } from './chess';
import type { StoneView } from './stones';
import type { ReversiView } from './reversi';
export type Suit = 'spade' | 'heart' | 'club' | 'diamond' | 'joker';

/** rank: 3..15 (15 === 2), 16 small joker, 17 big joker. Kept identical for both games. */
export interface Card {
  id: string;
  rank: number;
  suit: Suit;
}

/** Normalized 0..1 layout coordinates; angle in degrees, inward orientation. */
export interface Position {
  x: number;
  y: number;
  angle: number;
}

export interface Seat extends Position {
  id: number;
  name: string | null;
  connected: boolean;
  ready: boolean;
  count: number;
  passed: boolean;
  /** Host-added DouZero robot: no socket, always ready, never gains host rights. */
  isBot: boolean;
  /** Robot tier for both games: strong = strongest inference, easy = deliberately softer. */
  botTier?: 'strong' | 'easy';
  /** This seat is played automatically (bot, or a human who opted into 托管). */
  autoPlay: boolean;
}

/** Which game a room runs. */
export type GameKind = 'doudizhu' | 'guandan' | 'junqi' | 'xiangqi' | 'chess' | 'go' | 'gomoku' | 'reversi';

/** Doudizhu phases, unchanged apart from living in its own union. */
export type DoudizhuPhase = 'lobby' | 'bidding' | 'playing' | 'finished';

/** Guandan phases: exchange stages live inside the state, not as extra phases. */
export type GuandanPhase = 'lobby' | 'tribute' | 'playing' | 'finished';

/** Common phase union; never a bare string. */
export type Phase = DoudizhuPhase | GuandanPhase | 'deploying';

/**
 * Which board a room runs: `tablet` = one shared table screen plus phones,
 * `phone` = every player holds a phone with the full board (手机开一桌).
 */
export type RoomMode = 'tablet' | 'phone';

/** Machine ids of the ten Guandan play kinds. */
export type GuandanKind =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triplePair'
  | 'straight'
  | 'threePairs'
  | 'twoTriples'
  | 'bomb'
  | 'straightFlush'
  | 'fourJokers';

/**
 * One interpreted Guandan play, produced only by the server after recomputing the claim from the
 * raw cards. `primaryRank` is the raw encoded group rank, or the raw encoded HIGH endpoint of a
 * sequence; `low` is the natural sequence window start (1..10 / 1..12 / 1..13) or null. `key`
 * identifies the semantic claim (kind, count, ranks, pair, low, straight-flush suit) and never
 * depends on physical ids, card order or equivalent wild copies.
 */
export interface GuandanDeclaration {
  key: string;
  kind: GuandanKind;
  label: string;
  count: number;
  primaryRank: number;
  secondaryRank: number | null;
  low: number | null;
  suit: Exclude<Suit, 'joker'> | null;
  substitutions: { cardId: string; rank: number; suit: Exclude<Suit, 'joker'> }[];
}

/**
 * One server-computed play suggestion. The client only selects these exact physical cards; the
 * normal play command still revalidates them. `claim` is present only for Guandan, where the same
 * cards may have more than one legal reading.
 */
export interface HintPlay {
  cards: string[];
  label: string;
  claim?: string;
}

/**
 * One accepted play of the current round, replayed as public history.
 *
 * `scatter` is the authoritative landing offset, generated once when the play is accepted and
 * never regenerated: x/y are offsets as fractions of min(stageW, stageH) bounded to
 * [-0.045, 0.045]; angle is degrees bounded to [-8, 8]. Physical cards stay raw: nothing that
 * renders a counter may treat a claimed rank as a physical rank.
 */
export interface TablePlay {
  /** Unique for the room lifetime; ids are never reused across rounds. */
  id: string;
  seatId: number;
  cards: Card[];
  kind: string;
  /** Present on every Guandan record, absent for Doudizhu. */
  claim?: GuandanDeclaration;
  scatter: { x: number; y: number; angle: number };
}

/** Rules cursor for the active trick; a game may hand back one of its own TablePlay records. */
export interface LastPlay {
  seatId: number;
  cards: Card[];
  kind: string;
  claim?: GuandanDeclaration;
}

/** One finished Guandan deal. `order` holds two seats for a double down, four otherwise. */
export interface GuandanRoundResult {
  order: number[];
  doubleDown: boolean;
  winnerTeam: 0 | 1;
  upgrade: 1 | 2 | 3;
  levelsBefore: [number, number];
  levelsAfter: [number, number];
}

export interface GuandanExchangePair {
  giver: number;
  receiver: number;
  tribute: Card;
  returned: Card | null;
}

/** Tribute/return bookkeeping. `pairs` is empty before every tribute is committed. */
export interface GuandanExchange {
  stage: 'none' | 'tribute' | 'return' | 'complete' | 'resisted';
  givers: number[];
  submitted: number[];
  pairs: GuandanExchangePair[];
  leader: number | null;
}

/** Public Guandan match state; levels/result/matchWinner are per team (seat parity). */
export interface GuandanState {
  deal: number;
  levels: [number, number];
  playedLevel: number;
  finishOrder: number[];
  result: GuandanRoundResult | null;
  matchWinner: 0 | 1 | null;
  exchange: GuandanExchange;
}

/** Private exchange view for exactly one seat, never another seat's cards. */
export interface GuandanPrivateAction {
  kind: 'tribute' | 'return';
  eligibleIds: string[];
  committed: Card | null;
}

/**
 * Host-only pending replacement queue entry: a connected newcomer asking to take over `seatId`.
 * Carries no token and no peer id. `previousName` is the current occupant's name and `connected`
 * says whether that occupant is online right now (an approved request kicks an online device).
 */
export interface SeatRequest {
  id: string;
  seatId: number;
  name: string;
  previousName: string;
  connected: boolean;
}

/**
 * Read-only public join preview returned by `inspect`. Never contains hands or credentials,
 * so it is safe to render before anyone is authenticated.
 */
export interface RoomSummary {
  code: string;
  game: GameKind;
  roomMode: RoomMode;
  phase: Phase;
  seats: Seat[];
  /** Owner seat of a phone room; null for tablet rooms. */
  hostSeatId: number | null;
  hostConnected: boolean;
  spectatorCount: number;
}

export type RoomRole = 'table' | 'player' | 'spectator';

/**
 * Public automation status for this room. `message` is the honest Chinese reason when opting in is
 * impossible (runtime unavailable in this process, or a runtime failure already seen in this room).
 */
export interface RoomAutomation {
  available: boolean;
  message: string | null;
}

/**
 * Room-owned snapshot fields: identity, roster, host rights and the exact-private hand slot.
 * Never produced by a game engine.
 */
export interface RoomSnapshotFields {
  /** Only the two open-information chess games expose computer-opponent controls. */
  boardAi?: import('./boardAi').BoardAiView;
  /** Public deal choreography only: no card faces or opponents' private ids. */
  dealAnimation?: { id: number; elapsedMs: number; seatCount: number; cardsPerSeat: number };
  code: string;
  roomMode: RoomMode;
  seats: Seat[];
  /** The viewer's own unplayed cards only, or [] when this recipient owns no seat. */
  hand: Card[];
  selfSeat: number | null;
  role: RoomRole;
  spectatorCount: number;
  spectatorPhrases: boolean;
  /** Host rights of THIS recipient, computed from the live connection, never from local state. */
  isHost: boolean;
  /** Owner seat of a phone room; null for tablet rooms. */
  hostSeatId: number | null;
  hostConnected: boolean;
  /** Host-selected per-decision limit in seconds; 0 means the clock is off. */
  turnLimitSeconds: number;
  /** Time left on the current decision when this snapshot was created; null = no clock. */
  turnRemainingMs: number | null;
  /** Seat that owns the advertised countdown; null when no human decision is timed. */
  turnSeatId: number | null;
  /** Pending replacement queue, for the host only; empty for everyone else. */
  seatRequests: SeatRequest[];
  /**
   * Public automation status: whether opting into auto play is possible right now, and the honest
   * reason when it is not (runtime unavailable, or a public runtime failure in this room).
   */
  automation: RoomAutomation;
  message: string;
  version: number;
}

/** Gameplay fields both games publish with the same meaning. */
export interface GameBaseFields {
  phase: Phase;
  turn: number | null;
  lastPlay: LastPlay | null;
  /**
   * Public accepted-play history for the whole deal, oldest first, identical for every bound peer.
   * Opponents' unplayed hands are never part of it; it survives passes and the end of a deal.
   */
  tablePlays: TablePlay[];
  /**
   * Index into `tablePlays` where the current active trick begins: 0 right after a deal, the
   * history length after a clear. The current board is `tablePlays.slice(trickStartIndex)`;
   * `lastPlay` stays the rules cursor.
   */
  trickStartIndex: number;
}

/** Doudizhu gameplay fields, exactly the phase-1 behaviour. */
export interface DoudizhuGameFields extends GameBaseFields {
  game: 'doudizhu';
  phase: DoudizhuPhase;
  landlord: number | null;
  bid: number;
  bottom: Card[];
  winner: 'landlord' | 'farmers' | null;
  multiplier: number;
  scores: number[];
}

/** Guandan gameplay fields. No Doudizhu fields, no unused score array. */
export interface GuandanGameFields extends GameBaseFields {
  game: 'guandan';
  phase: GuandanPhase;
  guandan: GuandanState;
  /** Private exchange action for the viewer's own seat, null when the viewer has none. */
  privateAction: GuandanPrivateAction | null;
}

/** Discriminated gameplay union; the shared shape both engines implement `view()` with. */
export interface JunqiGameFields extends GameBaseFields {
  game: 'junqi';
  phase: 'lobby' | 'deploying' | 'playing' | 'finished';
  junqi: JunqiView;
}
export interface XiangqiGameFields extends GameBaseFields {
  game: 'xiangqi';
  phase: 'lobby' | 'playing' | 'finished';
  xiangqi: XiangqiView;
}
export interface ChessGameFields extends GameBaseFields {
  game: 'chess'; phase: 'lobby' | 'playing' | 'finished'; chess: ChessView;
}
interface StoneBaseFields extends GameBaseFields { phase: 'lobby' | 'playing' | 'finished'; stones: StoneView }
export interface GoGameFields extends StoneBaseFields { game: 'go' }
export interface GomokuGameFields extends StoneBaseFields { game: 'gomoku' }
export type StoneGameFields = GoGameFields | GomokuGameFields;
export interface ReversiGameFields extends GameBaseFields {
  game: 'reversi';
  phase: 'lobby' | 'playing' | 'finished';
  reversi: ReversiView;
}
export type GameView = DoudizhuGameFields | GuandanGameFields | JunqiGameFields | XiangqiGameFields | ChessGameFields | StoneGameFields | ReversiGameFields;

export type DoudizhuSnapshot = RoomSnapshotFields & DoudizhuGameFields;
export type GuandanSnapshot = RoomSnapshotFields & GuandanGameFields;

export type JunqiSnapshot = RoomSnapshotFields & JunqiGameFields;
export type XiangqiSnapshot = RoomSnapshotFields & XiangqiGameFields;
export type ChessSnapshot = RoomSnapshotFields & ChessGameFields;
export type StoneSnapshot = RoomSnapshotFields & StoneGameFields;
export type ReversiSnapshot = RoomSnapshotFields & ReversiGameFields;
export type Snapshot = DoudizhuSnapshot | GuandanSnapshot | JunqiSnapshot | XiangqiSnapshot | ChessSnapshot | StoneSnapshot | ReversiSnapshot;

export type ClientMessageType =
  | 'reversiMove' | 'reversiResign' | 'reversiUndo'
  | 'stoneMove' | 'stonePass' | 'stoneResign' | 'stoneScore' | 'stoneSetup' | 'stoneUndo'
  | 'boardAi' | 'boardAiRetry'
  | 'chessMove' | 'chessResign' | 'chessDraw' | 'chessUndo'
  | 'xiangqiMove'
  | 'xiangqiResign'
  | 'xiangqiDraw' | 'xiangqiUndo'
  | 'junqiMode'
  | 'junqiSetup'
  | 'junqiMove'
  | 'junqiResign'
  | 'ping'
  | 'create'
  | 'join'
  | 'spectate'
  | 'resume'
  | 'inspect'
  | 'requestSeat'
  | 'decideSeat'
  | 'rename'
  | 'seats'
  | 'ready'
  | 'start'
  | 'bid'
  | 'play'
  | 'pass'
  | 'tribute'
  | 'returnTribute'
  | 'addBot'
  | 'removeBot'
  | 'autoPlay'
  | 'again'
  | 'hint'
  | 'turnTimer'
  | 'phrase'
  | 'spectatorPhrases'
  | 'removeOffline'
  | 'transferHost'
  | 'clearEmptySeats'
  | 'dissolve';

export type ClientPayload =
  | { action: import('./boardUndo').BoardUndoAction }
  | { point: number }
  | { size: number }
  | { rule: import('./stones').GomokuRule }
  | { action: 'mark' | 'confirm' | 'resume'; point?: number; side?: 0 | 1; revision?: number; roundId?: string }
  | { enabled: boolean; side?: 0 | 1; difficulty?: import('./boardAi').BoardAiDifficulty }
  | { action: 'offer' | 'accept' | 'decline' | 'agree'; side?: 0 | 1 }
  | { side: 0 | 1 }
  | { variant: 'two' | 'four' }
  | { action: 'shuffle' | 'confirm' | 'swap'; from?: number; to?: number }
  | { from: number; to: number; promotion?: import('./chess').ChessPromotion }
  | Record<string, never> // start, pass, again, hint
  | { game: GameKind; roomMode: RoomMode; name?: string } // create: the server generates the code
  | { code: string; seatId: number; name: string } // join, requestSeat
  | { code: string; token: string } // resume
  | { code: string } // inspect, spectate
  | { requestId: string; approve: boolean } // decideSeat
  | { name: string } // rename
  | { positions: Position[] } // seats
  | { ready: boolean }
  | { value: 0 | 1 | 2 | 3 } // bid
  | { cards: string[]; claim?: string } // play: claim is a Guandan declaration key
  | { cardId: string } // tribute, returnTribute
  | { seatId: number } // addBot, removeBot
  | { enabled: boolean } // autoPlay, spectatorPhrases
  | { seconds: number } // turnTimer: host-only per-decision limit, 0 disables
  | { phraseId: string } // phrase: one id from the shared fixed preset list
  | { seatId: number }; // transferHost: target connected human seat

export interface ClientMessage {
  id: string;
  type: ClientMessageType;
  payload: ClientPayload;
}

export interface SessionMessage {
  type: 'session';
  id: string;
  code: string;
  game: GameKind;
  roomMode: RoomMode;
  token: string;
  role: RoomRole;
  seatId: number | null;
}

export interface StateMessage {
  type: 'state';
  state: Snapshot;
}

/** Reply to `inspect`; the ack for that command follows. */
export interface RoomInfoMessage {
  type: 'room-info';
  id: string;
  room: RoomSummary;
}

/**
 * Reply to `requestSeat` and the follow-up the host's decision sends to the requester.
 * An approval is delivered as a normal SessionMessage plus ack/state instead, so `approved`
 * is not a status here.
 */
export interface SeatRequestMessage {
  type: 'seat-request';
  id: string;
  requestId: string;
  code: string;
  seatId: number;
  status: 'pending' | 'rejected' | 'cancelled';
  message: string;
}

/** Reply to `hint`; sent only to the requesting player, ordered best-first. */
export interface HintMessage {
  type: 'hint';
  id: string;
  plays: HintPlay[];
}

/** The host removed this room; every bound device must drop its credential and return home. */
export interface DissolvedMessage {
  type: 'dissolved';
  code: string;
  message: string;
}

/** Ephemeral in-room quick phrase; never part of snapshots or durable game history. */
export interface PhraseMessage {
  type: 'phrase';
  seatId: number | null;
  name: string;
  phraseId: string;
  text: string;
  at: number;
}

export interface AckMessage {
  type: 'ack';
  id: string;
}

/**
 * Machine ids for identity failures. The client only discards stored credentials on these;
 * every other error (rules, transient transport) keeps them.
 */
export type ErrorCode = 'ROOM_NOT_FOUND' | 'INVALID_CREDENTIAL' | 'SEAT_OCCUPIED';

export interface ErrorMessage {
  type: 'error';
  id?: string;
  message: string;
  code?: ErrorCode;
}

export type ServerMessage =
  | { type: 'pong'; id: string }
  | SessionMessage
  | StateMessage
  | AckMessage
  | RoomInfoMessage
  | SeatRequestMessage
  | HintMessage
  | PhraseMessage
  | DissolvedMessage
  | ErrorMessage;

/** Chinese labels for the machine ids emitted in Doudizhu `lastPlay.kind` / plays. */
export const KIND_LABELS: Record<string, string> = {
  single: '单张',
  pair: '对子',
  triple: '三张',
  triple_single: '三带一',
  triple_pair: '三带二',
  straight: '顺子',
  pairs_run: '连对',
  triples_run: '飞机',
  airplane_single: '飞机带单',
  airplane_pair: '飞机带对',
  four_two_single: '四带二',
  four_two_pair: '四带两对',
  bomb: '炸弹',
  rocket: '王炸',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}
