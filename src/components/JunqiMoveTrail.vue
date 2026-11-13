<script setup lang="ts">
import { computed } from 'vue'
import { junqiSideName, type JunqiBoard, type JunqiMove, type JunqiVariant } from '../../shared/junqi'
import { junqiPointPosition, junqiRouteGeometry } from '../../shared/junqiGeometry'
import type { BoardPlayback } from '../useBoardPlayback'
import JunqiToken from './JunqiToken.vue'

const props = defineProps<{ move: JunqiMove; variant: JunqiVariant; side: number | null; playback?: BoardPlayback<JunqiBoard, JunqiMove> | null }>()
const geometry = computed(() => junqiRouteGeometry(props.move.path, props.variant, props.side))
const start = computed(() => junqiPointPosition(props.move.from, props.variant, props.side))
const end = computed(() => junqiPointPosition(props.move.to, props.variant, props.side))
const color = computed(() => ['#a44835', '#356b92', '#477343', '#82527c'][props.move.side])
const size = computed(() => props.variant === 'four' ? 25 : 40)
const travel = computed(() => {
  const t = Math.max(0, Math.min(1, ((props.playback?.progress ?? 1) - .06) / .68))
  return geometry.value.at(t * t * (3 - 2 * t))
})
const arrow = computed(() => {
  const a = geometry.value.at(.88), b = geometry.value.at(.96)
  return `translate(${b.x} ${b.y}) rotate(${Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI})`
})
const attacker = computed(() => props.playback?.board[props.move.from])
const defender = computed(() => props.playback?.board[props.move.to])
const fade = computed(() => Math.max(0, 1 - Math.max(0, (props.playback?.progress ?? 0) - .76) / .24))
</script>

<template>
  <g class="junqi-move-trail" :data-move-ply="move.ply" :data-move-side="move.side" :style="{ color }" pointer-events="none" aria-hidden="true">
    <path class="junqi-last-route" :d="geometry.path" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="8 6" opacity=".65" />
    <path :transform="arrow" d="M-12-7L0 0L-12 7" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
    <rect class="junqi-move-origin" :x="start.x - size" :y="start.y - size * .65" :width="size * 2" :height="size * 1.3" rx="8" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="5 4" />
    <rect class="junqi-move-destination" :x="end.x - size" :y="end.y - size * .65" :width="size * 2" :height="size * 1.3" rx="8" fill="none" stroke="currentColor" stroke-width="3" />
    <g v-if="playback" class="junqi-live-motion" :data-progress="playback.progress">
      <JunqiToken v-if="defender" class="junqi-defending-token" :piece="defender" :x="end.x" :y="end.y" :variant="variant" :opacity="move.outcome === 'attacker' || move.outcome === 'both' ? fade : 1" />
      <JunqiToken v-if="attacker" class="junqi-moving-token" :piece="attacker" :x="travel.x" :y="travel.y" :variant="variant" :opacity="move.outcome === 'defender' || move.outcome === 'both' ? fade : 1" />
    </g>
    <g v-for="(point, index) in [start, end]" :key="index" :transform="`translate(${point.x} ${point.y - size * .65 - 9})`">
      <rect x="-11" y="-10" width="22" height="19" rx="5" fill="#fffbed" stroke="currentColor" />
      <text text-anchor="middle" y="4" fill="currentColor" font-size="13" font-family="sans-serif">{{ index === 0 ? '起' : '落' }}</text>
    </g>
    <title>{{ junqiSideName(move.side) }}第 {{ move.ply }} 步</title>
  </g>
</template>
