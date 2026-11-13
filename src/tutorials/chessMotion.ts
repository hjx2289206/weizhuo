import type { TeachingFrame } from '../../shared/tutorialProtocol'
export interface ChessMotion { from: number; to: number; path: number[]; phase: number; rejected?: string; combat?: TeachingFrame['combat'] }
export const clamp = (value: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value))
