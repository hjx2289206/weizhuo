// One local sorting preference per game, shared by every phone renderer. The composable owns the
// mode ref, persistence and the display projection; callers only pass their live hand.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Card, GameKind } from '../shared/protocol'
import { HAND_SORT_LABELS, nextHandSortMode, readHandSortMode, sortHandForDisplay, writeHandSortMode, type HandSortMode } from './handSort'
import { browserStores, type StorageLike } from './sessionStore'

export interface HandSortOptions {
  /** Live room kind; null while a public room summary is still loading. */
  game: () => GameKind | null
  hand: () => readonly Card[]
  /** Guandan's played level; ignored for Doudizhu. */
  level?: () => number | null
  /** Injectable in tests; defaults to this browser's localStorage. */
  store?: StorageLike | null
}

export interface HandSortApi {
  mode: Ref<HandSortMode>
  label: ComputedRef<string>
  displayHand: ComputedRef<Card[]>
  cycle: () => void
}

export function useHandSort(options: HandSortOptions): HandSortApi {
  const store = options.store !== undefined ? options.store : browserStores().durable
  const mode = ref<HandSortMode>('rank')
  let loadedGame: GameKind | null = null

  /** Load the saved mode once per game, so two rooms of different kinds remember separately. */
  function syncMode(): void {
    const game = options.game()
    if (!game || game === loadedGame) return
    loadedGame = game
    mode.value = readHandSortMode(game, store)
  }

  syncMode()
  watch(() => options.game(), syncMode)

  const displayHand = computed(() =>
    sortHandForDisplay(options.hand(), mode.value, options.game() ?? 'doudizhu', options.level?.() ?? null),
  )

  const label = computed(() => HAND_SORT_LABELS[mode.value])

  function cycle(): void {
    const game = options.game()
    mode.value = nextHandSortMode(mode.value)
    if (game) writeHandSortMode(game, mode.value, store)
  }

  return { mode, label, displayHand, cycle }
}
