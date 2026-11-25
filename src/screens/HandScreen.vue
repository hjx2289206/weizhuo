<script setup lang="ts">
import BrandMark from '../components/BrandMark.vue'
import GameTools from '../components/GameTools.vue'
import { inject } from 'vue'
import { GAME_TOOLS } from '../gameTools'
import AppIcon from '../components/AppIcon.vue'
import { computed, ref, watch } from 'vue'
import type { GameKind, TablePlay } from '../../shared/protocol'
import type { GameController } from '../useGame'
import AutoPlayControl from '../components/AutoPlayControl.vue'
import PlayActions from '../components/PlayActions.vue'
import CardCounter from '../components/CardCounter.vue'
import FanHand from '../components/FanHand.vue'
import GuandanActions from '../components/GuandanActions.vue'
import GuandanExchange from '../components/GuandanExchange.vue'
import GuandanExchangeNotice from '../components/GuandanExchangeNotice.vue'
import HandheldHand from '../components/HandheldHand.vue'
import HandSortControl from '../components/HandSortControl.vue'
import JoinForm from '../components/JoinForm.vue'
import NicknameEditor from '../components/NicknameEditor.vue'
import PhraseBanner from '../components/PhraseBanner.vue'
import QuickPhraseControl from '../components/QuickPhraseControl.vue'
import SoundToggle from '../components/SoundToggle.vue'
import { useHandMorph } from '../useHandMorph'
import { useHandSort } from '../useHandSort'
import { useDealAnimation } from '../useDealAnimation'
import { useHandMotion } from '../useHandMotion'
import { useGameScreen } from '../siteScreen'
import { useGuandanActions } from '../useGuandanActions'
import { useDoudizhuView } from './useDoudizhuView'
import { useGuandanView } from './useGuandanView'

const props = defineProps<{ game: GameController }>()
const tools = inject(GAME_TOOLS)
function showResult(): void { if (tools) tools.resultOpen.value = true }
const { state, connected, busy, error, selected, roomCode, seatId, savedSession, roomInfo, seatRequest, phrase, inspectRoom } =
  props.game
const ddz = useDoudizhuView(props.game)
const gu = useGuandanView(props.game)
const guActions = useGuandanActions(props.game)
const {
  phase,
  phaseText,
  winnerText,
  mySeat,
  myHand,
  isMyTurn,
  myRole,
  myScore,
  playEnabled,
  canPlay,
  canPass,
  canBid,
  turnText,
  turnClock,
  bidStatusText,
  fmtScore,
  run,
  playFromGesture,
  autoPlayEnabled,
} = ddz

/** The dedicated hand serves both games: only the game-specific panels differ. */
const isGuandan = computed(() => state.value?.game === 'guandan')

function sayPhrase(phraseId: string): void {
  run(() => props.game.sayPhrase(phraseId))
}
const isDoudizhu = computed(() => state.value?.game === 'doudizhu')
const guEligibleIds = computed<readonly string[] | null>(() => gu.privateAction.value?.eligibleIds ?? null)
const guPlayEnabled = computed(() => gu.playEnabled.value)
const guPlayedLevel = computed(() => gu.playedLevel.value)
/**
 * Kind of the room this screen is about: the live snapshot once bound, otherwise the public
 * summary an invite link inspected. Unknown stays the collection name rather than guessing a game.
 */
const knownGame = computed<GameKind | null>(() => roomInfo.value?.game ?? state.value?.game ?? null)
const gameName = computed(() =>
  knownGame.value === 'guandan' ? '掼蛋' : knownGame.value === 'doudizhu' ? '斗地主' : '桌游合集',
)

/** Local-only ordering: remembered per game, never sent to the server. */
const handSort = useHandSort({
  game: () => knownGame.value,
  hand: () => myHand.value,
  level: () => (isGuandan.value ? guPlayedLevel.value : null),
})

const joined = computed(() => state.value?.role === 'player' && state.value.selfSeat != null)
/** A stored seat credential for exactly this URL intent is being re-authenticated right now. */
const restoring = computed(() => {
  const saved = savedSession.value
  return (
    !joined.value &&
    !error.value &&
    saved != null &&
    saved.role === 'player' &&
    saved.code === roomCode.value &&
    saved.seatId === seatId.value
  )
})

/* ------------------------------------------------------------ guest invite */
/** Pending / rejected / cancelled state handed to the join form (matches JoinForm's own shape). */
interface JoinRequestStatus {
  status: 'pending' | 'rejected' | 'cancelled'
  code: string
  seatId: number
  message: string
}

/** Code whose public summary this screen last asked for; never inspected twice in a row. */
const inspectedCode = ref('')

function inspect(code: string): void {
  inspectedCode.value = code
  run(() => inspectRoom(code))
}

