<script setup lang="ts">
import type { SeatRequest } from '../../shared/protocol'

defineProps<{ requests: SeatRequest[]; busy: boolean }>()
const emit = defineEmits<{ (e: 'decide', requestId: string, approve: boolean): void }>()

/** `previousName` is the occupant the newcomer would replace; an empty target is an empty seat. */
function target(request: SeatRequest): string {
  return request.previousName ? `${request.seatId + 1} 号座（现为 ${request.previousName}）` : `${request.seatId + 1} 号座（空座）`
}
</script>

<template>
  <section class="seat-request-panel">
    <h3 class="panel-title">入座申请</h3>
    <p v-if="requests.length === 0" class="muted">暂无申请</p>
    <article v-for="request in requests" :key="request.id" class="request-card">
      <p><strong>{{ request.name }}</strong> 申请 {{ target(request) }}</p>
      <p v-if="request.connected" class="muted">该座位当前在线，同意后会顶替正在使用的旧设备。</p>
      <p v-else class="muted">该座位当前离线，同意后由申请人接手。</p>
      <div class="dock-actions">
        <button class="button primary" type="button" :disabled="busy" @click="emit('decide', request.id, true)">同意</button>
        <button class="button ghost" type="button" :disabled="busy" @click="emit('decide', request.id, false)">拒绝</button>
      </div>
    </article>
  </section>
</template>
