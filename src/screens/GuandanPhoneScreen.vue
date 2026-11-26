<script setup lang="ts">
import CardTableBoard from '../components/CardTableBoard.vue'
import BrandMark from '../components/BrandMark.vue'
import GameTools from '../components/GameTools.vue'
import { inject } from 'vue'
import { GAME_TOOLS } from '../gameTools'
import AppIcon from '../components/AppIcon.vue'
import { computed, ref, watch } from 'vue'
import type { GameController } from '../useGame'
import { useGuandanActions } from '../useGuandanActions'
import AutoPlayControl from '../components/AutoPlayControl.vue'
import CounterFloat from '../components/CounterFloat.vue'
import FanHand from '../components/FanHand.vue'
import GuandanActions from '../components/GuandanActions.vue'
import HandSortControl from '../components/HandSortControl.vue'
import GuandanExchange from '../components/GuandanExchange.vue'
import GuandanExchangeNotice from '../components/GuandanExchangeNotice.vue'
import SoundToggle from '../components/SoundToggle.vue'
import SeatCountControl from '../components/SeatCountControl.vue'
import TurnTimerControl from '../components/TurnTimerControl.vue'
import NicknameEditor from '../components/NicknameEditor.vue'
import HostTools from '../components/HostTools.vue'
import PhraseBanner from '../components/PhraseBanner.vue'
import QuickPhraseControl from '../components/QuickPhraseControl.vue'
import RobotIcon from '../components/RobotIcon.vue'
import SeatRequestPanel from '../components/SeatRequestPanel.vue'
import { useDealAnimation } from '../useDealAnimation'
import { useHandMotion } from '../useHandMotion'
import { useGameScreen } from '../siteScreen'
import { useHandSort } from '../useHandSort'
import { useGuandanView } from './useGuandanView'

const props = defineProps<{ game: GameController }>()
const tools = inject(GAME_TOOLS)
function showResult(): void { if (tools) tools.resultOpen.value = true }
const { state, connected, busy, selected, roomCode, phrase } = props.game
const stageEl = ref<HTMLElement | null>(null)
const dealMotion = useDealAnimation(state)
useHandMotion(state, stageEl, dealMotion, false)
const view = useGuandanView(props.game)
const actions = useGuandanActions(props.game)

function sayPhrase(phraseId: string): void {
  view.run(() => props.game.sayPhrase(phraseId))
}

function transferHost(nextSeatId: number): void {
  view.run(() => props.game.transferHost(nextSeatId))
}

function removeOfflineSeats(): void {
  view.run(() => props.game.removeOfflineSeats())
}

function dissolveRoom(): void {
  view.run(() => props.game.dissolveRoom())
}
const {
  phase,
  phaseText,
  mySeat,
  myHand,
  isMyTurn,
  turnText,
  trickPlayFor,
  isSeatFinished,
  seats,
  privateAction,
  levelText,
  levelsText,
  deckCount,
  playedLevel,
  matchWinner,
  resultText,
  finishLabel,
  relativeSeat,
  canAddBot,
  canRemoveBot,
  addBot,
  removeBot,
  automation,
  autoPlayEnabled,
  seatFlags,
  seatMarker,
  run,
} = view

const isHost = computed(() => state.value?.isHost === true)
const turnLimitText = computed(() => state.value?.turnLimitSeconds ? `${state.value.turnLimitSeconds} 秒/回合` : '不计时')
const pendingRequests = computed(() => state.value?.seatRequests ?? [])
const joined = computed(() => state.value?.role === 'player' && state.value.selfSeat != null)
/** Local-only ordering; Guandan sorts by the live level before combination grouping. */
const handSort = useHandSort({
  game: () => 'guandan',
  hand: () => myHand.value,
  level: () => playedLevel.value,
})
/** Phone board rows are avatar-first: an initial plus the live remaining count or lobby fact. */
const selfName = computed(() => mySeat.value?.name?.trim() || '我')
const selfInitial = computed(() => selfName.value.slice(0, 1))

const eligibleIds = computed<readonly string[] | null>(() => privateAction.value?.eligibleIds ?? null)

const counterOpen = ref(false)
const counterReady = computed(() => phase.value === 'playing' || phase.value === 'finished')

/* --------------------------------------------------------------- invites */
const inviteLink = ref('')
const manualLink = ref(false)
const copyState = ref('')

function shareSeat(seat: number): void {
  inviteLink.value = props.game.inviteUrl(seat)
  manualLink.value = false
  copyState.value = ''
  void copyInvite()
}

