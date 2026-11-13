<script setup lang="ts">
import { computed } from 'vue'
import type { Card } from '../../shared/protocol'
import PlayingCard from './PlayingCard.vue'
const props = defineProps<{ cards: Card[]; back?: boolean; level?: number; label?: string }>()
const spacing = computed(() => props.cards.length > 9 ? 30 : props.cards.length > 5 ? 42 : 65)
const width = computed(() => 100 + Math.max(0, props.cards.length - 1) * spacing.value)
</script>
<template>
  <svg class="tutorial-card-spread" :viewBox="`-3 -5 ${width + 6} 156`" role="img" :aria-label="label ?? (back ? '尚未公开的牌' : cards.map(card => ({11:'J',12:'Q',13:'K',14:'A',15:'2',16:'小王',17:'大王'}[card.rank] ?? card.rank)).join('、'))" :style="{ maxWidth: `${width}px` }">
    <svg v-for="(card, index) in cards" :key="card.id" :x="index * spacing" y="2" width="100" height="144" overflow="visible" :data-demo-card-id="card.id">
      <PlayingCard :card="card" :back="back" style="width:100%;height:100%;display:block" />
      <rect v-if="!back && card.rank === level && card.suit === 'heart'" x="1" y="1" width="98" height="142" rx="7" fill="none" stroke="#ad8b35" stroke-width="2.5" />
    </svg>
  </svg>
</template>
<style scoped>
.tutorial-card-spread { display: block; width: 100%; height: 100%; max-height: 180px; overflow: visible; margin: auto; filter: drop-shadow(0 5px 4px #2443341a); }
</style>
