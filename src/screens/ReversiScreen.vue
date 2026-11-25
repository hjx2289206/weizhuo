<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { boardAiLabel } from '../../shared/boardAi'
import type { ReversiSnapshot } from '../../shared/protocol'
import { REVERSI_FLIP_MS, otherReversiSide, reversiCoordinate, reversiSideName, type ReversiBoard, type ReversiSide } from '../../shared/reversi'
import AppIcon from '../components/AppIcon.vue'
import BoardAiControl from '../components/BoardAiControl.vue'
import BoardClockControl from '../components/BoardClockControl.vue'
import BoardClockReadout from '../components/BoardClockReadout.vue'
import BoardUndoControl from '../components/BoardUndoControl.vue'
import BrandMark from '../components/BrandMark.vue'
import DialogShell from '../components/DialogShell.vue'
import GameTools from '../components/GameTools.vue'
import HostTools from '../components/HostTools.vue'
import ReversiBoardView from '../components/ReversiBoard.vue'
import SeatRequestPanel from '../components/SeatRequestPanel.vue'
import { useBoardPlayback } from '../useBoardPlayback'
import type { GameController } from '../useGame'

const props = defineProps<{ game: GameController }>()
const emit = defineEmits<{ animating: [value: boolean] }>()
const snapshot = computed<ReversiSnapshot | null>(() => {
  const state = props.game.state.value
  return state?.game === 'reversi' ? state : null
})
const shared = computed(() => snapshot.value?.roomMode === 'tablet')
const computer = computed(() => snapshot.value?.boardAi?.config ?? null)
const thinking = computed(() => snapshot.value?.boardAi?.thinking === true)
const side = computed<ReversiSide | null>(() => {
  if (shared.value && computer.value) return otherReversiSide(computer.value.side)
  const seat = snapshot.value?.selfSeat
  return seat === 0 || seat === 1 ? seat : null
})
const opposed = computed(() => shared.value && !computer.value)
const { board, playback, animating } = useBoardPlayback(snapshot, props.game.connected, {
  position: state => {
    // A placement and its automatic pass arrive together. Only placement advances playback.
    const moves = state.reversi.moves.filter(move => move.point !== null).map((move, index) => ({ ...move, ply: index + 1 }))
    return { roundId: state.reversi.roundId, layout: opposed.value ? 'shared' : 'one-side', moves, board: state.reversi.board }
  },
  empty: [] as ReversiBoard,
  durationMs: REVERSI_FLIP_MS,
  canAnimate: (before, move) => move.point !== null && before[move.point] === null,
})
watch(animating, value => emit('animating', value), { immediate: true, flush: 'sync' })

const selected = ref<number | null>(null)
const busy = ref(false)
const inviteOpen = ref(false), requestsOpen = ref(false), resignOpen = ref(false), historyOpen = ref(false)
const resignSide = ref<ReversiSide>(0)
const copied = ref('')
const page = ref(0)
const pageSize = 6
const paused = computed(() => !shared.value && !!snapshot.value?.seats.some(seat => !!seat.name && !seat.connected))
const locked = computed(() => busy.value || props.game.busy.value || !props.game.connected.value || paused.value || animating.value)
const canAct = computed(() => !locked.value && (shared.value ? snapshot.value?.isHost : side.value !== null))
const canPlay = computed(() => canAct.value && !thinking.value && snapshot.value?.phase === 'playing' &&
  (opposed.value || snapshot.value.turn === side.value))
const ready = computed(() => snapshot.value?.seats.find(seat => seat.id === side.value)?.ready)
const canStart = computed(() => shared.value || snapshot.value?.seats.every(seat => seat.name && seat.connected && seat.ready))
const last = computed(() => snapshot.value?.reversi.moves.at(-1))
const lastPlacement = computed(() => snapshot.value?.reversi.moves.filter(move => move.point !== null).at(-1) ?? null)
const moveCount = computed(() => snapshot.value?.reversi.moves.length ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(moveCount.value / pageSize)))
const moves = computed(() => snapshot.value?.reversi.moves.slice(page.value * pageSize, (page.value + 1) * pageSize) ?? [])
watch(() => snapshot.value?.version, () => { selected.value = null })
watch(pageCount, count => { page.value = Math.min(page.value, count - 1) })
watch(() => snapshot.value?.reversi.roundId, () => { historyOpen.value = false; resignOpen.value = false; page.value = 0 })

