<script setup lang="ts">
import { Chess } from 'chess.js'
import { computed, ref, watch } from 'vue'
import {
  ANALYSIS_CURVE_LIMIT, ANALYSIS_GRADES, analysisCurveValue, analysisGrade, analysisLoss, analysisRecord,
  analysisScoreFor, isAnalyzableView, type BoardAnalyzeAction,
} from '../../shared/boardAnalysis'
import { chessBoard, chessCoordinate } from '../../shared/chess'
import { rewindXiangqiBoard, xiangqiCoordinate, xiangqiInCheck } from '../../shared/xiangqi'
import type { GameController } from '../useGame'
import AppIcon from './AppIcon.vue'
import DialogShell from './DialogShell.vue'
import ChessBoard from './ChessBoard.vue'
import XiangqiBoard from './XiangqiBoard.vue'

const props = defineProps<{ game: GameController; spectator?: boolean }>()
const open = ref(false)
const selectedPly = ref<number | null>(null)
const submitting = ref(false)
const localError = ref('')
const room = computed(() => {
  const state = props.game.state.value
  return state?.phase === 'finished' && isAnalyzableView(state) ? state : null
})
const record = computed(() => room.value && analysisRecord(room.value))
const moves = computed(() => record.value?.moves ?? [])
const analysis = computed(() => {
  const state = room.value?.boardAnalysis
  return state?.roundId === record.value?.roundId ? state : undefined
})
const running = computed(() => analysis.value?.status === 'running')
const hasResult = computed(() => analysis.value?.status === 'done' || !!analysis.value?.completed)
const mayControl = computed(() => !props.spectator && (room.value?.role === 'player' || room.value?.isHost))
const side = computed(() => props.spectator ? 0 : room.value?.selfSeat ??
  (room.value?.boardAi?.config?.side === 0 ? 1 : 0))
const ply = computed(() => selectedPly.value ?? moves.value.length)

watch(() => record.value?.roundId, () => { open.value = false; selectedPly.value = null; localError.value = '' })
watch(() => analysis.value?.status, status => {
  if (props.spectator && status === 'idle') open.value = false
})
function show(): void {
  selectedPly.value = null
  open.value = true
}
async function submit(action: BoardAnalyzeAction): Promise<void> {
  if (submitting.value) return
  if (action === 'start') show()
  localError.value = ''
  submitting.value = true
  try { await props.game.boardAnalyze(action) }
  catch (error) { localError.value = error instanceof Error ? error.message : '分析操作失败' }
  finally { submitting.value = false }
}

const replay = computed(() => {
  if (!open.value) return null
  const state = room.value
  if (state?.game === 'chess') {
    const engine = new Chess(state.chess.startFen)
    for (const move of state.chess.moves.slice(0, ply.value)) {
      engine.move({ from: chessCoordinate(move.from), to: chessCoordinate(move.to), promotion: move.promotion })
    }
    return { game: state.game, board: chessBoard(engine), last: state.chess.moves[ply.value - 1],
      checked: engine.isCheck() ? engine.turn() === 'w' ? 0 : 1 : null }
  }
  if (state?.game === 'xiangqi') {
    const board = rewindXiangqiBoard(state.xiangqi.board, state.xiangqi.moves.slice(ply.value))
    const last = state.xiangqi.moves[ply.value - 1]
    const turn = last?.side === 0 ? 1 : 0
    return { game: state.game, board, last, checked: xiangqiInCheck(board, turn) ? turn : null }
  }
  return null
})
const byPly = computed(() => new Map(analysis.value?.positions.map(position => [position.ply, position])))
const recommendation = computed(() => selectedPly.value === null ? null : byPly.value.get(selectedPly.value)?.bestMove)
const recommendationText = computed(() => {
  const move = recommendation.value
  if (!move) return ''
  const coordinate = room.value?.game === 'chess' ? chessCoordinate : xiangqiCoordinate
  return `${coordinate(move.from)} → ${coordinate(move.to)}${move.promotion ? `（${{ q: '后', r: '车', b: '象', n: '马' }[move.promotion]}）` : ''}`
})
const grades = computed(() => new Map(moves.value.flatMap(move => {
  const before = byPly.value.get(move.ply - 1), after = byPly.value.get(move.ply)
  const grade = before && after && analysisGrade(analysisLoss(before, after, move.side))
  return grade ? [[move.ply, grade] as const] : []
})))
const curve = computed(() => (analysis.value?.positions ?? []).map(position => ({
  ply: position.ply, x: 17 + 526 * position.ply / Math.max(1, moves.value.length),
  y: 65 - 53 * analysisCurveValue(position) / ANALYSIS_CURVE_LIMIT,
  grade: grades.value.get(position.ply), score: analysisScoreFor(position, 0),
})))
const polyline = computed(() => curve.value.map(({ x, y }) => `${x},${y}`).join(' '))
</script>

