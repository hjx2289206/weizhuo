<script setup lang="ts">
import { computed } from 'vue'
import { xiangqiCoordinate, xiangqiName, xiangqiSideName, type XiangqiBoard, type XiangqiMove, type XiangqiPiece } from '../../shared/xiangqi'
import { xiangqiMotionPath, xiangqiPoint } from '../../shared/xiangqiGeometry'
import { xiangqiPathPoint, xiangqiPlaybackProgress, type XiangqiPlayback } from '../tutorials/xiangqiMotion'
import type { BoardPlayback } from '../useBoardPlayback'
import BoardMoveTrail, { type TrailMarker, type TrailRoute } from './BoardMoveTrail.vue'
import XiangqiToken from './XiangqiToken.vue'
const props = defineProps<{ board: XiangqiBoard; side: number | null; selected: number | null; targets: number[]; disabled?: boolean; last?: XiangqiMove | null; checked?: number | null; opposed?: boolean; camera?: string; live?: BoardPlayback<XiangqiBoard, XiangqiMove> | null; playback?: XiangqiPlayback | null }>()
const emit = defineEmits<{ select: [point: number] }>()
const x = (point: number) => xiangqiPoint(point, props.side).x
const y = (point: number) => xiangqiPoint(point, props.side).y
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const ease = (t: number) => t * t * (3 - 2 * t)
/** Tutorial playback stays on its own clock; live play is driven by the shared hook. */
const active = computed(() => props.playback)
const moving = computed(() => {
  const current = active.value; if (!current) return null
  const t = xiangqiPlaybackProgress(current.phase,!!current.rejected)
  const point = xiangqiPathPoint(current.path,t,props.side)
  return { x: point.x, y: point.y - (current.piece.rank === 'cannon' && current.capture && !current.rejected ? Math.sin(t * Math.PI) * 12 : 0) }
})
const live = computed(() => props.live)
const liveMove = computed(() => props.live?.move ?? null)
const travel = computed(() => ease(clamp((props.live?.progress ?? 0) / .7)))
const fade = computed(() => 1 - clamp(((props.live?.progress ?? 0) - .72) / .28))
const livePath = computed(() => { const move = liveMove.value; return move ? xiangqiMotionPath(move.piece, move.from, move.to) : [] })
const liveMoving = computed(() => {
  const move = liveMove.value; if (!move) return null
  const t = travel.value, point = xiangqiPathPoint(livePath.value, t, props.side)
  return { x: point.x, y: point.y - (move.piece.rank === 'cannon' && move.captured ? Math.sin(t * Math.PI) * 12 : 0) }
})
const route = computed(() => props.playback?.path.map(p=>`${x(p)},${y(p)}`).join(' ') ?? '')
function hidden(piece: XiangqiPiece | null) { return !!piece && liveMove.value?.piece.id === piece.id }
/** The captured token keeps its intersection until contact, then fades before the settled board replaces it. */
function opacity(point: number): number {
  const move = liveMove.value
  if (move) return move.captured && point === move.to && props.board[point]?.id !== move.piece.id ? fade.value : 1
  return props.playback && !props.playback.rejected && point===props.playback.to && props.board[point]?.id!==props.playback.piece.id ? Math.max(0,1-(props.playback.phase-.65)/.17) : 1
}
/** Tutorial playback owns its own route; live/finished play keeps a persistent moving-side trail. */
const trail = computed<{ color: string; routes: TrailRoute[]; markers: TrailMarker[]; title: string } | null>(() => {
  if (props.playback) return null
  const move = liveMove.value ?? props.last
  if (!move) return null
  const path = xiangqiMotionPath(move.piece, move.from, move.to)
  return {
    color: move.side === 0 ? '#a33c2d' : '#2e4b3e',
    routes: [{ points: path.map(point => ({ x: x(point), y: y(point) })) }],
    markers: [
      { x: x(move.from), y: y(move.from), size: 55, kind: 'origin', shape: 'circle' },
      { x: x(move.to), y: y(move.to), size: 55, kind: 'destination', shape: 'circle' },
    ],
    title: `${xiangqiSideName(move.side)}第 ${move.ply} 步 ${xiangqiCoordinate(move.from)} 到 ${xiangqiCoordinate(move.to)}`,
  }
})
function label(point: number): string { const piece = props.board[point]; return `${xiangqiCoordinate(point)} ${piece ? `${xiangqiSideName(piece.side)}${xiangqiName(piece)}` : '空位'}${!props.disabled && props.targets.includes(point) ? '，可以走到这里' : ''}` }
const marks = [19, 25, 27, 29, 31, 33, 35, 54, 56, 58, 60, 62, 64, 70]
</script>
<template>
  <svg class="xiangqi-board" :viewBox="camera || '0 0 500 540'" :data-piece-orientation="opposed ? 'opposed' : 'down'" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="中国象棋棋盘，九路十横，红黑双方各十六子">
    <rect x="3" y="3" width="494" height="534" rx="15" fill="#d7bb83" stroke="#ae8c56" />
    <rect x="12" y="12" width="476" height="516" rx="9" fill="#f2dfb5" stroke="#edcf94" />
    <path d="M22 30Q180 20 478 31M22 116Q220 123 478 109M22 401Q230 393 478 405M22 510Q170 501 478 512" stroke="#bc9352" stroke-width=".8" fill="none" opacity=".14" />
    <g fill="none" stroke="#7f6849" stroke-width="1.3"><path v-for="row in 10" :key="`r${row}`" :d="`M50 ${45 + (row-1)*50}H450`" /><path v-for="col in 9" :key="`c${col}`" :d="col === 1 || col === 9 ? `M${50+(col-1)*50} 45V495` : `M${50+(col-1)*50} 45V245M${50+(col-1)*50} 295V495`" /><path d="M200 45L300 145M300 45L200 145M200 395L300 495M300 395L200 495" /></g>
    <rect x="44" y="39" width="412" height="462" fill="none" stroke="#7f6849" stroke-width="2.1" />
    <g font-family="Songti SC, Noto Serif SC, serif" font-size="28" fill="#887149" text-anchor="middle" letter-spacing="9"><text x="147" y="279">楚河</text><text x="355" y="279">汉界</text></g>
    <g fill="none" stroke="#8d7753" stroke-width="1.2"><g v-for="p in marks" :key="p" :transform="`translate(${x(p)} ${y(p)})`"><path v-if="(side === 1 ? 8 - p % 9 : p % 9) > 0" d="M-5-13V-5H-13M-5 13V5H-13" /><path v-if="(side === 1 ? 8 - p % 9 : p % 9) < 8" d="M5-13V-5H13M5 13V5H13" /></g></g>
    <g fill="#9c845a" font-size="11" font-family="Songti SC, serif" text-anchor="middle"><text v-for="col in 9" :key="col" :x="50+(col-1)*50" y="525">{{ side === 1 ? 10 - col : '九八七六五四三二一'[col-1] }}</text></g>
    <g v-if="playback" class="xiangqi-tutorial-route" fill="none" :stroke="playback.rejected ? '#b55f49' : '#5b8051'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".75" pointer-events="none"><polyline :points="route" stroke-dasharray="6 5" /><circle :cx="x(playback.from)" :cy="y(playback.from)" r="25" /><circle :cx="x(playback.to)" :cy="y(playback.to)" r="12" /></g>
    <BoardMoveTrail v-if="trail" :color="trail.color" :routes="trail.routes" :markers="trail.markers" :title="trail.title" />
    <g v-for="(_, p) in board" :key="p" class="xiangqi-point" :data-xq-point="p" role="button" :tabindex="disabled ? -1 : 0" :aria-disabled="disabled || undefined" :aria-label="label(p)" :aria-pressed="selected === p" @click="!disabled && emit('select',p)" @keydown.enter.prevent="!disabled && emit('select',p)" @keydown.space.prevent="!disabled && emit('select',p)">
      <title>{{ label(p) }}</title><rect class="xiangqi-hit" :x="x(p)-25" :y="y(p)-25" width="50" height="50" fill="transparent" />
      <rect v-if="last?.from === p" :x="x(p)-25" :y="y(p)-25" width="50" height="50" rx="6" fill="#7e8a4a1f" />
      <rect v-if="last?.to === p" :x="x(p)-25" :y="y(p)-25" width="50" height="50" rx="6" fill="#a98a3f3d" />
      <XiangqiToken v-if="board[p] && active?.piece.id !== board[p]!.id && !hidden(board[p]!)" :piece="board[p]!" :opacity="opacity(p)" :facing-away="opposed && board[p]!.side === 1" :x="x(p)" :y="y(p)" :checked="board[p]!.rank === 'general' && board[p]!.side === checked" />
      <circle v-if="selected === p" :cx="x(p)" :cy="y(p)" r="26" fill="none" stroke="#4e7950" stroke-width="2.5" />
      <circle v-if="targets.includes(p)" :cx="x(p)" :cy="y(p)" :r="board[p] ? 25.5 : 6" :fill="board[p] ? 'none' : '#5c8158'" :stroke="board[p] ? '#5c8158' : '#f5efdb'" stroke-width="2" />
    </g>
    <g v-if="live && liveMoving" class="xiangqi-live-token" :data-progress="live.progress" pointer-events="none"><XiangqiToken :piece="live.move.piece" :facing-away="opposed && live.move.piece.side === 1" :x="liveMoving.x" :y="liveMoving.y" /></g>
    <g v-else-if="active && moving" class="xiangqi-moving-token" pointer-events="none"><XiangqiToken :piece="active.piece" :facing-away="opposed && active.piece.side === 1" :x="moving.x" :y="moving.y" /></g>
    <g v-if="playback?.rejected && playback.phase > .4" class="xiangqi-tutorial-denied" :transform="`translate(${x(playback.to)} ${y(playback.to)})`" pointer-events="none"><circle r="21" fill="#fff4dfec" stroke="#b75e48" stroke-width="2" /><path d="M-8-8L8 8M-8 8L8-8" stroke="#b75e48" stroke-width="3" stroke-linecap="round" /></g>
  </svg>
</template>
<style scoped>
.xiangqi-board { display: block; width: 100%; height: 100%; user-select: none; touch-action: manipulation; }
.xiangqi-point { cursor: pointer; outline: none; }.xiangqi-point[aria-disabled=true] { cursor: default; }.xiangqi-point:focus-visible .xiangqi-hit { stroke: #52794d; stroke-width: 2; }
</style>
