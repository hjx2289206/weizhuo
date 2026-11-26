<script setup lang="ts">
import BrandMark from '../components/BrandMark.vue'
import GameTools from '../components/GameTools.vue'
import GameTutorialButton from '../components/GameTutorialButton.vue'
import { inject } from 'vue'
import { GAME_TOOLS } from '../gameTools'
import AppIcon from '../components/AppIcon.vue'
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import QRCode from 'qrcode'
import type { Card, Phase, Position, Seat, TablePlay } from '../../shared/protocol'
import type { GameController } from '../useGame'
import GuandanExchange from '../components/GuandanExchange.vue'
import GuandanExchangeNotice from '../components/GuandanExchangeNotice.vue'
import PassMark from '../components/PassMark.vue'
import HostTools from '../components/HostTools.vue'
import PhraseBanner from '../components/PhraseBanner.vue'
import TabletSeat from '../components/TabletSeat.vue'
import { recommendedTabletSeats, tabletSeatLayout } from '../tabletSeatLayout'
import PlayingCard from '../components/PlayingCard.vue'
import RobotIcon from '../components/RobotIcon.vue'
import SoundToggle from '../components/SoundToggle.vue'
import SeatCountControl from '../components/SeatCountControl.vue'
import SeatRequestPanel from '../components/SeatRequestPanel.vue'
import TurnTimerControl from '../components/TurnTimerControl.vue'
import TableDealAnimation from '../components/TableDealAnimation.vue'
import { useDealAnimation } from '../useDealAnimation'
import {
  bottomLayout,
  orientationForSeat,
  passLayout,
  playLayout,
  type BottomLayout,
  type StageBox,
  type ThrowLayout,
} from '../tableLayout'
import { fullscreenElement, releaseDocumentFullscreen, requestDocumentFullscreen } from '../usePhoneScreen'
import { suitGlyph } from './cardText'
import { useGameView } from './useGameView'
import { useDoudizhuView } from './useDoudizhuView'
import { useGuandanView } from './useGuandanView'

const props = defineProps<{ game: GameController; readOnly?: boolean }>()
const tools = inject(GAME_TOOLS)
function showResult(): void { if (tools) tools.resultOpen.value = true }
const { state, connected, busy, roomCode, phrase } = props.game
const dealMotion = useDealAnimation(state)
const common = useGameView(props.game)
const ddzView = useDoudizhuView(props.game)
const gu = useGuandanView(props.game)
const { seatFlags, seatMarker, automation } = common
const { canAddBot, canRemoveBot, addBot, removeBot } = ddzView
const { phase, phaseText, fmtScore, run } = common
const { winnerText, scoreOf, roleLabel } = ddzView

/** The table serves both games; only the game-specific panels differ. */
const game = computed(() => state.value?.game ?? null)
const isGuandan = computed(() => game.value === 'guandan')

/** Honest per-game description of the two robot tiers the lobby offers. */
const strongBotTitle = computed(() =>
  isGuandan.value
    ? 'DanLM transformer：每次都采纳模型估值最高的走法'
    : 'DouZero：始终采纳估值最高的合法走法',
)
const easyBotTitle = computed(() =>
  isGuandan.value
    ? 'DanZero 轻量 ONNX 网络（同仓库的易档模型）'
    : 'DouZero：按模型估值加权从最优 5 个走法里抽取，会犯一些合理错误',
)
const expectedSeats = common.seatCount
const seatSuggestions = computed(() => expectedSeats.value > 4 ? recommendedTabletSeats(expectedSeats.value) : [])

/* ---------------------------------------------------------------- seats */
/** Authoritative placements broadcast by the server. */
const authoritativeSeats = computed<Position[]>(() =>
  (state.value?.seats ?? []).map((seat) => ({ x: seat.x, y: seat.y, angle: seat.angle })),
)
/** Host-side projection: taps the host has made that the server has not broadcast yet. */
const draft = ref<Position[]>([])

const seats = computed<Seat[]>(() => {
  const placed = state.value?.seats ?? []
  const pending = draft.value.slice(placed.length)
  if (pending.length === 0) return placed
  return [
    ...placed,
    ...pending.map((position, index) => ({
      id: placed.length + index,
      name: null,
      connected: false,
      ready: false,
      count: 0,
      passed: false,
      isBot: false,
      autoPlay: false,
      ...position,
    })),
  ]
})

const isLobby = computed(() => phase.value === 'lobby')
const isPlaying = computed(() => phase.value === 'playing' || phase.value === 'finished')
/** Per-recipient host flag from the snapshot: never inferred from local state. */
const isHost = computed(() => state.value?.isHost === true)
const pendingRequests = computed(() => state.value?.seatRequests ?? [])
const anyClaimed = computed(() => seats.value.some((seat) => seat.name !== null))
const canConfigure = computed(() => !props.readOnly && !isGuandan.value && isLobby.value && draft.value.length < expectedSeats.value)
/** Trimming trailing empty positions preserves the identifiers of occupied seats. */
const canClearEmpty = computed(() => {
  if (isGuandan.value || !isLobby.value) return false
  const placed = state.value?.seats ?? []
  return placed.length > 0 && placed[placed.length - 1]!.name === null
})

function transferHost(nextSeatId: number): void {
  run(() => props.game.transferHost(nextSeatId))
}

function removeOfflineSeats(): void {
  run(() => props.game.removeOfflineSeats())
}

function clearEmptySeats(): void {
  run(() => props.game.clearEmptySeats())
}

