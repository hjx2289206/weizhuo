<script setup lang="ts">
import { xiangqiName, type XiangqiPiece } from '../../shared/xiangqi'
defineProps<{ piece: XiangqiPiece; x: number; y: number; checked?: boolean; facingAway?: boolean }>()
</script>
<template>
  <g class="xiangqi-token" :class="{ 'is-red': piece.side === 0, 'is-checked': checked }" :transform="`translate(${x} ${y})`" :data-piece-id="piece.id" :data-piece-side="piece.side" :data-piece-rank="piece.rank" :data-piece-facing="facingAway ? 'away' : 'near'">
    <ellipse cx="0" cy="3" rx="23" ry="22" fill="#4d311829" />
    <circle r="23" fill="#edd4a6" stroke="#b18a54" stroke-width="1.3" />
    <circle cy="-1.5" r="21.7" fill="#f8e7bd" stroke="#d8b67c" stroke-width="1" />
    <circle cy="-1.5" r="17.8" fill="none" :stroke="piece.side === 0 ? '#a24a36' : '#3d493d'" stroke-width=".9" />
    <path d="M-14-16Q0-24 14-16" fill="none" stroke="#fff9df" stroke-width="1.2" opacity=".8" />
    <text :transform="facingAway ? 'rotate(180 0 -1.5)' : undefined" x="0" y="7" text-anchor="middle" font-size="25" font-weight="600" font-family="Songti SC, Noto Serif SC, serif" :fill="piece.side === 0 ? '#a33c2d' : '#2e3730'">{{ xiangqiName(piece) }}</text>
    <circle v-if="checked" r="26" fill="none" stroke="#b64232" stroke-width="2" stroke-dasharray="4 3" />
  </g>
</template>
