<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PhoneScreenApi } from '../usePhoneScreen'
import { installAutoScreenEntry } from '../autoScreenEntry'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ screen: PhoneScreenApi; strict?: boolean; orientation?: 'landscape' | 'portrait' }>()
const mobile = ref(false)
const preview = ref(false)
const panel = ref<HTMLElement | null>(null)
let stopAuto = () => {}
function measure(): void {
  mobile.value = navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (Math.min(innerWidth, innerHeight) <= 600 && Math.max(innerWidth, innerHeight) <= 1100)
}
const portrait = computed(() => props.orientation === 'portrait')
const oriented = computed(() => portrait.value ? !props.screen.landscape.value : props.screen.landscape.value)
const visible = computed(() => props.strict && !oriented.value || mobile.value && !preview.value && !(oriented.value && (props.screen.active.value || props.screen.dismissed.value)))
function browse(): void { if (props.strict && !oriented.value) return; preview.value = true; stopAuto(); props.screen.dismiss() }
watch(visible, shown => { if (shown) void nextTick(() => panel.value?.querySelector<HTMLButtonElement>('button')?.focus()) })
function containFocus(event: FocusEvent): void {
  if (!visible.value || !panel.value || panel.value.contains(event.target as Node)) return
  panel.value.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
}
function trapFocus(event: KeyboardEvent): void {
  const buttons = panel.value?.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
  if (!buttons?.length) return
  const first = buttons[0]!, last = buttons[buttons.length - 1]!
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
watch(() => props.screen.active.value, (active, wasActive) => {
  if (wasActive && !active) browse() // Respect the user's native exit; never force them back in.
})
onMounted(() => {
  measure()
  window.addEventListener('resize', measure)
  document.addEventListener('focusin', containFocus, true)
  stopAuto = installAutoScreenEntry({
    enter: props.screen.enter, active: () => props.screen.active.value, busy: () => props.screen.busy.value,
    listen(listener) {
      document.addEventListener('pointerdown', listener, true)
      document.addEventListener('keydown', listener, true)
      return () => { document.removeEventListener('pointerdown', listener, true); document.removeEventListener('keydown', listener, true) }
    },
  })
})
onBeforeUnmount(() => { stopAuto(); window.removeEventListener('resize', measure); document.removeEventListener('focusin', containFocus, true) })
</script>
<template>
  <Teleport to="body">
    <section v-if="visible" ref="panel" class="site-entry" role="dialog" aria-modal="true" :aria-label="portrait ? '进入竖屏棋盘' : '进入横屏全屏桌游'" @keydown.tab="trapFocus" @keydown.esc.prevent="browse">
      <div class="site-entry-art" aria-hidden="true"><AppIcon name="phone" /><AppIcon name="rotate" /></div>
      <p class="entry-eyebrow">桌游合集</p>
      <h1>{{ portrait ? '竖起屏幕，下盘棋。' : '横过来，开一局。' }}</h1>
      <p class="entry-description">{{ portrait ? '请竖放设备，棋盘和操作会在一屏内显示。' : strict ? '请横放手机，所有入口和按钮都会在一屏内显示。' : '完整牌桌，刚好握在手里。' }}</p>
      <button class="entry-primary" type="button" :disabled="screen.busy.value" @click="screen.enter"><AppIcon name="fullscreen" />{{ screen.busy.value ? '正在进入…' : portrait ? '进入竖屏全屏' : '进入横屏全屏' }}</button>
      <p class="entry-note" role="status">{{ screen.note.value }}</p>
      <button v-if="!strict || oriented" class="entry-browse" data-skip-fullscreen type="button" @click="browse"><AppIcon :name="oriented ? 'right' : 'home'" />{{ oriented ? portrait ? '继续浏览器竖屏' : '继续浏览器横屏' : '先浏览大厅' }}</button>
    </section>
  </Teleport>
</template>
