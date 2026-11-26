<script setup lang="ts">
import { computed } from 'vue'
import type { AnalysisMove } from '../../shared/boardAnalysis'
import { chessCoordinate, chessName, chessPoint, chessSideName, type ChessBoard, type ChessMove, type ChessPiece } from '../../shared/chess'
import type { BoardPlayback } from '../useBoardPlayback'
import BoardMoveTrail, { type TrailMarker, type TrailRoute } from './BoardMoveTrail.vue'
import ChessToken from './ChessToken.vue'
export interface ChessPlayback { from: number; to: number; piece: ChessPiece; phase: number; rejected?: string; move?: ChessMove }
const props = defineProps<{ board: ChessBoard; side: number | null; selected: number | null; targets: number[]; recommendation?: AnalysisMove | null; disabled?: boolean; last?: ChessMove | null; checked?: number | null; opposed?: boolean; live?: BoardPlayback<ChessBoard, ChessMove> | null; playback?: ChessPlayback | null }>()
const emit = defineEmits<{ select: [point: number] }>()
const point = (p: number) => chessPoint(p, props.opposed ? 0 : props.side)
const x = (p: number) => point(p).x, y = (p: number) => point(p).y
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const ease = (t: number) => t * t * (3 - 2 * t)
/** Tutorial playback stays on its own clock; live play is driven by the shared hook. */
const active = computed(() => props.playback && (props.playback.phase < .84 || props.playback.rejected) ? props.playback : null)
const progress = computed(() => { const a = active.value; if (!a) return 1; const t = clamp((a.phase - .12) / .55); return a.rejected ? Math.sin(clamp((a.phase - .08) / .7) * Math.PI) * .45 : ease(t) })
function moving(from: number, to: number) { const a = point(from), b = point(to), t = progress.value; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } }
const live = computed(() => props.live)
const liveMove = computed(() => props.live?.move ?? null)
const travel = computed(() => ease(clamp((props.live?.progress ?? 0) / .7)))
const fade = computed(() => 1 - clamp(((props.live?.progress ?? 0) - .72) / .28))
function liveMoving(from: number, to: number) { const a = point(from), b = point(to), t = travel.value; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } }
const hiddenIds = computed(() => {
  const ids = new Set<string>(), a = active.value, move = liveMove.value
  if (a) { ids.add(a.piece.id); if (a.move?.castle) ids.add(a.move.castle.piece.id) }
  if (move) { ids.add(move.piece.id); if (move.castle) ids.add(move.castle.piece.id) }
  return ids
})
function hidden(piece: ChessPiece | null) { return !!piece && hiddenIds.value.has(piece.id) }
/** The captured token keeps its square until contact, then fades out before the settled board replaces it. */
function opacity(p: number) {
  const move = liveMove.value
  if (move && move.capturePoint === p) return props.board[p] && props.board[p]!.id !== move.piece.id ? fade.value : 1
  const a = active.value
  return a && !a.rejected && a.move?.capturePoint === p && props.board[p]?.id !== a.piece.id ? 1 - progress.value : 1
}
/** Tutorial playback owns its own route; live/finished play keeps a persistent moving-side trail. */
const trail = computed<{ color: string; routes: TrailRoute[]; markers: TrailMarker[]; title: string } | null>(() => {
  if (props.playback) return null
  const move = liveMove.value ?? props.last
  if (!move) return null
  const start = point(move.from), end = point(move.to)
  const routes: TrailRoute[] = [{ points: [start, end] }]
  const markers: TrailMarker[] = [
    { x: start.x, y: start.y, size: 56, kind: 'origin', shape: 'square' },
    { x: end.x, y: end.y, size: 56, kind: 'destination', shape: 'square' },
  ]
  if (move.castle) {
    const rookStart = point(move.castle.from), rookEnd = point(move.castle.to)
    routes.push({ points: [rookStart, rookEnd], width: 2.4, opacity: .85 })
    markers.push(
      { x: rookStart.x, y: rookStart.y, size: 56, kind: 'origin', shape: 'square', muted: true },
      { x: rookEnd.x, y: rookEnd.y, size: 56, kind: 'destination', shape: 'square', muted: true },
    )
  }
  return { color: move.side === 0 ? '#9a5d16' : '#2f566f', routes, markers, title: `${chessSideName(move.side)}第 ${move.ply} 手 ${chessCoordinate(move.from)} 到 ${chessCoordinate(move.to)}` }
})
function label(p: number) { const piece = props.board[p]; return `${chessCoordinate(p)} ${piece ? chessSideName(piece.side) + chessName(piece) : '空格'}${props.targets.includes(p) ? '，可以走到这里' : ''}` }
</script>
<template>
  <svg class="chess-board" viewBox="0 0 492 492" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="国际象棋棋盘，八行八列，白方先行" :data-piece-orientation="opposed ? 'opposed' : 'down'">
    <rect x="3" y="3" width="486" height="486" rx="14" fill="#e7d8b8" stroke="#b8a77d" stroke-width="2" />
    <rect x="20" y="20" width="452" height="452" rx="3" fill="#537363" />
    <g v-for="(_, p) in board" :key="p" class="chess-square" :data-chess-point="p" role="button" :tabindex="disabled ? -1 : 0" :aria-disabled="disabled || undefined" :aria-label="label(p)" :aria-pressed="selected === p" @click="!disabled && emit('select', p)" @keydown.enter.prevent="!disabled && emit('select', p)" @keydown.space.prevent="!disabled && emit('select', p)">
      <title>{{ label(p) }}</title>
      <rect class="chess-hit" :x="x(p)-28" :y="y(p)-28" width="56" height="56" :fill="(Math.floor(p/8)+p%8)%2 === 0 ? '#eee4c9' : '#78927a'" />
      <rect v-if="last?.from === p" :x="x(p)-28" :y="y(p)-28" width="56" height="56" fill="#b3a06a26" />
      <rect v-if="last?.to === p" :x="x(p)-28" :y="y(p)-28" width="56" height="56" fill="#e0b45c59" />
    </g>
    <BoardMoveTrail v-if="trail" :color="trail.color" :routes="trail.routes" :markers="trail.markers" :title="trail.title" />
    <g class="chess-pieces" pointer-events="none">
      <template v-for="(_, p) in board" :key="`piece-${p}`">
        <ChessToken v-if="board[p] && !hidden(board[p])" :piece="board[p]!" :x="x(p)" :y="y(p)" :opacity="opacity(p)" :facing-away="opposed && board[p]!.side === 1" :checked="board[p]!.rank === 'k' && board[p]!.side === checked" />
      </template>
    </g>
    <BoardMoveTrail v-if="recommendation" color="#793965" :routes="[{ points: [point(recommendation.from), point(recommendation.to)], dashed: true }]" title="引擎推荐走法" />
    <g v-if="playback" fill="none" :stroke="playback.rejected ? '#b55f49' : '#bc913e'" stroke-width="3" pointer-events="none"><path :d="`M${x(playback.from)} ${y(playback.from)}L${x(playback.to)} ${y(playback.to)}`" stroke-dasharray="6 5" /><circle :cx="x(playback.to)" :cy="y(playback.to)" r="24" /></g>
    <g class="chess-overlays" pointer-events="none">
      <template v-for="(_, p) in board" :key="`overlay-${p}`">
        <rect v-if="selected === p" :x="x(p)-26" :y="y(p)-26" width="52" height="52" fill="none" stroke="#c39539" stroke-width="3" />
        <circle v-if="targets.includes(p)" :cx="x(p)" :cy="y(p)" :r="board[p] ? 25 : 7" :fill="board[p] ? 'none' : '#244f46aa'" stroke="#f6efd5" stroke-width="2" />
      </template>
    </g>
    <g v-if="live" class="chess-live-motion" :data-progress="live.progress" pointer-events="none">
      <ChessToken class="chess-moving-token" :piece="live.move.piece" v-bind="liveMoving(live.move.from, live.move.to)" :facing-away="opposed && live.move.piece.side === 1" />
      <ChessToken v-if="live.move.castle" class="chess-moving-rook" :piece="live.move.castle.piece" v-bind="liveMoving(live.move.castle.from, live.move.castle.to)" :facing-away="opposed && live.move.castle.piece.side === 1" />
    </g>
    <template v-else-if="active">
      <ChessToken class="chess-moving-token" :piece="active.piece" v-bind="moving(active.from,active.to)" :facing-away="opposed && active.piece.side === 1" />
      <ChessToken v-if="active.move?.castle" class="chess-moving-rook" :piece="active.move.castle.piece" v-bind="moving(active.move.castle.from,active.move.castle.to)" :facing-away="opposed && active.piece.side === 1" />
    </template>
    <g v-if="playback?.rejected && playback.phase > .4" :transform="`translate(${x(playback.to)} ${y(playback.to)})`" pointer-events="none"><circle r="19" fill="#fff4dfef" stroke="#b75e48" stroke-width="2" /><path d="M-7-7L7 7M-7 7L7-7" stroke="#b75e48" stroke-width="3" /></g>
    <g fill="#6d7052" font-size="12" text-anchor="middle" font-family="sans-serif" pointer-events="none"><text v-for="col in 8" :key="`c${col}`" :x="50+(col-1)*56" y="485">{{ !opposed && side === 1 ? 'hgfedcba'[col-1] : 'abcdefgh'[col-1] }}</text><text v-for="row in 8" :key="`r${row}`" x="12" :y="54+(row-1)*56">{{ !opposed && side === 1 ? row : 9-row }}</text></g>
  </svg>
</template>
<style scoped>
.chess-board { display: block; width: 100%; height: 100%; user-select: none; touch-action: manipulation; }.chess-square { cursor: pointer; outline: none; }.chess-square[aria-disabled=true] { cursor: default; }.chess-square:focus-visible .chess-hit { stroke: #be8e2c; stroke-width: 3; }
</style>