<template>
  <div v-if="room && (!spectator || (analysis && analysis.status !== 'idle'))" class="analysis-tools">
    <button v-if="!spectator" class="tool-button" type="button" @click="show"><AppIcon name="history" />棋谱</button>
    <button v-if="mayControl && !running && analysis?.status !== 'done'" class="tool-button" type="button"
      :disabled="submitting || !game.connected.value || !analysis?.available" :title="analysis?.unavailableReason ?? undefined"
      @click="submit('start')">{{ analysis?.status === 'failed' ? '重新分析' : '分析本局' }}</button>
    <button v-if="(hasResult || running || analysis?.status === 'failed') && (spectator || !open)"
      class="tool-button" type="button" @click="show">{{ running ? `分析 ${analysis?.completed} / ${analysis?.total}` : '查看分析' }}</button>
    <button v-if="mayControl && running && !open" class="tool-button" type="button"
      :disabled="submitting || !game.connected.value" @click="submit('cancel')">取消</button>
    <small v-if="mayControl && !analysis?.available && analysis?.unavailableReason">{{ analysis.unavailableReason }}</small>

    <DialogShell v-if="open" title="本局棋谱与分析" class="board-analysis-dialog" @close="open = false">
      <p class="analysis-disclaimer">引擎参考，非绝对结论</p>
      <div class="analysis-status">
        <p v-if="running" role="status">正在分析 {{ analysis?.completed }} / {{ analysis?.total }} 个局面</p>
        <p v-else-if="analysis?.status === 'done'" role="status">已分析 {{ analysis.completed }} 个局面</p>
        <p v-else-if="analysis?.status === 'failed'" class="analysis-error" role="status">分析中断：{{ analysis.error }}</p>
        <p v-else-if="!analysis?.available" role="status">{{ analysis?.unavailableReason }}</p>
        <button v-if="mayControl && running" class="tool-button" type="button" :disabled="submitting || !game.connected.value" @click="submit('cancel')">取消</button>
        <button v-else-if="mayControl && analysis?.status !== 'done'" class="tool-button" type="button"
          :disabled="submitting || !game.connected.value || !analysis?.available"
          @click="submit('start')">{{ analysis?.status === 'failed' ? '重新分析' : '分析本局' }}</button>
      </div>
      <p v-if="localError" class="analysis-error" role="alert">{{ localError }}</p>
      <div class="analysis-layout">
        <div class="analysis-board">
          <ChessBoard v-if="replay?.game === 'chess'" :board="replay.board" :side="side" :selected="null" :targets="[]"
            :last="replay.last" :checked="replay.checked" :recommendation="recommendation" disabled />
          <XiangqiBoard v-else-if="replay?.game === 'xiangqi'" :board="replay.board" :side="side" :selected="null" :targets="[]"
            :last="replay.last" :checked="replay.checked" :recommendation="recommendation" disabled />
          <div class="analysis-board-meta">
            <strong>{{ selectedPly === null ? '终局' : ply === 0 ? '初始局面' : `第 ${ply} 步后` }}</strong>
            <button type="button" class="review-button" :disabled="selectedPly === null" @click="selectedPly = null">回到终局</button>
          </div>
          <p v-if="recommendationText" class="analysis-recommendation">引擎推荐 {{ recommendationText }}</p>
        </div>
        <div class="analysis-data">
          <template v-if="curve.length">
            <p class="analysis-axis">{{ room.game === 'chess' ? '白方' : '红方' }}视角 · 显示范围 ±{{ ANALYSIS_CURVE_LIMIT }}</p>
            <svg class="analysis-curve" viewBox="0 0 560 130" role="group" aria-label="局势评分曲线">
              <path d="M17 12H543 M17 65H543 M17 118H543" fill="none" stroke="#c8cbb4" />
              <polyline :points="polyline" fill="none" stroke="#365c48" stroke-width="2.5" />
              <circle v-for="point in curve" :key="point.ply" :cx="point.x" :cy="point.y" :r="point.grade ? 6 : 4"
                :fill="point.grade?.color ?? '#365c48'" :stroke="selectedPly === point.ply ? '#1c3429' : '#fffdf5'"
                :stroke-width="selectedPly === point.ply ? 3 : 1" role="button" tabindex="0" :data-ply="point.ply"
                :aria-label="`${point.ply === 0 ? '初始局面' : `第 ${point.ply} 步后`}，评分 ${point.score}${point.grade ? '，' + point.grade.label : ''}`"
                @click="selectedPly = point.ply" @keydown.enter.prevent="selectedPly = point.ply" @keydown.space.prevent="selectedPly = point.ply" />
            </svg>
            <ul class="analysis-legend" aria-label="失误分级">
              <li v-for="grade in ANALYSIS_GRADES" :key="grade.id"><i :style="{ background: grade.color }" />{{ grade.label }}</li>
            </ul>
          </template>
          <ol class="analysis-moves" aria-label="本局棋谱">
            <li><button type="button" :aria-current="selectedPly === 0" @click="selectedPly = 0">初始局面</button></li>
            <li v-for="move in moves" :key="move.ply">
              <button type="button" :aria-current="selectedPly === move.ply" :data-ply="move.ply" @click="selectedPly = move.ply">
                <span>{{ move.ply }}. {{ move.notation }}</span>
                <small v-if="grades.get(move.ply)" :style="{ color: grades.get(move.ply)?.color }">{{ grades.get(move.ply)?.label }}</small>
              </button>
            </li>
          </ol>
        </div>
      </div>
    </DialogShell>
  </div>