const status = computed(() => {
  const state = snapshot.value
  if (!state) return ''
  if (state.phase === 'lobby') return computer.value ? '和电脑下一局' : shared.value ? '两人同屏，直接开局' : '邀一位朋友，一起落子'
  if (animating.value) return '正在翻子'
  if (state.phase === 'finished') return state.reversi.draw ? '和棋' : reversiSideName(state.reversi.winner!) + '获胜'
  if (paused.value) return '等待玩家重连'
  if (thinking.value) return '电脑正在思考'
  if (state.boardAi?.error) return '电脑行棋已暂停'
  if (canPlay.value && (!shared.value || computer.value)) return '轮到你落子'
  return '轮到' + reversiSideName(state.turn!) + '落子'
})
const instruction = computed(() => {
  const state = snapshot.value
  if (!state) return ''
  if (state.phase === 'lobby') return computer.value ? '电脑难度 · ' + boardAiLabel(computer.value.difficulty) : '8×8 格 · 黑方先行'
  if (state.phase === 'finished') return state.reversi.reason
  if (state.boardAi?.error) return state.boardAi.error
  if (thinking.value) return '电脑走完后可以落子或悔棋'
  return selected.value === null ? '点小圆点选格，再确认落子' : '已选 ' + reversiCoordinate(selected.value) + '，确认后翻子'
})

async function run(action: () => Promise<void> | void): Promise<void> {
  if (busy.value) return
  busy.value = true
  try { await action() }
  catch (error) { props.game.error.value = error instanceof Error ? error.message : '操作失败' }
  finally { busy.value = false }
}
function select(point: number): void {
  if (canPlay.value && snapshot.value?.reversi.legal.includes(point)) selected.value = selected.value === point ? null : point
}
function place(): void {
  const point = selected.value
  if (canPlay.value && point !== null) void run(() => props.game.reversiMove(point))
}
async function copy(seat: number): Promise<void> {
  try { await navigator.clipboard.writeText(props.game.inviteUrl(seat)); copied.value = '已复制' + reversiSideName(seat) + '链接' }
  catch { copied.value = '可以长按下方链接复制' }
}
</script>