/**
 * An invite link carries a room, not a session, so a guest loads the public summary once
 * (seats and kind only, no hand and no token). A code the controller already resolved is
 * inspected only when its summary is missing; failures stay visible instead of retrying.
 */
watch(
  [roomCode, joined, restoring, () => roomInfo.value?.code],
  () => {
    const code = roomCode.value
    if (joined.value || restoring.value) return
    if (!/^[A-Z0-9]{3,10}$/.test(code)) return
    if (inspectedCode.value === code || roomInfo.value?.code === code) return
    inspect(code)
  },
  { immediate: true },
)

/** Roster of the room this screen is showing; a summary of another room is never reused. */
const roster = computed(() => {
  const summary = roomInfo.value
  if (!summary) return null
  const wanted = inspectedCode.value || roomCode.value
  return summary.code === wanted ? summary.seats : null
})

/** This device's own request, and only while it still matches the room on screen. */
const requestInfo = computed<JoinRequestStatus | null>(() => {
  const request = seatRequest.value
  if (!request || request.code !== roomCode.value) return null
  return { status: request.status, code: request.code, seatId: request.seatId, message: request.message }
})

/* ------------------------------------------------------- screen / landscape */
// Fullscreen and orientation lock are gesture-gated, so the 准备 tap asks for them
// inside the same gesture and an honest gate explains the real answer afterwards.
// The module only reads the browser: identity, hand, turn and selection survive it.
const phoneScreen = useGameScreen()
const {
  supported: screenSupported,
  active: screenActive,
  landscape: screenLandscape,
  busy: screenBusy,
  limited: screenLimited,
  dismissed: screenDismissed,
  note: screenNote,
} = phoneScreen

/**
 * The gate matters while the hand is actually in a game: DDZ bids, both games play, and the
 * Guandan tribute/return exchange is part of the same active deal.
 */
const handInGame = computed(
  () => phase.value === 'bidding' || phase.value === 'playing' || phase.value === 'tribute',
)
/** Landscape with the screen actually granted, or an explicit landscape fallback. */
const screenSettled = computed(() => screenLandscape.value && (screenActive.value || screenDismissed.value))
const showPhoneGate = computed(() => joined.value && handInGame.value && !screenSettled.value)
const gateCanRetry = computed(() => screenSupported.value)
/** The browser fallback is only offered once the phone is really landscape. */
const gateCanContinue = computed(() => screenLandscape.value && screenLimited.value)

watch([phase, joined], () => {
  phoneScreen.refresh()
})

/** 准备: ask for the game screen first (same gesture), then send the ready command. */
function ready(): void {
  phoneScreen.enter()
  run(props.game.ready)
}

/* ------------------------------------------------------- 记牌器 / hand mode */
/** OFF: the large handheld fan. ON: the compact fan with the counter strip above it. */
const counterOn = ref(false)
let counterTarget = false
let counterSwitch = 0
const counterReady = computed(() => phase.value === 'playing' || phase.value === 'finished')
const plays = computed<TablePlay[]>(() => state.value?.tablePlays ?? [])

const stageEl = ref<HTMLElement | null>(null)
const dealMotion = useDealAnimation(state)
const handMotion = useHandMotion(state, stageEl, dealMotion, true)
const { morphing: handMorphing, run: runHandMorph, cancel: cancelHandMorph } = useHandMorph()

/**
 * Switching renderers moves the same cards: the poses are captured, the mode is
 * changed, and the ghost layer travels between the two layouts. Selection, the
 * hand and the room are untouched, and a fast second tap just restarts the move.
 */
function toggleCounter(): void {
  if (dealMotion.value) return
  const request = ++counterSwitch
  counterTarget = !counterTarget
  const next = counterTarget
  handMotion.cancel()
  cancelHandMorph()
  if (next === counterOn.value) return
  void runHandMorph(stageEl.value, () => {
    counterOn.value = next
  }).finally(() => {
    if (request === counterSwitch) counterTarget = counterOn.value
  })
}

// A played hand changes the cards under the ghosts: settle on the real cards.
watch(
  () => myHand.value.map((card) => card.id).join(','),
  () => {
    cancelHandMorph()
  },
)

const bidValues = [0, 1, 2, 3]

function rename(name: string): void {
  run(() => props.game.renameSelf(name))
}

function leave(): void {
  handMotion.cancel()
  cancelHandMorph()
  props.game.leaveRoom()
}

/* --------------------------------------------------------------- edit join */
function join(payload: { code: string; seat: number; name: string }): void {
  run(() => props.game.joinRoom(payload.code, payload.seat, payload.name))
}

function request(payload: { code: string; seat: number; name: string }): void {
  run(() => props.game.requestSeat(payload.code, payload.seat, payload.name))
}
</script>

