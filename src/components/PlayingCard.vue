<script lang="ts">
// Immutable artwork is shared by every card instance, rather than rebuilt on each deal.
const RANK_LABELS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小', 17: '大' }
const SUIT_GLYPHS: Record<string, string> = { spade: '♠', heart: '♥', club: '♣', diamond: '♦', joker: '✦' }
const SUIT_PATHS: Record<string, string> = {
  heart: 'M50 91C37 77 8 59 8 34C8 10 38 3 50 25C62 3 92 10 92 34C92 59 63 77 50 91Z',
  spade: 'M50 7C39 22 8 40 8 62C8 83 36 91 47 70C46 83 41 90 32 94H68C59 90 54 83 53 70C64 91 92 83 92 62C92 40 61 22 50 7Z',
  diamond: 'M50 5L88 50L50 95L12 50Z',
  club: 'M50 7C27 7 23 34 38 43C14 32 1 54 13 72C22 86 42 81 47 69C46 82 41 90 32 94H68C59 90 54 82 53 69C58 81 78 86 87 72C99 54 86 32 62 43C77 34 73 7 50 7Z',
}
type PipArtwork = Readonly<{ transform: string }>
function pip(x: number, y: number, size = 16, inverted = false): PipArtwork {
  return { transform: `translate(${x} ${y}) rotate(${inverted ? 180 : 0}) scale(${size / 100}) translate(-50 -50)` }
}
const PIP_LAYOUTS: Record<number, readonly PipArtwork[]> = {
  1: [pip(50, 72, 34)],
  2: [pip(50, 48, 20), pip(50, 96, 20, true)],
  3: [pip(50, 46, 18), pip(50, 72, 18), pip(50, 98, 18, true)],
  4: [pip(36, 48), pip(64, 48), pip(36, 96, 16, true), pip(64, 96, 16, true)],
  5: [pip(36, 48), pip(64, 48), pip(50, 72, 18), pip(36, 96, 16, true), pip(64, 96, 16, true)],
  6: [pip(36, 48), pip(64, 48), pip(36, 72), pip(64, 72), pip(36, 96, 16, true), pip(64, 96, 16, true)],
  7: [pip(36, 48), pip(64, 48), pip(50, 60, 12), pip(36, 72), pip(64, 72), pip(36, 96, 16, true), pip(64, 96, 16, true)],
  8: [pip(36, 48), pip(64, 48), pip(50, 60, 12), pip(36, 72), pip(64, 72), pip(50, 84, 12, true), pip(36, 96, 16, true), pip(64, 96, 16, true)],
  9: [pip(36, 46, 14), pip(64, 46, 14), pip(36, 64, 14), pip(64, 64, 14), pip(50, 72, 13), pip(36, 80, 14, true), pip(64, 80, 14, true), pip(36, 98, 14, true), pip(64, 98, 14, true)],
  10: [pip(36, 46, 14), pip(64, 46, 14), pip(50, 55, 12), pip(36, 64, 14), pip(64, 64, 14), pip(36, 80, 14, true), pip(64, 80, 14, true), pip(50, 89, 12, true), pip(36, 98, 14, true), pip(64, 98, 14, true)],
}
const NO_PIPS: readonly PipArtwork[] = []
</script>

<script setup lang="ts">
import { computed, useId } from 'vue'
import type { Card } from '../../shared/protocol'
import { cardCornerLayout } from '../cardCornerLayout'

const props = defineProps<{ card?: Card; back?: boolean; small?: boolean; narrowCorner?: boolean }>()
const corner = computed(() => cardCornerLayout(Boolean(props.narrowCorner)))
const patternId = `weave-${useId()}`
const rank = computed(() => props.card ? RANK_LABELS[props.card.rank] ?? String(props.card.rank) : '')
const red = computed(() => Boolean(props.card && (props.card.suit === 'heart' || props.card.suit === 'diamond' || props.card.rank === 17)))
const ink = computed(() => red.value ? '#b8463d' : '#203e36')
const symbol = computed(() => props.card ? SUIT_GLYPHS[props.card.suit] : '')
const suitPath = computed(() => props.card ? SUIT_PATHS[props.card.suit] ?? '' : '')
const pips = computed(() => {
  const value = props.card?.rank
  return value === undefined ? NO_PIPS : PIP_LAYOUTS[value === 14 ? 1 : value === 15 ? 2 : value] ?? NO_PIPS
})
const court = computed(() => {
  const value = props.card?.rank
  return value !== undefined && value >= 11 && value <= 13
})
</script>

