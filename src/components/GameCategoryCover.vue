<script setup lang="ts">
import { useId } from 'vue'
import ChessToken from './ChessToken.vue'
import XiangqiToken from './XiangqiToken.vue'

defineProps<{ category: 'board' | 'cards' }>()
const artworkId = `category-cover-${useId()}`
</script>

<template>
  <svg class="category-cover" viewBox="0 0 480 300" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <defs>
      <pattern :id="`${artworkId}-squares`" width="84" height="84" patternUnits="userSpaceOnUse">
        <rect width="84" height="84" fill="#eee4ca" />
        <path d="M0 0H42V42H0ZM42 42H84V84H42Z" fill="#7f9679" />
      </pattern>
      <pattern :id="`${artworkId}-weave`" width="12" height="12" patternUnits="userSpaceOnUse">
        <rect width="12" height="12" fill="#315b48" />
        <path d="M0 6L6 0L12 6L6 12Z" fill="none" stroke="#c0ae76" stroke-width=".6" />
      </pattern>
      <symbol :id="`${artworkId}-spade`" viewBox="0 0 100 100">
        <path d="M50 7C39 22 8 40 8 62C8 83 36 91 47 70C46 83 41 90 32 94H68C59 90 54 83 53 70C64 91 92 83 92 62C92 40 61 22 50 7Z" />
      </symbol>
      <symbol :id="`${artworkId}-heart`" viewBox="0 0 100 100">
        <path d="M50 91C37 77 8 59 8 34C8 10 38 3 50 25C62 3 92 10 92 34C92 59 63 77 50 91Z" />
      </symbol>
    </defs>
    <ellipse cx="240" cy="257" rx="161" ry="17" fill="#31533d" opacity=".07" />
    <path d="M57 200L65 192M414 86L422 78M73 91H85M79 85V97" fill="none" stroke="#a5ad86" stroke-width="1.4" stroke-linecap="round" />
    <circle cx="403" cy="225" r="4" fill="none" stroke="#b6b48e" />
    <template v-if="category === 'board'">
      <g transform="rotate(-9 240 150)">
        <rect x="99" y="44" width="278" height="194" rx="12" fill="#d3be92" stroke="#b39c70" stroke-width="1.5" />
        <rect x="112" y="57" width="252" height="168" :fill="`url(#${artworkId}-squares)`" />
        <rect x="112" y="57" width="252" height="168" fill="none" stroke="#a7956c" />
      </g>
      <g transform="translate(287 135) scale(3.4)"><ChessToken :piece="{ id: 'category-knight', side: 0, rank: 'n' }" /></g>
      <g transform="translate(146 214) rotate(-12) scale(2)"><XiangqiToken :x="0" :y="0" :piece="{ id: 'category-general', side: 0, rank: 'general' }" /></g>
      <g transform="translate(352 213) scale(1.7)"><ChessToken :piece="{ id: 'category-rook', side: 1, rank: 'r' }" /></g>
    </template>
    <template v-else>
      <g transform="translate(114 65) rotate(-22 57 82)">
        <rect x="2" y="5" width="114" height="164" rx="10" fill="#2b4a3520" />
        <rect width="114" height="164" rx="10" fill="#faf7e9" stroke="#c3bea2" stroke-width="1.5" />
        <rect x="6" y="6" width="102" height="152" rx="6" :fill="`url(#${artworkId}-weave)`" />
        <rect x="13" y="13" width="88" height="138" rx="3" fill="none" stroke="#cebb83" stroke-width=".8" />
        <path d="M57 56L79 82L57 108L35 82Z" fill="none" stroke="#cebb83" stroke-width="1.3" />
        <path d="M57 67L69 82L57 97L45 82Z" fill="#cebb83" />
      </g>
      <g transform="translate(185 36) rotate(-3 57 82)">
        <rect x="2" y="5" width="114" height="164" rx="10" fill="#2b4a3515" />
        <rect width="114" height="164" rx="10" fill="#fffdf2" stroke="#c7c5ad" stroke-width="1.5" />
        <rect x="5" y="5" width="104" height="154" rx="6" fill="none" stroke="#e5dfc9" />
        <g fill="#2b503e">
          <text x="12" y="33" font-family="Georgia,serif" font-size="29">A</text>
          <use :href="`#${artworkId}-spade`" x="12" y="39" width="17" height="17" />
          <use :href="`#${artworkId}-spade`" x="33" y="58" width="48" height="48" />
          <g transform="rotate(180 57 82)"><text x="12" y="33" font-family="Georgia,serif" font-size="29">A</text><use :href="`#${artworkId}-spade`" x="12" y="39" width="17" height="17" /></g>
        </g>
      </g>
      <g transform="translate(253 74) rotate(19 57 82)">
        <rect x="2" y="5" width="114" height="164" rx="10" fill="#2b4a3515" />
        <rect width="114" height="164" rx="10" fill="#fffdf2" stroke="#c7c5ad" stroke-width="1.5" />
        <rect x="5" y="5" width="104" height="154" rx="6" fill="none" stroke="#e5dfc9" />
        <g fill="#b44e3f">
          <text x="12" y="33" font-family="Georgia,serif" font-size="29">A</text>
          <use :href="`#${artworkId}-heart`" x="12" y="39" width="17" height="17" />
          <use :href="`#${artworkId}-heart`" x="33" y="58" width="48" height="48" />
          <g transform="rotate(180 57 82)"><text x="12" y="33" font-family="Georgia,serif" font-size="29">A</text><use :href="`#${artworkId}-heart`" x="12" y="39" width="17" height="17" /></g>
        </g>
      </g>
    </template>
  </svg>
</template>
