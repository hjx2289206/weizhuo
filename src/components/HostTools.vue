<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Phase, RoomMode, Seat } from '../../shared/protocol'

const props = defineProps<{
  seats: Seat[]
  roomMode: RoomMode
  selfSeat: number | null
  phase: Phase
  busy?: boolean
  canClearEmpty?: boolean
}>()

const emit = defineEmits<{
  transfer: [seatId: number]
  removeOffline: []
  clearEmpty: []
  dissolve: []
}>()

const open = ref(false)
const confirming = ref(false)
const targetSeat = ref<number | null>(null)
const root = ref<HTMLElement | null>(null)

const transferTargets = computed(() =>
  props.seats.filter((seat) => seat.name !== null && seat.connected && !seat.isBot && seat.id !== props.selfSeat),
)
const offlineSeats = computed(() =>
  props.seats.filter((seat) => seat.name !== null && !seat.connected && !seat.isBot && !seat.autoPlay),
)
const canTransfer = computed(() => props.roomMode === 'phone' && transferTargets.value.length > 0)
const canRemoveOffline = computed(() => props.phase === 'lobby' && offlineSeats.value.length > 0)

watch(transferTargets, (targets) => {
  if (targetSeat.value !== null && !targets.some((seat) => seat.id === targetSeat.value)) targetSeat.value = null
})

function close(): void {
  open.value = false
  confirming.value = false
}

function transfer(): void {
  const seatId = targetSeat.value
  if (seatId === null) return
  emit('transfer', seatId)
  close()
}

function removeOffline(): void {
  emit('removeOffline')
  close()
}

function clearEmpty(): void {
  emit('clearEmpty')
  close()
}

function dissolve(): void {
  emit('dissolve')
  close()
}

function onOutside(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target
  if (target instanceof Node && root.value?.contains(target)) return
  close()
}

onMounted(() => window.addEventListener('pointerdown', onOutside))
onBeforeUnmount(() => window.removeEventListener('pointerdown', onOutside))
</script>

<template>
  <div ref="root" class="host-tools" @pointerdown.stop>
    <button
      class="host-tools-trigger"
      type="button"
      aria-label="房主工具"
      title="房主工具"
      :aria-expanded="open"
      aria-controls="host-tools-menu"
      @click="open = !open"
    ><AppIcon name="crown" /></button>
    <div v-if="open" id="host-tools-menu" class="host-tools-menu" role="menu" aria-label="房主工具">
      <div class="host-tools-heading">
        <span>房主工具</span>
        <small>仅房主可见</small>
      </div>

      <div v-if="canTransfer" class="host-tools-section">
        <label for="host-tools-transfer">转让房主</label>
        <div class="host-tools-row">
          <select id="host-tools-transfer" v-model.number="targetSeat" :disabled="busy">
            <option :value="null" disabled>选择在线玩家</option>
            <option v-for="seat in transferTargets" :key="seat.id" :value="seat.id">
              {{ seat.name }}（{{ seat.id + 1 }} 号座）
            </option>
          </select>
          <button
            class="button small ghost"
            type="button"
            :disabled="busy || targetSeat === null"
            @click="transfer"
          ><AppIcon name="swap" />转让</button>
        </div>
      </div>

      <div v-if="phase === 'lobby'" class="host-tools-section">
        <button
          class="button small ghost host-tools-action"
          type="button"
          :disabled="busy || !canRemoveOffline"
          @click="removeOffline"
        ><AppIcon name="users" />移除离线座位{{ offlineSeats.length ? `（${offlineSeats.length}）` : '' }}</button>
        <p v-if="!canRemoveOffline" class="host-tools-note">当前没有离线玩家。</p>
        <button
          v-if="canClearEmpty"
          class="button small ghost host-tools-action"
          type="button"
          :disabled="busy"
          @click="clearEmpty"
        ><AppIcon name="trash" />清理空位</button>
      </div>

      <div class="host-tools-section host-tools-danger">
        <button
          v-if="!confirming"
          class="button small ghost host-tools-action is-danger"
          type="button"
          :disabled="busy"
          @click="confirming = true"
        ><AppIcon name="close" />解散房间</button>
        <template v-else>
          <p class="host-tools-confirm">解散后所有玩家都会被带回大厅，确定吗？</p>
          <div class="host-tools-row">
            <button class="button small ghost" type="button" :disabled="busy" @click="confirming = false">取消</button>
            <button class="button small host-tools-confirm-button" type="button" :disabled="busy" @click="dissolve">
              确认解散
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
