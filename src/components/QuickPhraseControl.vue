<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { QUICK_PHRASES } from '../../shared/phrases'
import { HAPTIC_SELECT, vibrate } from '../haptics'

const props = defineProps<{ busy?: boolean; connected?: boolean }>()
const emit = defineEmits<{ say: [phraseId: string] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function choose(phraseId: string): void {
  // Selection feedback belongs to the fixed list, not to the server response.
  vibrate(HAPTIC_SELECT)
  emit('say', phraseId)
  open.value = false
}

function onOutside(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target
  if (target instanceof Node && root.value?.contains(target)) return
  open.value = false
}

onMounted(() => window.addEventListener('pointerdown', onOutside))
onBeforeUnmount(() => window.removeEventListener('pointerdown', onOutside))
</script>

<template>
  <div ref="root" class="quick-phrase" @pointerdown.stop>
    <button
      class="quick-phrase-trigger"
      type="button"
      aria-label="快捷语"
      title="快捷语（固定预设，无自由输入）"
      :aria-expanded="open"
      aria-controls="quick-phrase-menu"
      @click="open = !open"
    ><AppIcon name="chat" /></button>
    <div
      v-if="open"
      id="quick-phrase-menu"
      class="quick-phrase-menu"
      role="menu"
      aria-label="快捷语预设"
    >
      <div class="quick-phrase-heading">
        <span>快捷语</span>
        <small>固定预设 · 无自由输入</small>
      </div>
      <div class="quick-phrase-grid">
        <button
          v-for="phrase in QUICK_PHRASES"
          :key="phrase.id"
          class="quick-phrase-option"
          type="button"
          role="menuitem"
          :disabled="props.busy || props.connected === false"
          @click="choose(phrase.id)"
        >
          <span class="quick-phrase-emoji" aria-hidden="true">{{ phrase.emoji }}</span>
          <span>{{ phrase.text }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
