<script setup lang="ts">
import { computed } from 'vue'
import type { TeachingClip } from '../../shared/tutorialProtocol'
import { GOMOKU_RULES, stoneSideName } from '../../shared/stones'
import { clipPosition } from '../tutorials/motion'
import StoneBoard from './StoneBoard.vue'
const props = defineProps<{ clip: TeachingClip; elapsed: number; reduced: boolean }>()
const pos = computed(() => clipPosition(props.clip,props.elapsed,props.reduced))
const state = computed(() => { const s = pos.value.snapshot; return s.game === 'go' || s.game === 'gomoku' ? s : null })
const move = computed(() => { const f = pos.value.frame; return f?.action?.type === 'stoneMove' ? f : null })
const preview = computed(() => move.value && pos.value.fraction < .84 && !move.value.rejected ? Number(move.value.action!.payload.point) : null)
const focus = computed(() => pos.value.frame?.focus?.points ?? props.clip.frames[0]?.focus?.points ?? [])
</script>
<template>
  <div v-if="state" class="stone-tutorial-stage">
    <div class="clip-chess-context"><span>固定教学局面 · {{ state.stones.size }} 路{{ state.game === 'gomoku' ? ' · ' + GOMOKU_RULES[state.stones.rule ?? 'freestyle'] : '' }}</span><span>金色标记为本段关注点</span></div>
    <div class="clip-chess-viewport" inert><StoneBoard :board="state.stones.board" :size="state.stones.size" :selected="preview" :preview-side="(move?.action?.seat ?? 0) as 0 | 1" :last="state.stones.moves.at(-1)?.point" :dead="state.stones.dead" :ownership="state.stones.score?.ownership" :winning-line="state.stones.winningLine" :focus-points="focus" :renju-board="state.stones.rule === 'renju' && state.turn === 0 ? state.stones.board : null" disabled /></div>
    <div class="clip-chess-facts stone-tutorial-facts"><span v-if="pos.frame?.rejected" class="clip-xiangqi-refused">{{ pos.frame.rejected }}</span><span v-else-if="state.phase === 'finished'">{{ state.stones.draw ? '和棋' : `${stoneSideName(state.stones.winner!)}获胜` }} · {{ state.stones.reason }}</span><span v-else-if="state.stones.stage === 'scoring'">死子确认中 · 双方同意后才结算</span><span v-else>下一手：{{ stoneSideName(state.turn ?? 0) }}</span><span v-if="state.stones.score">黑 {{ state.stones.score.total[0] }} 点 / 白 {{ state.stones.score.total[1] }} 点</span><span v-else-if="state.game === 'go'">提子：黑 {{ state.stones.captured[0] }} / 白 {{ state.stones.captured[1] }}</span></div>
  </div>
</template>
<style>
.stone-tutorial-stage { display: flex; flex: 1; flex-direction: column; width: 100%; height: 100%; min-height: 0; gap: 6px; }.stone-tutorial-stage .clip-chess-viewport { flex: 1; min-height: 0; }.stone-tutorial-facts { flex-wrap: wrap; line-height: 1.5; }.stone-tutorial-facts > span { font-size: 11px; }
@media(max-width:430px) { .stone-tutorial-stage .clip-chess-context,.stone-tutorial-facts > span { font-size: 9px; } }
</style>
