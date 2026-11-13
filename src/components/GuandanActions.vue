<script setup lang="ts">
import { computed } from 'vue'
import type { GamePlayController } from '../playController'
import type { GuandanActionsApi } from '../useGuandanActions'
import type { GuandanView } from '../screens/useGuandanView'
import PlayActions from './PlayActions.vue'
const props = defineProps<{ game: GamePlayController; view: GuandanView; actions: GuandanActionsApi }>()
const hintEnabled = computed(() => props.view.playEnabled.value && !props.game.busy.value)
</script>

<template>
  <PlayActions
    class="guandan-actions"
    :selected-count="game.selected.value.length"
    :can-play="actions.canPlay.value"
    :can-pass="view.canPass.value"
    :can-hint="hintEnabled"
    @play="view.run(actions.play)"
    @pass="view.run(game.pass)"
    @hint="game.nextHint"
    @clear="game.clearSelection()"
  >
    <span class="guandan-selection-status" role="status" :title="actions.statusText.value">{{ view.managed.value ? '托管中' : actions.statusText.value }}</span>
  </PlayActions>
</template>

<style scoped>
.guandan-selection-status { max-width: 190px; overflow: hidden; color: #758367; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 560px) {
  .guandan-selection-status { max-width: 100%; font-size: 9px; }
}
</style>