function dissolveRoom(): void {
  run(() => props.game.dissolveRoom())
}
const canReset = computed(() => !isGuandan.value && isLobby.value && seats.value.length > 0 && !anyClaimed.value)
// A robot or an opted-in 托管 seat keeps the round moving without a socket, so it is not offline.
const allConnected = computed(
  () =>
    seats.value.length > 0 &&
    seats.value.every((seat) => seat.connected || seat.isBot === true || seat.autoPlay === true),
)
const canStart = computed(
  () =>
    isLobby.value &&
    seats.value.length === expectedSeats.value &&
    seats.value.every(
      (seat) => (seat.connected || seat.isBot === true || seat.autoPlay === true) && seat.ready && seat.name !== null,
    ),
)
const readyCount = computed(() => seats.value.filter((seat) => seat.ready).length)

/* --------------------------------------------------------- stage sizing */
const stageEl = ref<HTMLElement | null>(null)
const stageSize = ref({ w: 0, h: 0 })
const levelEl = ref<HTMLElement | null>(null)
const levelBox = ref<StageBox | null>(null)
watchEffect((onCleanup) => {
  const el = levelEl.value, stage = stageEl.value
  if (!el || !stage) { levelBox.value = null; return }
  const update = () => {
    const bounds = el.getBoundingClientRect(), parent = stage.getBoundingClientRect()
    levelBox.value = { cx: bounds.x - parent.x + bounds.width / 2,
      cy: bounds.y - parent.y + bounds.height / 2, width: bounds.width + 12, height: bounds.height + 12, angle: 0 }
  }
  update()
  if (typeof ResizeObserver === 'undefined') return
  const observer = new ResizeObserver(update)
  observer.observe(el); observer.observe(stage)
  onCleanup(() => observer.disconnect())
})

watchEffect((onCleanup) => {
  const el = stageEl.value
  if (!el) return
  const update = (): void => {
    stageSize.value = { w: el.clientWidth, h: el.clientHeight }
  }
  update()
  if (typeof ResizeObserver === 'undefined') return
  const observer = new ResizeObserver(update)
  observer.observe(el)
  onCleanup(() => observer.disconnect())
})

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/* -------------------------------------------------------- seat placement */
// Placement is serialized: `draft` is the host's projected placement, every tap
// appends to it locally and the whole array is sent one request at a time. The
// server acks before it broadcasts, so the snapshot always lags a burst of taps;
// the draft is never rebuilt from it.
let seatSyncInFlight = false
let seatSyncKey: string | null = null

function reconcileDraft(): void {
  const authoritative = authoritativeSeats.value
  const pendingAppend =
    draft.value.length > authoritative.length &&
    authoritative.every((position, index) => {
      const local = draft.value[index]
      return local !== undefined && local.x === position.x && local.y === position.y && local.angle === position.angle
    })
  if (!pendingAppend || (state.value?.seatCountSettings && !seatSyncInFlight)) draft.value = authoritative
}

watch(authoritativeSeats, reconcileDraft)
watch(expectedSeats, () => {
  draft.value = authoritativeSeats.value
  seatSyncKey = JSON.stringify(draft.value)
})

// A draft belongs to one room: a new room code must not inherit old seats.
watch(roomCode, () => {
  draft.value = []
  seatSyncKey = null
})

async function syncSeats(): Promise<void> {
  if (seatSyncInFlight) return
  const key = JSON.stringify(draft.value)
  if (seatSyncKey === key) return
  seatSyncInFlight = true
  let failed = false
  try {
    await props.game.setSeats(draft.value.map((position) => ({ ...position })))
    seatSyncKey = key
  } catch (caught) {
    // Drop the rejected draft instead of replaying it: the host sees the
    // authoritative placement again and retries by tapping.
    failed = true
    seatSyncKey = null
    draft.value = authoritativeSeats.value
    const message = caught instanceof Error && caught.message ? caught.message : '座位设置失败'
    if (!props.game.error.value) props.game.error.value = message
  } finally {
    seatSyncInFlight = false
  }
  if (!failed && seatSyncKey !== JSON.stringify(draft.value)) void syncSeats()
}

function resetSeats(): void {
  draft.value = []
  void syncSeats()
}

function setTurnTimer(seconds: number): void {
  run(() => props.game.setTurnTimer(seconds))
}

/** Adds a seat when the host taps a stage edge; middle taps are ignored. */
function onStageClick(event: MouseEvent): void {
  // The click that follows a long-press must never place a seat.
  if (longPressFired) {
    longPressFired = false
    return
  }
  if (!canConfigure.value || !stageEl.value) return
  if ((event.target as HTMLElement).closest('.tablet-seat')) return
  const rect = stageEl.value.getBoundingClientRect()
  const nx = clamp((event.clientX - rect.left) / rect.width, 0, 1)
  const ny = clamp((event.clientY - rect.top) / rect.height, 0, 1)
  const distances = { left: nx, right: 1 - nx, top: ny, bottom: 1 - ny }
  const edge = (Object.keys(distances) as Array<keyof typeof distances>).reduce((a, b) => (distances[a] <= distances[b] ? a : b))
  if (distances[edge] > 0.22) return
  let x = nx
  let y = ny
  if (edge === 'left') x = 0.1
  else if (edge === 'right') x = 0.9
  else if (edge === 'top') y = 0.1
  else y = 0.9
  x = clamp(x, 0.1, 0.9)
  y = clamp(y, 0.1, 0.9)
  placeSeat({ x, y, angle: orientationForSeat({ x, y }) })
}

