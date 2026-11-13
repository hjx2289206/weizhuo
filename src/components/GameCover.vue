<script setup lang="ts">
import ChessToken from './ChessToken.vue'
import XiangqiToken from './XiangqiToken.vue'
import { useId } from 'vue'
import type { GameKind } from '../../shared/protocol'

// Decorative printed cards, not a dealt hand or a preview of any player's cards.
defineProps<{ game: GameKind }>()
const artworkId = `collection-cover-${useId()}`
</script>

<template>
  <svg class="game-cover" :class="`game-cover--${game}`" viewBox="0 0 360 220" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient :id="`${artworkId}-paper`" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#fffef7" />
        <stop offset="1" stop-color="#eee9d8" />
      </linearGradient>
      <pattern :id="`${artworkId}-weave`" width="10" height="10" patternUnits="userSpaceOnUse">
        <rect width="10" height="10" fill="#234d3e" />
        <path d="M-5 5L5-5M0 10L10 0M5 15L15 5M-5 5L5 15M0 0L10 10M5-5L15 5" fill="none" stroke="#c1ad73" stroke-width=".45" opacity=".6" />
        <path d="M5 3L7 5L5 7L3 5Z" fill="#c1ad73" opacity=".55" />
      </pattern>
      <symbol :id="`${artworkId}-heart`" viewBox="0 0 100 100">
        <path d="M50 91C37 77 8 59 8 34C8 10 38 3 50 25C62 3 92 10 92 34C92 59 63 77 50 91Z" />
      </symbol>
      <symbol :id="`${artworkId}-spade`" viewBox="0 0 100 100">
        <path d="M50 7C39 22 8 40 8 62C8 83 36 91 47 70C46 83 41 90 32 94H68C59 90 54 83 53 70C64 91 92 83 92 62C92 40 61 22 50 7Z" />
      </symbol>
      <symbol :id="`${artworkId}-back`" viewBox="0 0 96 138">
        <rect x=".7" y=".7" width="94.6" height="136.6" rx="8" :fill="`url(#${artworkId}-paper)`" stroke="#bfc7b1" stroke-width="1.4" />
        <rect x="5" y="5" width="86" height="128" rx="4" :fill="`url(#${artworkId}-weave)`" />
        <rect x="10" y="10" width="76" height="118" rx="2" fill="none" stroke="#c7b77e" stroke-width=".7" />
        <path d="M15 26V15H27M69 15H81V27M15 111V123H27M69 123H81V111" fill="none" stroke="#c7b77e" stroke-width=".75" />
        <circle cx="48" cy="69" r="25" fill="#234d3e" stroke="#c7b77e" stroke-width=".8" />
        <circle cx="48" cy="69" r="21" fill="none" stroke="#c7b77e" stroke-width=".45" />
        <path d="M48 36L52 42L48 48L44 42ZM48 90L52 96L48 102L44 96Z" fill="#c7b77e" />
        <text x="48" y="77" text-anchor="middle" fill="#eadfbb" font-family="Songti SC, Noto Serif SC, serif" font-size="24">桌</text>
      </symbol>
      <symbol :id="`${artworkId}-heart-two`" viewBox="0 0 96 138">
        <rect x=".7" y=".7" width="94.6" height="136.6" rx="8" :fill="`url(#${artworkId}-paper)`" stroke="#c8cbb9" stroke-width="1.4" />
        <rect x="4" y="4" width="88" height="130" rx="5" fill="none" stroke="#e5dfcd" stroke-width=".6" />
        <g fill="#b64b40">
          <text x="10" y="27" font-family="Georgia, serif" font-weight="700" font-size="23">2</text>
          <use :href="`#${artworkId}-heart`" x="10" y="32" width="14" height="14" />
          <use :href="`#${artworkId}-heart`" x="34" y="39" width="28" height="28" />
          <use :href="`#${artworkId}-heart`" x="34" y="77" width="28" height="28" transform="rotate(180 48 91)" />
          <g transform="rotate(180 48 69)">
            <text x="10" y="27" font-family="Georgia, serif" font-weight="700" font-size="23">2</text>
            <use :href="`#${artworkId}-heart`" x="10" y="32" width="14" height="14" />
          </g>
        </g>
      </symbol>
    </defs>

    <ellipse cx="185" cy="187" rx="130" ry="14" fill="#254a37" opacity=".065" />
    <g v-if="game === 'go' || game === 'gomoku'" transform="translate(94 14) rotate(-7 88 88)">
      <rect width="176" height="176" rx="9" fill="#ead2a0" stroke="#baa16f" />
      <path v-for="i in 9" :key="i" :d="`M16 ${16+(i-1)*18}H160M${16+(i-1)*18} 16V160`" fill="none" stroke="#aa9060" stroke-width=".7" />
      <circle cx="88" cy="88" r="2" fill="#937e52" />
      <template v-if="game === 'go'"><g v-for="(point,i) in [20,21,22,29,40,41,49,50,58,59]" :key="point"><ellipse :cx="16+(point%9)*18+1" :cy="18+Math.floor(point/9)*18" rx="8" ry="7" fill="#28412b30" /><circle :cx="16+(point%9)*18" :cy="16+Math.floor(point/9)*18" r="8" :fill="i < 4 ? '#2c3d2e' : '#fff9e7'" stroke="#9b9e83" stroke-width=".5" /></g></template>
      <template v-else><circle v-for="point in [21,30,39,48,57]" :key="point" :cx="16+(point%9)*18" :cy="16+Math.floor(point/9)*18" r="8" fill="#2c3d2e" /><circle v-for="point in [22,31,41,50]" :key="point" :cx="16+(point%9)*18" :cy="16+Math.floor(point/9)*18" r="8" fill="#fff9e7" stroke="#b5b49b" stroke-width=".6" /><path d="M70 52V124" fill="none" stroke="#c29a50" stroke-width="1.5" /></template>
    </g>
    <path d="M34 155C45 168 56 173 73 174M294 160C309 158 320 149 326 136" fill="none" stroke="#a6b295" stroke-width="1" stroke-linecap="round" />
    <path d="M37 153L33 159M324 133L329 138" fill="none" stroke="#a6b295" stroke-width="1" stroke-linecap="round" />

    <template v-if="game === 'doudizhu'">
      <use :href="`#${artworkId}-back`" x="0" y="0" width="96" height="138" transform="translate(83 43) rotate(-19 48 69)" />
      <g transform="translate(135 22) rotate(-2 48 69)">
        <rect x="2" y="4" width="95" height="137" rx="8" fill="#173d2f" opacity=".08" />
        <rect x=".7" y=".7" width="94.6" height="136.6" rx="8" :fill="`url(#${artworkId}-paper)`" stroke="#c8cbb9" stroke-width="1.4" />
        <rect x="4" y="4" width="88" height="130" rx="5" fill="none" stroke="#e5dfcd" stroke-width=".6" />
        <g fill="#25483a">
          <text x="10" y="27" font-family="Georgia, serif" font-weight="700" font-size="23">A</text>
          <use :href="`#${artworkId}-spade`" x="10" y="33" width="14" height="14" />
          <use :href="`#${artworkId}-spade`" x="27" y="48" width="42" height="42" />
          <g transform="rotate(180 48 69)">
            <text x="10" y="27" font-family="Georgia, serif" font-weight="700" font-size="23">A</text>
            <use :href="`#${artworkId}-spade`" x="10" y="33" width="14" height="14" />
          </g>
        </g>
      </g>
      <use :href="`#${artworkId}-heart-two`" x="0" y="0" width="96" height="138" transform="translate(186 51) rotate(18 48 69)" />
      <g transform="translate(289 45)">
        <circle r="22" fill="#f4efdc" stroke="#bbaa76" stroke-width=".8" />
        <circle r="18" fill="none" stroke="#d8cda9" stroke-width=".5" />
        <text y="2" text-anchor="middle" fill="#7d7754" font-family="Georgia, serif" font-size="21">3</text>
        <text y="12" text-anchor="middle" fill="#909477" font-size="7" letter-spacing="1">人围桌</text>
      </g>
    </template>

    <template v-else-if="game === 'guandan'">
      <use :href="`#${artworkId}-back`" x="0" y="0" width="96" height="138" transform="translate(64 49) rotate(-24 48 69)" />
      <use :href="`#${artworkId}-back`" x="0" y="0" width="96" height="138" transform="translate(111 28) rotate(-10 48 69)" />
      <use :href="`#${artworkId}-heart-two`" x="0" y="0" width="96" height="138" transform="translate(157 27) rotate(7 48 69)" />
      <use :href="`#${artworkId}-heart-two`" x="0" y="0" width="96" height="138" transform="translate(198 52) rotate(23 48 69)" />
      <g transform="translate(294 38)">
        <path d="M-14-4L14 18M14-4L-14 18" fill="none" stroke="#adb995" stroke-width=".8" stroke-dasharray="2 3" />
        <circle cx="-14" cy="-4" r="7" fill="#31583e" stroke="#f0ecd9" stroke-width="1.5" />
        <circle cx="14" cy="18" r="7" fill="#31583e" stroke="#f0ecd9" stroke-width="1.5" />
        <circle cx="14" cy="-4" r="7" fill="#b49b60" stroke="#f0ecd9" stroke-width="1.5" />
        <circle cx="-14" cy="18" r="7" fill="#b49b60" stroke="#f0ecd9" stroke-width="1.5" />
        <text x="0" y="39" text-anchor="middle" fill="#7d8b6d" font-size="8" letter-spacing="1">两副牌 · 两对搭档</text>
      </g>
    </template>
    <g v-if="game === 'chess'" transform="translate(86 15) rotate(-8 90 95)">
      <rect x="-7" y="-7" width="194" height="194" rx="9" fill="#d1bd92" stroke="#af9c76" />
      <rect v-for="p in 16" :key="p" :x="((p-1)%4)*45" :y="Math.floor((p-1)/4)*45" width="45" height="45" :fill="(Math.floor((p-1)/4)+(p-1)%4)%2 ? '#78927a' : '#eee4c9'" />
      <g transform="translate(55 65) scale(1.55)"><ChessToken :piece="{id:'cover-white',side:0,rank:'n'}" /></g>
      <g transform="translate(123 125) scale(1.55)"><ChessToken :piece="{id:'cover-black',side:1,rank:'k'}" /></g>
    </g>
    <g v-if="game === 'xiangqi'">
      <g transform="translate(64 12) rotate(-6 115 85)">
        <rect width="232" height="180" rx="10" fill="#e4cc9c" stroke="#baa471" />
        <rect x="9" y="9" width="214" height="162" rx="4" fill="#efdbb1" stroke="#c1a873" />
        <path d="M20 20H212M20 36H212M20 52H212M20 68H212M20 84H212M20 104H212M20 120H212M20 136H212M20 152H212M20 168H212M20 20V168M212 20V168M44 20V84M68 20V84M92 20V84M116 20V84M140 20V84M164 20V84M188 20V84M44 104V168M68 104V168M92 104V168M116 104V168M140 104V168M164 104V168M188 104V168M92 20L140 52M140 20L92 52M92 136L140 168M140 136L92 168" fill="none" stroke="#aa8e5c" stroke-width=".8" />
        <text x="57" y="99" fill="#977a4b" font-size="12" font-family="Songti SC,serif">楚 河</text><text x="145" y="99" fill="#977a4b" font-size="12" font-family="Songti SC,serif">汉 界</text>
      </g>
      <g transform="translate(120 141) rotate(-9) scale(1.35)"><XiangqiToken :x="0" :y="0" :piece="{ id: 'cover-red', rank: 'general', side: 0 }" /></g>
      <g transform="translate(245 96) rotate(10) scale(1.2)"><XiangqiToken :x="0" :y="0" :piece="{ id: 'cover-black', rank: 'general', side: 1 }" /></g>
    </g>
    <g v-if="game === 'junqi'">
      <g transform="translate(71 24) rotate(-7 100 80)">
        <rect width="218" height="150" rx="12" fill="#ebe5d0" stroke="#bbb69a" />
        <path d="M23 28H195M23 60H195M23 92H195M23 124H195M23 28V124M66 28V124M109 28V124M152 28V124M195 28V124" fill="none" stroke="#a6b092" />
        <path d="M23 60H195M23 124H195M23 60V124M195 60V124" fill="none" stroke="#647c60" stroke-width="4" />
        <path d="M23 60H195M23 124H195M23 60V124M195 60V124" fill="none" stroke="#eee8d6" stroke-width="1.5" stroke-dasharray="3 4" />
        <circle cx="66" cy="92" r="11" fill="#e0e5cd" stroke="#8d9d7c" /><circle cx="152" cy="92" r="11" fill="#e0e5cd" stroke="#8d9d7c" />
      </g>
      <g transform="translate(103 111) rotate(-12)"><rect y="4" width="88" height="49" rx="6" fill="#244b3c20" /><rect width="88" height="49" rx="6" fill="#f4e2cc" stroke="#b17c60" /><rect x="5" y="5" width="78" height="39" rx="3" fill="none" stroke="#c99b7d" /><text x="44" y="33" text-anchor="middle" fill="#9e4437" font-size="25" font-family="Songti SC, serif">司令</text></g>
      <g transform="translate(205 82) rotate(12)"><rect y="4" width="88" height="49" rx="6" fill="#244b3c20" /><rect width="88" height="49" rx="6" fill="#e5ecee" stroke="#7a929b" /><rect x="5" y="5" width="78" height="39" rx="3" fill="none" stroke="#a3b4b8" /><text x="44" y="33" text-anchor="middle" fill="#3c6079" font-size="25" font-family="Songti SC, serif">军旗</text></g>
    </g>
  </svg>
</template>
