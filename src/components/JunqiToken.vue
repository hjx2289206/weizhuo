<script setup lang="ts">
import { computed } from 'vue'
import { JUNQI_NAMES, type JunqiPiece, type JunqiVariant } from '../../shared/junqi'
const props = defineProps<{ piece: JunqiPiece; x: number; y: number; variant: JunqiVariant }>()
const four = computed(() => props.variant === 'four')
const colors = computed(() => [
  ['#9b4237', '#f3e3d2', '#b5806a'],
  ['#356083', four.value ? '#e2ecf1' : '#e7edf0', '#718da0'],
  ['#426442', '#e3ebd7', '#839c6c'], ['#795773', '#eee2ec', '#a386a0'],
][props.piece.side]!)
</script>
<template>
  <g class="junqi-token" :data-token-side="piece.side" :data-token-rank="piece.rank ?? 'hidden'" :transform="`translate(${x} ${y})`" :style="{ color: colors[0] }">
    <rect v-if="!four" class="junqi-piece-shadow" x="-34" y="-17" width="68" height="38" rx="6" fill="#253d3020" />
    <rect :class="four ? 'junqi-four-piece' : 'junqi-piece'" :x="four ? -22 : -34" :y="four ? -17 : -20" :width="four ? 44 : 68" :height="four ? 34 : 38" :rx="four ? 5 : 6" :fill="colors[1]" :stroke="colors[2]" stroke-width="1.5" />
    <rect class="junqi-piece-inset" :x="four ? -19 : -30" :y="four ? -14 : -16" :width="four ? 38 : 60" :height="four ? 28 : 30" rx="3" fill="none" stroke="currentColor" :opacity="four ? .25 : .28" />
    <text x="0" :y="four ? 6 : 5" text-anchor="middle" :font-size="four ? 18 : 19" font-weight="600" font-family="Songti SC, Noto Serif SC, serif" fill="currentColor">{{ piece.rank ? JUNQI_NAMES[piece.rank] : '暗' }}</text>
  </g>
</template>
