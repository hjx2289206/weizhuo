<script setup lang="ts">
import { computed } from 'vue'
import type { JunqiBoard, JunqiVariant } from '../../shared/junqi'
import { junqiPointPosition, junqiRouteGeometry } from '../../shared/junqiGeometry'
import type { ChessMotion } from '../tutorials/chessMotion'
import { clamp } from '../tutorials/chessMotion'
import JunqiToken from './JunqiToken.vue'
const props = defineProps<{ board: JunqiBoard; side: number | null; variant: JunqiVariant; motion: ChessMotion }>()
const geometry = computed(() => junqiRouteGeometry(props.motion.path, props.variant, props.side))
const active = computed(() => props.motion.phase >= .14 && props.motion.phase < .84)
const piece = computed(() => props.board[props.motion.from])
const defender = computed(() => props.board[props.motion.to])
const position = computed(() => {
  const p = props.motion.phase
  const travel = props.motion.rejected ? p < .5 ? clamp((p - .2) / .3) * .32 : (1 - clamp((p - .5) / .25)) * .32 : clamp((p - .2) / .46)
  const point = geometry.value.at(travel)
  return { x: point.x + (props.motion.rejected && p > .4 && p < .65 ? Math.sin(p * 100) * 3 : 0), y: point.y }
})
const target = computed(() => junqiPointPosition(props.motion.to, props.variant, props.side))
const opacity = computed(() => !props.motion.rejected && props.motion.combat && props.motion.combat.outcome !== 'attacker' ? 1 - clamp((props.motion.phase - .7) / .13) : 1)
</script>
<template>
  <g class="teaching-svg-motion" aria-hidden="true" pointer-events="none">
    <path class="teaching-route" :d="geometry.path" fill="none" :stroke="motion.rejected ? '#ad5544' : '#bb9340'" stroke-width="4" stroke-dasharray="7 5" opacity=".9" />
    <g v-if="active && piece" class="teaching-moving-piece" :opacity="opacity"><JunqiToken :piece="piece" :x="position.x" :y="position.y" :variant="variant" /></g>
    <g v-if="motion.combat && defender && motion.phase > .66 && motion.phase < .84" class="teaching-defender" :opacity="motion.combat.outcome === 'defender' ? 1 : 1 - clamp((motion.phase - .7) / .13)"><JunqiToken :piece="{ ...defender, rank: motion.combat.defender }" :x="target.x" :y="target.y" :variant="variant" /></g>
    <g v-if="motion.rejected && motion.phase > .35" class="teaching-prohibition" :transform="`translate(${target.x} ${target.y - 30})`"><circle r="15" fill="#fcf1e7" stroke="#ad5544" stroke-width="2" /><path d="M-5-5L5 5M5-5L-5 5" stroke="#ad5544" stroke-width="2.5" stroke-linecap="round" /></g>
  </g>
</template>