<template>
  <svg class="playing-card" :class="{ 'card-back': back, 'card-small': small }" viewBox="0 0 100 144" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x=".65" y=".65" width="98.7" height="142.7" rx="7.5" fill="#fffdf6" stroke="#cbd2c2" stroke-width="1.3" />
    <rect x="2.7" y="2.7" width="94.6" height="138.6" rx="5.6" fill="none" stroke="#e9e7dc" stroke-width=".5" />
    <template v-if="back">
      <defs>
        <pattern :id="patternId" width="12" height="12" patternUnits="userSpaceOnUse">
          <rect width="12" height="12" fill="#214d42" />
          <path d="M-6 6L6-6M0 12L12 0M6 18L18 6M-6 6L6 18M0 0L12 12M6-6L18 6" fill="none" stroke="#bfad75" stroke-width=".45" opacity=".55" />
          <path d="M6 4L8 6L6 8L4 6Z" fill="#bfad75" opacity=".65" />
        </pattern>
      </defs>
      <rect x="5" y="5" width="90" height="134" rx="4" :fill="`url(#${patternId})`" />
      <rect x="10" y="10" width="80" height="124" rx="2" fill="none" stroke="#c6b47c" stroke-width=".7" />
      <path d="M14 28V14H28M72 14H86V28M14 116V130H28M72 130H86V116" fill="none" stroke="#c6b47c" stroke-width=".8" />
      <circle cx="50" cy="72" r="27" fill="#214d42" stroke="#c6b47c" stroke-width=".85" />
      <circle cx="50" cy="72" r="23" fill="none" stroke="#c6b47c" stroke-width=".45" />
      <path d="M50 39L54 45L50 51L46 45ZM50 93L54 99L50 105L46 99Z" fill="#c6b47c" />
      <text x="50" y="80" text-anchor="middle" fill="#e6d8ad" font-size="24" font-family="Songti SC, serif">桌</text>
    </template>
    <g v-else-if="card" :fill="ink">
      <text data-card-corner="top-rank" :x="corner.rank.x" :y="corner.rank.y" :font-family="corner.rank.family" :font-size="corner.rank.size" font-weight="700" :textLength="corner.rank.width" lengthAdjust="spacingAndGlyphs">{{ rank }}</text>
      <text data-card-corner="top-suit" :x="corner.suit.x" :y="corner.suit.y" font-family="Arial, sans-serif" :font-size="corner.suit.size">{{ symbol }}</text>

      <g v-if="card.suit === 'joker'">
        <circle cx="50" cy="73" r="24" fill="none" stroke="#c5b580" stroke-width=".7" />
        <path d="M31 58C25 39 38 37 43 52C43 29 56 29 57 52C64 36 77 41 69 59L61 65H39Z" :fill="ink" />
        <path d="M43 52C44 39 48 34 51 34C54 37 56 43 57 52L50 62Z" fill="#c3ad6d" />
        <circle cx="30" cy="43" r="2.3" fill="#c3ad6d" />
        <circle cx="51" cy="33" r="2.3" fill="#c3ad6d" />
        <circle cx="71" cy="44" r="2.3" fill="#c3ad6d" />
        <path d="M39 58Q50 54 61 58V70Q60 81 50 83Q40 81 39 70Z" fill="#fffdf6" :stroke="ink" stroke-width="1" />
        <path d="M43 65Q46 62 48 65M53 65Q56 62 58 65M44 74Q50 79 56 73" fill="none" :stroke="ink" stroke-width="1.1" stroke-linecap="round" />
        <path d="M50 67L48 71H52Z" fill="#c3ad6d" />
        <path d="M38 78L44 87L50 81L56 87L63 78L66 91L58 89L50 96L42 89L34 91Z" :fill="ink" />
        <circle cx="35" cy="91" r="1.8" fill="#c3ad6d" />
        <circle cx="50" cy="96" r="1.8" fill="#c3ad6d" />
        <circle cx="65" cy="91" r="1.8" fill="#c3ad6d" />
        <text x="50" y="108" text-anchor="middle" font-family="Georgia, serif" font-size="7" letter-spacing="1.7">JOKER</text>
      </g>

      <g v-else-if="court">
        <rect x="29" y="32" width="42" height="80" rx="2" fill="#f3efdf" :stroke="ink" stroke-width=".65" />
        <path d="M31 36L50 45L69 36M31 108L50 99L69 108" fill="none" stroke="#bfaa70" stroke-width=".7" />
        <g v-for="inverted in [false, true]" :key="String(inverted)" :transform="inverted ? 'rotate(180 50 72)' : undefined">
          <path d="M33 72V64Q39 57 45 56H55Q61 57 67 64V72Z" :fill="ink" />
          <path d="M39 59L50 70L61 59L58 72H42Z" fill="#c1ab70" />
          <path d="M45 55L50 60L55 55L57 59L50 65L43 59Z" fill="#fffdf6" :stroke="ink" stroke-width=".55" />
          <path d="M41 44Q40 36 50 36Q60 36 59 44L59 51L54 57H46L41 51Z" :fill="ink" />
          <path d="M44 42H56V50Q55 56 50 57Q45 56 44 50Z" fill="#fffdf6" :stroke="ink" stroke-width=".6" />
          <path d="M46 46H48M52 46H54M50 47L49 50H51M47 53Q50 54 53 53" fill="none" :stroke="ink" stroke-width=".65" stroke-linecap="round" />
          <template v-if="card.rank === 13">
            <path d="M40 41L38 33L45 36L50 29L55 36L62 33L60 41Z" fill="#c1ab70" :stroke="ink" stroke-width=".6" />
            <path d="M43 41H57M48 52L50 55L52 52M47 55L50 59L53 55" fill="none" :stroke="ink" stroke-width=".75" />
            <path d="M64 69V48M62 49L64 44L66 49ZM61 57H67" fill="none" stroke="#c1ab70" stroke-width="1.1" />
          </template>
          <template v-else-if="card.rank === 12">
            <path d="M42 41L41 35L46 37L50 31L54 37L59 35L58 41Z" fill="#c1ab70" :stroke="ink" stroke-width=".55" />
            <path d="M41 43Q36 51 42 58M59 43Q64 51 58 58" fill="none" :stroke="ink" stroke-width="2.1" />
            <path d="M36 69V53M36 59L32 56M36 64L40 61" fill="none" stroke="#c1ab70" stroke-width=".8" />
            <path d="M36 48L39 52L36 56L33 52Z" fill="#fffdf6" stroke="#c1ab70" stroke-width=".7" />
          </template>
          <template v-else>
            <path d="M39 41Q36 34 48 33Q60 31 62 40L57 43L43 42Z" :fill="ink" />
            <path d="M57 38Q58 29 65 30Q66 35 57 40" fill="#c1ab70" />
            <path d="M64 69V49L62 52M62 59H67" fill="none" stroke="#c1ab70" stroke-width="1.1" />
          </template>
          <path :d="suitPath" transform="translate(46 62) scale(.08)" fill="#fffdf6" />
          <path d="M34 65L39 70M34 69L37 72M66 65L61 70M66 69L63 72" fill="none" stroke="#c1ab70" stroke-width=".7" />
        </g>
        <path d="M30 72H70" fill="none" stroke="#bfaa70" stroke-width=".6" />
      </g>

      <g v-else>
        <g v-for="(point, index) in pips" :key="index" :transform="point.transform">
          <path :d="suitPath" />
        </g>
        <path v-if="card.rank === 14" d="M44 96H56M47 99H53" fill="none" stroke="#c5b580" stroke-width=".7" />
      </g>

      <g transform="rotate(180 50 72)">
        <text data-card-corner="bottom-rank" :x="corner.rank.x" :y="corner.rank.y" :font-family="corner.rank.family" :font-size="corner.rank.size" font-weight="700" :textLength="corner.rank.width" lengthAdjust="spacingAndGlyphs">{{ rank }}</text>
        <text data-card-corner="bottom-suit" :x="corner.suit.x" :y="corner.suit.y" font-family="Arial, sans-serif" :font-size="corner.suit.size">{{ symbol }}</text>
      </g>
    </g>
  </svg>
</template>
