<script setup lang="ts">
import { computed, useId } from 'vue'
import { REVERSI_AREA, REVERSI_FLIP_MS, reversiCoordinate, reversiSideName, type ReversiBoard, type ReversiMove, type ReversiSide } from '../../shared/reversi'
import type { BoardPlayback } from '../useBoardPlayback'

const props = withDefaults(defineProps<{
  board: ReversiBoard
  legal?: number[]
  last?: ReversiMove | null
  selected?: number | null
  disabled?: boolean
  live?: BoardPlayback<ReversiBoard, ReversiMove> | null
  focusPoints?: number[]
}>(), { legal: () => [], focusPoints: () => [] })
const emit = defineEmits<{ select: [point: number] }>()
const id = 'reversi-' + useId()
const edge = 25
const cell = 54
const grid = cell * 8
const x = (point: number) => edge + cell * (point % 8)
const y = (point: number) => edge + cell * Math.floor(point / 8)
const distance = (from: number, to: number) => (x(from) - x(to)) ** 2 + (y(from) - y(to)) ** 2
const indices = Array.from({ length: REVERSI_AREA }, (_, point) => point)
const targets = computed(() => new Set(props.legal))
const flipOrder = computed(() => {
  const move = props.live?.move
  if (!move || move.point === null) return new Map<number, number>()
  const point = move.point
  return new Map([...move.flipped].sort((a, b) => distance(point, a) - distance(point, b) || a - b).map((value, index) => [value, index]))
})
const lastFlips = computed(() => new Set(props.last?.flipped ?? []))

function disk(point: number): { side: ReversiSide | null; width: number } {
  const live = props.live
  if (!live) return { side: props.board[point] ?? null, width: 1 }
  if (live.move.point === point) return { side: live.move.side, width: 1 }
  const order = flipOrder.value.get(point)
  if (order === undefined) return { side: live.board[point] ?? null, width: 1 }
  const duration = 220
  const step = Math.min(80, (REVERSI_FLIP_MS - duration) / Math.max(1, flipOrder.value.size - 1))
  const progress = Math.min(1, Math.max(0, (live.progress * REVERSI_FLIP_MS - order * step) / duration))
  return { side: progress < 0.5 ? live.board[point] ?? null : live.move.side,
    width: Math.max(0.065, Math.abs(Math.cos(progress * Math.PI))) }
}
const disks = computed(() => indices.map(disk))
function label(point: number): string {
  const side = disks.value[point]!.side
  return reversiCoordinate(point) + '，' + (side !== null ? reversiSideName(side) + '棋子' : targets.value.has(point) ? '可落子' : '空格')
}
function select(point: number): void {
  if (!props.disabled && targets.value.has(point)) emit('select', point)
}
</script>

<template>
  <svg class="reversi-board" viewBox="0 0 482 482" role="group" aria-label="黑白棋棋盘，八行八列"
    :data-flipping="live ? 'true' : undefined">
    <defs>
      <linearGradient :id="id + '-slate'" x2="1" y2="1" gradientUnits="objectBoundingBox">
        <stop stop-color="#768699" /><stop offset="1" stop-color="#515e76" />
      </linearGradient>
      <radialGradient :id="id + '-black'" cx="33%" cy="26%" r="72%">
        <stop stop-color="#516573" /><stop offset=".65" stop-color="#293643" /><stop offset="1" stop-color="#172331" />
      </radialGradient>
      <radialGradient :id="id + '-white'" cx="32%" cy="24%" r="78%">
        <stop stop-color="#fff9e9" /><stop offset=".7" stop-color="#e8dfc9" /><stop offset="1" stop-color="#c5b595" />
      </radialGradient>
    </defs>
    <rect x="2" y="2" width="478" height="478" rx="16" fill="#ede5d4" stroke="#afa38b" stroke-width="1.5" />
    <rect :x="edge" :y="edge" :width="grid" :height="grid" :fill="'url(#' + id + '-slate)'" />
    <path d="M15 25V15H25M457 15H467V25M467 457V467H457M25 467H15V457" fill="none" stroke="#968360" stroke-width="1.25" />
    <g class="reversi-coordinates" fill="#605a4d" font-size="11" text-anchor="middle" pointer-events="none" aria-hidden="true">
      <text v-for="index in 8" :key="'file-' + index" :x="edge + (index - .5) * cell" y="17">{{ 'ABCDEFGH'[index - 1] }}</text>
      <text v-for="index in 8" :key="'rank-' + index" x="14" :y="edge + (index - .5) * cell + 4">{{ index }}</text>
    </g>
    <g v-for="point in indices" :key="point" class="reversi-cell" :class="{ 'can-place': !disabled && targets.has(point) }"
      :data-reversi-point="point" :data-side="disks[point]!.side ?? undefined"
      :data-flipped="!live && lastFlips.has(point) ? 'true' : undefined"
      role="button" :tabindex="!disabled && targets.has(point) ? 0 : -1" :aria-label="label(point)"
      :aria-disabled="disabled || !targets.has(point)" :aria-pressed="selected === point"
      @click="select(point)" @keydown.enter.prevent="select(point)" @keydown.space.prevent="select(point)"
      :transform="'translate(' + x(point) + ' ' + y(point) + ')'">
      <rect class="reversi-square" x=".5" y=".5" width="53" height="53"
        :fill="(point % 8 + Math.floor(point / 8)) % 2 ? '#ffffff08' : '#1e293d0e'" stroke="#29394a62" />
      <rect v-if="!live && lastFlips.has(point) || focusPoints.includes(point)" x="3" y="3" width="48" height="48" rx="5"
        fill="#e6bc5933" stroke="#fae0a0" stroke-width="1.5" pointer-events="none" />
      <circle v-if="targets.has(point) && disks[point]!.side === null && !live" class="reversi-legal" cx="27" cy="27"
        :r="selected === point ? 8 : 3.5" fill="#f8e4a8" stroke="#37485d" stroke-width="1" />
      <g v-if="disks[point]!.side !== null" pointer-events="none"
        :transform="'translate(27 27) scale(' + disks[point]!.width + ' 1)'">
        <ellipse cy="2.7" rx="19.2" ry="19.2" fill="#24304166" />
        <circle r="18.6" :fill="'url(#' + id + (disks[point]!.side === 0 ? '-black)' : '-white)')"
          :stroke="disks[point]!.side === 0 ? '#192534' : '#b4a587'" />
        <circle r="14.6" fill="none" :stroke="disks[point]!.side === 0 ? '#81939e73' : '#9b8c6e67'" stroke-width=".9" />
        <circle v-if="last?.point === point" r="3.5" fill="#d6a450" :stroke="disks[point]!.side === 0 ? '#f5deb0' : '#886735'" />
      </g>
    </g>
  </svg>
</template>

<style scoped>
.reversi-board { display: block; width: 100%; height: 100%; }
.reversi-cell.can-place { cursor: pointer; }
.reversi-cell.can-place:hover .reversi-square, .reversi-cell:focus-visible .reversi-square { fill: #f6e3b650; stroke: #f1dc9d; stroke-width: 2; }
.reversi-cell:focus-visible { outline: none; }
</style>
