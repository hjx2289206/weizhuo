<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { BOARD_CLOCK_PRESETS, spendBoardClock } from '../../shared/boardClock'
import { HAPTIC_SELECT, vibrate } from '../haptics'
import type { GameController } from '../useGame'

const props = defineProps<{ game: GameController; seat: number; flipped?: boolean }>()
const room = computed(() => props.game.state.value)
const clock = computed(() => room.value?.boardClock)
const sample = computed(() => clock.value?.times[props.seat] ?? null)
const running = computed(() => props.game.connected.value && clock.value?.running === props.seat)
const elapsed = ref(0)
let ticker: number | undefined

function stop(): void {
  if (ticker !== undefined) window.clearInterval(ticker)
  ticker = undefined
}

watch([clock, running], () => {
  stop()
  // Keep the last local reading when this device drops; the next snapshot reanchors it.
  if (!props.game.connected.value) return
  const update = () => { elapsed.value = Math.max(0, performance.now() - props.game.stateReceivedAt.value) }
  elapsed.value = 0
  if (running.value && sample.value) {
    update()
    ticker = window.setInterval(update, 50)
  }
}, { immediate: true })
onScopeDispose(stop)

const time = computed(() => {
  const value = sample.value
  if (!value || !clock.value || clock.value.running !== props.seat) return value
  return spendBoardClock(value, elapsed.value, BOARD_CLOCK_PRESETS[clock.value.preset].periodMs)
})
const readingByoyomi = computed(() => time.value?.mainMs === 0 && time.value.periodsLeft > 0)
const remaining = computed(() => readingByoyomi.value ? time.value!.periodRemainingMs : time.value?.mainMs ?? 0)
const low = computed(() => time.value !== null && remaining.value <= 10_000)

const ownDevice = computed(() => {
  const state = room.value
  if (state?.role === 'player') return state.selfSeat === props.seat
  return state?.role === 'table' && !!state.boardAi?.config && state.boardAi.config.side !== props.seat
})

watch([low, running, () => time.value?.periodsLeft], ([isLow, isRunning, periods], [wasLow, wasRunning, previousPeriods]) => {
  if (isLow && isRunning && (!wasLow || !wasRunning || previousPeriods !== periods) &&
      remaining.value > 0 && ownDevice.value) vibrate(HAPTIC_SELECT)
})

function formatTime(ms: number, byoyomi: boolean): string {
  const decimals = ms <= 10_000 ? 1 : 0
  const scale = 10 ** decimals
  const seconds = Math.ceil(ms * scale / 1_000) / scale
  if (byoyomi) return seconds.toFixed(decimals)
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0')
  const rest = (seconds % 60).toFixed(decimals).padStart(decimals ? 4 : 2, '0')
  return `${minutes}:${rest}`
}

const label = computed(() => {
  const display = formatTime(remaining.value, readingByoyomi.value)
  return readingByoyomi.value ? `读秒 ${display} · 剩 ${time.value!.periodsLeft} 次` : display
})
</script>

<template>
  <time v-if="time" class="board-clock-readout" :class="{ low, flipped }" :data-seat="seat" :data-running="running"
    :aria-label="'棋钟剩余时间 ' + label" :datetime="`PT${(remaining / 1_000).toFixed(3)}S`">
    {{ label }}
  </time>
</template>

<style scoped>
.board-clock-readout { display: block; width: max-content; max-width: 100%; color: #435137; font-size: .86rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.25; }
.board-clock-readout.low { color: #a02c25; }
.board-clock-readout.flipped { transform: rotate(180deg); }
</style>
