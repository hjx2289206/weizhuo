<script setup lang="ts">
import { computed } from 'vue'
import type { TeachingClip } from '../../shared/tutorialProtocol'
import { REVERSI_FLIP_MS, reversiSideName } from '../../shared/reversi'
import { clipPosition, frameDuration } from '../tutorials/motion'
import ReversiBoard from './ReversiBoard.vue'

const props = defineProps<{ clip: TeachingClip; elapsed: number; reduced: boolean }>()
const pos = computed(() => clipPosition(props.clip, props.elapsed, props.reduced))
const transition = computed(() => {
  const { frame, before, fraction } = pos.value
  if (before.game !== 'reversi' || frame?.snapshot.game !== 'reversi' || frame.rejected || frame.action?.type !== 'reversiMove') return null
  const move = frame.snapshot.reversi.moves.filter(move => move.point !== null).at(-1)
  if (!move) return null
  return { before, after: frame.snapshot, move, progress: fraction * frameDuration(frame, props.reduced) / REVERSI_FLIP_MS }
})
const live = computed(() => {
  const step = transition.value
  return step && !props.reduced && step.progress < 1 ? { board: step.before.reversi.board, move: step.move, progress: step.progress } : null
})
const state = computed(() => {
  const value = live.value ? transition.value!.before : transition.value?.after ?? pos.value.snapshot
  return value.game === 'reversi' ? value : null
})
const lastPlacement = computed(() => state.value?.reversi.moves.filter(move => move.point !== null).at(-1))
const last = computed(() => state.value?.reversi.moves.at(-1))
</script>

<template>
  <div v-if="state" class="reversi-tutorial-stage">
    <div class="clip-chess-context"><span>固定教学局面</span><span>黑 {{ state.reversi.counts[0] }} 子 · 白 {{ state.reversi.counts[1] }} 子</span></div>
    <div class="clip-chess-viewport" inert><ReversiBoard :board="state.reversi.board" :legal="state.reversi.legal" :last="lastPlacement"
      :focus-points="pos.frame?.focus?.points" :live="live" disabled /></div>
    <div class="clip-chess-facts">
      <span v-if="pos.frame?.rejected">{{ pos.frame.rejected }}</span>
      <span v-else-if="last?.point === null">{{ last.notation }}</span>
      <span v-else-if="state.phase === 'finished'">{{ state.reversi.draw ? '和棋' : reversiSideName(state.reversi.winner!) + '获胜' }} · {{ state.reversi.reason }}</span>
      <span v-else>轮到{{ reversiSideName(state.turn!) }}落子</span>
    </div>
  </div>
</template>

<style scoped>
.reversi-tutorial-stage { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; gap: 6px; }
.reversi-tutorial-stage .clip-chess-viewport { flex: 1; min-height: 0; }
</style>
