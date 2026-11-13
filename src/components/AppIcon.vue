<script setup lang="ts">
import { ICON_PATHS, type IconName } from '../icons'
defineProps<{ name: IconName }>()
</script>
<template>
  <svg class="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path v-for="(path, i) in ICON_PATHS[name]" :key="i" :d="path" />
  </svg>
</template>
<style>
.app-icon { display: block; width: 20px; height: 20px; flex: none; pointer-events: none; }
</style>
