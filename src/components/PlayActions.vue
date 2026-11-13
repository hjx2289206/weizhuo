<script setup lang="ts">
const props = withDefaults(
  defineProps<{ selectedCount: number; canPlay: boolean; canPass: boolean; canHint?: boolean }>(),
  { canHint: false },
)
defineEmits<{ play: []; pass: []; clear: []; hint: [] }>()
</script>

<template>
  <section class="play-actions" aria-label="出牌操作">
    <div class="play-actions-info">
      <span class="selection-count">已选 {{ props.selectedCount }} 张</span>
      <slot />
    </div>
    <div class="play-actions-buttons">
      <button class="button ghost hint-button" type="button" :disabled="!props.canHint" title="选择一手合法牌，再点可切换" @click="$emit('hint')">提示</button>
      <button class="button primary" :class="{ attention: props.canPlay }" type="button" :disabled="!props.canPlay" @click="$emit('play')">出牌</button>
      <button class="button secondary" type="button" :disabled="!props.canPass" @click="$emit('pass')">不出</button>
      <button class="button ghost" type="button" :disabled="props.selectedCount === 0" @click="$emit('clear')">清空</button>
    </div>
  </section>
</template>

<style scoped>
.play-actions { display: flex; flex: none; width: 100%; min-width: 0; align-items: center; justify-content: center; gap: 10px; }
.play-actions-info { display: flex; min-width: 0; align-items: center; gap: 9px; }
.selection-count { flex: none; white-space: nowrap; font-size: 10px; }
.play-actions-buttons { display: flex; flex: none; align-items: center; gap: 8px; }
.play-actions-buttons .button { min-height: 34px; min-width: 46px; padding: 6px 11px; border-radius: 10px; background: transparent; color: #3d624e; font-size: 11px; white-space: nowrap; }
.play-actions-buttons .primary { min-width: 84px; }
@media (max-width: 560px) {
  .play-actions { gap: 7px; }
  .play-actions-info { flex: 1; flex-wrap: wrap; gap: 2px; }
  .play-actions-buttons { gap: 5px; }
  .play-actions-buttons .button { min-width: 42px; padding: 6px 8px; }
  .play-actions-buttons .primary { min-width: 72px; }
}
</style>
