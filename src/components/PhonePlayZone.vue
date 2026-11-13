<script setup lang="ts">
import type { Card } from '../../shared/protocol';
import type { PhonePlayLayout, PhonePlayPosition } from '../phonePlayLayout';
import PlayingCard from './PlayingCard.vue';
import PassMark from './PassMark.vue';
defineProps<{ cards: Card[]; passed?: boolean; hint?: string; active?: boolean; position: PhonePlayPosition; seatId?: number; layout: PhonePlayLayout }>();
</script>
<template>
  <div class="phone-public-play" :data-position="position" :data-seat-id="seatId" :style="{
    left: `${layout.x}px`, top: `${layout.y}px`, width: `${layout.width}px`, height: `${layout.height}px`,
    '--public-card-width': `${layout.cardWidth}px`, gridTemplateColumns: `repeat(${layout.columns}, ${layout.step}px)`, gridAutoRows: `${layout.rowStep}px`,
  }">
    <PassMark v-if="passed" />
    <template v-else><PlayingCard v-for="card in cards" :key="card.id" :card="card" /></template>
    <span v-if="!passed && !cards.length && hint" class="turn-pill" :class="{ 'your-turn': active }">{{ hint }}</span>
  </div>
</template>
<style scoped>
.phone-public-play { position:absolute;z-index:2;display:grid;filter:drop-shadow(0 2px 2px #4a5a3c33);pointer-events:none; }
.phone-public-play > .playing-card { display:block;width:var(--public-card-width);max-width:none;margin:0; }
.phone-public-play > .pass-mark { width:min(64px,100%);height:100%;max-height:34px;grid-column:1/-1;justify-self:center; }
.phone-public-play > .turn-pill { grid-column:1/-1;align-self:center;justify-self:center;width:max-content;max-width:100%;font-size:9px;white-space:nowrap; }
</style>
