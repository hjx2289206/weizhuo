<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { createRenjuAnalyzer, renjuForbiddenText, stoneCoordinate, stonePositionKey, stoneSideName, type RenjuForbidden, type StoneBoard, type StoneMove, type StoneSide } from '../../shared/stones'
import type { BoardPlayback } from '../useBoardPlayback'
const props = withDefaults(defineProps<{ board: StoneBoard; size: number; selected?: number | null; previewSide?: StoneSide; disabled?: boolean; last?: number | null; dead?: number[]; winningLine?: number[]; ownership?: (StoneSide | null)[]; focusPoints?: number[]; live?: BoardPlayback<StoneBoard, StoneMove> | null; renjuBoard?: StoneBoard | null }>(), { selected: null, previewSide: 0, last: null, dead: () => [], winningLine: () => [], focusPoints: () => [] })
const emit = defineEmits<{ select: [point: number] }>()
const art = `stones-${useId()}`, root = ref<SVGSVGElement | null>(null), cursor = ref(Math.floor(props.size ** 2 / 2))
const step = computed(() => 520 / (props.size - 1)), radius = computed(() => step.value * .45)
const xy = (point: number) => ({ x: 40 + point % props.size * step.value, y: 40 + Math.floor(point / props.size) * step.value })
const emptyForbidden = new Map<number, RenjuForbidden>()
let cachedForbidden = { key: '', points: emptyForbidden }
const forbidden = computed(() => {
  const board = props.renjuBoard
  if (!board) return emptyForbidden
  const key = `${props.size}:${stonePositionKey(board)}`
  if (cachedForbidden.key !== key) {
    const analyzer = createRenjuAnalyzer(props.size, point => board[point])
    const points = new Map<number, RenjuForbidden>()
    board.forEach((stone, point) => {
      if (stone !== null) return
      const reason = analyzer.forbidden(point)
      if (reason) points.set(point, reason)
    })
    cachedForbidden = { key, points }
  }
  return cachedForbidden.points
})
function intersectionLabel(point: number, stone: StoneSide | null): string {
  const reason = forbidden.value.get(point)
  return `${stoneCoordinate(point, props.size)}，${stone === null ? '空位' : stoneSideName(stone) + '棋子'}${props.dead.includes(point) ? '，已标死子' : ''}${reason ? '，' + renjuForbiddenText(reason) : ''}`
}
const liveMove = computed(() => props.live?.move ?? null)
const livePoint = computed(() => liveMove.value?.point ?? null)
const shown = computed(() => {
  const point = livePoint.value
  if (point === null) return props.board
  const board = props.board.slice()
  board[point] = liveMove.value!.side
  return board
})
const captured = computed(() => new Set(liveMove.value?.captured ?? []))
const drop = computed(() => 1 - (1 - Math.min(1, (props.live?.progress ?? 1) / .42)) ** 3)
const fade = computed(() => Math.max(0, Math.min(1, ((props.live?.progress ?? 0) - .55) / .45)))
const ripple = computed(() => { const t = Math.min(1, (props.live?.progress ?? 1) / .62); return { r: radius.value * (1 + 1.3 * t), opacity: props.live ? .55 * (1 - t) : 0 } })
function stoneOpacity(point: number): number {
  const base = props.dead.includes(point) ? .35 : 1
  if (livePoint.value === point) return base * Math.min(1, drop.value * 1.5)
  return captured.value.has(point) ? base * (1 - fade.value) : base
}
function stoneTransform(point: number): string | undefined {
  if (livePoint.value !== point) return undefined
  const scale = .4 + .6 * drop.value, { x, y } = xy(point)
  return `translate(${x} ${y - (1 - drop.value) * Math.max(7, radius.value * .6)}) scale(${scale}) translate(${-x} ${-y})`
}
const stars = computed(() => { const n = props.size, near = n === 9 ? 2 : 3, far = n - 1 - near, mid = (n - 1) / 2; return (n === 19 ? [near,mid,far].flatMap(y => [near,mid,far].map(x => y * n + x)) : [near * n + near, near * n + far, mid * n + mid, far * n + near, far * n + far]) })
watch(() => props.size, () => { cursor.value = Math.floor(props.size ** 2 / 2) })
function keydown(event: KeyboardEvent, point: number): void {
  const n = props.size, x = point % n, y = Math.floor(point / n)
  if (['Enter',' '].includes(event.key)) { event.preventDefault(); if (!props.disabled) emit('select', point); return }
  const target = event.key === 'ArrowLeft' ? y * n + Math.max(0,x-1) : event.key === 'ArrowRight' ? y * n + Math.min(n-1,x+1) : event.key === 'ArrowUp' ? Math.max(0,y-1) * n + x : event.key === 'ArrowDown' ? Math.min(n-1,y+1) * n + x : null
  if (target !== null) { event.preventDefault(); cursor.value = target; root.value?.querySelector<SVGGElement>(`[data-stone-point="${target}"]`)?.focus() }
}
</script>
<template>
  <svg ref="root" class="stone-board" viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg" :aria-label="`${size} 路棋盘，坐标从左上角开始，字母表示列，数字表示行`">
    <defs><radialGradient :id="`${art}-black`" cx=".32" cy=".25" r=".75"><stop stop-color="#62675e" /><stop offset=".48" stop-color="#30352e" /><stop offset="1" stop-color="#171e18" /></radialGradient><radialGradient :id="`${art}-white`" cx=".3" cy=".2" r=".8"><stop stop-color="#fffef7" /><stop offset=".6" stop-color="#f7f3df" /><stop offset="1" stop-color="#c8c8b6" /></radialGradient><clipPath :id="`${art}-board`"><rect x="16" y="16" width="568" height="568" rx="8" /></clipPath></defs>
    <rect x="5" y="5" width="590" height="590" rx="14" fill="#ddc18b" stroke="#af9769" stroke-width="2" />
    <rect x="15" y="15" width="570" height="570" rx="8" fill="#ead2a0" stroke="#c8ad7a" />
    <g stroke="#8f794f" stroke-width="1.1"><path v-for="i in size" :key="i" :d="`M40 ${40+(i-1)*step}H560M${40+(i-1)*step} 40V560`" /></g>
    <g fill="#8f794f"><circle v-for="p in stars" :key="p" :cx="xy(p).x" :cy="xy(p).y" r="3" /></g>
    <g fill="#88734d" font-family="sans-serif" font-size="11" text-anchor="middle"><template v-for="i in size" :key="i"><text :x="40+(i-1)*step" y="30">{{ 'ABCDEFGHJKLMNOPQRST'[i-1] }}</text><text x="27" :y="44+(i-1)*step">{{ i }}</text></template></g>
    <g v-if="live && livePoint !== null" class="stone-live-ripple" :clip-path="`url(#${art}-board)`" pointer-events="none" aria-hidden="true"><circle :cx="xy(livePoint ?? 0).x" :cy="xy(livePoint ?? 0).y" :r="ripple.r" fill="none" stroke="#a8792c" stroke-width="2.5" :opacity="ripple.opacity" /></g>
    <g v-for="(stone,p) in shown" :key="p" class="stone-intersection" :data-stone-point="p" role="button" :tabindex="cursor === p ? 0 : -1" :aria-disabled="disabled" :aria-label="intersectionLabel(p, stone)" @focus="cursor = p" @keydown="keydown($event,p)" @click="!disabled && emit('select',p)">
      <rect class="stone-hit" :x="xy(p).x-step/2" :y="xy(p).y-step/2" :width="step" :height="step" fill="transparent" />
      <circle v-if="focusPoints.includes(p)" :cx="xy(p).x" :cy="xy(p).y" :r="radius+3" fill="#c8a34a70" />
      <g v-if="stone !== null" class="placed-stone" :opacity="stoneOpacity(p)" :transform="stoneTransform(p)" pointer-events="none"><ellipse :cx="xy(p).x+1" :cy="xy(p).y+2" :rx="radius" :ry="radius*.94" fill="#27352630" /><circle :cx="xy(p).x" :cy="xy(p).y" :r="radius" :fill="`url(#${art}-${stone === 0 ? 'black' : 'white'})`" :stroke="stone === 0 ? '#1d291e' : '#b7b6a1'" stroke-width=".7" /><template v-if="last === p"><circle class="stone-last-ring" :cx="xy(p).x" :cy="xy(p).y" :r="radius+Math.max(2.8,radius*.2)" fill="none" stroke="#c2603d" stroke-width="2.6" /><circle class="stone-last-mark" :cx="xy(p).x" :cy="xy(p).y" :r="Math.max(4.2,radius*.28)" :fill="stone === 0 ? '#fbf3d8' : '#22352a'" stroke="#c2603d" stroke-width="1" /></template></g>
      <rect v-if="ownership?.[p] !== null && ownership?.[p] !== undefined && (stone === null || dead.includes(p))" :x="xy(p).x-radius*.3" :y="xy(p).y-radius*.3" :width="radius*.6" :height="radius*.6" :fill="ownership[p] === 0 ? '#34462d' : '#fffdf0'" stroke="#8f916e" stroke-width=".5" pointer-events="none" />
      <path v-if="dead.includes(p)" :d="`M${xy(p).x-radius*.4} ${xy(p).y-radius*.4}l${radius*.8} ${radius*.8}m0 ${-radius*.8}l${-radius*.8} ${radius*.8}`" fill="none" stroke="#ae4b39" stroke-width="2" pointer-events="none" />
      <circle v-if="selected === p && stone === null" :cx="xy(p).x" :cy="xy(p).y" :r="radius" :fill="previewSide === 0 ? '#233b2b' : '#fffef2'" opacity=".6" stroke="#9c7234" stroke-width="2" pointer-events="none" />
      <g v-if="stone === null && forbidden.has(p)" class="stone-forbidden" :data-forbidden="forbidden.get(p)" :transform="`translate(${xy(p).x} ${xy(p).y})`" pointer-events="none" aria-hidden="true">
        <circle r="8" fill="#f3d59d" /><path d="M-4 -4L4 4M4 -4L-4 4" fill="none" stroke="#a5382a" stroke-width="2.6" stroke-linecap="round" />
      </g>
      <circle v-if="winningLine.includes(p)" :cx="xy(p).x" :cy="xy(p).y" :r="radius*.72" fill="none" stroke="#d2aa54" stroke-width="2" pointer-events="none" />
    </g>
  </svg>
</template>
<style>
.stone-board { display: block; width: 100%; height: 100%; user-select: none; touch-action: manipulation; }
.stone-intersection { cursor: pointer; outline: none; }.stone-intersection[aria-disabled="true"] { cursor: default; }.stone-intersection:focus-visible .stone-hit { stroke: #a66c2d; stroke-width: 2; }
</style>