</template>

<style scoped>
.analysis-tools, .analysis-status, .analysis-board-meta, .analysis-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.analysis-tools { min-width: 0; }
.analysis-tools > small { color: #6e624e; overflow-wrap: anywhere; }
:global(.tools-dialog.board-analysis-dialog) { width: min(calc(100vw - 24px), 780px); max-height: min(88dvh, 780px); overflow-y: auto; overflow-x: hidden; color: #294f3c; }
.board-analysis-dialog p { margin: 0; overflow-wrap: anywhere; }
.analysis-disclaimer, .analysis-status, .analysis-axis, .analysis-recommendation { font-size: 12px; }
.analysis-disclaimer, .analysis-axis { color: #52644e; }
.analysis-status { margin: 8px 0; }
.analysis-error { color: #a02c25; }
.analysis-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.analysis-board, .analysis-data { min-width: 0; }
.analysis-board > svg, .analysis-curve { display: block; width: 100%; height: auto; }
.analysis-board-meta { justify-content: space-between; font-size: 13px; }
.analysis-recommendation { color: #793965; }
.analysis-curve circle { cursor: pointer; }
.analysis-curve circle:focus-visible { outline: none; stroke: #111; stroke-width: 4; }
.analysis-legend { padding: 0; margin: 4px 0 8px; list-style: none; font-size: 12px; }
.analysis-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
.analysis-moves { max-height: 260px; overflow-y: auto; padding: 0; margin: 0; list-style: none; }
.analysis-moves button { display: flex; justify-content: space-between; gap: 6px; width: 100%; text-align: start; padding: 6px 8px; border: 0; border-bottom: 1px solid #d9decc; background: transparent; color: inherit; font: inherit; overflow-wrap: anywhere; }
.analysis-moves button[aria-current="true"] { background: #dce8d9; }
@media (max-width: 570px) {
  .analysis-layout { grid-template-columns: minmax(0, 1fr); }
  .analysis-board > svg { max-height: 36dvh; }
  .analysis-moves { max-height: 135px; }
}
</style>
