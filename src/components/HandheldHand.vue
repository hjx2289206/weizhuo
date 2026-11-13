<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Card } from '../../shared/protocol'
import PlayingCard from './PlayingCard.vue'
import { computeHandheldGeometry } from '../handheldLayout'
import { useHandheldGesture } from '../useHandheldGesture'

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
  }>(),
  { levelRank: null, eligibleIds: null },
)

/** Fallback surface for the first paint, before ResizeObserver reports. */
const FALLBACK_WIDTH = 360
const FALLBACK_HEIGHT = 260
/**
 * Mobile browsers dispatch a synthetic `focus` right after the finger lifts.
 * A focus that arrives this soon after a pointer interaction is a tap, not
 * keyboard navigation, so it must not re-open the big preview card.
 */
const FOCUS_POINTER_GRACE_MS = 600

const root = ref<HTMLElement | null>(null)
const size = ref({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT })
const focusedIndex = ref<number | null>(null)

let observer: ResizeObserver | null = null
let pointerStamp = -Infinity

function measure(): void {
  const el = root.value
  if (!el) return
  const width = el.clientWidth
  const height = el.clientHeight
  if (width !== size.value.width || height !== size.value.height) size.value = { width, height }
}

/** Ends any gesture and drops the temporary preview: capture loss, blur, hidden tab. */
function releaseHand(): void {
  gesture.dispose()
  focusedIndex.value = null
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') releaseHand()
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    observer = new ResizeObserver(measure)
    observer.observe(root.value)
  } else {
    window.addEventListener('resize', measure)
  }
  window.addEventListener('blur', releaseHand)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  window.removeEventListener('resize', measure)
  window.removeEventListener('blur', releaseHand)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  releaseHand()
})

const geometry = computed(() =>
  computeHandheldGeometry({
    width: size.value.width,
    height: size.value.height,
    count: props.cards.length,
  }),
)

const layout = computed(() => {
  const geo = geometry.value
  return props.cards.map((card, index) => ({
    card,
    index,
    cardX: geo.cardX[index] ?? geo.pivotX,
    angle: geo.angles[index] ?? 0,
  }))
})

/**
 * Selection and focus are deliberately not part of the layout above: a toggle or a
 * moving preview must repaint one card's class, never rebuild every item mid-sweep.
 */
const selectedSet = computed(() => new Set(props.selected))

const SUIT_CN: Record<Card['suit'], string> = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块', joker: '王' }
const RANK_CN: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' }

function label(card: Card): string {
  if (card.suit === 'joker') return card.rank === 17 ? '大王' : '小王'
  return SUIT_CN[card.suit] + (RANK_CN[card.rank] ?? card.rank)
}

const previewCard = computed<Card | undefined>(() => {
  const index = focusedIndex.value
  return index === null ? undefined : props.cards[index]
})

const previewLabel = computed(() => (previewCard.value ? label(previewCard.value) : ''))

const gesture = useHandheldGesture({
  root: () => root.value,
  cards: () => props.cards,
  geometry: () => geometry.value,
  selected: () => props.selected,
  toggleCard: (id: string) => props.toggleCard(id),
  play: () => props.play(),
  enabled: () => props.enabled,
  setFocusedIndex: (index: number | null) => {
    focusedIndex.value = index
  },
})

// The hand changes between rounds: indices shift, so drop stale focus/gesture.
watch(
  () => props.cards.map((card) => card.id).join('|'),
  () => {
    releaseHand()
  },
)

function onPointerDown(event: PointerEvent): void {
  pointerStamp = performance.now()
  gesture.pointerDown(event)
}

/** Only keyboard focus raises the preview; taps are handled by the gesture layer. */
function onCardFocus(event: FocusEvent, index: number): void {
  if (performance.now() - pointerStamp < FOCUS_POINTER_GRACE_MS) return
  const element = event.currentTarget
  if (element instanceof HTMLElement && typeof element.matches === 'function') {
    try {
      if (!element.matches(':focus-visible')) return
    } catch {
      /* without :focus-visible support the grace window above already filters taps */
    }
  }
  focusedIndex.value = index
}

function onCardBlur(index: number): void {
  if (focusedIndex.value === index) focusedIndex.value = null
}

function onActivate(index: number): void {
  const card = props.cards[index]
  if (!card) return
  focusedIndex.value = index
  props.toggleCard(card.id)
}
</script>

<template>
  <div
    ref="root"
    class="handheld-hand"
    @pointermove="gesture.pointerMove"
    @pointerup="gesture.pointerUp"
    @pointercancel="gesture.pointerCancel"
    @lostpointercapture="gesture.pointerCancel"
  >
    <div v-if="previewCard" class="handheld-preview">
      <PlayingCard class="handheld-preview-card" :card="previewCard" />
      <span class="handheld-preview-label">{{ previewLabel }}</span>
    </div>
    <button
      v-for="item in layout"
      :key="item.card.id"
      type="button"
      class="handheld-card"
      :class="{
        selected: selectedSet.has(item.card.id),
        focused: focusedIndex === item.index,
        'is-levelcard': levelRank != null && item.card.rank === levelRank,
        'is-wild': levelRank != null && item.card.rank === levelRank && item.card.suit === 'heart',
        'is-eligible': eligibleIds != null && eligibleIds.includes(item.card.id),
      }"
      :data-card-id="item.card.id"
      :aria-label="label(item.card)"
      :aria-pressed="selectedSet.has(item.card.id)"
      :style="{
        '--card-x': `${item.cardX}px`,
        '--card-y': `${geometry.cardY}px`,
        '--card-angle': `${item.angle}deg`,
        '--card-width': `${geometry.cardWidth}px`,
        '--card-depth': item.index + 1,
      }"
      @pointerdown="onPointerDown($event)"
      @focus="onCardFocus($event, item.index)"
      @blur="onCardBlur(item.index)"
      @keydown.enter.prevent="onActivate(item.index)"
      @keydown.space.prevent="onActivate(item.index)"
    >
      <PlayingCard v-memo="[item.card.id, item.card.rank, item.card.suit]" :card="item.card" :narrow-corner="true" />
    </button>
    <div class="handheld-grip-mark" aria-hidden="true" />
  </div>
</template>
