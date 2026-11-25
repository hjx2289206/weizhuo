export const BOARD_AI_GAMES = ['chess', 'xiangqi', 'gomoku', 'reversi'] as const
export type BoardAiGame = typeof BOARD_AI_GAMES[number]
export type UciBoardAiGame = Exclude<BoardAiGame, 'gomoku' | 'reversi'>
export const isBoardAiGame = (value: unknown): value is BoardAiGame => BOARD_AI_GAMES.some(game => game === value)

/** Product difficulty names are relative presets, not measured human Elo ratings. */
export type BoardAiDifficulty = 'beginner' | 'easy' | 'normal' | 'hard' | 'challenge'
export const BOARD_AI_DIFFICULTIES = [
  { id: 'beginner', label: '入门' }, { id: 'easy', label: '简单' }, { id: 'normal', label: '普通' },
  { id: 'hard', label: '困难' }, { id: 'challenge', label: '挑战' },
] as const satisfies readonly { id: BoardAiDifficulty; label: string }[]
export const isBoardAiDifficulty = (value: unknown): value is BoardAiDifficulty => BOARD_AI_DIFFICULTIES.some(item => item.id === value)
export const boardAiLabel = (difficulty: BoardAiDifficulty) => BOARD_AI_DIFFICULTIES.find(item => item.id === difficulty)!.label
export interface BoardAiConfig { side: 0 | 1; difficulty: BoardAiDifficulty }
export interface BoardAiView {
  config: BoardAiConfig | null
  levels: { id: BoardAiDifficulty; label: string; available: boolean; message: string | null }[]
  thinking: boolean
  error: string | null
}