async function copyInvite(): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteLink.value)
    copyState.value = '已复制邀请链接'
    manualLink.value = false
  } catch {
    copyState.value = '请长按下面的链接手动复制'
    manualLink.value = true
  }
}

function selectInviteInput(): void {
  document.querySelector<HTMLInputElement>('.phone-invite-url')?.select()
}

/* ---------------------------------------------------------- screen / gate */
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

const phoneInGame = computed(() => phase.value === 'playing' || phase.value === 'tribute')
const phoneScreenSettled = computed(() => screenLandscape.value && (screenActive.value || screenDismissed.value))
const showPhoneGate = computed(() => joined.value && phoneInGame.value && !phoneScreenSettled.value)
const phoneGateCanRetry = computed(() => screenSupported.value)
const phoneGateCanContinue = computed(() => screenLandscape.value && screenLimited.value)

watch([phase, joined], () => {
  phoneScreen.refresh()
})

/** 准备: ask for the game screen first, then send the ready command. */
function onReady(): void {
  phoneScreen.enter()
  run(props.game.ready)
}

function rename(name: string): void {
  run(() => props.game.renameSelf(name))
}

function setTurnTimer(seconds: number): void {
  run(() => props.game.setTurnTimer(seconds))
}

function decide(requestId: string, approve: boolean): void {
  run(() => props.game.decideSeatRequest(requestId, approve))
}

function leave(): void {
  props.game.leaveRoom()
}

function again(): void {
  run(() => props.game.again())
}
</script>

