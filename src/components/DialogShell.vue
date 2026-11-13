<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
defineOptions({ inheritAttrs: false })
defineProps<{ title: string; backdropClass?: string }>()
const emit = defineEmits<{ close: [] }>()
const root = ref<HTMLElement | null>(null)
let previous: HTMLElement | null = null
function keydown(event: KeyboardEvent): void {
  if (!root.value?.contains(document.activeElement)) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); emit('close'); return }
  if (event.key !== 'Tab') return
  const items = [...(root.value?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, [tabindex="0"]') ?? [])]
  const first = items[0]; const last = items.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(() => {
  previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  root.value?.querySelector<HTMLButtonElement>('button')?.focus()
  document.addEventListener('keydown', keydown, true)
})
onBeforeUnmount(() => { document.removeEventListener('keydown', keydown, true); previous?.focus() })
</script>
<template>
  <Teleport to="body">
    <div class="tools-backdrop" :class="backdropClass" @click.self="emit('close')">
      <section ref="root" class="tools-dialog" v-bind="$attrs" role="dialog" aria-modal="true" :aria-label="title">
        <header class="tools-dialog-heading"><h2>{{ title }}</h2><button class="icon-button" type="button" aria-label="关闭面板" @click="emit('close')"><AppIcon name="close" /></button></header>
        <slot />
      </section>
    </div>
  </Teleport>
</template>
