<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue'
import { GAME_DEFINITIONS, isBoardGame } from '../../shared/gameCatalog'
import { QUICK_PHRASES } from '../../shared/phrases'
import { GOMOKU_RULES } from '../../shared/stones'
import type { Snapshot } from '../../shared/protocol'
import type { GameController } from '../useGame'
import { resultFromSnapshot, resultSeatLabel } from '../resultHistory'
import AppIcon from '../components/AppIcon.vue'
import BoardAnalysisPanel from '../components/BoardAnalysisPanel.vue'
import BoardClockReadout from '../components/BoardClockReadout.vue'
import BrandMark from '../components/BrandMark.vue'
import CardTableBoard from '../components/CardTableBoard.vue'
import ChessBoard from '../components/ChessBoard.vue'
import DialogShell from '../components/DialogShell.vue'
import GuandanExchangeNotice from '../components/GuandanExchangeNotice.vue'
import JoinForm from '../components/JoinForm.vue'
import JunqiBoard from '../components/JunqiBoard.vue'
import JunqiFourBoard from '../components/JunqiFourBoard.vue'
import PhraseBanner from '../components/PhraseBanner.vue'
import ReversiBoard from '../components/ReversiBoard.vue'
import StoneBoard from '../components/StoneBoard.vue'
import XiangqiBoard from '../components/XiangqiBoard.vue'
import { useDealAnimation } from '../useDealAnimation'
import TabletScreen from './TabletScreen.vue'
import { useGuandanView } from './useGuandanView'

const props = defineProps<{ game: GameController }>()
const { busy, connected, state, roomCode, phrase, seatRequest } = props.game
const phoneSize = matchMedia('(max-width: 700px), (max-width: 1000px) and (max-height: 550px)')
const phoneLayout = ref(phoneSize.matches)
function updateLayout(event: MediaQueryListEvent): void { phoneLayout.value = event.matches }
phoneSize.addEventListener('change', updateLayout)
onScopeDispose(() => phoneSize.removeEventListener('change', updateLayout))
const deal = useDealAnimation(state)
const guandan = useGuandanView(props.game)
const room = computed(() => state.value?.role === 'spectator' ? state.value : null)
const boardGame = computed(() => room.value ? isBoardGame(room.value.game) : false)
const seatDialog = ref(false)
const phraseDialog = ref(false)
const eligibleSeats = computed(() => {
  const current = room.value
  if (!current || current.roomMode === 'tablet' && boardGame.value) return []
  return current.seats.filter(seat =>
    seat.id !== current.boardAi?.config?.side && (seat.name !== null || current.phase === 'lobby'))
})
const suggestedSeat = computed(() =>
  eligibleSeats.value.find(seat => seat.name === null)?.id ??
  eligibleSeats.value.find(seat => !seat.connected)?.id ?? eligibleSeats.value[0]?.id ?? 0)
const result = computed(() => room.value ? resultFromSnapshot(room.value) : null)
function seatLabel(snapshot: Snapshot, seat: number): string {
  return snapshot.seats.find(member => member.id === seat)?.name ?? resultSeatLabel(snapshot.game, seat)
}
function run(action: () => Promise<void>): void {
  void action().catch(error => { props.game.error.value = error instanceof Error ? error.message : '操作失败' })
}
function takeSeat(payload: { code: string; seat: number; name: string }, replace: boolean): void {
  run(async () => {
    if (replace) await props.game.requestSeat(payload.code, payload.seat, payload.name)
    else await props.game.joinRoom(payload.code, payload.seat, payload.name)
  })
}
function say(id: string): void {
  run(async () => {
    await props.game.sayPhrase(id)
    phraseDialog.value = false
  })
}
</script>

