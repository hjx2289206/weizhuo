// Best-effort vibration feedback. Desktop browsers and unsupported devices simply no-op; a failed
// vibration call must never block a card gesture, a phrase, or a turn notification.
export const HAPTIC_SELECT = 12
export const HAPTIC_TURN: readonly number[] = [18, 40, 24]

type Vibrator = { vibrate?: (pattern: number | number[]) => boolean }

function currentNavigator(): Vibrator | null {
  try {
    return typeof navigator === 'undefined' ? null : (navigator as Vibrator)
  } catch {
    return null
  }
}

export function vibrate(pattern: number | readonly number[], target: Vibrator | null = currentNavigator()): boolean {
  try {
    if (!target || typeof target.vibrate !== 'function') return false
    return target.vibrate(typeof pattern === 'number' ? pattern : Array.from(pattern))
  } catch {
    return false
  }
}
