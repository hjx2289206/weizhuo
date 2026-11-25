<script setup lang="ts">
import GuandanPhoneScreen from './screens/GuandanPhoneScreen.vue'
import XiangqiScreen from './screens/XiangqiScreen.vue'
import ChessScreen from './screens/ChessScreen.vue'
import ReversiScreen from './screens/ReversiScreen.vue'
import StoneScreen from './screens/StoneScreen.vue'
import { isBoardGame, isStoneGame } from '../shared/gameCatalog'
import JunqiScreen from './screens/JunqiScreen.vue'
import HandScreen from './screens/HandScreen.vue'
import HomeScreen from './screens/HomeScreen.vue'
import PhoneTableScreen from './screens/PhoneTableScreen.vue'
import TabletScreen from './screens/TabletScreen.vue'
import SpectatorScreen from './screens/SpectatorScreen.vue'
import { useGame } from './useGame'
import { provideGameTools } from './gameTools'
import { provideSiteScreen } from './siteScreen'
import SiteEntry from './components/SiteEntry.vue'
import ResultDialog from './components/ResultDialog.vue'
import AppIcon from './components/AppIcon.vue'
import { computed, ref } from 'vue'
import { teachingVisible } from './tutorials/visibility'

/**
 * One controller, one screen at a time. The controller owns identity, transport and
 * persistence; each screen renders one board and sends commands back through the same
 * frozen interface, so nothing here has to know how a room is opened or resumed.
 *
 * A phone room picks its board from the live server-confirmed kind, never from a guess: the
 * Doudizhu board is the fallback for a confirmed Doudizhu room only, and while the kind is still
 * unknown the tab stays neutral instead of dressing one game up as the other.
 */
const game = useGame()
const tools = provideGameTools(game)
const portraitBoard = computed(() => game.gameKind.value !== null && isBoardGame(game.gameKind.value))
const invitedChess = computed(() => !game.state.value && game.roomInfo.value !== null && isBoardGame(game.roomInfo.value.game) && game.roomInfo.value.game !== 'junqi')
const portraitFlow = computed(() => invitedChess.value || game.mode.value !== 'home' && portraitBoard.value)
const siteScreen = provideSiteScreen(computed(() => portraitFlow.value ? 'portrait' : 'landscape'))
const { mode, gameKind, connected, busy, error, clearError, leaveRoom } = game
const boardAnimating = ref(false)

/** Same contract as every screen: a rejected command lands in the shared toast, never silently. */
function leave(): void {
  Promise.resolve(leaveRoom()).catch((reason: unknown) => {
    if (!error.value) error.value = reason instanceof Error ? reason.message : '无法返回大厅'
  })
}
</script>

<template>
  <div class="app-shell">
    <SpectatorScreen v-if="mode === 'spectator'" :game="game" />
    <JunqiScreen v-else-if="mode !== 'home' && gameKind === 'junqi'" :game="game" @animating="boardAnimating = $event" />
    <XiangqiScreen v-else-if="mode !== 'home' && gameKind === 'xiangqi'" :game="game" @animating="boardAnimating = $event" />
    <ChessScreen v-else-if="mode !== 'home' && gameKind === 'chess'" :game="game" @animating="boardAnimating = $event" />
    <ReversiScreen v-else-if="mode !== 'home' && gameKind === 'reversi'" :game="game" @animating="boardAnimating = $event" />
    <StoneScreen v-else-if="mode !== 'home' && gameKind !== null && isStoneGame(gameKind)" :game="game" @animating="boardAnimating = $event" />
    <TabletScreen v-else-if="mode === 'table'" :game="game" />
    <HomeScreen v-else-if="mode === 'home' || invitedChess" :game="game" />
    <HandScreen v-else-if="mode === 'hand'" :game="game" />
    <GuandanPhoneScreen v-else-if="mode === 'phone-table' && gameKind === 'guandan'" :game="game" />
    <PhoneTableScreen v-else-if="mode === 'phone-table' && gameKind === 'doudizhu'" :game="game" />
    <section v-else-if="mode === 'phone-table'" class="hand-screen">
      <header class="hand-header">
        <span class="connection" :class="{ online: connected }">
          <i class="connection-dot"></i>{{ connected ? '已连接' : '连接中' }}
        </span>
      </header>
      <div class="phone-status">
        <p class="muted">正在读取房间信息…</p>
      </div>
      <footer class="phone-footer">
        <button class="button secondary" type="button" :disabled="busy" @click="leave()">返回大厅</button>
      </footer>
    </section>
    <HomeScreen v-else :game="game" />
    <ResultDialog v-if="!teachingVisible && tools.resultOpen.value && game.state.value?.phase === 'finished' && !(portraitBoard && boardAnimating)" :game="game" @close="tools.resultOpen.value = false" />
    <SiteEntry v-if="!teachingVisible && (mode === 'home' || invitedChess || gameKind !== null && (gameKind !== 'junqi' || mode === 'spectator'))"
      :strict="mode === 'home' || mode === 'spectator' || invitedChess || portraitBoard" :watching="mode === 'spectator'"
      :orientation="portraitFlow ? 'portrait' : 'landscape'" :screen="siteScreen" />

    <div v-if="mode !== 'home' && !connected" class="connection-banner" role="status">
      <span>连接已中断，正在自动重连；牌局与身份凭证会保留。</span>
      <button class="tool-button" type="button" @click="game.reconnectNow"><AppIcon name="rotate" />立即重连</button>
    </div>

    <div v-if="error" class="toast" role="alert">
      <span>{{ error }}</span>
      <button class="icon-button" type="button" aria-label="关闭提示" @click="clearError()"><AppIcon name="close" /></button>
    </div>
  </div>
</template>