<template>
  <main class="spectator-screen" aria-label="旁观中" :data-phase="room?.phase">
    <header class="spectator-header">
      <div class="spectator-identity">
        <BrandMark />
        <div>
          <h1>旁观中 <span v-if="room">{{ GAME_DEFINITIONS[room.game].name }}</span></h1>
          <p>房间 {{ roomCode }}<template v-if="room"> · 旁观 {{ room.spectatorCount }} 人</template></p>
        </div>
      </div>
      <div class="spectator-actions">
        <button v-if="eligibleSeats.length" class="tool-button" type="button" :disabled="!connected" @click="seatDialog = true"><AppIcon name="users" />入座</button>
        <button v-if="room?.spectatorPhrases" class="tool-button" type="button" :disabled="!connected" @click="phraseDialog = true">快捷语</button>
        <button class="tool-button" type="button" @click="game.leaveRoom"><AppIcon name="home" />大厅</button>
      </div>
    </header>

    <PhraseBanner :phrase="phrase" />
    <p v-if="!room" class="spectator-status" role="status">正在连接公开牌桌…</p>
    <p v-else class="spectator-status" role="status">{{ room.boardAi?.thinking ? '电脑正在思考' : room.message }}</p>

    <template v-if="room">
      <p v-if="room.game === 'gomoku'" class="spectator-status">{{ GOMOKU_RULES[room.stones.rule ?? 'freestyle'] }}</p>
      <CardTableBoard v-if="!boardGame && phoneLayout" class="spectator-phone-table" :state="room" :deal="deal" self-hint="">
        <GuandanExchangeNotice v-if="room.game === 'guandan'" :view="guandan" />
      </CardTableBoard>
      <TabletScreen v-else-if="!boardGame" :game="game" read-only />
      <section v-else class="spectator-board" aria-label="公开棋盘">
        <XiangqiBoard v-if="room.game === 'xiangqi'" :board="room.xiangqi.board" :side="0" :targets="[]" :selected="null" :last="room.xiangqi.moves.at(-1)" :checked="room.xiangqi.check" disabled />
        <ChessBoard v-else-if="room.game === 'chess'" :board="room.chess.board" :side="0" :targets="[]" :selected="null" :last="room.chess.moves.at(-1)" :checked="room.chess.check" disabled />
        <JunqiFourBoard v-else-if="room.game === 'junqi' && room.junqi.variant === 'four'" :board="room.junqi.board" :side="0" :targets="[]" :selected="null" :last="room.junqi.moves.at(-1)" disabled />
        <JunqiBoard v-else-if="room.game === 'junqi'" :board="room.junqi.board" :side="0" :targets="[]" :selected="null" :last="room.junqi.moves.at(-1)" disabled />
        <StoneBoard v-else-if="room.game === 'go' || room.game === 'gomoku'" :board="room.stones.board" :size="room.stones.size" :last="room.stones.moves.at(-1)?.point" :dead="room.stones.dead" :winning-line="room.stones.winningLine" :renju-board="room.game === 'gomoku' && room.stones.rule === 'renju' && room.turn === 0 ? room.stones.board : null" disabled />
        <ReversiBoard v-else-if="room.game === 'reversi'" :board="room.reversi.board" :last="room.reversi.moves.filter(move => move.point !== null).at(-1)" disabled />
      </section>

      <div v-if="result" class="spectator-result" role="status">
        <strong>{{ result.title }}</strong>
        <span>{{ result.detail }}</span>
        <span v-for="player in result.players.filter(entry => entry.total !== undefined)" :key="player.seat">{{ player.name }} {{ player.total }} 分</span>
      </div>
      <BoardAnalysisPanel v-if="room.game === 'chess' || room.game === 'xiangqi'" :game="game" spectator />
      <ul v-if="boardGame" class="spectator-seats" aria-label="对局双方">
        <li v-for="seat in room.seats" :key="seat.id" :class="{ 'is-turn': room.turn === seat.id }">
          <strong>{{ seatLabel(room, seat.id) }}</strong>
          <BoardClockReadout :game="game" :seat="seat.id" />
          <span v-if="room.game === 'reversi'">{{ room.reversi.counts[seat.id] }} 子</span>
          <span v-if="seat.connected && room.phase === 'lobby'">{{ seat.ready ? '已准备' : '未准备' }}</span>
          <span v-if="seat.name && !seat.connected">等待重连</span>
        </li>
      </ul>
    </template>

    <DialogShell v-if="seatDialog && room && eligibleSeats.length" title="入座" @close="seatDialog = false">
      <JoinForm compact room-locked :saved-session="null" :initial-code="room.code" :initial-seat="suggestedSeat"
        initial-name="" :roster="eligibleSeats" :game="room.game" :busy="busy || !connected"
        :request="seatRequest" @join="payload => takeSeat(payload, false)" @request="payload => takeSeat(payload, true)" />
    </DialogShell>
    <DialogShell v-if="phraseDialog && room?.spectatorPhrases" title="快捷语" @close="phraseDialog = false">
      <div class="spectator-phrases">
        <button v-for="entry in QUICK_PHRASES" :key="entry.id" class="button secondary" type="button" :disabled="busy || !connected"
          @click="say(entry.id)">{{ entry.emoji }} {{ entry.text }}</button>
      </div>
    </DialogShell>
  </main>
</template>

<style scoped>
.spectator-screen { display: flex; flex-direction: column; gap: 10px; min-height: 100dvh; padding: 12px clamp(10px, 3vw, 28px) max(12px, env(safe-area-inset-bottom)); background: #f6f3e9; }
.spectator-header, .spectator-identity, .spectator-actions { display: flex; align-items: center; gap: 8px; }
.spectator-header { justify-content: space-between; }
.spectator-identity h1 { font-size: 17px; color: #264c3e; white-space: nowrap; }
.spectator-identity h1 span { margin-left: 4px; font-size: 12px; font-weight: 500; }
.spectator-identity p, .spectator-status { font-size: 12px; color: #5b6a58; }
.spectator-identity p { white-space: nowrap; }
.spectator-actions { justify-content: flex-end; flex-wrap: wrap; gap: 4px; }
.spectator-phone-table { margin: 0; min-height: min(325px, 68dvh); border: 1px solid #dadbc9; border-radius: 16px; background: #fbf9f0; }
.spectator-board { min-height: 0; width: 100%; height: min(64dvh, 620px); display: grid; place-items: center; }
.spectator-board > svg { width: 100%; height: 100%; }
.spectator-seats, .spectator-result { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; font-size: 12px; }
.spectator-seats { list-style: none; justify-content: center; }
.spectator-seats li, .spectator-result { background: #fffdf5; border: 1px solid #dadbc9; border-radius: 10px; padding: 7px 10px; }
.spectator-seats li.is-turn { border-color: #a69562; background: #f3ecd5; }
.spectator-seats li span, .spectator-result span { margin-left: 5px; color: #5b6a58; }
.spectator-phrases { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 360px) { .spectator-actions .tool-button { padding-inline: 7px; } .spectator-identity .brand-mark { width: 26px; height: 26px; } }
@media (orientation: landscape) and (max-height: 550px) {
  .spectator-screen { gap: 6px; padding-block: 6px; }
  .spectator-board { height: min(70dvh, 510px); }
}
</style>