function placeSeat(position: Position): void {
  if (!canConfigure.value) return
  draft.value = [...draft.value, position]
  void syncSeats()
}

function seatStyle(seat: Position): Record<string, string> {
  const layout = tabletSeatLayout(seat, stageSize.value, expectedSeats.value)
  return { left: `${layout.left}%`, top: `${layout.top}%`,
    '--seat-angle': `${layout.angle}deg`, '--seat-scale': String(layout.scale) }
}

function seatLabel(seat: Seat): string {
  return isGuandan.value ? gu.teamTagOf(seat.id) : roleLabel(seat) || '待定身份'
}

/** Public text for a throw that used wild cards: which level card stood in for what. */
function claimLabel(play: TablePlay): string {
  const claim = play.claim
  if (!claim || !isGuandan.value) return ''
  const level = gu.rankLabel(gu.playedLevel.value)
  const subs = claim.substitutions
    .map((item) => `红桃${level} 当 ${suitGlyph(item.suit)}${gu.rankLabel(item.rank)}`)
    .join('、')
  return subs ? `${claim.label} · ${subs}` : claim.label
}

/* -------------------------------------------------------- felt contents */
const ddz = computed(() => ddzView.ddz.value)
const bottomRevealed = computed(() => ddz.value != null && ddz.value.landlord !== null && isPlaying.value)
const centerCards = computed<Array<Card | null>>(() =>
  bottomRevealed.value && ddz.value ? ddz.value.bottom : [null, null, null],
)
/** The bottom-3 turns to face the landlord once one is chosen, 0deg before that. */
const bottomAngle = computed(() => {
  const landlord = ddz.value?.landlord
  if (!bottomRevealed.value || landlord == null) return 0
  const seat = seats.value.find((entry) => entry.id === landlord)
  return seat ? orientationForSeat(seat) : 0
})
const blockLayout = computed<BottomLayout>(() => bottomLayout(stageSize.value, bottomAngle.value))
const bottomWidth = computed(() => blockLayout.value.cardWidth)

/**
 * Public throws of the current round, oldest first. Every accepted play stays in
 * the DOM until the server clears the history for a new round, and later throws
 * land on top of earlier ones and of the block — covering is allowed, so no
 * placement search runs at all.
 */
interface ThrownPlay {
  play: TablePlay
  layout: ThrowLayout
  rows: Card[][]
  /** Only plays that arrived after the initial snapshot re-play the smash. */
  isNew: boolean
}

/**
 * Arrival tracking for `.is-new`. A fresh client that already sees a history
 * (joined or refreshed mid-round) treats it as old; a client that watched the
 * round from an empty history animates only the plays it has not seen yet.
 */
const seenPlayIds = new Set<string>()
const newPlays = ref<Set<string>>(new Set())
let playClock: 'unknown' | 'tracking' = 'unknown'
let newPlayTimers: number[] = []

/** Matches the parent's `table-smash` keyframes; the class is dropped afterwards. */
const SMASH_MS = 700

watch(
  () => (state.value?.tablePlays ?? []).map((play) => play.id),
  (ids) => {
    if (ids.length === 0) {
      seenPlayIds.clear()
      newPlays.value = new Set()
      playClock = 'tracking'
      return
    }
    if (playClock === 'unknown') {
      // First sight of this round's history: it is already on the felt.
      ids.forEach((id) => seenPlayIds.add(id))
      playClock = 'tracking'
      return
    }
    const arrived = ids.filter((id) => !seenPlayIds.has(id))
    if (arrived.length === 0) return
    arrived.forEach((id) => seenPlayIds.add(id))
    const next = new Set(newPlays.value)
    arrived.forEach((id) => next.add(id))
    newPlays.value = next
    newPlayTimers.push(
      window.setTimeout(() => {
        const pruned = new Set(newPlays.value)
        arrived.forEach((id) => pruned.delete(id))
        newPlays.value = pruned
      }, SMASH_MS),
    )
  },
)

onBeforeUnmount(() => {
  newPlayTimers.forEach((timer) => window.clearTimeout(timer))
  newPlayTimers = []
})

const tableThrows = computed<ThrownPlay[]>(() => {
  const plays = state.value?.tablePlays ?? []
  if (plays.length === 0) return []
  const byId = new Map(seats.value.map((seat) => [seat.id, seat]))
  const built: ThrownPlay[] = []
  for (const play of plays) {
    const actor = byId.get(play.seatId)
    if (!actor || play.cards.length === 0) continue
    const layout = playLayout(actor, stageSize.value, play.cards.length, play.scatter)
    built.push({ play, layout, rows: splitRows(play.cards, layout.rows), isNew: newPlays.value.has(play.id) })
  }
  return built
})

/** One entry per planned row, keeping straights/tractors in their played order. */
function splitRows(cards: Card[], rows: number[]): Card[][] {
  const split: Card[][] = []
  let index = 0
  for (const take of rows) {
    split.push(cards.slice(index, index + take))
    index += take
  }
  return split
}

function throwStyle(entry: ThrownPlay, index: number): Record<string, string> {
  const layout = entry.layout
  return {
    left: `${layout.left}%`,
    top: `${layout.top}%`,
    '--seat-angle': `${layout.angle}deg`,
    '--from-x': `${layout.fromX}px`,
    '--from-y': `${layout.fromY}px`,
    '--play-card-width': `${layout.cardWidth}px`,
    zIndex: `${index}`,
  }
}

