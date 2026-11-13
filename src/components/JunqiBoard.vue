<script setup lang="ts">
import { computed } from 'vue'
import { JUNQI_EDGES, JUNQI_NAMES, isJunqiCamp, isJunqiHQ, junqiRailEdge, junqiCoordinate, type JunqiBoard, type JunqiMove } from '../../shared/junqi'
import { junqiPointPosition } from '../../shared/junqiGeometry'
import type { ChessMotion } from '../tutorials/chessMotion'
import JunqiToken from './JunqiToken.vue'
import JunqiMoveOverlay from './JunqiMoveOverlay.vue'
import type { BoardPlayback } from '../useBoardPlayback'
import JunqiMoveTrail from './JunqiMoveTrail.vue'
const props = defineProps<{ board: JunqiBoard; side: number | null; selected: number | null; targets: number[]; disabled?: boolean; last?: JunqiMove | null; camera?: string; motion?: ChessMotion | null; playback?: BoardPlayback<JunqiBoard, JunqiMove> | null; fadingSides?: number[]; fade?: number }>()
const emit = defineEmits<{ select: [point: number] }>()
const flipped = computed(() => props.side === 1)
function x(p: number) { return junqiPointPosition(p, 'two', props.side).x }
function y(p: number) { return junqiPointPosition(p, 'two', props.side).y }
function hidden(p: number) { return props.playback && (props.playback.move.from === p || props.playback.move.to === p) || props.motion && (props.motion.from === p && props.motion.phase >= .14 && props.motion.phase < .84 || props.motion.to === p && props.motion.combat && props.motion.phase > .66 && props.motion.phase < .84) }
function label(p: number): string {
  const piece = props.board[p]
  return `${junqiCoordinate(p)} ${piece ? `${piece.side === 0 ? '红方' : '蓝方'}${piece.rank ? JUNQI_NAMES[piece.rank] : '暗子'}` : isJunqiCamp(p) ? '行营' : isJunqiHQ(p) ? '大本营' : '空兵站'}${props.targets.includes(p) ? '，可选位置' : ''}`
}
</script>
<template>
  <svg class="junqi-board" :viewBox="camera ?? '0 0 500 760'" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="双人暗棋棋盘，红蓝双方各二十五枚棋子">
    <rect x="9" y="9" width="482" height="742" rx="20" fill="#eae5d4" stroke="#b8b59d" />
    <rect x="23" y="23" width="454" height="714" rx="12" fill="#f8f4e8" stroke="#d7d0b7" />
    <g stroke="#b8b79e" stroke-width="2">
      <line v-for="[a,b] in JUNQI_EDGES" :key="`${a}-${b}`" :data-edge="`${a}-${b}`" :x1="x(a)" :y1="y(a)" :x2="x(b)" :y2="y(b)" />
    </g>
    <g v-for="[a,b] in JUNQI_EDGES.filter(([a,b]) => junqiRailEdge(a,b))" :key="`rail-${a}-${b}`">
      <line :x1="x(a)" :y1="y(a)" :x2="x(b)" :y2="y(b)" stroke="#6e7a66" stroke-width="7" />
      <line :x1="x(a)" :y1="y(a)" :x2="x(b)" :y2="y(b)" stroke="#f8f4e8" stroke-width="3" stroke-dasharray="4 5" />
    </g>
    <g class="junqi-frontier" fill="#8c8c72" font-size="12" text-anchor="middle" letter-spacing="4">
      <text x="160" y="388">山界</text><text x="340" y="388">山界</text>
    </g>
    <g fill="#899078" font-size="9" text-anchor="middle" aria-hidden="true">
      <text v-for="c in 5" :key="`col${c}`" :x="70 + (c-1)*90" y="28">{{ 'ABCDE'[flipped ? 5-c : c-1] }}</text>
      <text v-for="r in 12" :key="`row${r}`" x="26" :y="52 + (r-1)*56 + (r>6 ? 48 : 0) + 3">{{ flipped ? r : 13-r }}</text>
    </g>
    <g v-for="(_, p) in board" :key="p" class="junqi-point" :class="{ selected: selected === p, target: targets.includes(p), red: board[p]?.side === 0, blue: board[p]?.side === 1, occupied: !!board[p], 'last-move': last?.from === p || last?.to === p }"
      role="button" :data-point="p" :data-side="board[p]?.side" :tabindex="disabled ? -1 : 0" :aria-disabled="disabled || undefined" :aria-label="label(p)" :aria-pressed="selected === p"
      @click="!disabled && emit('select', p)" @keydown.enter.prevent="!disabled && emit('select', p)" @keydown.space.prevent="!disabled && emit('select', p)">
      <title>{{ label(p) }}</title>
      <rect class="junqi-hit" :x="x(p)-43" :y="y(p)-26" width="86" height="52" rx="8" fill="transparent" />
      <ellipse v-if="isJunqiCamp(p)" :cx="x(p)" :cy="y(p)" rx="26" ry="19" fill="#e5ead8" stroke="#9aa88a" stroke-width="1.5" />
      <rect v-else :x="x(p)-31" :y="y(p)-18" width="62" height="36" :rx="isJunqiHQ(p) ? 4 : 8" :fill="isJunqiHQ(p) ? '#e9dfbf' : '#f8f4e8'" stroke="#bbb99f" />
      <text v-if="!board[p]" :x="x(p)" :y="y(p)+4" text-anchor="middle" fill="#93977c" font-size="10">{{ isJunqiCamp(p) ? '行营' : isJunqiHQ(p) ? '大本营' : '' }}</text>
      <JunqiToken v-if="board[p]" :piece="board[p]!" :x="x(p)" :y="y(p)" variant="two" :opacity="fadingSides?.includes(board[p]!.side) ? fade : undefined" :style="{ visibility: hidden(p) ? 'hidden' : undefined }" />
      <rect v-if="selected === p" :x="x(p)-39" :y="y(p)-25" width="78" height="48" rx="10" fill="none" stroke="#ac863b" stroke-width="3" />
      <circle v-if="targets.includes(p)" :cx="x(p)+30" :cy="y(p)-18" r="7" fill="#406d4c" stroke="#fffdf4" stroke-width="2" />
    </g>
    <JunqiMoveOverlay v-if="motion" :board="board" :side="side" variant="two" :motion="motion" />
    <JunqiMoveTrail v-if="last && !motion" :move="last" variant="two" :side="side" :playback="playback" />
  </svg>
</template>
<style scoped>
.junqi-board { display: block; width: 100%; height: 100%; max-height: inherit; user-select: none; touch-action: manipulation; }
.junqi-point { cursor: pointer; outline: none; color: #356083; }
.junqi-point.red { color: #9b4237; }
.junqi-point:focus-visible .junqi-hit { stroke: #31583e; stroke-width: 3; }
.junqi-point[aria-disabled=true] { cursor: default; }
.junqi-point.target .junqi-hit { fill: #4d755714; }.junqi-point.last-move:not(.occupied) .junqi-hit { fill: #b49b6014; }
@media (prefers-reduced-motion: no-preference) { .junqi-point:hover .junqi-hit { fill: #31583e0b; } }
</style>
