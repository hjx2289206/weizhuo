<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Card, TablePlay } from '../../shared/protocol'
import CardCounter from './CardCounter.vue'

withDefaults(
  defineProps<{
    hand: Card[]
    plays: TablePlay[]
    ready?: boolean
    deckCount?: 1 | 2
    levelRank?: number | null
  }>(),
  { ready: true, deckCount: 1, levelRank: null },
)
const emit = defineEmits<{ (e: 'close'): void }>()

/** Fallback box used for bounds before the panel has been measured. */
const FALLBACK_W = 236
const FALLBACK_H = 260
const MARGIN = 8
/** Clear of the phone header so the panel never opens over the room badge. */
const TOP_INSET = 64

const panel = ref<HTMLElement | null>(null)
const pos = ref({ x: MARGIN, y: TOP_INSET })
let dragOrigin = { x: 0, y: 0 }
let dragStart = { x: 0, y: 0 }
const dragging = ref(false)

/** Keeps the whole panel inside the viewport, so it can never cover an unreachable control. */
function clampInto(x: number, y: number): { x: number; y: number } {
  const width = panel.value?.offsetWidth || FALLBACK_W
  const height = panel.value?.offsetHeight || FALLBACK_H
  const maxX = Math.max(MARGIN, window.innerWidth - width - MARGIN)
  const maxY = Math.max(MARGIN, window.innerHeight - height - MARGIN)
  return {
    x: Math.round(Math.min(maxX, Math.max(MARGIN, x))),
    y: Math.round(Math.min(maxY, Math.max(MARGIN, y))),
  }
}

/** Sensible first placement: top-right, under the header. */
function home(): { x: number; y: number } {
  const width = panel.value?.offsetWidth || FALLBACK_W
  return clampInto(window.innerWidth - width - MARGIN, TOP_INSET)
}

function onHeaderPointerDown(event: PointerEvent): void {
  if ((event.target as HTMLElement).closest('.counter-float-close')) return
  dragging.value = true
  dragOrigin = { x: event.clientX, y: event.clientY }
  dragStart = { ...pos.value }
  const header = event.currentTarget as HTMLElement
  header.setPointerCapture(event.pointerId)
}

function onHeaderPointerMove(event: PointerEvent): void {
  if (!dragging.value) return
  pos.value = clampInto(dragStart.x + (event.clientX - dragOrigin.x), dragStart.y + (event.clientY - dragOrigin.y))
}

function onHeaderPointerUp(event: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  const header = event.currentTarget as HTMLElement
  if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId)
}

function onViewportResize(): void {
  pos.value = clampInto(pos.value.x, pos.value.y)
}

onMounted(() => {
  pos.value = home()
  window.addEventListener('resize', onViewportResize)
  window.addEventListener('orientationchange', onViewportResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportResize)
  window.removeEventListener('orientationchange', onViewportResize)
})
</script>

<template>
  <div ref="panel" class="counter-float" :class="{ 'is-dragging': dragging }" :style="{ left: `${pos.x}px`, top: `${pos.y}px` }">
    <div
      class="counter-float-header"
      @pointerdown="onHeaderPointerDown"
      @pointermove="onHeaderPointerMove"
      @pointerup="onHeaderPointerUp"
      @pointercancel="onHeaderPointerUp"
    >
      <span>记牌器</span>
      <button class="counter-float-close" type="button" aria-label="关闭记牌器" @click="emit('close')"><AppIcon name="close" /></button>
    </div>
    <CardCounter v-if="ready" :hand="hand" :plays="plays" :deck-count="deckCount" :level-rank="levelRank" />
    <p v-else class="muted">确定地主后开始记牌（此时底牌还未归入任何一方）。</p>
  </div>
</template>
