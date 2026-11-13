import { computed, type ComputedRef } from 'vue'
import type { DoudizhuSnapshot, Seat } from '../../shared/protocol'
import type { GamePlayController } from '../playController'
import { useGameView, type GameViewCommon } from './useGameView'
import { canBeat, detectPlay } from '../../shared/doudizhu'
import { KIND_LABELS } from '../../shared/protocol'

/** Dou Dizhu-only facts: landlord, bidding, bottom three and per-seat scores. */
export interface DoudizhuView extends GameViewCommon {
  /**
   * The live snapshot narrowed to Dou Dizhu, or null while another game is live. It is the whole
   * snapshot, not just the gameplay fields, so room facts (own seat, hand, host rights) stay typed.
   */
  ddz: ComputedRef<DoudizhuSnapshot | null>
  winnerText: ComputedRef<string>
  myRole: ComputedRef<string>
  myScore: ComputedRef<number>
  playEnabled: ComputedRef<boolean>
  canPlay: ComputedRef<boolean>
  selectionStatus: ComputedRef<string>
  selectionValid: ComputedRef<boolean>
  canPass: ComputedRef<boolean>
  canBid: (value: number) => boolean
  bidStatusText: ComputedRef<string>
  roleLabel: (seat: Seat) => string
  scoreOf: (id: number) => number
  /** Hand components submit through `play`; the rejection must surface like the button path. */
  playFromGesture: () => Promise<void>
}

export function useDoudizhuView(game: GamePlayController): DoudizhuView {
  const common = useGameView(game)
  const { state, busy, selected } = game
  const { phase, mySeat, isMyTurn, allConnected } = common

  const ddz = computed<DoudizhuSnapshot | null>(() => {
    const snapshot = state.value
    return snapshot != null && snapshot.game === 'doudizhu' ? snapshot : null
  })

  const winnerText = computed(() => {
    const winner = ddz.value?.winner
    if (winner == null) return ''
    return winner === 'landlord' ? '地主获胜' : '农民获胜'
  })

  function roleLabel(seat: Seat): string {
    const snapshot = ddz.value
    if (!snapshot) return ''
    if (snapshot.landlord === seat.id) return '地主'
    return snapshot.landlord != null ? '农民' : ''
  }

  function scoreOf(id: number): number {
    return ddz.value?.scores[id] ?? 0
  }

  const myRole = computed<string>(() => {
    const seat = mySeat.value
    return seat ? roleLabel(seat) || '—' : '—'
  })

  const myScore = computed(() => (state.value?.selfSeat != null ? scoreOf(state.value.selfSeat) : 0))

  const playEnabled = computed(
    () => phase.value === 'playing' && isMyTurn.value && allConnected.value && game.connected?.value !== false && !busy.value && !common.managed.value && !common.dealing.value,
  )
  const selectedPlay = computed(() => {
    const ids = new Set(selected.value)
    const cards = (ddz.value?.hand ?? []).filter(c => ids.has(c.id))
    return cards.length === ids.size && cards.length === selected.value.length ? detectPlay(cards) : null
  })
  const selectionValid = computed(() => {
    const play = selectedPlay.value
    if (!play) return false
    const last = ddz.value?.lastPlay
    return canBeat(play, last && last.seatId !== ddz.value?.selfSeat ? detectPlay(last.cards) : null)
  })
  const selectionStatus = computed(() => {
    if (!selected.value.length) return '先选牌，再出牌'
    const play = selectedPlay.value
    if (!play) return '所选牌不构成合法牌型'
    return `${KIND_LABELS[play.kind] ?? play.kind}${selectionValid.value ? ' · 可以出牌' : ' · 管不上上家'}`
  })
  const canPlay = computed(() => playEnabled.value && selectionValid.value)
  const canPass = computed(() => {
    const snapshot = ddz.value
    return playEnabled.value && snapshot?.lastPlay != null && snapshot.lastPlay.seatId !== snapshot.selfSeat
  })

  function canBid(value: number): boolean {
    const snapshot = ddz.value
    if (!snapshot || phase.value !== 'bidding' || !isMyTurn.value || busy.value || !allConnected.value || game.connected?.value === false || common.dealing.value) return false
    if (common.managed.value) return false
    return value === 0 || value >= snapshot.bid + 1
  }

  const bidStatusText = computed(() => {
    const snapshot = ddz.value
    if (!snapshot) return ''
    if (isMyTurn.value) return `当前 ${snapshot.bid} 分`
    return `等待 ${(snapshot.turn ?? 0) + 1} 号座叫分 · 当前 ${snapshot.bid} 分`
  })

  async function playFromGesture(): Promise<void> {
    try {
      if (common.managed.value) throw new Error('托管中，手动出牌已关闭；取消托管即可恢复')
      if (!playEnabled.value) throw new Error('当前不能出牌，请等待轮到你并完成发牌')
      if (!selectionValid.value) throw new Error(selectionStatus.value)
      await game.playSelected()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
      if (message && !game.error.value) game.error.value = message
    }
  }

  /* robot hosting lives in the shared common view so both games offer it */

  return {
    ...common,
    ddz,
    winnerText,
    myRole,
    myScore,
    playEnabled,
    canPlay,
    selectionStatus,
    selectionValid,
    canPass,
    canBid,
    bidStatusText,
    roleLabel,
    scoreOf,
    playFromGesture,
  }
}
