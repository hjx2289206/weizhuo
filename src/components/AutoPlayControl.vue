<script setup lang="ts">
import type { GameViewCommon } from '../screens/useGameView'
import RobotIcon from './RobotIcon.vue'
defineProps<{ view: GameViewCommon; busy: boolean; connected: boolean }>()
</script>

<template>
  <div v-if="view.canToggleAutoPlay.value" class="automation-bar">
    <button
      class="button small ghost automation-button"
      :class="{ 'is-active': view.autoPlayEnabled.value }"
      type="button"
      :disabled="busy || !connected"
      :aria-pressed="view.autoPlayEnabled.value"
      :title="view.autoPlayTitle.value"
      @click="view.toggleAutoPlay()"
    >
      <RobotIcon />
      <span>{{ view.autoPlayEnabled.value ? '取消托管' : '托管' }}</span>
    </button>
    <span v-if="view.autoPlayStatus.value" class="automation-status muted" :title="view.autoPlayStatus.value" role="status">{{ view.autoPlayStatus.value }}</span>
  </div>
</template>
