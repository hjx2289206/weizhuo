<script setup lang="ts">
import { computed } from 'vue'
import { JUNQI_FOUR_EDGES, JUNQI_NAMES, isJunqiCamp, isJunqiHQ, junqiCoordinate, junqiSideName, type JunqiBoard, type JunqiMove } from '../../shared/junqi'
import { junqiPointPosition, junqiEdgePath } from '../../shared/junqiGeometry'
import type { ChessMotion } from '../tutorials/chessMotion'
import JunqiToken from './JunqiToken.vue'
import JunqiMoveOverlay from './JunqiMoveOverlay.vue'
import type { BoardPlayback } from '../useBoardPlayback'
import JunqiMoveTrail from './JunqiMoveTrail.vue'

const props = defineProps<{ board: JunqiBoard; side: number | null; selected: number | null; targets: number[]; disabled?: boolean; last?: JunqiMove | null; focusArmy?: boolean; zoom?: boolean; camera?: string; motion?: ChessMotion | null; playback?: BoardPlayback<JunqiBoard, JunqiMove> | null; fadingSides?: number[]; fade?: number }>()
const emit = defineEmits<{ select: [point: number] }>()
const visiblePoints = computed(() => Array.from({ length: props.focusArmy && props.side !== null ? 30 : 129 }, (_, p) => p + (props.focusArmy && props.side !== null ? props.side * 30 : 0)))
const positions = computed(() => Array.from({ length: 129 }, (_, p) => junqiPointPosition(p, 'four', props.side)))
const x = (p: number) => positions.value[p]!.x
const y = (p: number) => positions.value[p]!.y
const path = (a: number, b: number, curve: boolean) => junqiEdgePath(a, b, 'four', props.side, curve)
function hidden(p: number) { return props.playback && (props.playback.move.from === p || props.playback.move.to === p) || props.motion && (props.motion.from === p && props.motion.phase >= .14 && props.motion.phase < .84 || props.motion.to === p && props.motion.combat && props.motion.phase > .66 && props.motion.phase < .84) }
function label(p: number) {
  const piece = props.board[p]
  return `${junqiCoordinate(p, 'four')} ${piece ? `${junqiSideName(piece.side)}${piece.rank ? JUNQI_NAMES[piece.rank] : '暗子'}` : isJunqiCamp(p, 'four') ? '行营' : isJunqiHQ(p, 'four') ? '大本营' : '空兵站'}${props.targets.includes(p) ? '，可选位置' : ''}`
}
</script>

