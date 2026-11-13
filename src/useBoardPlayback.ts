import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type Ref } from 'vue'

/** One authoritative move rendered against the preceding viewer-visible board. */
export interface BoardPlayback<B, M> {
  move: M
  board: B
  progress: number
}

export const BOARD_PLAYBACK_MS = 900

interface BoardContext { code: string; selfSeat: number | null; phase: string }
interface Position<B, M> { roundId: string; layout: string; board: B; moves: readonly M[] }

/** No historical queue: discontinuities settle immediately; a reconnect establishes a fresh baseline. */
export function useBoardPlayback<S extends BoardContext, B, M extends { ply: number }>(
  source: Readonly<Ref<S | null>>,
  connected: Readonly<Ref<boolean>>,
  options: {
    position: (snapshot: S) => Position<B, M>
    empty: B
    canAnimate: (board: B, move: M) => boolean
  },
) {
  const playback = shallowRef<BoardPlayback<B, M> | null>(null)
  const board = computed(() => playback.value?.board ?? (source.value ? options.position(source.value).board : options.empty))
  const animating = computed(() => playback.value !== null)
  let baseline: S | null = connected.value ? source.value : null
  let frame: number | null = null
  const reduceQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

  function stop(): void {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    playback.value = null
  }

  function invalidate(): void { stop(); baseline = null }

  function start(move: M, previousBoard: B): void {
    stop()
    if (typeof requestAnimationFrame !== 'function' || reduceQuery?.matches || (typeof document !== 'undefined' && document.hidden)) return
    playback.value = { move, board: previousBoard, progress: 0 }
    let startedAt: number | null = null
    const step = (timestamp: number) => {
      startedAt ??= timestamp
      const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / BOARD_PLAYBACK_MS))
      if (progress >= 1) { frame = null; playback.value = null; return }
      playback.value = { move, board: previousBoard, progress }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  }

  watch(connected, invalidate, { flush: 'sync' })
  watch(source, next => {
    if (!connected.value || !next) { invalidate(); return }
    const previous = baseline
    baseline = next
    if (!previous) { stop(); return }
    const before = options.position(previous), after = options.position(next)
    const contextChanged = previous.code !== next.code || previous.selfSeat !== next.selfSeat
      || before.roundId !== after.roundId || before.layout !== after.layout
    if (!contextChanged && before.moves.length === after.moves.length) {
      if (previous.phase !== next.phase) stop()
      return
    }
    const move = after.moves.at(-1)
    if (contextChanged || after.moves.length !== before.moves.length + 1
      || previous.phase !== 'playing' || (next.phase !== 'playing' && next.phase !== 'finished')
      || !move || move.ply !== after.moves.length || !options.canAnimate(before.board, move)) {
      stop()
      return
    }
    start(move, before.board)
  }, { flush: 'sync' })

  function onReducedMotion(event: MediaQueryListEvent): void { if (event.matches) stop() }
  function onVisibility(): void { if (document.hidden) stop() }
  if (typeof window !== 'undefined') window.addEventListener('resize', stop)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  reduceQuery?.addEventListener('change', onReducedMotion)
  if (getCurrentScope()) onScopeDispose(() => {
    invalidate()
    if (typeof window !== 'undefined') window.removeEventListener('resize', stop)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    reduceQuery?.removeEventListener('change', onReducedMotion)
  })
  return { playback, board, animating }
}
