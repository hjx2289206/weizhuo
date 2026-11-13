import type { Snapshot } from '../../shared/protocol'
import type { TeachingClip, TeachingFrame } from '../../shared/tutorialProtocol'
import { clamp } from './chessMotion'

/** A single logical clock drives captions, snapshots, camera and artwork. No detached DOM ghosts. */
export const INTRO_DURATION = 1200
export function frameDuration(frame: TeachingFrame, reduced = false): number { return reduced ? Math.min(900, frame.duration) : frame.duration }
export function clipDuration(clip: TeachingClip, reduced = false): number { return INTRO_DURATION + clip.frames.reduce((total, frame) => total + frameDuration(frame, reduced), 0) }
export interface ClipPosition { before: Snapshot; snapshot: Snapshot; frame: TeachingFrame | null; frameIndex: number; fraction: number; intro: number; ended: boolean }
export function clipPosition(clip: TeachingClip, elapsed: number, reduced = false): ClipPosition {
  if (elapsed < INTRO_DURATION) return { before: clip.snapshot, snapshot: clip.snapshot, frame: null, frameIndex: -1, fraction: 0, intro: clamp(elapsed / INTRO_DURATION), ended: false }
  let remaining = elapsed - INTRO_DURATION, before = clip.snapshot
  for (let i = 0; i < clip.frames.length; i++) {
    const frame = clip.frames[i]!, duration = frameDuration(frame, reduced)
    if (remaining < duration) {
      const fraction = clamp(remaining / duration)
      return { before, snapshot: frame.rejected || fraction < .84 && frame.kind !== 'result' ? before : frame.snapshot, frame, frameIndex: i, fraction, intro: 1, ended: false }
    }
    remaining -= duration; before = frame.snapshot
  }
  const frame = clip.frames.at(-1) ?? null
  return { before, snapshot: before, frame, frameIndex: clip.frames.length - 1, fraction: 1, intro: 1, ended: true }
}