function throwRowStyle(entry: ThrownPlay, index: number): Record<string, string> {
  const layout = entry.layout
  return {
    '--play-card-width': `${layout.cardWidth}px`,
    '--card-overlap': `${layout.rowOverlaps[index] ?? layout.overlap}px`,
    margin: index === 0 ? '0 auto' : `${layout.rowGap}px auto 0`,
  }
}

/** Footprints of the newest throws, so a `不要` label can dodge what is on top. */
const throwBoxes = computed<StageBox[]>(() =>
  tableThrows.value.slice(-6).map(({ layout }) => ({
    cx: (layout.left / 100) * stageSize.value.w,
    cy: (layout.top / 100) * stageSize.value.h,
    width: layout.width,
    height: layout.height,
    angle: layout.angle,
  })),
)

function passStyle(seat: Seat): Record<string, string> {
  const placards = seats.value.map(entry => {
    const box = tabletSeatLayout(entry, stageSize.value, expectedSeats.value)
    return { cx: box.left / 100 * stageSize.value.w, cy: box.top / 100 * stageSize.value.h,
      width: box.width, height: box.height, angle: 0 }
  })
  const scale = Math.min(stageSize.value.w, stageSize.value.h) < 340 ? .82 : 1
  const layout = passLayout(seat, stageSize.value, isGuandan.value ? null : blockLayout.value,
    [...throwBoxes.value, ...placards, ...(isGuandan.value && levelBox.value ? [levelBox.value] : [])],
    { w: 104 * scale, h: 78 * scale })
  return {
    left: `${layout.left}%`,
    top: `${layout.top}%`,
    '--seat-angle': `${layout.angle}deg`,
    '--tablet-pass-scale': String(scale),
  }
}

/* ------------------------------------------------------------- QR invites */
const inviteSeat = ref<Seat | null>(null)
const inviteLink = ref('')
const qrData = ref('')
const copyState = ref('复制链接')

function openInvite(seat: Seat): void {
  // The controls panel paints above the dialog, so step out of the way first.
  closeControls()
  inviteSeat.value = seat
  inviteLink.value = props.game.inviteUrl(seat.id)
  qrData.value = ''
  copyState.value = '复制链接'
  QRCode.toDataURL(inviteLink.value, { margin: 1, width: 420, color: { dark: '#193c34', light: '#fffdf5' } })
    .then((data) => {
      qrData.value = data
    })
    .catch(() => {
      copyState.value = '二维码生成失败'
    })
}

function closeInvite(): void {
  inviteSeat.value = null
}

function selectInviteInput(): void {
  document.querySelector<HTMLInputElement>('.invite-url')?.select()
}

async function copyInvite(): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteLink.value)
    copyState.value = '已复制'
  } catch {
    document.querySelector<HTMLInputElement>('.invite-url')?.select()
    copyState.value = '请手动复制'
  }
}

/* ------------------------------------------------------------ immersive */
const immersive = ref(false)
const controlsOpen = ref(false)
const fullscreenRejected = ref(false)
const isFullscreen = ref(false)

function syncFullscreen(): void {
  const active = fullscreenElement() !== null
  const wasFullscreen = isFullscreen.value
  isFullscreen.value = active
  if (active) fullscreenRejected.value = false
  // Leaving native fullscreen (Esc, F11, browser menu) restores the control view
  // instead of stranding the table in a half-immersive state.
  else if (wasFullscreen && immersive.value) exitImmersive()
}

document.addEventListener('fullscreenchange', syncFullscreen)
document.addEventListener('webkitfullscreenchange', syncFullscreen)
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFullscreen)
  document.removeEventListener('webkitfullscreenchange', syncFullscreen)
})

const fullscreenNote = computed(() => {
  if (isFullscreen.value) return '已进入浏览器全屏显示'
  if (fullscreenRejected.value) return '纯牌桌模式（浏览器未授权全屏，仍铺满屏幕）'
  return '纯牌桌模式（未使用浏览器全屏）'
})

function closeControls(): void {
  controlsOpen.value = false
}

function enterImmersive(): void {
  immersive.value = true
  controlsOpen.value = false
  fullscreenRejected.value = false
  let action: Promise<void> | void
  try {
    action = requestDocumentFullscreen()
  } catch {
    fullscreenRejected.value = true
    return
  }
  Promise.resolve(action)
    .catch(() => {
      fullscreenRejected.value = true
    })
    .finally(syncFullscreen)
}

function exitImmersive(): void {
  const leavingFullscreen = isFullscreen.value
  immersive.value = false
  controlsOpen.value = false
  fullscreenRejected.value = false
  if (!leavingFullscreen) return
  try {
    Promise.resolve(releaseDocumentFullscreen())
      .catch(() => undefined)
      .finally(syncFullscreen)
  } catch {
    /* native fullscreen already released */
  }
}

/** Explicit return to the hall: the server keeps this seat for a later resume. */
function leave(): void {
  exitImmersive()
  props.game.leaveRoom()
}

function decide(requestId: string, approve: boolean): void {
  run(() => props.game.decideSeatRequest(requestId, approve))
}

/* Long-press the empty felt to open the controls; movement, seats and cards cancel. */
const LONG_PRESS_MS = 550
const LONG_PRESS_MOVE_PX = 12
let pressTimer: number | null = null
let pressOrigin = { x: 0, y: 0 }
let pressArmed = false
/** Set when a long-press fired, so the click that follows cannot place a seat. */
let longPressFired = false

function clearPress(): void {
  if (pressTimer !== null) {
    window.clearTimeout(pressTimer)
    pressTimer = null
  }
  pressArmed = false
}

