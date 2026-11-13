<script setup lang="ts">
import type { GuandanView } from '../screens/useGuandanView'

defineProps<{ view: GuandanView }>()
</script>

<template>
  <div v-if="view.exchangeNotice.value && !view.dealing.value" class="guandan-exchange-notice" role="status" aria-live="polite" aria-atomic="true">
    <strong>{{ view.exchangeNotice.value.title }}</strong>
    <span>{{ view.exchangeNotice.value.detail }}</span>
  </div>
</template>

<style scoped>
.guandan-exchange-notice { flex: none; display: flex; flex-direction: column; align-items: center; gap: 3px; margin: 0; padding: 5px 12px; background: transparent; color: #526d49; font-size: 11px; line-height: 1.5; text-align: center; overflow-wrap: anywhere; }
.guandan-exchange-notice strong { color: #8d6b25; font-size: 13px; font-weight: 600; }
@media (max-height: 400px) { .guandan-exchange-notice { gap: 1px; padding: 2px 8px; font-size: 9px; line-height: 1.35; } .guandan-exchange-notice strong { font-size: 11px; } }
</style>