<template>
  <section v-if="snapshot" class="reversi-screen" :data-phase="snapshot.phase" :data-shared="shared">
    <header class="reversi-header">
      <div class="reversi-brand"><BrandMark /><strong>黑白棋</strong><small>{{ snapshot.code }}</small></div>
      <div class="reversi-tools"><GameTools :game="game" /><button class="tool-button" :disabled="locked" @click="run(game.leaveRoom)"><AppIcon name="home" />大厅</button></div>
    </header>

    <div class="reversi-layout">
      <div class="reversi-intro">
        <div><h1>{{ status }}</h1><p role="status">{{ instruction }}</p></div>
        <span v-if="computer && side !== null" class="reversi-mode">你执{{ reversiSideName(side) }}</span>
        <span v-else-if="shared" class="reversi-mode">双人同屏</span>
      </div>
      <div class="reversi-board-area">
        <p v-if="last" class="reversi-last" role="status">{{ last.point === null ? last.notation : '第 ' + last.ply + ' 手 · ' + reversiSideName(last.side) + ' ' + last.notation }}</p>
        <div class="reversi-board-frame">
          <ReversiBoardView :board="board" :legal="snapshot.reversi.legal" :selected="selected" :last="lastPlacement"
            :live="playback" :disabled="!canPlay" @select="select" />
        </div>
      </div>
      <div class="reversi-panel">
        <BoardClockControl :game="game" :disabled="locked" />
        <div class="reversi-counts" aria-label="双方棋子数">
          <article v-for="seat in snapshot.seats" :key="seat.id" :class="{ current: snapshot.turn === seat.id }">
            <i :class="{ white: seat.id === 1 }" aria-hidden="true"></i>
            <div><strong>{{ seat.name ?? reversiSideName(seat.id) }}</strong>
              <small>{{ seat.isBot ? thinking ? '思考中' : '电脑' : seat.id === side ? '我 · ' + reversiSideName(seat.id) :
                !seat.name ? '等待入座' : !seat.connected ? '等待重连' : snapshot.phase === 'lobby' && !shared ? seat.ready ? '已准备' : '未准备' : reversiSideName(seat.id) }}</small>
              <BoardClockReadout :game="game" :seat="seat.id" :flipped="opposed && seat.id === 1" />
            </div>
            <b :aria-label="reversiSideName(seat.id) + snapshot.reversi.counts[seat.id] + '子'">{{ snapshot.reversi.counts[seat.id] }}</b>
          </article>
        </div>
        <div v-if="snapshot.phase === 'lobby'" class="reversi-actions">
          <button v-if="!shared && side !== null" class="button" :class="ready ? 'secondary' : 'primary'" :disabled="locked" @click="run(game.ready)">{{ ready ? '取消准备' : '我准备好了' }}</button>
          <button v-if="snapshot.isHost" class="button primary" :disabled="locked || !canStart" @click="run(game.start)">开始对弈</button>
        </div>
        <div v-else-if="snapshot.phase === 'playing'" class="reversi-actions">
          <button class="button primary reversi-place" :disabled="!canPlay || selected === null" @click="place">确认落子</button>
          <button class="button secondary" :disabled="!canAct" @click="resignSide = side ?? (snapshot.turn === 1 ? 1 : 0); resignOpen = true">认输</button>
          <BoardUndoControl :board="snapshot.reversi" :side="side" :shared="shared" :computer="!!computer" :side-name="reversiSideName"
            :disabled="!canAct || thinking" :confirm-description="last?.point === null ? '撤销上一手落子及随后的自动停一手' : undefined" @action="action => run(() => game.boardUndo(action))" />
        </div>
        <div v-else class="reversi-actions">
          <button v-if="snapshot.isHost" class="button primary" :disabled="locked" @click="run(game.again)">再来一局</button>
          <span v-else>等待房主再开一局</span>
        </div>
        <div class="reversi-utilities">
          <button v-if="!shared && !computer" class="tool-button" @click="inviteOpen = true"><AppIcon name="users" />邀请朋友</button>
          <button class="tool-button" :disabled="!moveCount" @click="page = pageCount - 1; historyOpen = true"><AppIcon name="history" />棋谱</button>
          <BoardAiControl :game="game" />
          <button v-if="snapshot.isHost && snapshot.seatRequests.length" class="tool-button" @click="requestsOpen = true">入座申请</button>
          <HostTools v-if="snapshot.isHost" :phase="snapshot.phase" :room-mode="snapshot.roomMode" :seats="snapshot.seats"
            :self-seat="side" :busy="locked" @remove-offline="run(game.removeOfflineSeats)" @transfer="seat => run(() => game.transferHost(seat))"
            @dissolve="run(game.dissolveRoom)" />
        </div>
      </div>
    </div>

    <DialogShell v-if="inviteOpen" title="邀请朋友下黑白棋" @close="inviteOpen = false">
      <p>朋友连接同一局域网，打开空位一方的链接入座。</p>
      <div v-for="seat in snapshot.seats" :key="seat.id" class="reversi-invite">
        <button class="button secondary" @click="copy(seat.id)">复制{{ reversiSideName(seat.id) }}链接</button>
        <a :href="game.inviteUrl(seat.id)">{{ game.inviteUrl(seat.id) }}</a>
      </div>
      <p role="status">{{ copied }}</p>
    </DialogShell>
    <DialogShell v-if="resignOpen" :title="'确认' + reversiSideName(resignSide) + '认输？'" @close="resignOpen = false">
      <p>对方获胜，本局结束。</p>
      <div v-if="opposed" class="reversi-actions">
        <button v-for="color in ([0, 1] as const)" :key="color" class="button secondary" :aria-pressed="resignSide === color" @click="resignSide = color">{{ reversiSideName(color) }}</button>
      </div>
      <button class="button primary" :disabled="!canAct" @click="resignOpen = false; run(() => game.reversiResign(shared ? resignSide : undefined))">确认认输</button>
    </DialogShell>
    <DialogShell v-if="historyOpen" title="本局棋谱" @close="historyOpen = false">
      <ol class="reversi-history"><li v-for="move in moves" :key="move.ply">
        <span>{{ move.ply }}.</span><strong>{{ move.point === null ? move.notation : reversiSideName(move.side) + ' ' + move.notation }}</strong>
      </li></ol>
      <nav class="reversi-actions">
        <button class="button secondary" :disabled="page === 0" @click="page--">上一页</button>
        <span>{{ page + 1 }} / {{ pageCount }}</span>
        <button class="button secondary" :disabled="page + 1 >= pageCount" @click="page++">下一页</button>
      </nav>
    </DialogShell>
    <DialogShell v-if="requestsOpen && snapshot.isHost && snapshot.seatRequests.length" title="入座申请" @close="requestsOpen = false">
      <SeatRequestPanel :requests="snapshot.seatRequests" :busy="locked" @decide="(id, approve) => run(() => game.decideSeatRequest(id, approve))" />
    </DialogShell>
  </section>
