import { computed, type ComputedRef } from 'vue'
import { GAME_DEFINITIONS } from '../../shared/gameCatalog'
import type { Card, GameKind, Phase, Seat, TablePlay } from '../../shared/protocol'
import type { GamePlayController } from '../playController'
import { useDealAnimation } from '../useDealAnimation'
import { useTurnClock, type TurnClock } from '../useTurnClock'

/**
 * Facts both games share. Nothing here reads a game-specific field, so a Guandan snapshot can
 * never be dressed up with a landlord, a bottom-three or Dou Dizhu scores.
 */
export interface GameViewCommon {
  dealing: ComputedRef<boolean>
  /** Confirmed room kind of the live snapshot, or null before a snapshot exists. */
  game: ComputedRef<GameKind | null>
  phase: ComputedRef<Phase>
  phaseText: ComputedRef<string>
  seats: ComputedRef<Seat[]>
  /** Seats this game actually needs, from the room setting or shared catalog, independent of placed seats. */
  seatCount: ComputedRef<number>
  allConnected: ComputedRef<boolean>
  readyCount: ComputedRef<number>
  canStart: ComputedRef<boolean>
  startStatus: ComputedRef<string>
  mySeat: ComputedRef<Seat | null>
  myHand: ComputedRef<Card[]>
  isMyTurn: ComputedRef<boolean>
  turnText: ComputedRef<string>
  /** Shared countdown fed by the snapshot; screens may style urgency or show a compact badge. */
  turnClock: TurnClock
  fmtScore: (value: number) => string
  /** Public accepted plays of the trick in progress: history after the last trick clear. */
  trickSlice: ComputedRef<TablePlay[]>
  trickPlayFor: (seatId: number) => TablePlay | null
  isSeatFinished: (seatId: number) => boolean
  /** Public runtime automation availability of this room (honest reason when missing). */
  automation: ComputedRef<RuntimeAutomation>
  /** Host lobby bot facts shared by both games; Guandan bots also carry a strength tier. */
  canHostBots: ComputedRef<boolean>
  canAddBot: (seatId: number) => boolean
  canRemoveBot: (seatId: number) => boolean
  addBot: (seatId: number, options?: { strength?: 'strong' | 'easy' }) => void
  removeBot: (seatId: number) => void
  /** Public per-seat automation facts, for robot / 托管 / offline markers. */
  seatFlags: (seatId: number) => SeatAutomationFlags
  /** Public marker chip for one seat, or null when the seat needs none. */
  seatMarker: (seatId: number) => SeatMarker | null
  /** True while this viewer's own seat is played by automation, so manual controls stay off. */
  managed: ComputedRef<boolean>
  autoPlayEnabled: ComputedRef<boolean>
  canToggleAutoPlay: ComputedRef<boolean>
  autoPlayTitle: ComputedRef<string>
  autoPlayStatus: ComputedRef<string>
  toggleAutoPlay: () => void
  /** Rejections surface as the shared toast instead of vanishing into an unhandled promise. */
  run: (action: () => Promise<void> | void) => void
}

/** DouZero runtime availability as published by the room: honest reason when it is missing. */
export interface RuntimeAutomation {
  available: boolean
  message: string | null
}

/** Marker facts for one seat: a robot, a managed seat, or a real human who is offline. */
export interface SeatAutomationFlags {
  bot: boolean
  managed: boolean
  offline: boolean
  /** True when a marker is meaningful at all (a bot or a hosting seat). */
  marked: boolean
}

/** Text plus tooltip for one seat's marker chip. */
export interface SeatMarker {
  text: string
  title: string
}

const PHASE_TEXT: Record<Phase, string> = {
  deploying: '秘密布阵',
  lobby: '等待入座',
  bidding: '叫地主',
  tribute: '进贡还贡',
  playing: '出牌中',
  finished: '本局结束',
}

/** Seats the catalog requires; an unknown game waits with the widest choice (up to 4). */
export function expectedSeatCount(game: GameKind | null | undefined): number {
  return game ? GAME_DEFINITIONS[game].seatCount : 4
}

