<script setup lang="ts">
import { defineAsyncComponent, onScopeDispose, ref, watch } from 'vue'
import { GAME_DEFINITIONS } from '../../shared/gameCatalog'
import type { GameKind } from '../../shared/protocol'
import AppIcon from './AppIcon.vue'
import DialogShell from './DialogShell.vue'
import type { TeachingLevel } from '../../shared/tutorialProtocol'
import { teachingVisible } from '../tutorials/visibility'

defineProps<{ game: GameKind; live?: boolean; opposed?: boolean }>()
const open = ref(false), choosing = ref(false), level = ref<TeachingLevel>('basic')
function choose(value: TeachingLevel): void { level.value = value; choosing.value = false; open.value = true }
const TutorialMatchView = defineAsyncComponent(() => import('./TutorialMatchView.vue'))
watch(open, value => { teachingVisible.value = value })
onScopeDispose(() => { if (open.value) teachingVisible.value = false })
</script>

<template>
  <button class="tool-button tutorial-trigger" type="button" :aria-label="`${GAME_DEFINITIONS[game].name}教程`" :aria-expanded="open || choosing" @click="game === 'go' ? choosing = true : open = true"><AppIcon name="book" /><span>教程</span></button>
  <DialogShell v-if="choosing" title="围棋教程：选择学习内容" class="go-learning-menu" @close="choosing = false">
    <p>第一次玩先看基础；会下完整一盘后，再按需要选看进阶。</p>
    <button class="go-learning-choice" @click="choose('basic')"><strong>基础教程<AppIcon name="right" /></strong><span>操作、气与提子、禁入点、打劫、停一手、死子确认与数子结算。</span></button>
    <button class="go-learning-choice go-learning-choice--advanced" @click="choose('advanced')"><strong>进阶教程<AppIcon name="right" /></strong><span>两眼、双打吃、征子、倒扑、劫材、布局与官子；另附网上进阶和高级课程，可选择观看。</span></button>
    <p class="go-learning-optional">两个教程区分别保存观看进度。进阶可跳过；网上课程在原站打开，登录和费用以原站为准。</p>
  </DialogShell>
  <TutorialMatchView v-if="open" :game="game" :level="level" :live="live" :opposed="opposed" @close="open = false" />
</template>

<style>
.tutorial-trigger { flex: none; }
.go-learning-menu > p { margin: 0 0 14px; color: #7d8d6c; font-size: 12px; line-height: 1.7; }.go-learning-choice { display: flex; flex-direction: column; width: 100%; gap: 9px; padding: 18px; margin: 10px 0; text-align: left; border: 1px solid #c5d1b1; border-radius: 12px; background: #edf0df; color: #31533e; }.go-learning-choice strong { display: flex; align-items: center; justify-content: space-between; font: 23px 'Songti SC',serif; }.go-learning-choice strong svg { width: 18px; height: 18px; }.go-learning-choice > span { font-size: 12px; color: #788868; line-height: 1.8; }.go-learning-choice--advanced { background: #f0ead8; border-color: #d4c6a2; }.go-learning-menu .go-learning-optional { margin: 12px 0 0; font-size: 10px; }
@media(max-height:550px) { .go-learning-choice { padding: 11px 14px; gap: 5px; }.go-learning-choice strong { font-size: 20px; }.go-learning-menu > p { font-size: 11px; margin-bottom: 8px; }.go-learning-choice > span { font-size: 11px; } }
.table-tutorial-entry { position: absolute; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right)); z-index: 75; }.table-tutorial-entry .tutorial-trigger { border-color: #c8d0ad88; background: #f6f2e4ed; color: #244b3c; }
@media (max-height: 500px) and (orientation: landscape) { .tutorial-trigger { min-height: 30px; padding: 5px 8px; } .tutorial-trigger .app-icon { width: 16px; height: 16px; } }
</style>
