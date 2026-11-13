// Local projection of the server's turn deadline. The snapshot carries the remaining time at the
// moment it was created; this composable only counts down from receipt, so no client clock sync is
// needed and every fresh snapshot re-anchors the display to the authoritative room timer.
import { computed, getCurrentScope, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Snapshot } from '../shared/protocol'

export interface TurnClock {
  /** True while the room is timing a human decision. */
  active: ComputedRef<boolean>
  /** Whole seconds left, rounded up so the display reads the configured limit immediately. */
  seconds: ComputedRef<number>
  /** Five seconds or fewer, for a visual warning. */
  urgent: ComputedRef<boolean>
  /** Seat whose decision is timed, or null when the clock is off/paused. */
  seatId: ComputedRef<number | null>
}

const TICK_MS = 250

export function useTurnClock(state: Ref<Snapshot | null>): TurnClock {
  const now = ref(Date.now())
  const receivedAt = ref(Date.now())
  const remainingAtReceipt = ref<number | null>(null)
  let ticker: ReturnType<typeof setInterval> | null = null

  function stopTicker(): void {
    if (ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
  }

  function sync(snapshot: Snapshot | null): void {
    receivedAt.value = Date.now()
    now.value = receivedAt.value
    remainingAtReceipt.value = snapshot?.turnRemainingMs ?? null
    if (remainingAtReceipt.value === null) {
      stopTicker()
    } else if (ticker === null) {
      ticker = setInterval(() => {
        now.value = Date.now()
      }, TICK_MS)
    }
  }

  watch(state, sync, { immediate: true })
  if (getCurrentScope()) onScopeDispose(stopTicker)

  const remainingMs = computed(() => {
    const atReceipt = remainingAtReceipt.value
    if (atReceipt === null) return null
    const elapsed = Math.max(0, now.value - receivedAt.value)
    return Math.max(0, atReceipt - elapsed)
  })

  const active = computed(() => remainingMs.value !== null)
  const seconds = computed(() => Math.ceil((remainingMs.value ?? 0) / 1000))
  const urgent = computed(() => active.value && seconds.value <= 5)
  const seatId = computed(() => (active.value ? state.value?.turnSeatId ?? null : null))

  return { active, seconds, urgent, seatId }
}
