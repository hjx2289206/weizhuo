<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef } from 'vue'
import type { Card } from '../../shared/protocol'
import PlayingCard from './PlayingCard.vue'
import { useHandGesture } from '../useHandGesture'

const props = withDefaults(
  defineProps<{
    cards: Card[]
    selected: string[]
    toggleCard: (id: string) => void
    play: () => Promise<void>
    enabled: boolean
    /** Guandan played level: marks every level card and the two heart wilds. */
    levelRank?: number | null
    /** Guandan exchange: physical ids this seat may tribute or return right now. */
    eligibleIds?: readonly string[] | null
    highlightedIds?: readonly string[]
  }>(),
  { levelRank: null, eligibleIds: null },
)

const root = ref<HTMLElement | null>(null)
const width = ref(0)
let observer: ResizeObserver | null = null

function measure(): void {
  if (root.value) width.value = root.value.clientWidth
}

/** Untransformed layout width of a rendered card, so breakpoint widths drive the spread. */
function cardWidth(): number {
  const el = root.value?.querySelector<HTMLElement>('.fan-card')
  return (el ? el.offsetWidth : 0) || 84
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    observer = new ResizeObserver(measure)
    observer.observe(root.value)
  } else {
    window.addEventListener('resize', measure)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  window.removeEventListener('resize', measure)
})

const FAN_MAX_ANGLE = 16
const FAN_ANGLE_STEP_CAP = 5
const FAN_GUTTER = 6
/** Every card must keep at least this fraction of its width exposed for rank/suit. */
const FAN_MIN_REVEAL = 0.31

/**
 * Half of a card's horizontal footprint after `deg` rotation about the CSS
 * transform-origin 50% 150% (the origin sits below the card). Card corners are
 * at (±w/2, -1.5h) and (±w/2, -0.5h) relative to that origin, so rotation adds
 * 1.5h·|sin| to both sides — the deeper corner swings furthest out.
 * Equivalently `halfExtent(deg) = R·cos(deg − φ)` with `R = hypot(w/2, 1.5h)`.
 */
function halfExtent(cardW: number, cardH: number, deg: number): number {
  const r = (deg * Math.PI) / 180
  return (cardW / 2) * Math.abs(Math.cos(r)) + 1.5 * cardH * Math.abs(Math.sin(r))
}

const layout = computed(() => {
  const count = props.cards.length
  if (count === 0) return []
  const containerW = Math.max(width.value, 160)
  const cardW = cardWidth()
  const cardH = cardW * 1.44
  const halfSpan = (count - 1) / 2
  const budget = containerW / 2 - FAN_GUTTER
  const flatExtent = halfExtent(cardW, cardH, 0)
  const flatStep = halfSpan > 0 ? (budget - flatExtent) / halfSpan : 0
  const reveal = Math.min(cardW * FAN_MIN_REVEAL, Math.max(flatStep, 0))

  // Widest fan that still leaves every card `reveal` px exposed. The fit is
  // monotonic in the angle, so solve halfExtent(A) = budget − halfSpan·reveal.
  let maxAngle = FAN_MAX_ANGLE
  if (halfSpan > 0 && cardH > 0) {
    const radius = Math.hypot(cardW / 2, 1.5 * cardH)
    const phase = Math.atan2(1.5 * cardH, cardW / 2)
    const needed = budget - halfSpan * reveal
    if (needed < radius) {
      const ratio = Math.max(-1, Math.min(1, needed / radius))
      const solved = ((phase - Math.acos(ratio)) * 180) / Math.PI
      maxAngle = Math.max(0, Math.min(FAN_MAX_ANGLE, solved))
    }
  }
  const angleStep = halfSpan > 0 ? Math.min(FAN_ANGLE_STEP_CAP, maxAngle / halfSpan) : 0
  const outerAngle = Math.abs(angleStep) * halfSpan
  // Step from the outermost rotated cards so nothing crosses the gutter.
  const fitStep = halfSpan > 0 ? (budget - halfExtent(cardW, cardH, outerAngle)) / halfSpan : 0
  const step = Math.max(0, Math.min(cardW * 0.56, fitStep))

  return props.cards.map((card, index) => {
    const relative = index - halfSpan
    const angle = relative * angleStep
    return {
      card,
      index,
      offset: relative * step,
      angle,
      arc: Math.abs(angle) * 1.4,
    }
  })
})

/**
 * Selection is deliberately not part of the layout above: a toggle must repaint one
 * card's class, never re-solve the fan (or measure a rendered card) mid-sweep.
 */
const selectedSet = computed(() => new Set(props.selected))

const SUIT_CN: Record<Card['suit'], string> = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块', joker: '王' }
const RANK_CN: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' }

function label(card: Card): string {
  if (card.suit === 'joker') return card.rank === 17 ? '大王' : '小王'
  return SUIT_CN[card.suit] + (RANK_CN[card.rank] ?? card.rank)
}

// FanHand owns pointer wiring; useHandGesture drives tap / drag paint / upward swipe.
const gesture = useHandGesture({
  selected: toRef(props, 'selected'),
  toggleCard: (id: string) => props.toggleCard(id),
  play: () => props.play(),
  enabled: () => props.enabled,
})

function onKey(id: string): void {
  props.toggleCard(id)
}
</script>

<template>
  <div
    ref="root"
    class="fan-hand"
    @pointermove="gesture.pointerMove"
    @pointerup="gesture.pointerUp"
    @pointercancel="gesture.pointerCancel"
    @lostpointercapture="gesture.pointerCancel"
  >
    <button
      v-for="item in layout"
      :key="item.card.id"
      type="button"
      class="fan-card"
      :class="{
        selected: selectedSet.has(item.card.id),
        'is-levelcard': levelRank != null && item.card.rank === levelRank,
        'is-wild': levelRank != null && item.card.rank === levelRank && item.card.suit === 'heart',
        'is-eligible': eligibleIds != null && eligibleIds.includes(item.card.id),
        'is-teaching-target': highlightedIds?.includes(item.card.id),
      }"
      :data-card-id="item.card.id"
      :aria-label="label(item.card)"
      :aria-pressed="selectedSet.has(item.card.id)"
      :style="{
        left: '50%',
        '--offset': `${item.offset}px`,
        '--angle': `${item.angle}deg`,
        '--arc': `${item.arc}px`,
        '--depth': item.index,
      }"
      @pointerdown="gesture.pointerDown($event)"
      @keydown.enter.prevent="onKey(item.card.id)"
      @keydown.space.prevent="onKey(item.card.id)"
    >
      <PlayingCard v-memo="[item.card.id, item.card.rank, item.card.suit]" :card="item.card" />
    </button>
  </div>
</template>
