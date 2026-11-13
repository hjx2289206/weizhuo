<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { computed } from 'vue'
import { HAND_SORT_LABELS, type HandSortMode } from '../handSort'

const props = defineProps<{ mode: HandSortMode }>()
defineEmits<{ cycle: [] }>()
const label = computed(() => HAND_SORT_LABELS[props.mode])
</script>

<template>
  <button
    class="hand-sort-chip"
    type="button"
    :aria-label="`切换理牌方式，当前${label}`"
    :title="`切换理牌方式（当前：${label}）`"
    @pointerdown.stop
    @click.stop="$emit('cycle')"
  >
    <AppIcon class="hand-sort-icon" name="sort" />{{ label }}
  </button>
</template>

<style scoped>
.hand-sort-chip {
  position: absolute;
  top: 4px;
  right: 8px;
  z-index: 30;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-height: 24px;
  padding: 3px 9px;
  border: 1px solid #c7d1b8;
  border-radius: 20px;
  background: #f8f5e8e8;
  color: #5d7052;
  font: inherit;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
  box-shadow: 0 2px 8px #153e3314;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
}
.hand-sort-chip:active {
  transform: scale(0.96);
}
.hand-sort-chip:focus-visible {
  outline: 2px solid #b3954e;
  outline-offset: 2px;
}
.hand-sort-icon {
  font-size: 11px;
  line-height: 1;
  opacity: 0.8;
}
@media (max-height: 550px) and (orientation: landscape) {
  .hand-sort-chip {
    top: 2px;
    right: 5px;
    min-height: 20px;
    padding: 2px 7px;
    font-size: 9px;
  }
}
</style>