/** Seats, cards and other chrome are not empty felt. */
function isFeltChrome(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest('.tablet-seat, .physical-card-group, .playing-card, .physical-bottom-cards, button, input, select') !== null
}

/** The bottom-3 block is a physical element sitting on the felt. */
function isOnCentreBlock(clientX: number, clientY: number): boolean {
  const stage = stageEl.value
  if (!stage) return false
  const rect = stage.getBoundingClientRect()
  const block = blockLayout.value
  return (
    Math.abs(clientX - (rect.left + block.cx)) <= block.halfX + 18 &&
    Math.abs(clientY - (rect.top + block.cy)) <= block.halfY + 18
  )
}

function onStagePointerDown(event: PointerEvent): void {
  longPressFired = false
  if (!immersive.value || controlsOpen.value) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  if (isFeltChrome(event.target) || isOnCentreBlock(event.clientX, event.clientY)) return
  pressArmed = true
  pressOrigin = { x: event.clientX, y: event.clientY }
  pressTimer = window.setTimeout(() => {
    pressTimer = null
    if (!pressArmed) return
    pressArmed = false
    longPressFired = true
    controlsOpen.value = true
  }, LONG_PRESS_MS)
}

function onStagePointerMove(event: PointerEvent): void {
  if (!pressArmed) return
  if (Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y) > LONG_PRESS_MOVE_PX) clearPress()
}

/** Desktop/accessibility alternate for opening the controls once setup is done. */
function onStageDoubleClick(event: MouseEvent): void {
  if (!immersive.value || canConfigure.value || controlsOpen.value) return
  if (isFeltChrome(event.target) || isOnCentreBlock(event.clientX, event.clientY)) return
  controlsOpen.value = true
}

// The round result is transient: it surfaces once through the controls overlay,
// which also carries 再来一局, instead of parking a permanent dock on the felt.
watch(phase, (value) => {
  if (immersive.value && value === 'finished') controlsOpen.value = true
})

// A different room must not inherit the previous table's presentation state.
watch(roomCode, () => {
  immersive.value = false
  controlsOpen.value = false
})

onBeforeUnmount(clearPress)

/** Escape unwinds one layer at a time: invite dialog, then controls, then the table-only mode. */
function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (inviteSeat.value) {
    closeInvite()
    return
  }
  if (controlsOpen.value) {
    closeControls()
    return
  }
  if (immersive.value) exitImmersive()
}
watchEffect((onCleanup) => {
  window.addEventListener('keydown', onEscape)
  onCleanup(() => window.removeEventListener('keydown', onEscape))
})

/* ------------------------------------------------------------------ dock */
const PHASE_EYEBROW: Record<Phase, string> = {
  deploying: '秘密布阵',
  lobby: 'Lobby',
  bidding: 'Bidding',
  tribute: 'Tribute',
  playing: 'Playing',
  finished: 'Result',
}
const phaseEyebrow = computed(() => PHASE_EYEBROW[phase.value])
const centerHint = computed(() => {
  if (phase.value === 'lobby') {
    if (props.readOnly) return state.value?.message ?? ''
    if (isGuandan.value) return '上下同队 · 左右同队 · 按下 → 右 → 上 → 左出牌'
    if (seats.value.length === 0) return `点击牌桌边缘依次放置 ${expectedSeats.value} 个座位`
    if (seats.value.length < expectedSeats.value) {
      return `继续点击边缘放置座位（还差 ${expectedSeats.value - seats.value.length} 个）`
    }
    return '三台手机扫码入座'
  }
  if (phase.value === 'bidding') return '依次叫分 · 3 分直接成为地主'
  if (phase.value === 'tribute') return '进贡还贡 · 双贡需双方都提交后才公开'
  return ''
})
const dockTitle = computed(() => {
  if (phase.value === 'lobby') {
    if (isGuandan.value) return '固定四方座位'
    return seats.value.length === 0 ? '先放置座位' : `已就座 ${seats.value.length}/${expectedSeats.value}`
  }
  if (phase.value === 'bidding') return `当前最高 ${ddz.value?.bid ?? 0} 分`
  if (phase.value === 'tribute') return gu.exchangeStageText.value || '进贡还贡'
  if (phase.value === 'playing') return state.value?.turn != null ? `轮到 ${state.value.turn + 1} 号座` : '出牌中'
  return isGuandan.value ? gu.resultText.value || '本副结束' : '本局结束'
})
const dockText = computed(() => {
  if (phase.value === 'lobby') {
    const seatsText = `座位顺序 1 号 → ${expectedSeats.value} 号座`
    if (seats.value.length === 0) {
      return `点击牌桌边缘依次放置 ${expectedSeats.value} 个座位（按 1→${expectedSeats.value} 号顺序，四方各坐一边），随后点座位出示二维码。`
    }
    if (seats.value.length < expectedSeats.value) {
      return `继续点击牌桌边缘放置剩余座位（${seats.value.length}/${expectedSeats.value}）；点已放置的座位可出示邀请二维码。`
    }
    return isGuandan.value
      ? `固定四方座位 · 对家同队 · 下 → 右 → 上 → 左 · 已准备 ${readyCount.value}/${expectedSeats.value}`
      : `${seatsText} · 已准备 ${readyCount.value}/${expectedSeats.value}`
  }
  if (state.value?.message) return state.value.message
  if (phase.value === 'bidding') return '依次叫分，3 分立即成为地主；全部不叫则重新发牌。'
  if (phase.value === 'tribute') return '进贡/还贡完成前不能出牌；两张大王可以抗贡。'
  if (phase.value === 'playing') {
    return isGuandan.value
      ? '头游与队友先出完（双下）升 3 级；级牌与逢人配由服务器按声明校验。'
      : '地主先出牌，农民配合，先出完手牌的一方获胜。'
  }
  return isGuandan.value
    ? gu.resultText.value || '本副结束'
    : '零和计分：地主 ±2×底分×倍数，农民各取反。'
})
</script>