<template>
  <div class="phone-table-screen guandan-phone-screen" data-game="guandan" :data-phase="phase">
    <PhraseBanner :phrase="phrase" />
    <header class="phone-table-header guandan-phone-header">
      <div class="hand-brand">
        <BrandMark />
        <span class="brand">掼蛋</span>
        <span v-if="roomCode" class="room-badge">房间 <strong>{{ roomCode }}</strong></span>
      </div>
      <span class="phone-own-identity">
        <span class="phone-player-avatar is-self" :title="selfName" :aria-label="selfName">{{ selfInitial }}</span>
      </span>
      <span class="connection" :class="{ online: connected }">
        <i class="connection-dot"></i>{{ connected ? '已连接' : '连接中' }}
      </span>
      <span class="guandan-level-chip">{{ levelText }}</span>
      <AutoPlayControl :view="view" :busy="busy" :connected="connected" />
      <QuickPhraseControl :busy="busy" :connected="connected" @say="sayPhrase" />
      <HostTools
        v-if="isHost"
        :seats="seats"
        room-mode="phone"
        :self-seat="state?.selfSeat ?? null"
        :phase="phase"
        :busy="busy"
        :can-clear-empty="false"
        @transfer="transferHost"
        @remove-offline="removeOfflineSeats"
        @dissolve="dissolveRoom"
      />
      <SoundToggle />
      <button
        class="counter-toggle" aria-label="记牌器"
        type="button"
        :aria-pressed="counterOpen"
        :disabled="!counterReady"
        :title="counterReady ? '打开记牌器' : '开局后可记牌'"
        @click="counterOpen = !counterOpen"
      ><AppIcon name="counter" /><span>记牌器</span></button>
      <button class="button small ghost" type="button" :disabled="busy" @click="leave" aria-label="返回大厅"><AppIcon name="home" /><span>返回大厅</span></button>
      <GameTools :game="props.game" />
    </header>

    <CardTableBoard :state="state" :deal="dealMotion" :self-hint="phase === 'finished' ? (matchWinner != null ? '整场结束' : '本副结束') : turnText"><GuandanExchangeNotice :view="view" /></CardTableBoard>

    <div v-if="phase === 'lobby'" class="phone-lobby">
      <div class="player-identity">
        <span class="identity-avatar">{{ (mySeat?.name ?? '我').slice(0, 1) }}</span>
        <div>
          <strong>{{ mySeat?.name ?? '我' }}</strong>
          <small>{{ isHost ? '房主' : '玩家' }} · {{ mySeat?.ready ? '已准备' : '未准备' }} · {{ turnLimitText }}</small>
        </div>
      </div>
      <NicknameEditor :name="mySeat?.name ?? null" :busy="busy" @save="rename" />
      <button class="button primary" type="button" :disabled="busy || !connected || autoPlayEnabled" @click="onReady">
        {{ autoPlayEnabled ? '托管已准备' : mySeat?.ready ? '取消准备' : '准备' }}
      </button>
      <button v-if="isHost" class="button primary" type="button" :disabled="busy || !view.canStart.value" @click="run(props.game.start)">
        开始游戏
      </button>
      <SeatCountControl :game="props.game" />
      <TurnTimerControl
        v-if="isHost"
        :seconds="state?.turnLimitSeconds ?? 0"
        :busy="busy"
        @change="setTurnTimer"
      />
      <p class="start-status" role="status">{{ view.startStatus.value }}</p>
      <button v-if="isHost && seats.some(s => s.name === null)" class="button ghost fill-bots" type="button" :disabled="busy || !automation.available" @click="run(() => props.game.fillBots())">用机器人补齐空位</button>
      <ul v-if="isHost" class="score-list">
        <li v-for="seat in seats.filter((entry) => entry.id !== (state?.selfSeat ?? 0))" :key="seat.id" class="score-row">
          <span>{{ seat.id + 1 }} 号座 · {{ seat.name ?? '待加入' }}</span>
          <template v-if="canAddBot(seat.id)">
            <button
              class="button small ghost automation-button"
              type="button"
              :disabled="busy"
              @click="addBot(seat.id, { strength: 'strong' })"
            >
              <RobotIcon />
              <span>强机器人</span>
            </button>
            <button
              class="button small ghost automation-button"
              type="button"
              :disabled="busy"
              @click="addBot(seat.id, { strength: 'easy' })"
            >
              <RobotIcon />
              <span>易机器人</span>
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
          <button class="button small ghost" type="button" @click="shareSeat(seat.id)"><AppIcon name="share" />邀请</button>
        </li>
      </ul>
      <p v-if="isHost && !automation.available" class="automation-status muted">
        {{ automation.message ?? '机器人不可用：本机没有可用的 DanLM 运行环境。' }}
      </p>
      <p v-if="copyState" class="muted">{{ copyState }}</p>
      <input
        v-if="manualLink"
        class="invite-url phone-invite-url"
        type="text"
        readonly
        :value="inviteLink"
        aria-label="邀请链接"
        @focus="selectInviteInput"
      />
      <p class="muted">4 人两副牌；同队为 1+3 / 2+4 号座（本局你在 {{ (state?.selfSeat ?? 0) + 1 }} 号座）。</p>
    </div>

    <template v-else>

      <GuandanExchange compact :game="props.game" :view="view" />

      <GuandanActions v-if="phase === 'playing'" class="phone-table-actions" :game="props.game" :view="view" :actions="actions" />


      <div ref="stageEl" class="phone-own-hand">
        <HandSortControl
          v-if="myHand.length > 0"
          :mode="handSort.mode.value"
          @cycle="handSort.cycle"
        />
        <FanHand
          :cards="handSort.displayHand.value"
          :selected="selected"
          :toggle-card="props.game.toggleCard"
          :play="actions.playFromGesture"
          :enabled="view.playEnabled.value"
          :level-rank="playedLevel"
          :eligible-ids="eligibleIds"
        />
      </div>


      <div v-if="phase === 'finished'" class="result-reopen"><button class="review-button" type="button" @click="showResult"><AppIcon name="trophy" />查看本副结算</button></div>
    </template>



    <SeatRequestPanel v-if="isHost && pendingRequests.length" :requests="pendingRequests" :busy="busy" @decide="decide" />

    <CounterFloat
      v-if="counterOpen"
      :hand="handSort.displayHand.value"
      :plays="view.plays.value"
      :ready="counterReady"
      :deck-count="deckCount"
      :level-rank="playedLevel"
      @close="counterOpen = false"
    />

    <footer class="phone-footer">
      <span>桌游合集 · 掼蛋</span>
      <span>{{ phaseText }}</span>
    </footer>

    <div v-if="showPhoneGate" class="phone-screen-gate" role="dialog" aria-label="横屏牌局">
      <div class="phone-screen-panel">
        <AppIcon class="phone-rotate-icon" name="rotate" />
        <h2>横屏牌局</h2>
        <p class="phone-screen-hint">{{ screenNote }}</p>
        <button
          v-if="phoneGateCanRetry"
          class="button primary"
          type="button"
          :disabled="screenBusy"
          @click="phoneScreen.enter"
        >点击进入横屏牌局</button>
        <button v-if="phoneGateCanContinue" class="text-link" type="button" @click="phoneScreen.dismiss">
          继续浏览器横屏
        </button>
        <button class="gate-leave" type="button" @click="leave" aria-label="返回大厅"><AppIcon name="home" /><span>返回大厅</span></button>
      </div>
    </div>
  </div>
</template>
