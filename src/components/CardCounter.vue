<script setup lang="ts">
import { computed } from 'vue'
import { guandanRankStrength } from '../../shared/guandan'
import type { Card, TablePlay } from '../../shared/protocol'
import { buildCardCounter } from '../cardCounter'

const props = withDefaults(
  defineProps<{
    /** Viewer's own current hand (never an opponent's). */
    hand: Card[]
    /** Public accepted-play history for the round; only `cards` is read. */
    plays: TablePlay[]
    deckCount?: 1 | 2
    /** Guandan played level; when set, rows are ordered by Guandan strength and the level row is marked. */
    levelRank?: number | null
  }>(),
  { deckCount: 1, levelRank: null },
)

/** One row per rank, strongest first. Guandan adds level/wild marking and its own rank order. */
const rows = computed(() => {
  const entries = buildCardCounter(props.hand, props.plays, props.deckCount)
  const level = props.levelRank
  if (level == null) return entries
  return [...entries].sort((left, right) => guandanRankStrength(right.rank, level) - guandanRankStrength(left.rank, level))
})

/** Face glyphs; jokers and 2/A/K/Q/J/10 differ from their raw rank number. */
const GLYPH_BY_RANK: Record<number, string> = {
  17: '大王',
  16: '小王',
  15: '2',
  14: 'A',
  13: 'K',
  12: 'Q',
  11: 'J',
  10: '10',
}

function kindOf(rank: number): 'joker' | 'level' | 'normal' {
  if (rank >= 16) return 'joker'
  return props.levelRank === rank ? 'level' : 'normal'
}
</script>

<template>
  <div class="card-counter" :class="{ 'is-empty': hand.length === 0 }">
    <div class="counter-heading">外部剩余 / 不含我的手牌</div>
    <div class="counter-grid">
      <div
        v-for="entry in rows"
        :key="entry.rank"
        class="counter-rank"
        :class="{ 'is-empty': entry.outside === 0, 'is-level': kindOf(entry.rank) === 'level' }"
        :data-rank="entry.rank"
        :data-kind="kindOf(entry.rank)"
        :title="`已出 ${entry.played} · 我手 ${entry.inHand} · 共 ${entry.total}`"
        :aria-label="`${GLYPH_BY_RANK[entry.rank] ?? entry.rank} 外部剩余 ${entry.outside} 张`"
      >
        <span class="counter-label">{{ GLYPH_BY_RANK[entry.rank] ?? entry.rank }}</span>
        <span class="counter-value">{{ entry.outside }}</span>
      </div>
    </div>
  </div>
</template>
