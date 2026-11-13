<script setup lang="ts">
import type { PhraseMessage } from '../../shared/protocol'

defineProps<{ phrase: PhraseMessage | null }>()
</script>

<template>
  <Transition name="phrase-pop">
    <div v-if="phrase" :key="phrase.at" class="phrase-banner" role="status" aria-live="polite">
      <span class="phrase-banner-speaker">{{ phrase.name }}</span>
      <span class="phrase-banner-text">{{ phrase.text }}</span>
    </div>
  </Transition>
</template>