export function formatScore(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

export function useGameView(game: GamePlayController): GameViewCommon {
  const { state, busy, selected, error } = game
  const deal = useDealAnimation(state)
  const dealing = computed(() => deal.value !== null)

  const kind = computed<GameKind | null>(() => state.value?.game ?? null)
  const phase = computed<Phase>(() => state.value?.phase ?? 'lobby')
  const seats = computed<Seat[]>(() => state.value?.seats ?? [])
  const seatCount = computed(() => state.value?.seatCountSettings?.count ?? expectedSeatCount(kind.value))
  /**
   * A managed seat (robot, or a human who opted into 托管) keeps the round moving without a live
   * socket, so it must never read as "offline" for enabling manual play or starting the game.
   */
  const allConnected = computed(
    () =>
      seats.value.length > 0 &&
      seats.value.every((seat) => seat.connected || seat.isBot === true || seat.autoPlay === true
        || (kind.value === 'guandan' && phase.value === 'playing' && seat.count === 0)),
  )
  const readyCount = computed(() => seats.value.filter((seat) => seat.ready).length)
  const canStart = computed(
    () =>
      seats.value.length === seatCount.value &&
      seats.value.every(
        (seat) => (seat.connected || seat.isBot === true || seat.autoPlay === true) && seat.ready && seat.name !== null,
      ),
  )
  const startStatus = computed(() => {
    const missing = seatCount.value - seats.value.filter(s => s.name !== null).length
    if (missing > 0) return `还差 ${missing} 位玩家，可邀请朋友或用机器人补齐`
    const offline = seats.value.filter(s => !s.connected && !s.isBot && !s.autoPlay)
    if (offline.length) return `等待 ${offline.map(s => s.name).join('、')} 重新连接`
    const unready = seats.value.filter(s => !s.ready)
    return unready.length ? `等待 ${unready.map(s => s.name).join('、')} 准备` : '全部就绪，房主可以开始游戏'
  })

  const mySeat = computed<Seat | null>(() => seats.value.find((seat) => seat.id === state.value?.selfSeat) ?? null)
  const myHand = computed<Card[]>(() => state.value?.hand ?? [])
  const isMyTurn = computed(
    () => state.value != null && state.value.turn != null && state.value.turn === state.value.selfSeat,
  )
  const turnClock = useTurnClock(state)

  const turnText = computed(() => {
    if (dealing.value) return '发牌中'
    const snapshot = state.value
    const suffix = turnClock.active.value ? ` · ${turnClock.seconds.value}s` : ''
    if (snapshot?.turn == null) {
      if (!turnClock.active.value) return '等待开始'
      const seat = turnClock.seatId.value
      if (seat === snapshot?.selfSeat) return `请操作${suffix}`
      return seat == null ? '等待开始' : `等待 ${seat + 1} 号座${suffix}`
    }
    const base = isMyTurn.value ? '轮到你' : `等待 ${snapshot.turn + 1} 号座`
    return `${base}${suffix}`
  })

  const trickSlice = computed<TablePlay[]>(() => {
    const snapshot = state.value
    if (!snapshot) return []
    const start = Number.isSafeInteger(snapshot.trickStartIndex) ? Math.max(0, snapshot.trickStartIndex) : 0
    return snapshot.tablePlays.slice(start)
  })

  function trickPlayFor(seatId: number): TablePlay | null {
    const slice = trickSlice.value
    for (let index = slice.length - 1; index >= 0; index -= 1) {
      const play = slice[index]
      if (play && play.seatId === seatId) return play
    }
    return null
  }

  /** A player who already emptied their hand stays finished for the rest of the deal. */
  function isSeatFinished(seatId: number): boolean {
    const snapshot = state.value
    if (!snapshot) return false
    if (snapshot.game === 'guandan') return snapshot.guandan.finishOrder.indexOf(seatId) >= 0
    const seat = snapshot.seats.find((entry) => entry.id === seatId)
    return snapshot.phase === 'finished' && seat != null && seat.count === 0
  }

  /** Runtime availability is a room fact; an older peer without it reads as unavailable. */
  const automation = computed<RuntimeAutomation>(() => {
    const published = state.value?.automation
    return published ? { available: published.available === true, message: published.message ?? null } : { available: false, message: null }
  })

  /* ------------------------------------------------------------ robot hosting */

  const canHostBots = computed(() => state.value != null && state.value.isHost === true && phase.value === 'lobby')

  function canAddBot(seatId: number): boolean {
    const seat = state.value?.seats.find((entry) => entry.id === seatId) ?? null
    if (!seat || !canHostBots.value) return false
    // Only a placed seat nobody human sits in can receive a robot.
    return seat.isBot !== true && seat.name === null
  }

  function canRemoveBot(seatId: number): boolean {
    const seat = state.value?.seats.find((entry) => entry.id === seatId) ?? null
    return seat != null && canHostBots.value && seat.isBot === true
  }

  function addBot(seatId: number, options?: { strength?: 'strong' | 'easy' }): void {
    run(() => game.addBot?.(seatId, options))
  }

  function removeBot(seatId: number): void {
    run(() => game.removeBot?.(seatId))
  }

  /**
   * Marker facts for one seat. A robot is never "offline" even though it owns no socket, and a
   * managed seat stays marked whether or not its human is currently connected.
   */
  function seatFlags(seatId: number): SeatAutomationFlags {
    const seat = state.value?.seats.find((entry) => entry.id === seatId)
    if (!seat) return { bot: false, managed: false, offline: false, marked: false }
    const bot = seat.isBot === true
    const managed = bot || seat.autoPlay === true
    return { bot, managed, offline: seat.name != null && !bot && !seat.connected, marked: managed }
  }

  /**
   * Marker chip for one seat. Robots and offline humans stay distinct, and a robot is never
   * described as disconnected even though it owns no socket.
   */
  function seatMarker(seatId: number): SeatMarker | null {
    const flags = seatFlags(seatId)
    if (flags.bot) {
      const seat = state.value?.seats.find((entry) => entry.id === seatId)
      const tier = seat?.botTier === 'easy' ? '易' : '强'
      const brain = kind.value === 'guandan' ? 'DanLM' : kind.value === 'doudizhu' ? 'DouZero' : null
      if (!brain) return { text: '机器人', title: '由服务器自动出牌，可申请替换该座位' }
      return {
        text: `机器人·${tier}`,
        title: `${brain} ${tier}机器人：由服务器自动出牌，可申请替换该座位`,
      }
    }
    if (!flags.managed) return null
    return flags.offline
      ? { text: '托管 · 离线', title: '该玩家已开启托管，当前离线，仍由托管自动出牌' }
      : { text: '托管', title: '该玩家已开启托管，由托管自动出牌' }
  }

  const managed = computed(() => {
    const self = state.value?.selfSeat
    return self == null ? false : seatFlags(self).managed
  })

  const canToggleAutoPlay = computed(() => state.value?.role === 'player' && state.value.selfSeat != null)
  const autoPlayTitle = computed(() => managed.value
    ? '取消托管，恢复手动操作'
    : kind.value === 'guandan' ? '开启托管：由简单 AI 自动出牌、进贡和还贡'
      : kind.value === 'doudizhu' ? '开启托管：由本机 DouZero 自动出牌' : '开启托管：由电脑自动出牌')
  const autoPlayStatus = computed(() => {
    if (!canToggleAutoPlay.value) return ''
    if (!automation.value.available) return automation.value.message ?? '托管服务暂不可用'
    if (!managed.value) return ''
    return kind.value === 'guandan' ? '简单 AI 托管中' : kind.value === 'doudizhu' ? 'DouZero 托管中' : '托管中'
  })
  function toggleAutoPlay(): void {
    run(() => game.setAutoPlay?.(!managed.value))
  }

  function report(reason: unknown): void {
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
    if (message && !error.value) error.value = message
  }

  function run(action: () => Promise<void> | void): void {
    try { Promise.resolve(action()).catch(report) } catch (reason) { report(reason) }
  }

  return {
    dealing,
    game: kind,
    phase,
    phaseText: computed(() => dealing.value ? '发牌中' : PHASE_TEXT[phase.value] ?? ''),
    seats,
    seatCount,
    allConnected,
    readyCount,
    canStart,
    startStatus,
    mySeat,
    myHand,
    isMyTurn,
    turnText,
    turnClock,
    fmtScore: formatScore,
    trickSlice,
    trickPlayFor,
    isSeatFinished,
    automation,
    canHostBots,
    canAddBot,
    canRemoveBot,
    addBot,
    removeBot,
    seatFlags,
    seatMarker,
    managed,
    autoPlayEnabled: managed,
    canToggleAutoPlay,
    autoPlayTitle,
    autoPlayStatus,
    toggleAutoPlay,
    run,
  }
}
