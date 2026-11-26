<script setup lang="ts">
import { computed } from 'vue'
import type { GameController } from '../useGame'

const props = defineProps<{ game: GameController }>()
const room = computed(() => props.game.state.value)
const settings = computed(() => room.value?.seatCountSettings)

async function change(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  try { await props.game.setSeatCount(Number(select.value)) }
  catch { if (settings.value) select.value = String(settings.value.count) }
}
</script>

<template>
  <label v-if="room?.isHost && room.phase === 'lobby' && settings" class="seat-count-control">
    对局人数
    <select aria-label="对局人数" :value="settings.count" :disabled="game.busy.value || !game.connected.value" @change="change">
      <option v-for="offset in settings.max - settings.min + 1" :key="offset" :value="settings.min + offset - 1">
        {{ settings.min + offset - 1 }} 人
      </option>
    </select>
  </label>
</template>

<style scoped>
.seat-count-control { display: inline-flex; align-items: center; gap: 8px; font-size: .85rem; }
.seat-count-control select { padding: 4px 8px; font: inherit; }
</style>
