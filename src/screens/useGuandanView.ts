import { computed, type ComputedRef } from 'vue'
import { GAME_DEFINITIONS } from '../../shared/gameCatalog'
import type {
  GuandanExchange,
  GuandanPrivateAction,
  GuandanRoundResult,
  GuandanSnapshot,
  Seat,
  TablePlay,
} from '../../shared/protocol'
import type { GamePlayController } from '../playController'
import { bottomCardText, rankGlyph } from './cardText'
import { useGameView, type GameViewCommon } from './useGameView'

export type GuandanTeam = 0 | 1

/** Guandan-only facts: teams, levels, the exchange stage and the private pending action. */
export interface GuandanView extends GameViewCommon {
  /**
   * The live snapshot narrowed to Guandan, or null while another game is live. It is the whole
   * snapshot, not just the gameplay fields, so room facts (own seat, hand, host rights) stay typed.
   */
  guan: ComputedRef<GuandanSnapshot | null>
  deckCount: 2
  /** Public accepted-play history of the deal, for the counter (exchange cards are never in it). */
  plays: ComputedRef<TablePlay[]>
  /** Own team's level (the level this seat is playing for). */
  level: ComputedRef<number>
  playedLevel: ComputedRef<number>
  levels: ComputedRef<readonly [number, number]>
  deal: ComputedRef<number>
  matchWinner: ComputedRef<GuandanTeam | null>
  result: ComputedRef<GuandanRoundResult | null>
  exchange: ComputedRef<GuandanExchange | null>
  /** Own pending tribute/return action, or null when this seat has nothing to submit. */
  privateAction: ComputedRef<GuandanPrivateAction | null>
  myTeam: ComputedRef<GuandanTeam | null>
  teamOf: (seatId: number) => GuandanTeam
  teamTagOf: (seatId: number) => string
  nextSeat: ComputedRef<number | null>
  partnerSeat: ComputedRef<number | null>
  previousSeat: ComputedRef<number | null>
  relativeSeat: (offset: number) => Seat | null
  seatLabel: (seatId: number) => string
  finishLabel: (seatId: number) => string
  levelText: ComputedRef<string>
  levelsText: ComputedRef<string>
  /** Level the next deal will be played at, or null when there is none to advertise. */
  nextLevel: ComputedRef<number | null>
  nextLevelText: ComputedRef<string>
  /** Public reason the deal skipped the exchange; empty unless the current stage is 抗贡. */
  resistNote: ComputedRef<string>
  resultText: ComputedRef<string>
  exchangeStageText: ComputedRef<string>
  exchangeNotice: ComputedRef<{ title: string; detail: string } | null>
  playEnabled: ComputedRef<boolean>
  canPass: ComputedRef<boolean>
  /** True while the deal is stopped for tribute/return; no play control may be offered. */
  exchangeLocked: ComputedRef<boolean>
  rankLabel: (rank: number) => string
}

const FINISH_LABELS = ['头游', '二游', '三游', '末游']
const DEFAULT_LEVELS: readonly [number, number] = [15, 15]
/** Fixed team names: seats 0+2 versus seats 1+3, the frozen Guandan pairing. */
const TEAM_NAMES: readonly [string, string] = ['1·3 队', '2·4 队']

function teamFromSeat(seatId: number): GuandanTeam {
  return seatId % 2 === 0 ? 0 : 1
}

