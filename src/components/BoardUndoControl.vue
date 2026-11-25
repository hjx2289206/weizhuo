<script setup lang="ts">
import { computed, ref } from 'vue'
import { BOARD_UNDO_LIMIT, boardUndoTarget, type BoardUndoClientAction, type BoardUndoSide, type BoardUndoView } from '../../shared/boardUndo'
import AppIcon from './AppIcon.vue'
import DialogShell from './DialogShell.vue'

const props = defineProps<{
  board: BoardUndoView & { moves: readonly { side: BoardUndoSide }[] }
  side: BoardUndoSide | null
  sideName: (side: number) => string
  shared: boolean
  computer?: boolean
  disabled: boolean
  drawPending?: boolean
  confirmDescription?: string
}>()
const emit = defineEmits<{ action: [action: BoardUndoClientAction] }>()
const confirmOpen = ref(false)
const proposer = computed(() => props.shared && !props.computer ? props.board.moves.at(-1)?.side ?? null : props.side)
const remaining = computed(() => proposer.value === null ? BOARD_UNDO_LIMIT : BOARD_UNDO_LIMIT - props.board.undoUsed[proposer.value])
const canRequest = computed(() => !props.disabled && !props.drawPending && proposer.value !== null &&
  (props.computer || remaining.value > 0) && boardUndoTarget(props.board.moves, proposer.value) >= 0)
function request(): void {
  if (!canRequest.value) return
  if (props.shared && !props.computer) confirmOpen.value = true
  else emit('action', 'request')
}
function confirm(): void {
  if (!canRequest.value) return
  confirmOpen.value = false
  emit('action', 'request')
}
</script>

<template>
  <template v-if="board.undoOffer !== null && side !== null">
    <span class="board-undo-offer" role="status">{{ board.undoOffer === side ? '等待对方同意悔棋' : '对方请求悔棋' }}</span>
    <button v-if="board.undoOffer === side" type="button" class="button secondary" :disabled="disabled" @click="emit('action', 'cancel')">撤回悔棋</button>
    <template v-else>
      <button type="button" class="button secondary" :disabled="disabled" @click="emit('action', 'decline')">拒绝悔棋</button>
      <button type="button" class="button primary" :disabled="disabled" @click="emit('action', 'accept')">同意悔棋</button>
    </template>
  </template>
  <button v-else type="button" class="button secondary board-undo-button" :disabled="!canRequest" @click="request">
    <AppIcon name="undo" />{{ !shared && !computer ? '请求悔棋' : '悔棋' }}{{ computer ? '' : `（剩 ${remaining} 次）` }}
  </button>
  <DialogShell v-if="confirmOpen && proposer !== null" :title="`确认${sideName(proposer)}悔棋？`" class="board-undo-dialog" @close="confirmOpen = false">
    <p>{{ confirmDescription ?? '撤销上一手' }}，本局{{ sideName(proposer) }}将用掉一次悔棋机会。</p>
    <button type="button" class="button primary" :disabled="!canRequest" @click="confirm">确认悔棋</button>
  </DialogShell>
</template>

<style>
.board-undo-button .app-icon { width: 15px; height: 15px; }
.board-undo-offer { order: -1; width: 100%; font-size: 11px; color: #977448; }
.board-undo-dialog.tools-dialog { width: min(420px, 100%); }
.board-undo-dialog > p { margin-bottom: 12px; }
</style>
