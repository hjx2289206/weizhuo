<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GameController } from '../useGame'
import { boardAiLabel, type BoardAiDifficulty } from '../../shared/boardAi'
import DialogShell from './DialogShell.vue'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ game: GameController }>()
const state = computed(() => props.game.state.value)
const ai = computed(() => state.value?.boardAi)
const open = ref(false), difficulty = ref<BoardAiDifficulty>('normal'), side = ref<0 | 1>(1), error = ref(''), saving = ref(false)
const selected = computed(() => ai.value?.levels.find(item => item.id === difficulty.value))
const sideName = (n: number) => n === 1 ? '黑方' : state.value?.game === 'chess' ? '白方' : '红方'
function show() { difficulty.value=ai.value?.config?.difficulty??'normal'; side.value=state.value?.roomMode==='phone'?(state.value.selfSeat===0?1:0):ai.value?.config?.side??1; error.value='';open.value=true }
watch(() => props.game.boardAiSetupRequested.value, value => { if(value&&state.value?.isHost&&state.value.phase==='lobby'){props.game.boardAiSetupRequested.value=false;show()} },{immediate:true})
async function configure(enabled:boolean) { if(saving.value)return;saving.value=true;error.value='';try{await props.game.configureBoardAi(enabled,side.value,difficulty.value);open.value=false}catch(e){error.value=e instanceof Error?e.message:'无法设置人机对弈'}finally{saving.value=false} }
async function retry() { try{await props.game.retryBoardAi()}catch{} }
</script>
<template>
  <template v-if="ai && state?.isHost">
    <button v-if="state.phase === 'lobby'" class="tool-button board-ai-trigger" type="button" @click="show"><AppIcon name="users" />{{ ai.config ? `电脑·${boardAiLabel(ai.config.difficulty)}` : '人机对弈' }}</button>
    <button v-else-if="state.phase === 'playing' && ai.error" class="tool-button board-ai-retry" type="button" :disabled="game.busy.value || !game.connected.value" @click="retry">重试电脑行棋</button>
    <DialogShell v-if="open" title="人机对弈" class="board-ai-dialog" @close="!saving && (open = false)">
      <p class="board-ai-lead">选好难度，与电脑下一局。</p>
      <label class="board-ai-field">难度<select v-model="difficulty" :disabled="saving"><option v-for="level in ai.levels" :key="level.id" :value="level.id" :disabled="!level.available">{{ level.label }}{{ level.available ? '' : '（暂不可用）' }}</option></select></label>
      <label v-if="state.roomMode === 'tablet'" class="board-ai-field">你执<select :value="1-side" :disabled="saving" @change="side = Number(($event.target as HTMLSelectElement).value) === 0 ? 1 : 0"><option :value="0">{{ sideName(0) }} · 先手</option><option :value="1">黑方 · 后手</option></select></label>
      <p v-else class="board-ai-note">你执{{ sideName(state.selfSeat ?? 0) }}，电脑执{{ sideName(side) }}。已有真人的座位不会被替换。</p>
      <p class="board-ai-note">五档为本游戏内的相对难度；人机对弈保留棋规自动和棋，不提供协议和棋。</p>
      <p v-if="!selected?.available" class="board-ai-error" role="status">{{ selected?.message || '这个难度的电脑暂不可用' }}</p>
      <p v-if="error" class="board-ai-error" role="alert">{{ error }}</p>
      <footer class="board-ai-actions"><button v-if="ai.config" class="button secondary" :disabled="saving" @click="configure(false)">改为双人对弈</button><button class="button primary" :disabled="saving || !selected?.available || !game.connected.value" @click="configure(true)">{{ saving ? '正在设置…' : '使用这个难度' }}</button></footer>
    </DialogShell>
  </template>
</template>
<style>
.board-ai-dialog.tools-dialog { width: min(420px,100%); }.board-ai-lead { color: #56714d; font-size: 13px; }.board-ai-field { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 14px 0; font-size: 13px; }.board-ai-field select { border: 1px solid #c4cfb2; border-radius: 8px; background: #fbf9ec; color: #31543e; min-height: 38px; padding: 7px 11px; min-width: 150px; font-size: 16px; }.board-ai-note { color: #7a896a; line-height: 1.8; font-size: 11px; }.board-ai-error { color: #a15b42; font-size: 12px; line-height: 1.7; }.board-ai-actions { display: flex; gap: 9px; margin-top: 16px; }.board-ai-actions .button { flex: 1; min-height: 38px; font-size: 12px; }.board-ai-retry { color: #9c613f; }
</style>
