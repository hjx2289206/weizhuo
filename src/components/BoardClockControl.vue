<script setup lang="ts">
import { computed } from 'vue'
import { BOARD_CLOCK_PRESETS, boardClockOptions, type BoardClockPreset } from '../../shared/boardClock'
import type { GameController } from '../useGame'

const props = defineProps<{ game: GameController; disabled?: boolean }>()
const room = computed(() => props.game.state.value)

function select(event: Event): void {
  const preset = (event.target as HTMLSelectElement).value as BoardClockPreset
  void props.game.setBoardClock(preset).catch((error: unknown) => {
    props.game.error.value = error instanceof Error ? error.message : '设置棋钟失败'
  })
}
</script>

<template>
  <label v-if="room?.boardClock && room.phase === 'lobby'" class="board-clock-setting">
    棋钟
    <select aria-label="棋钟" :value="room.boardClock.preset" :disabled="disabled || game.busy.value || !room.isHost" @change="select">
      <option v-for="preset in boardClockOptions(room.game)" :key="preset" :value="preset">{{ BOARD_CLOCK_PRESETS[preset].label }}</option>
    </select>
  </label>
</template>

<style scoped>
.board-clock-setting { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; color: #454e36; font-size: .8rem; font-weight: 700; }
.board-clock-setting select { min-height: 34px; border: 1px solid #b5bd9f; border-radius: 8px; padding: 3px 8px; background: #f9f8ed; color: inherit; font: inherit; }
</style>