<template>
  <div class="junqi-four-scroll" :class="{ 'is-zoomed': zoom && !focusArmy }">
    <svg class="junqi-four-board" :viewBox="camera ?? (focusArmy && side !== null ? '304 550 264 302' : '0 0 872 872')" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="四国四暗棋盘，对坐同队，只显示自己的棋子身份">
      <rect width="872" height="872" rx="22" fill="#f4f0e1" />
      <g v-if="!focusArmy" fill="#dedec8" opacity=".5"><rect x="315" y="15" width="242" height="280" rx="16"/><rect x="15" y="315" width="280" height="242" rx="16"/><rect x="577" y="315" width="280" height="242" rx="16"/><rect x="315" y="577" width="242" height="280" rx="16"/></g>
      <g stroke="#b2b299" stroke-width="2" fill="none"><path v-for="edge in JUNQI_FOUR_EDGES" :key="`${edge.a}-${edge.b}`" :data-edge="`${edge.a}-${edge.b}`" :d="path(edge.a, edge.b, edge.curve)" /></g>
      <g v-for="edge in JUNQI_FOUR_EDGES.filter(e => e.rail)" :key="`rail-${edge.a}-${edge.b}`" fill="none">
        <path :d="path(edge.a, edge.b, edge.curve)" stroke="#71816a" stroke-width="7" />
        <path :d="path(edge.a, edge.b, edge.curve)" stroke="#f4f0e1" stroke-width="3" stroke-dasharray="4 5" />
      </g>
      <g v-if="!focusArmy" fill="#7c8769" font-family="Songti SC, serif" text-anchor="middle">
        <text x="436" y="22" font-size="19">{{ junqiSideName(((side ?? 0) + 2) % 4) }} · 对家</text>
        <text x="145" y="610" font-size="20">{{ junqiSideName(((side ?? 0) + 1) % 4) }}</text>
        <text x="727" y="610" font-size="20">{{ junqiSideName(((side ?? 0) + 3) % 4) }}</text>
        <text x="436" y="863" font-size="19">{{ junqiSideName(side ?? 0) }} · {{ side === null ? '南方' : '我的阵地' }}</text>
        <text x="145" y="210" font-size="23" letter-spacing="6">四国暗棋</text><text x="727" y="210" font-size="20" letter-spacing="3">对坐同盟</text>
      </g>
      <g v-for="p in visiblePoints" :key="p" class="junqi-four-point" :class="[`side-${board[p]?.side}`, { target: targets.includes(p) }]" role="button" :data-point="p" :data-side="board[p]?.side" :tabindex="disabled ? -1 : 0" :aria-disabled="disabled || undefined" :aria-label="label(p)" :aria-pressed="selected === p" @click="!disabled && emit('select', p)" @keydown.enter.prevent="!disabled && emit('select', p)" @keydown.space.prevent="!disabled && emit('select', p)">
        <title>{{ label(p) }}</title>
        <rect class="junqi-four-hit" :x="x(p)-24" :y="y(p)-23" width="48" height="46" rx="7" fill="transparent" />
        <ellipse v-if="isJunqiCamp(p, 'four')" :cx="x(p)" :cy="y(p)" rx="20" ry="17" fill="#e5ead8" stroke="#9aa88a" stroke-width="1.5" />
        <rect v-else :x="x(p)-21" :y="y(p)-16" width="42" height="32" :rx="isJunqiHQ(p, 'four') ? 3 : 7" :fill="isJunqiHQ(p, 'four') ? '#e9dfbf' : '#f8f4e8'" stroke="#b9b99f" />
        <text v-if="!board[p]" :x="x(p)" :y="y(p)+4" text-anchor="middle" fill="#899274" font-size="11">{{ isJunqiCamp(p, 'four') ? '行营' : isJunqiHQ(p, 'four') ? '大本营' : '' }}</text>
        <JunqiToken v-if="board[p]" :piece="board[p]!" :x="x(p)" :y="y(p)" variant="four" :opacity="fadingSides?.includes(board[p]!.side) ? fade : undefined" :style="{ visibility: hidden(p) ? 'hidden' : undefined }" />
        <rect v-if="selected === p" :x="x(p)-24" :y="y(p)-21" width="48" height="42" rx="7" fill="none" stroke="#aa7f2a" stroke-width="3" />
        <circle v-if="targets.includes(p)" :cx="x(p)+17" :cy="y(p)-16" r="6" fill="#406d4c" stroke="#fffdf4" stroke-width="2" />
      </g>
      <JunqiMoveOverlay v-if="motion" :board="board" :side="side" variant="four" :motion="motion" />
      <JunqiMoveTrail v-if="last && !motion" :move="last" variant="four" :side="side" :playback="playback" />
    </svg>
  </div>
</template>

<style scoped>
.junqi-four-scroll { width: 100%; height: 100%; overflow: auto; border: 1px solid #c8ccb6; border-radius: 15px; background: #f4f0e1; }
.junqi-four-board { display: block; width: 100%; height: 100%; user-select: none; }
.is-zoomed .junqi-four-board { width: 200%; height: 200%; max-width: none; }
.junqi-four-point { color: #69765e; cursor: pointer; outline: none; }
.side-0 { color: #9b4237; }.side-1 { color: #356083; }.side-2 { color: #426442; }.side-3 { color: #795773; }
.target .junqi-four-hit { fill: #4d755722; }.junqi-four-point:focus-visible .junqi-four-hit { stroke: #31583e; stroke-width: 3; }
.junqi-four-point[aria-disabled=true] { cursor: default; }
</style>
