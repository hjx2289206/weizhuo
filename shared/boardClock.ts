import type { GameKind } from './protocol';

const minute = 60_000;

interface BoardClockSettings {
  label: string;
  mainMs: number;
  incrementMs: number;
  periods: number;
  periodMs: number;
}

export const BOARD_CLOCK_PRESETS = {
  off: { label: '关闭', mainMs: 0, incrementMs: 0, periods: 0, periodMs: 0 },
  rapid: { label: '快棋 5 分钟 + 3 秒', mainMs: 5 * minute, incrementMs: 3_000, periods: 0, periodMs: 0 },
  standard: { label: '标准 10 分钟 + 5 秒', mainMs: 10 * minute, incrementMs: 5_000, periods: 0, periodMs: 0 },
  slow: { label: '慢棋 20 分钟 + 10 秒', mainMs: 20 * minute, incrementMs: 10_000, periods: 0, periodMs: 0 },
  byoyomi: { label: '10 分钟 + 3 次 30 秒读秒', mainMs: 10 * minute, incrementMs: 0, periods: 3, periodMs: 30_000 },
} satisfies Record<string, BoardClockSettings>;

export type BoardClockPreset = keyof typeof BOARD_CLOCK_PRESETS;
export type BoardClockSide = 0 | 1;

export function boardClockOptions(game: GameKind): BoardClockPreset[] {
  return game === 'go' ? ['off', 'rapid', 'standard', 'slow', 'byoyomi'] : ['off', 'rapid', 'standard', 'slow'];
}

export interface BoardClockTime {
  mainMs: number;
  periodRemainingMs: number;
  /** Includes the period currently in progress. */
  periodsLeft: number;
}

export interface BoardClockView {
  preset: BoardClockPreset;
  /** A computer side has no clock. Each other side has its own main time and periods. */
  times: [BoardClockTime | null, BoardClockTime | null];
  running: BoardClockSide | null;
}

export function initialBoardClockTime(preset: BoardClockPreset): BoardClockTime {
  const { mainMs, periodMs, periods } = BOARD_CLOCK_PRESETS[preset];
  return { mainMs, periodRemainingMs: periodMs, periodsLeft: periods };
}

export function boardClockBudget(time: BoardClockTime, periodMs: number): number {
  return time.mainMs + time.periodRemainingMs + Math.max(0, time.periodsLeft - 1) * periodMs;
}

/** Cross main time and whole byoyomi periods while preserving the active period's remainder. */
export function spendBoardClock(time: BoardClockTime, elapsedMs: number, periodMs: number): BoardClockTime {
  const mainMs = Math.max(0, time.mainMs - elapsedMs);
  if (elapsedMs <= time.mainMs || time.periodsLeft === 0) return { ...time, mainMs };

  const periodBudget = Math.max(0, boardClockBudget(time, periodMs) - elapsedMs);
  const periodsLeft = Math.ceil(periodBudget / periodMs);
  return {
    mainMs,
    periodsLeft,
    periodRemainingMs: periodBudget - Math.max(0, periodsLeft - 1) * periodMs,
  };
}
