// Shared game catalog: which games the collection actually implements, and their table facts.
// Consumed by the transport (create validation), the controller (home entries / saved sessions) and
// the server room (seat count, deck count). No speculative games.

import type { GameKind, RoomMode } from './protocol';

/** Display order within each category in the hall. */
export const GAME_KINDS = ['doudizhu', 'guandan', 'xiangqi', 'go', 'gomoku', 'reversi', 'chess', 'junqi'] as const satisfies readonly GameKind[];
const gameKindSet: ReadonlySet<unknown> = new Set(GAME_KINDS);

export function isGameKind(value: unknown): value is GameKind {
  return gameKindSet.has(value);
}

export interface GameDefinition {
  /** Visible game name. */
  name: string;
  category: 'board' | 'card';
  /** Default seats in a full table. */
  seatCount: number;
  minSeats: number;
  maxSeats: number;
  /** Decks used per deal: 1 for Doudizhu, 2 for Guandan. */
  deckCount: 0 | 1 | 2;
  /** One-line description for the hall card. */
  brief: string;
  roomModes: readonly RoomMode[];
}

export const GAME_DEFINITIONS = {
  go: {
    name: '围棋', category: 'board', seatCount: 2, minSeats: 2, maxSeats: 2, deckCount: 0,
    brief: '9／13／19 路，围地提子；基础与进阶教程分开看。',
    roomModes: ['tablet', 'phone'],
  },
  gomoku: {
    name: '五子棋', category: 'board', seatCount: 2, minSeats: 2, maxSeats: 2, deckCount: 0,
    brief: '15 路无禁手，横竖斜先连成五子或以上获胜。',
    roomModes: ['tablet', 'phone'],
  },
  reversi: {
    name: '黑白棋', category: 'board', seatCount: 2, minSeats: 2, maxSeats: 2, deckCount: 0,
    brief: '8×8 棋盘，夹住对手棋子并翻面，终局子多者胜。',
    roomModes: ['tablet', 'phone'],
  },
  chess: {
    name: '国际象棋', category: 'board', seatCount: 2, minSeats: 2, maxSeats: 2, deckCount: 0,
    brief: '黑白方寸，双人同屏或手机联机；白方先行。',
    roomModes: ['tablet', 'phone'],
  },
  xiangqi: {
    name: '中国象棋', category: 'board', seatCount: 2, minSeats: 2, maxSeats: 2, deckCount: 0,
    brief: '双人共用平板，或各用手机；红黑轮流行棋。',
    roomModes: ['tablet', 'phone'],
  },
  junqi: {
    name: '军棋', category: 'board', seatCount: 2, minSeats: 2, maxSeats: 4, deckCount: 0,
    brief: '双人对弈或四国组队，秘密布阵，夺旗制胜。',
    roomModes: ['phone'],
  },
  doudizhu: {
    name: '斗地主',
    category: 'card',
    seatCount: 3, minSeats: 3, maxSeats: 3,
    deckCount: 1,
    brief: '三人一局，先出完手牌的一方获胜。',
    roomModes: ['tablet', 'phone'],
  },
  guandan: {
    name: '掼蛋',
    category: 'card',
    seatCount: 4, minSeats: 4, maxSeats: 4,
    deckCount: 2,
    brief: '四人两队两副牌，打到 A 并由已到 A 的一方打赢 A 即胜。',
    roomModes: ['tablet', 'phone'],
  },
} as const satisfies Record<GameKind, GameDefinition>;

type BoardGameKind = {
  [Kind in GameKind]: (typeof GAME_DEFINITIONS)[Kind]['category'] extends 'board' ? Kind : never;
}[GameKind];

export function isBoardGame(game: GameKind): game is BoardGameKind {
  return GAME_DEFINITIONS[game].category === 'board';
}
export function isStoneGame(game: GameKind): game is 'go' | 'gomoku' { return game === 'go' || game === 'gomoku'; }

export function isBlackFirstGame(game: GameKind | null | undefined): boolean {
  return game === 'reversi' || (game != null && isStoneGame(game));
}

export function supportsRoomMode(game: GameKind, mode: RoomMode): boolean {
  const modes: readonly RoomMode[] = GAME_DEFINITIONS[game].roomModes;
  return modes.includes(mode);
}
