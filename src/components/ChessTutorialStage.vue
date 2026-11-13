<script setup lang="ts">
import { computed } from 'vue'
import type { TeachingClip } from '../../shared/tutorialProtocol'
import { chessSideName } from '../../shared/chess'
import { clipPosition } from '../tutorials/motion'
import ChessBoard, { type ChessPlayback } from './ChessBoard.vue'
const props = defineProps<{ clip: TeachingClip; elapsed: number; reduced: boolean; opposed?: boolean }>()
const pos = computed(() => clipPosition(props.clip, props.elapsed, props.reduced))
const state = computed(() => pos.value.snapshot.game === 'chess' ? pos.value.snapshot : null)
const motion = computed<ChessPlayback | null>(() => {
  const f = pos.value.frame, before = pos.value.before
  if (props.reduced || f?.action?.type !== 'chessMove' || before.game !== 'chess') return null
  const from = Number(f.action.payload.from), to = Number(f.action.payload.to), piece = before.chess.board[from]
  return piece ? { from, to, piece, phase: pos.value.fraction, rejected: f.rejected, move: f.snapshot.game === 'chess' && !f.rejected ? f.snapshot.chess.moves.at(-1) : undefined } : null
})
</script>
<template>
  <div v-if="state" class="chess-tutorial-stage" :data-clip-id="clip.id" :data-beat="pos.frameIndex" :data-fraction="pos.fraction.toFixed(3)">
    <div class="clip-chess-context"><span>{{ opposed ? '双人同屏 · 双方棋子各朝自己' : '白方视角 · 棋子统一朝下' }}</span><span>8 × 8 方格</span></div>
    <div class="chess-tutorial-board" inert><ChessBoard :board="state.chess.board" :side="0" :selected="null" :targets="[]" disabled :opposed="opposed" :last="state.chess.moves.at(-1)" :checked="state.chess.check" :playback="motion" /></div>
    <div class="clip-chess-facts"><span v-if="pos.frame?.rejected" class="clip-xiangqi-refused">不能这样走 · 棋子留在原位</span><span v-else-if="state.phase === 'finished'" class="clip-outcome">{{ state.chess.draw ? '和棋' : `${chessSideName(state.chess.winner!)}获胜` }} · {{ state.chess.reason }}</span><span v-else-if="state.chess.drawOffer !== null">{{ chessSideName(state.chess.drawOffer) }}提出和棋，等待对方同意</span><span v-else-if="state.chess.check !== null">{{ chessSideName(state.chess.check) }}正在被将军，必须先解围</span><span v-else>下一步轮到{{ chessSideName(state.turn ?? 0) }}</span><span v-if="clip.tags.includes('fifty-moves')">无吃子、无兵移动 {{ state.chess.quietPlies }} / 100 手</span></div>
  </div>
</template>
<style scoped>
.chess-tutorial-stage { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid #cad3bb; border-radius: 12px; background: #e8eddd; }.chess-tutorial-board { flex: 1; min-height: 0; padding: 0 8px; }.chess-tutorial-board > svg { width: 100%; height: 100%; }.clip-chess-facts { min-height: 42px; align-items: center; }
</style>
