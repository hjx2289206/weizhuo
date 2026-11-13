<script setup lang="ts">
import { isBoardGame } from '../../shared/gameCatalog'
import { computed, ref } from 'vue'
import type { GameController } from '../useGame'
import AppIcon from './AppIcon.vue'
import DialogShell from './DialogShell.vue'
import RoundReview from './RoundReview.vue'
const props = defineProps<{ game: GameController }>()
const emit = defineEmits<{ close: [] }>()
const error = ref('')
const snapshot = computed(() => props.game.state.value)
const nextLabel = computed(() => snapshot.value?.game === 'guandan' ? snapshot.value.guandan.matchWinner !== null ? '再来一场' : '下一副' : '再来一局')
async function again(): Promise<void> {
  try { await props.game.again() }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '暂时无法开始下一局' }
}
</script>
<template>
  <DialogShell title="单局结算" class="result-dialog" :class="{ 'board-result-dialog': snapshot && isBoardGame(snapshot.game) }" @close="emit('close')">
    <RoundReview :snapshot="snapshot" />
    <footer class="result-footer">
      <button class="result-secondary" type="button" @click="emit('close')"><AppIcon name="table" />{{ snapshot && isBoardGame(snapshot.game) ? '返回棋盘' : '返回牌桌' }}</button>
      <button v-if="snapshot?.isHost" class="result-primary" type="button" :disabled="game.busy.value || !game.connected.value" @click="again">{{ nextLabel }}<AppIcon name="right" /></button>
      <p v-else class="result-wait"><AppIcon name="users" />等待房主{{ nextLabel }}</p>
    </footer>
    <p v-if="error" class="result-error" role="alert">{{ error }}</p>
  </DialogShell>
</template>