</template>

<style scoped>
.reversi-screen { height: 100dvh; padding: max(9px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); display: flex; flex-direction: column; gap: 10px; color: #263946; background: #f1eee5; overflow: hidden; }
.reversi-header, .reversi-brand, .reversi-tools, .reversi-intro, .reversi-utilities { display: flex; align-items: center; gap: 8px; }
.reversi-header { justify-content: space-between; flex: none; padding-bottom: 6px; border-bottom: 1px solid #d4d1c4; }
.reversi-brand strong { font: 23px 'Songti SC', serif; white-space: nowrap; }
.reversi-brand .brand-mark { width: 27px; height: 27px; }
.reversi-brand small, .reversi-mode, .reversi-intro p { color: #576575; font-size: 11px; }
.reversi-layout { width: 100%; max-width: 720px; margin: 0 auto; display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 8px; }
.reversi-intro { justify-content: space-between; flex: none; }
.reversi-intro h1 { margin: 0 0 4px; font: clamp(22px, 4vw, 32px) 'Songti SC', serif; }
.reversi-intro p { margin: 0; line-height: 1.5; }
.reversi-mode { padding: 4px 8px; border: 1px solid #c9cdd1; border-radius: 20px; white-space: nowrap; }
.reversi-board-area { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 5px; }
.reversi-board-frame { flex: 1; min-height: 0; display: grid; place-items: center; }
.reversi-board-frame :deep(svg) { max-width: 100%; }
.reversi-last { background: #e2e4e2; color: #44576a; border-left: 2px solid #a1865b; border-radius: 2px 5px 5px 2px; padding: 3px 8px; margin: 0; font-size: 11px; }
.reversi-panel { flex: none; display: grid; gap: 7px; }
.reversi-counts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.reversi-counts article { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 7px 9px; border: 1px solid #ccd0cf; border-radius: 9px; background: #f9f5ea; }
.reversi-counts article.current { border-color: #8f7952; background: #eee5d1; }
.reversi-counts i { display: block; width: 21px; height: 21px; flex: none; border-radius: 50%; background: radial-gradient(circle at 35% 30%,#586975,#1d2a37); border: 1px solid #344453; }
.reversi-counts i.white { background: radial-gradient(circle at 35% 30%,#fff9e8,#cfbd9e); border-color: #a49478; }
.reversi-counts article > div { min-width: 0; }
.reversi-counts strong, .reversi-counts small { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reversi-counts strong { font-size: 12px; }
.reversi-counts small { color: #576575; font-size: 10px; margin-top: 2px; }
.reversi-counts b { margin-left: auto; font: 21px Georgia, serif; color: #344553; }
.reversi-actions { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
.reversi-actions .button { flex: 1; white-space: nowrap; min-height: 36px; font-size: 11px; padding: 5px 9px; }
.reversi-actions .reversi-place { flex: 1.5; }
.reversi-utilities :deep(.host-tools) { margin-left: auto; }
.reversi-invite { display: grid; gap: 4px; margin-top: 9px; overflow-wrap: anywhere; font-size: 12px; }
.reversi-history { list-style: none; margin: 0 0 10px; padding: 0; display: grid; gap: 5px; }
.reversi-history li { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #dbd9ce; font-size: 12px; padding: 4px; }
@media (max-width: 370px), (max-height: 650px) {
  .reversi-screen { gap: 5px; padding-block: 5px; }
  .reversi-layout, .reversi-panel { gap: 5px; }
  .reversi-header { gap: 4px; }
  .reversi-brand { gap: 5px; }
  .reversi-brand strong { font-size: 18px; }
  .reversi-brand .brand-mark { width: 21px; height: 21px; }
  .reversi-tools { gap: 4px; }
  .reversi-screen :deep(.tool-button) { min-height: 30px; padding: 4px 6px; font-size: 10px; }
  .reversi-screen :deep(.tool-button .app-icon) { width: 16px; height: 16px; }
  .reversi-actions .button { min-height: 32px; font-size: 10px; padding: 4px 6px; }
  .reversi-counts article { padding: 4px 6px; }
}
</style>
