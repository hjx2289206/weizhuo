<script setup lang="ts">
/** Header sound switch: one shared reactive state, persisted in localStorage. */
import AppIcon from './AppIcon.vue'
import { soundOn, toggleSound, unlockAudio } from '../sound'

const on = soundOn

function click(): void {
  toggleSound()
  // Turning sounds on is itself a gesture, so lift any autoplay block right here.
  if (on.value) unlockAudio()
}
</script>

<template>
  <button
    class="sound-toggle"
    type="button"
    :aria-pressed="on"
    :title="on ? '关闭音效' : '开启音效'"
    :aria-label="on ? '关闭音效' : '开启音效'"
    @click="click"
  >
    <AppIcon :name="on ? 'volume' : 'muted'" />
  </button>
</template>
