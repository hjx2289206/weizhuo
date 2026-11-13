<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ seconds: number; busy?: boolean }>()
const emit = defineEmits<{ change: [seconds: number] }>()

/** Conventional host presets; a raw value set through another client is still shown honestly. */
const presets = [0, 15, 30, 60, 90]
const options = computed(() => {
  if (presets.includes(props.seconds)) return presets
  return [...presets, props.seconds].sort((a, b) => a - b)
})

function change(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value)
  if (Number.isInteger(value)) emit('change', value)
}
</script>

<template>
  <label class="turn-timer-control" title="每位玩家每回合的最长思考时间；关闭则不计时">
    <span class="turn-timer-label">回合倒计时</span>
    <select
      class="turn-timer-select"
      :value="seconds"
      :disabled="busy"
      aria-label="设置每回合倒计时"
      @change="change"
    >
      <option v-for="value in options" :key="value" :value="value">
        {{ value === 0 ? '关闭' : `${value} 秒` }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.turn-timer-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
  font-size: 11px;
  color: #74846a;
  white-space: nowrap;
}
.turn-timer-label {
  letter-spacing: 0.04em;
}
.turn-timer-select {
  min-height: 30px;
  padding: 4px 24px 4px 10px;
  border: 1px solid #c7d1b8;
  border-radius: 18px;
  background: #f4f2e6;
  color: #315d45;
  font: inherit;
  font-size: 11px;
  line-height: 1;
}
.turn-timer-select:focus-visible {
  outline: 2px solid #b3954e;
  outline-offset: 2px;
}
.turn-timer-select:disabled {
  opacity: 0.55;
}
@media (max-height: 550px) and (orientation: landscape) {
  .turn-timer-control {
    gap: 5px;
    font-size: 10px;
  }
  .turn-timer-select {
    min-height: 26px;
    padding-top: 2px;
    padding-bottom: 2px;
    font-size: 10px;
  }
}
</style>
