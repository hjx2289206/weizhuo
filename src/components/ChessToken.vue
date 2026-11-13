<script setup lang="ts">
import type { ChessPiece } from '../../shared/chess'
defineProps<{ piece: ChessPiece; x?: number; y?: number; facingAway?: boolean; checked?: boolean; opacity?: number }>()
</script>
<template>
  <g class="chess-token" :data-piece-id="piece.id" :data-rank="piece.rank" :data-side="piece.side" :data-facing="facingAway ? 'away' : 'down'" :opacity="opacity ?? 1" :transform="`translate(${x ?? 0} ${y ?? 0}) rotate(${facingAway ? 180 : 0})`" pointer-events="none">
    <circle v-if="checked" r="26" fill="#b9654850" stroke="#b15b45" stroke-width="2" />
    <ellipse cy="21" rx="19" ry="4" fill="#193b3026" />
    <g transform="translate(-25 -27) scale(.5)" :fill="piece.side === 0 ? '#fff5d9' : '#294d40'" :stroke="piece.side === 0 ? '#65583d' : '#d0dbbe'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <template v-if="piece.rank === 'p'"><circle cx="50" cy="24" r="13" /><path d="M42 38Q39 51 35 60L29 72H71L65 60Q61 51 58 38Z" /><path d="M30 72L25 83H75L70 72Z" /></template>
      <template v-else-if="piece.rank === 'r'"><path d="M25 14H36V24H44V14H56V24H64V14H75V38L66 44V69L73 77V84H27V77L34 69V44L25 38Z" /><path d="M34 44H66M34 68H66M28 77H72" fill="none" /></template>
      <template v-else-if="piece.rank === 'n'"><path d="M28 79Q31 58 53 48L45 39L36 49L23 44L26 34L43 15L43 8L55 14Q77 18 76 40Q74 59 71 71L77 83H24Z" /><path d="M53 23L42 33M60 32Q63 43 49 55M28 76H73" fill="none" /><circle cx="48" cy="26" r="2.4" :fill="piece.side === 0 ? '#65583d' : '#d0dbbe'" stroke="none" /></template>
      <template v-else-if="piece.rank === 'b'"><path d="M50 10Q23 30 34 43L43 51L38 66L29 75H71L62 66L57 51L66 43Q77 30 50 10Z" /><path d="M51 21L43 34M39 52H61M31 75L26 84H74L69 75Z" /><circle cx="50" cy="8" r="4" /></template>
      <template v-else-if="piece.rank === 'q'"><path d="M28 27L38 43L50 23L62 43L73 27L66 57H34Z" /><path d="M34 57H66L62 66L72 78V84H28V78L38 66Z" /><path d="M38 66H62M30 77H70" fill="none" /><circle cx="25" cy="23" r="5" /><circle cx="50" cy="18" r="5" /><circle cx="76" cy="23" r="5" /></template>
      <template v-else><path d="M46 8H54V16H62V24H54V33H46V24H38V16H46Z" /><path d="M50 33Q25 27 28 43L37 59H63L72 43Q75 27 50 33Z" /><path d="M37 59H63L61 68L71 78V84H29V78L39 68Z" /><path d="M39 68H61M30 78H70" fill="none" /></template>
    </g>
  </g>
</template>
