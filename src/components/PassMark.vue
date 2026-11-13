<script setup lang="ts">
defineProps<{ prominent?: boolean }>()
</script>

<template>
  <svg class="pass-mark" :class="{ 'is-prominent': prominent }" viewBox="3 0 80 48" role="img" aria-label="过牌" focusable="false">
    <title>不出，过牌，让下家继续</title>
    <g transform="rotate(-12 29.5 24)">
      <rect x="17" y="7" width="25" height="34" rx="4" fill="currentColor" :fill-opacity="prominent ? '.18' : '.055'" stroke="currentColor" :stroke-width="prominent ? '2.8' : '1.6'" />
      <rect x="21" y="11" width="17" height="26" rx="2" fill="none" stroke="currentColor" stroke-opacity=".28" />
      <path d="M29.5 18 L34 24 L29.5 30 L25 24 Z" fill="#b59b63" fill-opacity=".7" />
    </g>
    <path d="M43 33 C49 22 59 19 71 23 M64 16 L72 23 L65 31" fill="none" stroke="currentColor" :stroke-width="prominent ? '3.8' : '2.2'" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>

<style scoped>
.pass-mark { display: block; flex: none; grid-column: 1 / -1; justify-self: center; width: 64px; height: 38px; overflow: visible; color: #45654d; }
@media (max-height: 360px) { .pass-mark { width: 56px; height: 34px; } }
.pass-mark.is-prominent { width:96px;height:58px;color:#ffe3a2;filter:drop-shadow(0 2px 2px #0b281c) drop-shadow(0 0 6px #efd18b33); }
</style>
