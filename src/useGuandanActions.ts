import { computed, type ComputedRef } from 'vue'
import { enumerateGuandanPlays, strongestGuandanOption, type GuandanOption } from '../shared/guandan'
import type { Card, GuandanDeclaration } from '../shared/protocol'
import type { GamePlayController } from './playController'
import { rankGlyph, suitGlyph } from './screens/cardText'
import { useGameView } from './screens/useGameView'

/** Automatically selected strongest legal reading, ready to display and submit. */
export interface GuandanOptionView {
  key: string
  label: string
  note: string
  declaration: GuandanDeclaration
}

export type GuandanActionStatus = 'empty' | 'illegal' | 'losing' | 'ready'


const STATUS_TEXT: Record<GuandanActionStatus, string> = {
  empty: '选牌后自动识别最强合法牌型',
  illegal: '所选牌不构成合法牌型',
  losing: '管不上上家的牌',
  ready: '可以出牌',
}

/**
 * Automatic claim derivation from this client's selection and the live public play.
 * Every entry point uses the shared strongest-legal selector; the server revalidates the claim.
 */
export interface GuandanActionsApi {
  chosenOption: ComputedRef<GuandanOptionView | null>
  status: ComputedRef<GuandanActionStatus>
  statusText: ComputedRef<string>
  canPlay: ComputedRef<boolean>
  wildIds: ComputedRef<string[]>
  play: () => Promise<void>
  /** Up-swipe path from the hand components; surfaces the same Chinese reason and keeps the cards. */
  playFromGesture: () => Promise<void>
}


function substitutionNote(declaration: GuandanDeclaration, level: number): string {
  const parts = declaration.substitutions.map(
    (entry) => `红桃${rankGlyph(level)} 当 ${suitGlyph(entry.suit)}${rankGlyph(entry.rank)}`,
  )
  return parts.join('、')
}

function shapeNote(declaration: GuandanDeclaration, level: number): string {
  const bits = [`${declaration.count} 张`]
  if (declaration.kind === 'straight' || declaration.kind === 'straightFlush') {
    if (declaration.suit) bits.push(`${suitGlyph(declaration.suit)}同花`)
  } else if (declaration.kind === 'triplePair' && declaration.secondaryRank != null) {
    bits.push(`三张 ${rankGlyph(declaration.primaryRank)} · 对子 ${rankGlyph(declaration.secondaryRank)}`)
  } else if (declaration.kind !== 'fourJokers') {
    bits.push(`主牌 ${rankGlyph(declaration.primaryRank)}`)
  }
  const wild = substitutionNote(declaration, level)
  if (wild) bits.push(wild)
  return bits.join(' · ')
}

export function useGuandanActions(game: GamePlayController): GuandanActionsApi {
  const { state, busy, selected, error } = game
  const common = useGameView(game)

  const level = computed(() => {
    const snapshot = state.value
    return snapshot != null && snapshot.game === 'guandan' ? snapshot.guandan.playedLevel : 15
  })
  const hand = computed<Card[]>(() => state.value?.hand ?? [])

  /** The physical cards behind the current selection, in hand order. */
  const selection = computed<Card[]>(() => {
    const ids = new Set(selected.value)
    return hand.value.filter((card) => ids.has(card.id))
  })

  /** The public claim this seat must beat, or null when leading. */
  const previousClaim = computed<GuandanDeclaration | null>(() => {
    const snapshot = state.value
    if (!snapshot || snapshot.game !== 'guandan' || snapshot.phase !== 'playing') return null
    const last = snapshot.lastPlay
    if (!last || last.seatId === snapshot.selfSeat) return null
    return last.claim ?? null
  })

  /** Validate only the selected physical cards, never enumerate subsets of the whole hand. */
  const options = computed<GuandanOption[]>(() => {
    const cards = selection.value
    if (cards.length === 0) return []
    // A stale id (already played) means this selection can never be submitted.
    if (cards.length !== selected.value.length) return []
    try {
      return enumerateGuandanPlays(cards, level.value)
    } catch {
      return []
    }
  })

  const wildIds = computed(() => {
    const rank = level.value
    return hand.value.filter((card) => card.rank === rank && card.suit === 'heart').map((card) => card.id)
  })

  const chosenOption = computed<GuandanOptionView | null>(() => {
    const option = strongestGuandanOption(options.value, level.value, previousClaim.value)
    if (!option) return null
    return {
      key: option.declaration.key,
      label: option.declaration.label,
      note: shapeNote(option.declaration, level.value),
      declaration: option.declaration,
    }
  })

  const status = computed<GuandanActionStatus>(() => {
    if (selected.value.length === 0) return 'empty'
    if (options.value.length === 0) return 'illegal'
    return chosenOption.value ? 'ready' : 'losing'
  })

  const statusText = computed(() => {
    const option = chosenOption.value
    return option ? `自动识别：${option.label} · ${option.note}` : STATUS_TEXT[status.value]
  })

  const canPlay = computed(() => {
    const snapshot = state.value
    if (!snapshot || snapshot.game !== 'guandan') return false
    return (
      snapshot.phase === 'playing' &&
      snapshot.turn === snapshot.selfSeat &&
      snapshot.selfSeat != null &&
      !common.managed.value &&
      !common.dealing.value &&
      common.allConnected.value &&
      !busy.value &&
      status.value === 'ready'
    )
  })


  async function play(): Promise<void> {
    const self = state.value?.seats.find((seat) => seat.id === state.value?.selfSeat)
    if (self?.autoPlay || self?.isBot) {
      error.value = '托管中，请先取消托管'
      return
    }
    const option = chosenOption.value
    if (!canPlay.value || option == null) {
      error.value = STATUS_TEXT[status.value]
      return
    }
    error.value = ''
    await game.playSelected(option.key)
  }

  async function playFromGesture(): Promise<void> {
    try {
      await play()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
      if (message && !error.value) error.value = message
    }
  }

  return {
    chosenOption,
    status,
    statusText,
    canPlay,
    wildIds,
    play,
    playFromGesture,
  }
}
