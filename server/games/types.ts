// Server-side game boundary: the shared Room owns identity/authority, an engine owns one game's
// cards, phases, turn order, legality, results and public history. Engines never see a peer, socket,
// token, approval, host right or room lifecycle event.

import type { Card, GameKind, GameView, GuandanDeclaration, HintPlay, Phase, TablePlay } from '../../shared/protocol';

/** Client commands a game engine may own; every other command is room authority. */
export type GameCommandType = 'bid' | 'play' | 'pass' | 'tribute' | 'returnTribute' | 'junqiSetup' | 'junqiMove' | 'junqiResign' | 'xiangqiMove' | 'xiangqiResign' | 'xiangqiDraw' | 'chessMove' | 'chessResign' | 'chessDraw' | 'stoneMove' | 'stonePass' | 'stoneResign' | 'stoneScore';

export type GameResult = { ok: true } | { ok: false; message: string };

/** Result of a read-only hint request; `plays` is empty whenever `ok` is false. */
export interface HintResult {
  ok: boolean;
  message?: string;
  plays: HintPlay[];
}

/**
 * A legal fallback the room may apply when the seat's turn clock expires. Engines return null when
 * the seat is not currently actionable; the room never invents a card or a bid on its own.
 */
export interface TimeoutAction {
  type: GameCommandType;
  payload: Record<string, unknown>;
}

/** Trusted constructor dependencies; room transport and ownership never enter an engine. */
export interface GameContext {
  /** Trusted deterministic sources for authored teaching matches. Never read from client payloads. */
  dealDeck?: () => Card[];
  firstSeat?: number;
  /** Room-owned presentation clock, including a Doudizhu all-pass redeal. */
  onDeal?: (seatCount: number, cardsPerSeat: number) => void;
  stampPlay(seatId: number, cards: Card[], kind: string, claim?: GuandanDeclaration): TablePlay;
}

export interface RoomGame {
  readonly kind: GameKind;
  readonly seatCount: 2 | 3 | 4;
  readonly phase: Phase;

  /** Deal/start the first deal. Called only after the room's seat/readiness/connection gate passed. */
  start(): void;

  /** Run one command from an already-authenticated seat. Room owns identity, replay, ack, version. */
  command(seatId: number, type: GameCommandType, payload: Record<string, unknown>): GameResult;

  /** Read-only legal suggestions for one seat, best-first. Never mutates the deal. */
  hint(seatId: number): HintResult;

  /** One legal timeout fallback for this seat, or null when the seat owes no decision. */
  timeoutAction(seatId: number): TimeoutAction | null;

  /** Public snapshot fields plus this viewer's private game view; never another seat's cards. */
  view(selfSeat: number | null): GameView;

  /** Unplayed cards of one seat; the room decides which seat may receive them. */
  handOf(seatId: number): readonly Card[];

  /** Public in-play flag for one seat (already passed / 不要). */
  passedAt(seatId: number): boolean;

  /** True while this game needs the seat connected to keep playing (pause policy). */
  requiresConnection(seatId: number): boolean;

  /** In-play status line; the room supplies lobby text and knows the recipient's seat. */
  statusText(selfSeat: number | null, nameOf: (seatId: number) => string): string;

  /** Next deal / rematch. The room clears readiness itself; false = not allowed right now. */
  restart(): GameResult;
}