<template>
  <div class="table-screen" :class="{ 'is-immersive': immersive, 'is-read-only': readOnly }" :data-phase="phase" :data-game="game">
    <div v-if="immersive && game" class="table-tutorial-entry"><GameTutorialButton :game="game" :live="!['lobby', 'finished'].includes(phase)" /></div>
    <PhraseBanner v-if="!readOnly" :phrase="phrase" />
    <header v-if="!readOnly" class="table-header">
      <div class="brand"><BrandMark /><span>桌游合集</span></div>
      <div v-if="roomCode" class="room-badge">房间 <strong>{{ roomCode }}</strong></div>
      <span v-if="isGuandan" class="guandan-level-chip">{{ gu.levelText.value }} · {{ gu.levelsText.value }}</span>
      <span class="connection" :class="{ online: connected }">
        <i class="connection-dot"></i>{{ connected ? '已连接' : '重连中' }}
      </span>
      <span
        v-if="common.turnClock.active.value"
        class="turn-clock"
        :class="{ urgent: common.turnClock.urgent.value }"
        role="timer"
        :aria-label="`回合倒计时 ${common.turnClock.seconds.value} 秒`"
      ><AppIcon name="clock" />{{ common.turnClock.seconds.value }}s</span>
      <SoundToggle />
      <button
        class="button small ghost table-enter"
        type="button"
        aria-label="进入全屏牌桌模式"
        title="铺满屏幕只显示牌桌；进入后长按空白桌面可打开控制面板"
        @click="enterImmersive"
      >
        <AppIcon name="fullscreen" />全屏牌桌
      </button>
      <GameTools :game="props.game" />
    </header>

    <div
      ref="stageEl"
      class="table-stage"
      @click="onStageClick"
      @dblclick="onStageDoubleClick"
      @contextmenu.prevent
      @pointerdown="onStagePointerDown"
      @pointermove="onStagePointerMove"
      @pointerup="clearPress"
      @pointercancel="clearPress"
      @pointerleave="clearPress"
    >
      <div class="table-felt"></div>
      <div class="table-ring"></div>
      <TableDealAnimation :deal="dealMotion" :seats="seats" />
      <div v-if="canConfigure" class="edge-guide"></div>
      <template v-if="canConfigure && isHost">
        <button v-for="(position, index) in seatSuggestions" v-show="index >= draft.length" :key="index"
          class="tablet-seat-suggestion" type="button" :style="seatStyle(position)"
          :aria-label="`在推荐位置放置 ${index + 1} 号座`" :disabled="index !== draft.length"
          @click.stop="placeSeat(position)">{{ index + 1 }}</button>
      </template>

      <div class="table-center">
        <span
          v-if="(immersive || readOnly) && common.turnClock.active.value"
          class="turn-clock table-turn-clock"
          :class="{ urgent: common.turnClock.urgent.value }"
          role="timer"
          :aria-label="`回合倒计时 ${common.turnClock.seconds.value} 秒`"
        ><AppIcon name="clock" />{{ common.turnClock.seconds.value }}s</span>
        <p v-if="!isPlaying && !immersive" class="phase-label">{{ phaseText }}</p>
        <p v-if="!isPlaying && !immersive" class="table-logo">{{ isGuandan ? '掼蛋' : '斗地主' }}</p>
        <p v-if="!isPlaying && !immersive && centerHint" class="table-subtitle">{{ centerHint }}</p>
        <div
          v-if="!isGuandan"
          class="physical-bottom-cards"
          :style="{
            '--bottom-card-width': `${bottomWidth}px`,
            '--bottom-angle': `${bottomAngle}deg`,
          }"
        >
          <PlayingCard v-for="(card, index) in centerCards" :key="index" :card="card ?? undefined" :back="!card" />
        </div>
        <div v-if="isGuandan" ref="levelEl" class="guandan-level-block">
          <p class="guandan-level-team">{{ gu.levelsText.value }}</p>
          <p class="guandan-level-played">本副打 {{ gu.rankLabel(gu.playedLevel.value) }} · 第 {{ gu.deal.value }} 副</p>
          <p v-if="gu.exchangeStageText.value" class="guandan-level-exchange">
            {{ gu.exchangeStageText.value }}
          </p>
          <GuandanExchangeNotice :view="gu" />
          <p v-if="gu.matchWinner.value !== null" class="guandan-level-match">整场已分胜负</p>
        </div>
        <button v-if="phase === 'finished' && !readOnly" class="review-button table-result-reopen" type="button" @click="showResult"><AppIcon name="trophy" />查看本局结算</button>
      </div>

      <TabletSeat v-for="seat in seats" :key="seat.id" :seat="seat" :phase="phase"
        :active="(phase === 'playing' || phase === 'bidding') && state?.turn === seat.id"
        :label="seatLabel(seat)" :finish="isGuandan ? gu.finishLabel(seat.id) : ''"
        :team="isGuandan ? seat.id % 2 : undefined" :offline="seatFlags(seat.id).offline"
        :marker="seatMarker(seat.id)?.title" :readonly="readOnly" :style="seatStyle(seat)" @invite="openInvite(seat)" />

      <!-- Public history: every accepted play of the round, newest on top. -->
      <div class="table-throw-layer">
        <div
          v-for="(entry, index) in tableThrows"
          :key="entry.play.id"
          class="table-thrown-play"
          :class="{ 'is-new': entry.isNew }"
          :style="throwStyle(entry, index)"
        >
          <div
            v-for="(row, rowIndex) in entry.rows"
            :key="rowIndex"
            class="physical-card-group"
            :style="throwRowStyle(entry, rowIndex)"
          >
            <PlayingCard v-for="card in row" :key="card.id" class="physical-card" :card="card" />
          </div>
          <span v-if="claimLabel(entry.play)" class="guandan-claim-label">{{ claimLabel(entry.play) }}</span>
        </div>
      </div>

      <template v-for="seat in seats" :key="`seat-pass-${seat.id}`">
        <div v-if="isPlaying && seat.passed" :key="`pass-${seat.id}`" class="seat-play tablet-pass" :style="passStyle(seat)">
          <PassMark prominent />
          <span class="tablet-pass-caption">过牌</span>
        </div>
      </template>
    </div>

    <div v-if="!immersive && !readOnly" class="table-dock">
      <div class="dock-copy">
        <p class="eyebrow">{{ phaseEyebrow }}</p>
        <strong>{{ dockTitle }}</strong>
        <p>{{ dockText }}</p>
      </div>
      <SeatRequestPanel
        v-if="isHost && (isLobby || pendingRequests.length > 0)"
        :requests="pendingRequests"
        :busy="busy"
        @decide="decide"
      />
      <GuandanExchange v-if="isGuandan" :game="props.game" :view="gu" />
      <!-- Host-only lobby seating for robots; humans keep their invite and approval flow. -->
      <div v-if="isHost && isLobby" class="automation-bar">
        <SeatCountControl :game="props.game" />
        <div class="turn-timer-row">
          <TurnTimerControl
            :seconds="state?.turnLimitSeconds ?? 0"
            :busy="busy"
            @change="setTurnTimer"
          />
          <span class="automation-status muted">超时自动过牌；首出自动打最小合法牌</span>
        </div>
        <ul class="score-list">
          <li v-for="seat in state?.seats ?? []" :key="`bot-${seat.id}`" class="score-row">
            <span>
              {{ seat.id + 1 }} 号座 · {{ seat.name ?? '空座' }}
              <span v-if="seatMarker(seat.id)" class="automation-status">
                · {{ seatMarker(seat.id)?.text }}
              </span>
            </span>
            <template v-if="canAddBot(seat.id)">
              <button
                class="button small ghost automation-button"
                type="button"
                :disabled="busy"
                :title="strongBotTitle"
                @click="addBot(seat.id, { strength: 'strong' })"
              >
                <RobotIcon />
                <span>添加强机器人</span>
              </button>
              <button
                class="button small ghost automation-button"
                type="button"
                :disabled="busy"
                :title="easyBotTitle"
                @click="addBot(seat.id, { strength: 'easy' })"
              >
                <RobotIcon />
                <span>添加易机器人</span>
              </button>
            </template>
            <button
              v-else-if="canRemoveBot(seat.id)"
              class="button small ghost automation-button is-active"
              type="button"
              :disabled="busy"
              @click="removeBot(seat.id)"
            >
              <RobotIcon />
              <span>移除机器人</span>
            </button>
          </li>
        </ul>
        <span v-if="!automation.available" class="automation-status muted">
          {{
            automation.message ??
            (isGuandan
              ? '机器人不可用：本机没有可用的 DanLM 运行环境。'
              : '机器人不可用：本机没有可用的 DouZero 运行环境。')
          }}
        </span>
      </div>
      <div class="dock-actions">
        <button v-if="canReset" class="button small ghost" type="button" :disabled="busy" @click="resetSeats">
          重置座位
        </button>
        <button
          v-if="isLobby"
          class="button primary"
          type="button"
          :disabled="!canStart || busy"
          @click="run(props.game.start)"
        >开始游戏</button>
        <p v-if="phase === 'lobby'" class="start-status" role="status">{{ common.startStatus.value }}</p>
        <button v-if="phase === 'lobby' && seats.some(s => s.name === null)" class="button ghost fill-bots" type="button" :disabled="busy || !automation.available" @click="run(() => props.game.fillBots())">用机器人补齐空位</button>
        <button
          v-else-if="phase === 'finished'"
          class="button primary"
          type="button"
          :disabled="busy"
          @click="run(props.game.again)"
        >{{ isGuandan ? (gu.matchWinner.value !== null ? '再来一场' : '下一副') : '再来一局' }}</button>
        <button class="button secondary" type="button" :disabled="busy" @click="leave" aria-label="返回大厅"><AppIcon name="home" /><span>返回大厅</span></button>
        <HostTools
          v-if="isHost"
          :seats="seats"
          room-mode="tablet"
          :self-seat="null"
          :phase="phase"
          :busy="busy"
          :can-clear-empty="canClearEmpty"
          @transfer="transferHost"
          @remove-offline="removeOfflineSeats"
          @clear-empty="clearEmptySeats"
          @dissolve="dissolveRoom"
        />
      </div>
      <p v-if="isHost && pendingRequests.length" class="muted">有 {{ pendingRequests.length }} 个入座申请等待处理。</p>
      <p v-else-if="!allConnected" class="muted">有玩家离线，其手牌张数会保留，座位不会被清空。</p>
    </div>

    <!-- on-demand controls: the only chrome the table-only mode allows -->
    <div v-if="immersive && controlsOpen" class="table-controls-backdrop" @pointerdown.self="closeControls">
      <div class="table-controls-panel" role="dialog" aria-modal="true" aria-label="牌桌控制">
        <div class="dialog-heading">
          <div>
            <p class="eyebrow">Table</p>
            <h2>牌桌控制</h2>
          </div>
          <button class="icon-button" type="button" aria-label="关闭控制面板" @click="closeControls"><AppIcon name="close" /></button>
        </div>

        <div v-if="roomCode" class="room-badge">房间 <strong>{{ roomCode }}</strong></div>
        <span class="connection" :class="{ online: connected }">
          <i class="connection-dot"></i>{{ connected ? '已连接' : '重连中' }}
        </span>
        <p class="muted">{{ fullscreenNote }}</p>

        <button v-if="phase === 'finished'" class="review-button" type="button" @click="showResult"><AppIcon name="trophy" />查看本局结算</button>
        <p v-else class="muted">{{ dockTitle }} · {{ dockText }}</p>

        <template v-if="isLobby">
          <SeatCountControl :game="props.game" />
          <div class="score-list">
            <div v-for="seat in seats" :key="seat.id" class="score-row">
              <span>{{ seat.id + 1 }} 号座 · {{ seat.name ?? '待加入' }} · {{ seat.ready ? '已准备' : '未准备' }}</span>
              <button class="button small ghost" type="button" @click="openInvite(seat)"><AppIcon name="share" />邀请</button>
            </div>
          </div>
          <p v-if="seats.length < expectedSeats" class="muted">
            关闭面板后继续轻点牌桌边缘放置座位（{{ seats.length }}/{{ expectedSeats }}）。
          </p>
        </template>

        <SeatRequestPanel v-if="isHost" :requests="pendingRequests" :busy="busy" @decide="decide" />
        <GuandanExchange v-if="isGuandan" :game="props.game" :view="gu" />

        <GameTools :game="props.game" />
        <p v-if="isLobby" class="start-status" role="status">{{ common.startStatus.value }}</p>
        <button v-if="isLobby && seats.some(s => s.name === null)" class="button ghost fill-bots" type="button" :disabled="busy || !automation.available" @click="run(() => props.game.fillBots())">用机器人补齐空位</button>
        <div class="dock-actions">
          <button v-if="canReset" class="button small ghost" type="button" :disabled="busy" @click="resetSeats">
            重置座位
          </button>
          <button v-if="isLobby" class="button primary" type="button" :disabled="!canStart || busy" @click="run(props.game.start)">
            开始游戏
          </button>
          <button
            v-else-if="phase === 'finished'"
            class="button primary"
            type="button"
            :disabled="busy"
            @click="run(props.game.again)"
          >{{ isGuandan ? (gu.matchWinner.value !== null ? '再来一场' : '下一副') : '再来一局' }}</button>
          <button class="button secondary" type="button" @click="exitImmersive">退出纯牌桌</button>
          <button class="button secondary" type="button" :disabled="busy" @click="leave" aria-label="返回大厅"><AppIcon name="home" /><span>返回大厅</span></button>
          <HostTools
            v-if="isHost"
            :seats="seats"
            room-mode="tablet"
            :self-seat="null"
            :phase="phase"
            :busy="busy"
            :can-clear-empty="canClearEmpty"
            @transfer="transferHost"
            @remove-offline="removeOfflineSeats"
            @clear-empty="clearEmptySeats"
            @dissolve="dissolveRoom"
          />
        </div>

        <p class="muted">长按空白桌面可再次打开控制面板 · Esc 返回控制视图</p>
      </div>
    </div>

    <div v-if="inviteSeat" class="modal-backdrop" @click.self="closeInvite">
      <div class="invite-dialog" role="dialog" aria-modal="true" :aria-label="`${inviteSeat.id + 1} 号座邀请`">
        <div class="dialog-heading">
          <div>
            <p class="eyebrow">Seat Invite</p>
            <h2>{{ inviteSeat.id + 1 }} 号座</h2>
          </div>
          <button class="icon-button" type="button" aria-label="关闭" @click="closeInvite"><AppIcon name="close" /></button>
        </div>
        <img v-if="qrData" class="qr-image" :src="qrData" :alt="`${inviteSeat.id + 1} 号座邀请二维码`" />
        <input class="invite-url" type="text" readonly :value="inviteLink" aria-label="邀请链接" @focus="selectInviteInput" />
        <button class="button primary" type="button" @click="copyInvite">{{ copyState }}</button>
        <p class="dialog-footnote">手机需与平板连接同一 Wi-Fi，扫码后选择座位与昵称即可入座。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-screen.is-read-only { flex: 1; height: auto; min-height: 0; padding: 0; background: transparent; }
.is-read-only .table-stage { min-height: min(390px, 60dvh); }
.is-read-only .table-center { width: max-content; max-width: calc(100% - 20px); }
</style>

<style scoped>
.tablet-seat-suggestion { position: absolute; z-index: 4; transform: translate(-50%, -50%); width: 34px; height: 34px; padding: 0; border: 1px dashed #c8cba8; border-radius: 50%; background: #244839; color: #fff4d7; }
.tablet-seat-suggestion:disabled { pointer-events: none; opacity: .5; }
</style>