<template>
  <div class="hand-screen" :class="{ 'hand-screen--handheld': !counterOn }" :data-phase="phase" :data-game="state?.game">
    <PhraseBanner :phrase="phrase" />
    <header class="hand-header">
      <div class="hand-brand">
        <BrandMark />
        <span class="brand">{{ gameName }}</span>
        <span v-if="roomCode" class="room-badge">房间 <strong>{{ roomCode }}</strong></span>
      </div>
      <span class="connection" :class="{ online: connected }">
        <i class="connection-dot"></i>{{ connected ? '已连接' : '连接中' }}
      </span>
      <span v-if="isGuandan && joined" class="guandan-level-chip">{{ gu.levelText.value }}</span>
      <template v-if="joined">
        <AutoPlayControl v-if="phase !== 'lobby'" :view="isGuandan ? gu : ddz" :busy="busy" :connected="connected" />
        <QuickPhraseControl :busy="busy" :connected="connected" @say="sayPhrase" />
        <SoundToggle v-if="state?.roomMode !== 'tablet'" />
        <span v-else class="table-audio-note" title="平板模式的音效统一由牌桌播放">音效由平板播放</span>
        <button class="counter-toggle" aria-label="记牌器" type="button" :aria-pressed="counterOn" :disabled="Boolean(dealMotion)" @click="toggleCounter"><AppIcon name="counter" /><span>记牌器</span></button>
        <button class="button small ghost" type="button" :disabled="busy" @click="leave" aria-label="返回大厅"><AppIcon name="home" /><span>返回大厅</span></button>
      </template>
      <GameTools :game="props.game" />
    </header>

    <!-- Seat invite opened without a stored credential: this client holds no cards yet. -->
    <div v-if="!joined && !restoring" class="phone-lobby">
      <h2 class="panel-title">加入牌桌</h2>
      <JoinForm
        compact
        :saved-session="savedSession"
        :initial-code="roomCode"
        :initial-seat="seatId ?? 0"
        :initial-name="savedSession?.name ?? ''"
        :roster="roster"
        :spectator-count="roomInfo?.spectatorCount"
        :game="knownGame"
        :request="requestInfo"
        :busy="busy"
        @inspect="inspect"
        @spectate="code => run(() => game.spectateRoom(code))"
        @join="join"
        @request="request"
        @resume="run(props.game.resumeLastRoom)"
      />
    </div>

    <div v-else-if="restoring" class="phone-lobby">
      <BrandMark />
      <h2>正在恢复牌局</h2>
      <p class="muted">房间 {{ roomCode }} · {{ (seatId ?? 0) + 1 }} 号座</p>
    </div>

    <template v-else>
      <div v-if="phase === 'lobby'" class="phone-lobby">
        <h2>{{ mySeat?.name ?? '我' }}</h2>
        <p class="muted">{{ (state?.selfSeat ?? 0) + 1 }} 号座 · {{ mySeat?.ready ? '已准备' : '未准备' }}</p>
        <button class="button primary" type="button" :disabled="busy || !connected || autoPlayEnabled" @click="ready">
          {{ autoPlayEnabled ? '托管已准备' : mySeat?.ready ? '取消准备' : '准备' }}
        </button>
        <!-- Own opt-in hosting is reachable already in the lobby, where opting in also readies the seat. -->
        <AutoPlayControl :view="isGuandan ? gu : ddz" :busy="busy" :connected="connected" />
        <p v-if="isGuandan" class="muted">
          4 人两副牌 · {{ gu.teamTagOf(state?.selfSeat ?? 0) }} · {{ gu.levelsText.value }}
        </p>
        <p class="muted">等待房主在平板上开始游戏</p>
      </div>

      <template v-else>
        <div class="phone-status">
          <div class="player-identity">
            <span class="identity-avatar">{{ (mySeat?.name ?? '我').slice(0, 1) }}</span>
            <div>
              <strong>{{ mySeat?.name ?? '我' }}</strong>
              <small>{{ isGuandan ? gu.teamTagOf(state?.selfSeat ?? 0) : myRole }} · 剩 {{ mySeat?.count ?? myHand.length }} 张</small>
            </div>
          </div>
          <span
            class="turn-pill"
            :class="{ 'your-turn': isMyTurn, 'timer-urgent': turnClock.active.value && turnClock.urgent.value }"
          >
            {{ phase === 'finished' ? (isGuandan ? gu.resultText.value : winnerText) : turnText }}
          </span>
          <NicknameEditor :name="mySeat?.name ?? null" :busy="busy" @save="rename" />
        </div>

        <GuandanExchangeNotice v-if="isGuandan" :view="gu" />

        <div v-if="counterOn" class="counter-strip">
          <CardCounter
            v-if="counterReady"
            :hand="handSort.displayHand.value"
            :plays="isGuandan ? gu.plays.value : plays"
            :deck-count="isGuandan ? gu.deckCount : 1"
            :level-rank="isGuandan ? guPlayedLevel : null"
          />
          <p v-else class="muted">
            {{ isGuandan ? '开局后开始记牌。' : '确定地主后开始记牌（此时底牌还未归入任何一方）。' }}
          </p>
        </div>

        <div
          ref="stageEl"
          class="hand-stage"
          :class="{ 'hand-stage--handheld': !counterOn, 'is-hand-morphing': handMorphing }"
        >
          <HandSortControl
            v-if="myHand.length > 0"
            :mode="handSort.mode.value"
            @cycle="handSort.cycle"
          />
          <HandheldHand
            v-if="!counterOn"
            :cards="handSort.displayHand.value"
            :selected="selected"
            :toggle-card="props.game.toggleCard"
            :play="isGuandan ? guActions.playFromGesture : playFromGesture"
            :enabled="isGuandan ? guPlayEnabled : playEnabled"
            :level-rank="isGuandan ? guPlayedLevel : null"
            :eligible-ids="isGuandan ? guEligibleIds : null"
          />
          <FanHand
            v-else
            :cards="handSort.displayHand.value"
            :selected="selected"
            :toggle-card="props.game.toggleCard"
            :play="isGuandan ? guActions.playFromGesture : playFromGesture"
            :enabled="isGuandan ? guPlayEnabled : playEnabled"
            :level-rank="isGuandan ? guPlayedLevel : null"
            :eligible-ids="isGuandan ? guEligibleIds : null"
          />
        </div>

        <GuandanExchange v-if="isGuandan" compact :game="props.game" :view="gu" />

        <GuandanActions
          v-if="isGuandan && phase === 'playing'"
          class="hand-actions"
          :game="props.game"
          :view="gu"
          :actions="guActions"
        />



        <div v-if="!isGuandan" class="hand-actions">
          <template v-if="phase === 'bidding'">
            <span class="selection-count">{{ bidStatusText }}</span>
            <div class="bid-controls">
              <button
                v-for="value in bidValues"
                :key="value"
                class="button small"
                type="button"
                :disabled="!canBid(value)"
                @click="run(() => props.game.bid(value))"
              >{{ value === 0 ? '不叫' : `${value} 分` }}</button>
            </div>
          </template>
          <PlayActions
            v-else-if="phase === 'playing'"
            :selected-count="selected.length"
            :can-play="canPlay"
            :can-pass="canPass"
            :can-hint="playEnabled"
            @play="playFromGesture"
            @pass="run(props.game.pass)"
            @hint="props.game.nextHint"
            @clear="props.game.clearSelection()"
          ><span class="selection-feedback" :class="{ 'is-invalid': selected.length > 0 && !ddz.selectionValid.value }" role="status">{{ ddz.selectionStatus.value }}</span></PlayActions>
          <template v-else>
            <span class="selection-count">{{ winnerText }} · 累计得分 {{ fmtScore(myScore) }}</span>
            <span class="muted">等待房主再来一局</span>

          </template>
        </div>

        <p v-if="!counterOn" class="handheld-hint">点选选牌 · 拇指横向划选 · 上滑出牌</p>
        <p v-else class="gesture-hint">点按选牌 · 横向划扫连续选牌 · 上滑出牌</p>

      </template>
    </template>

    <div v-if="phase === 'finished' && joined" class="result-reopen"><button class="review-button" type="button" @click="showResult"><AppIcon name="trophy" />查看本局结算</button></div>
    <footer v-if="joined" class="phone-footer">
      <span>桌游合集 · {{ gameName }}</span>
      <span>{{ phaseText }}</span>
    </footer>

    <!-- Honest fullscreen/orientation gate: only real APIs, never a fake lock. -->
    <div v-if="showPhoneGate" class="phone-screen-gate" role="dialog" aria-label="横屏牌局">
      <div class="phone-screen-panel">
        <AppIcon class="phone-rotate-icon" name="rotate" />
        <h2>横屏牌局</h2>
        <p class="phone-screen-hint">{{ screenNote }}</p>
        <button
          v-if="gateCanRetry"
          class="button primary"
          type="button"
          :disabled="screenBusy"
          @click="phoneScreen.enter"
        >点击进入横屏牌局</button>
        <button v-if="gateCanContinue" class="text-link" type="button" @click="phoneScreen.dismiss">
          继续浏览器横屏
        </button>
        <button class="gate-leave" type="button" @click="leave" aria-label="返回大厅"><AppIcon name="home" /><span>返回大厅</span></button>
      </div>
    </div>
  </div>
</template>
