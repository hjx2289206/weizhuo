<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{ name: string | null; busy: boolean }>()
const emit = defineEmits<{ (e: 'save', name: string): void }>()

const draft = ref(props.name ?? '')
watch(
  () => props.name,
  (value) => {
    draft.value = value ?? ''
  },
)

const trimmed = computed(() => draft.value.trim())
const dirty = computed(() => trimmed.value !== (props.name ?? '').trim())
const valid = computed(() => trimmed.value.length > 0 && trimmed.value.length <= 8)

function submit(): void {
  if (!dirty.value || !valid.value) return
  emit('save', trimmed.value)
}
</script>

<template>
  <form class="field nickname-editor" @submit.prevent="submit">
    <input
      v-model="draft"
      type="text"
      autocomplete="nickname"
      maxlength="8"
      :placeholder="name ? '修改昵称' : '昵称'"
      aria-label="昵称"
    />
    <button class="button small ghost" type="submit" :disabled="busy || !dirty || !valid">改名</button>
  </form>
</template>