export function useGuandanView(game: GamePlayController): GuandanView {
  const common = useGameView(game)
  const { state, busy } = game
  const { phase, seats, isMyTurn, allConnected } = common

  const guan = computed<GuandanSnapshot | null>(() => {
    const snapshot = state.value
    return snapshot != null && snapshot.game === 'guandan' ? snapshot : null
  })

  const myTeam = computed<GuandanTeam | null>(() => {
    const seat = state.value?.selfSeat
    return seat == null ? null : teamFromSeat(seat)
  })

  const levels = computed<readonly [number, number]>(() => guan.value?.guandan.levels ?? DEFAULT_LEVELS)
  const playedLevel = computed(() => guan.value?.guandan.playedLevel ?? 15)
  const level = computed(() => {
    const team = myTeam.value
    return team == null ? playedLevel.value : levels.value[team]
  })
  const deal = computed(() => guan.value?.guandan.deal ?? 1)
  const matchWinner = computed<GuandanTeam | null>(() => guan.value?.guandan.matchWinner ?? null)
  const result = computed<GuandanRoundResult | null>(() => guan.value?.guandan.result ?? null)
  const exchange = computed<GuandanExchange | null>(() => guan.value?.guandan.exchange ?? null)
  // Full deal history survives trick clears and reconnects; lastPlay does not.
  const hasPlayed = computed(() => (guan.value?.tablePlays.length ?? 0) > 0)
  const privateAction = computed<GuandanPrivateAction | null>(() => guan.value?.privateAction ?? null)

  function teamOf(seatId: number): GuandanTeam {
    return teamFromSeat(seatId)
  }

  /** Own/opponent for a seated device; the host-less tablet names the fixed teams instead. */
  function teamTagOf(seatId: number): string {
    const team = teamOf(seatId)
    const mine = myTeam.value
    if (mine == null) return TEAM_NAMES[team]
    return team === mine ? '我方' : '对方'
  }

  function relativeSeat(offset: number): Seat | null {
    const self = state.value?.selfSeat
    if (self == null) return null
    const count = common.seatCount.value
    const id = (self + offset + count * 2) % count
    return seats.value.find((seat) => seat.id === id) ?? null
  }

  const nextSeat = computed(() => relativeSeat(1)?.id ?? null)
  const partnerSeat = computed(() => relativeSeat(2)?.id ?? null)
  const previousSeat = computed(() => relativeSeat(-1)?.id ?? null)

  function seatLabel(seatId: number): string {
    const seat = seats.value.find((entry) => entry.id === seatId)
    return seat?.name ?? `${seatId + 1} 号座`
  }

  /** 头游/二游/三游/末游 from the finished order; both losers of a 双下 read 双下. */
  function finishLabel(seatId: number): string {
    const snapshot = guan.value?.guandan
    if (!snapshot) return ''
    const order = snapshot.result ? snapshot.result.order : snapshot.finishOrder
    const index = order.indexOf(seatId)
    if (index < 0) return ''
    if (snapshot.result && snapshot.result.doubleDown && index >= 2) return '双下'
    return FINISH_LABELS[index] ?? ''
  }

  const levelText = computed(() => `打 ${rankGlyph(playedLevel.value)}`)
  /** Own team first, derived from seat parity; the tablet has no seat and reads both teams. */
  const levelsText = computed(() => {
    const [first, second] = levels.value
    const mine = myTeam.value
    if (mine == null) return `${TEAM_NAMES[0]} ${rankGlyph(first)} · ${TEAM_NAMES[1]} ${rankGlyph(second)}`
    return `我方 ${rankGlyph(mine === 0 ? first : second)} · 对方 ${rankGlyph(mine === 0 ? second : first)}`
  })
  /**
   * Level of the NEXT deal, taken from the upgrade the server already applied. A decided match
   * advertises nothing, because a rematch restarts both teams at 2.
   */
  const nextLevel = computed<number | null>(() => {
    if (matchWinner.value !== null) return null
    const round = guan.value?.guandan.result
    return round ? round.levelsAfter[round.winnerTeam] : null
  })
  const nextLevelText = computed(() => (nextLevel.value == null ? '' : `下一副打 ${rankGlyph(nextLevel.value)}`))
  const resultText = computed(() => {
    const round = guan.value?.guandan.result
    if (!round) return ''
    const mine = myTeam.value
    const side = mine == null ? TEAM_NAMES[round.winnerTeam] : round.winnerTeam === mine ? '我方' : '对方'
    const suffix = round.doubleDown ? ' · 双下' : ''
    return `${side}获胜 · 升 ${round.upgrade} 级${suffix}`
  })
  /**
   * Why the exchange was skipped. The paying side holds the two big jokers (split across the two
   * paying seats in a double down), so it is never "nobody has them"; the head still leads.
   */
  const resistNote = computed(() => {
    const current = exchange.value
    if (!current || current.stage !== 'resisted' || hasPlayed.value) return ''
    const side = current.givers.length > 1 ? '进贡的两家共有两张大王' : '进贡方持有两张大王'
    return `${side}，本副免进贡，由头游先出牌。`
  })
  const exchangeStageText = computed(() => {
    const stage = exchange.value?.stage
    if ((stage === 'resisted' || stage === 'complete') &&
        (hasPlayed.value || phase.value === 'finished' || phase.value === 'lobby')) return ''
    if (stage === 'tribute') return '进贡中'
    if (stage === 'return') return '还贡中'
    if (stage === 'resisted') return '抗贡 · 免进贡'
    if (stage === 'complete') return '交换完成'
    return ''
  })
  const exchangeNotice = computed(() => {
    if (phase.value === 'lobby' || phase.value === 'finished') return null
    if (phase.value === 'playing' && hasPlayed.value) return null
    const current = exchange.value
    if (!current || current.stage === 'none') return null
    const names = current.givers.map(seatLabel).join('、')
    if (current.stage === 'resisted') return {
      title: '抗贡成功 · 本副免进贡',
      detail: `${names}${current.givers.length > 1 ? '合计' : ''}持有两张大王，由${current.leader == null ? '头游' : seatLabel(current.leader)}先出牌。`,
    }
    if (current.stage === 'tribute') return {
      title: current.givers.length > 1 ? '双贡 · 等待进贡' : '单贡 · 等待进贡',
      detail: `${names}进贡最大的非逢人配牌，之后由收贡方还贡。`,
    }
    if (current.stage === 'return') return {
      title: '进贡已收齐 · 等待还贡',
      detail: `${current.pairs.map(pair => seatLabel(pair.receiver)).join('、')}选牌还贡后开始出牌。`,
    }
    return {
      title: '进贡还贡完成',
      detail: current.pairs.map(pair => `${seatLabel(pair.giver)}向${seatLabel(pair.receiver)}进贡${bottomCardText(pair.tribute).text}${pair.returned ? `，还${bottomCardText(pair.returned).text}` : ''}`).join('；'),
    }
  })

  const playEnabled = computed(
    () => phase.value === 'playing' && isMyTurn.value && allConnected.value && game.connected?.value !== false && !busy.value && !common.managed.value && !common.dealing.value,
  )
  const canPass = computed(() => {
    const snapshot = guan.value
    return playEnabled.value && snapshot?.lastPlay != null && snapshot.lastPlay.seatId !== snapshot.selfSeat
  })
  const exchangeLocked = computed(() => phase.value === 'tribute')
  const plays = computed<TablePlay[]>(() => state.value?.tablePlays ?? [])

  return {
    ...common,
    guan,
    deckCount: GAME_DEFINITIONS.guandan.deckCount,
    plays,
    level,
    playedLevel,
    levels,
    deal,
    matchWinner,
    result,
    exchange,
    privateAction,
    myTeam,
    teamOf,
    teamTagOf,
    nextSeat,
    partnerSeat,
    previousSeat,
    relativeSeat,
    seatLabel,
    finishLabel,
    levelText,
    levelsText,
    resultText,
    nextLevel,
    nextLevelText,
    resistNote,
    exchangeStageText,
    exchangeNotice,
    playEnabled,
    canPass,
    exchangeLocked,
    rankLabel: rankGlyph,
  }
}
