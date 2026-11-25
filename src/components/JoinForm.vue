<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { isBlackFirstGame } from '../../shared/gameCatalog'
import type { GameKind, Seat } from '../../shared/protocol'
import type { SavedSession } from '../sessionStore'
import { expectedSeatCount } from '../screens/useGameView'

const props = withDefaults(
  defineProps<{
    /** Room + seat the browser already holds a credential for (never the token itself). */
    savedSession: SavedSession | null
    /** Room code the controller already resolved from the URL, if any. */
    initialCode: string
    initialSeat: number
    initialName: string
    /** Public roster after an `inspect`, or null before one. */
    roster: Seat[] | null
    /** Kind of the room being joined when it is already known, for the seat choices. */
    game?: GameKind | null
    busy: boolean
    compact?: boolean
    /** Live state of this device's own replacement request for exactly this room + seat. */
    request?: JoinRequestStatus | null
  }>(),
  { compact: false, game: null, request: null },
)

/** Pending / rejected / cancelled state of this device's own seat request. */
interface JoinRequestStatus {
  status: 'pending' | 'rejected' | 'cancelled'
  code: string
  seatId: number
  message: string
}

const emit = defineEmits<{
  (e: 'inspect', code: string): void
  (e: 'join', payload: { code: string; seat: number; name: string }): void
  (e: 'request', payload: { code: string; seat: number; name: string }): void
  (e: 'resume'): void
}>()

const code = ref(props.initialCode)
const seat = ref(props.initialSeat)
/** Filled by the guarded watch below, never straight from props: see its comment. */
const name = ref('')
const notice = ref('')

watch(
  () => props.initialCode,
  (value) => {
    if (value) code.value = value
  },
)
watch(
  () => props.initialSeat,
  (value) => {
    if (Number.isSafeInteger(value)) seat.value = value
  },
)

/**
 * Seat choices: the real roster once it is known, otherwise every seat the game could have
 * (up to four while the kind is unknown). An explicit `?seat=` intent is never replaced — it is
 * offered as its own option so the select can show what the link asked for.
 */
const seatIds = computed(() => {
  if (props.roster) return props.roster.map((entry) => entry.id)
  const count = expectedSeatCount(props.game)
  return Array.from({ length: count }, (_, index) => index)
})

const seatOptions = computed(() => {
  const ids = seatIds.value
  return ids.includes(seat.value) ? ids : [...ids, seat.value].sort((left, right) => left - right)
})

/** The link (or the typed seat) points at a seat this room does not have. */
const seatInvalid = computed(() => props.roster != null && !props.roster.some((entry) => entry.id === seat.value))

const target = computed(() => props.roster?.find((entry) => entry.id === seat.value) ?? null)
/** Someone else is sitting there, so taking it needs the host's approval. */
const occupied = computed(() => target.value !== null && target.value.name !== null)
/** This browser already owns the seat: resume the exact identity instead of asking for it. */
const owned = computed(() => {
  const saved = props.savedSession
  if (!saved || saved.role !== 'player' || saved.seatId === null) return false
  return saved.code === code.value.trim().toUpperCase() && saved.seatId === seat.value
})

/**
 * A nickname only belongs to a room+seat this browser actually owns. Prefilling it
 * from another seat or another room is a cached-identity leak: the seat invite wins,
 * so the field stays empty until the form's room+seat matches the saved credential
 * (typing the saved room+seat by hand still fills it, while the name is still empty).
 */
watch(
  [() => props.initialName, owned],
  ([value, match]) => {
    if (match && value && !name.value) name.value = value
  },
  { immediate: true },
)

/**
 * A request status only describes the room + seat the form currently points at, so a status
 * from another room (or another seat the user just picked) can never leak into this form.
 */
const requestHere = computed<JoinRequestStatus | null>(() => {
  const request = props.request
  if (!request) return null
  if (request.code.trim().toUpperCase() !== code.value.trim().toUpperCase()) return null
  if (request.seatId !== seat.value) return null
  return request
})
/** While the host has not answered, this device may not submit the same request again. */
const pendingHere = computed(() => requestHere.value?.status === 'pending')
const requestStatusText = computed(() => {
  const request = requestHere.value
  if (!request) return ''
  if (request.status === 'pending') return '等待房主同意…通过后才会看到手牌，请保持本页面打开。'
  if (request.status === 'rejected') return '房主拒绝了这次替换申请；可以换一个座位或昵称再申请。'
  return '申请已取消，可以重新申请。'
})

function seatLabel(id: number): string {
  const entry = props.roster?.find(candidate => candidate.id === id)
  const label = isBlackFirstGame(props.game) ? id === 0 ? '黑方' : '白方' : props.game === 'chess' ? id === 0 ? '白方' : '黑方' : props.game === 'xiangqi' ? id === 0 ? '红方' : '黑方' : `${id + 1} 号座`
  if (!entry) return props.roster ? `${label} · 不存在` : label
  if (!entry.name) return `${label} · 空`
  return `${label} · ${entry.name}（${seatStatus(entry)}）`
}

function seatStatus(entry: Seat): string {
  if (entry.isBot) return entry.botTier === 'easy' ? '易机器人' : '强机器人'
  if (entry.autoPlay) return entry.connected ? '托管中' : '托管 · 离线'
  return entry.connected ? '在线' : '离线'
}

function normalizeCode(): string {
  const room = code.value.trim().toUpperCase()
  if (!/^[A-Z0-9]{3,10}$/.test(room)) {
    notice.value = '请输入 3–10 位房间号（字母或数字）'
    return ''
  }
  code.value = room
  return room
}

function submit(): void {
  notice.value = ''
  if (pendingHere.value) return
  const room = normalizeCode()
  if (!room) return
  if (owned.value) {
    emit('resume')
    return
  }
  if (seatInvalid.value) {
    notice.value = `该房间没有 ${seat.value + 1} 号座，请重新选择一个座位`
    return
  }
  const nickname = name.value.trim()
  if (!nickname) {
    notice.value = '请输入昵称'
    return
  }
  if (nickname.length > 8) {
    notice.value = '昵称最多 8 个字'
    return
  }
  const payload = { code: room, seat: seat.value, name: nickname }
  if (occupied.value) emit('request', payload)
  else emit('join', payload)
}

function inspect(): void {
  notice.value = ''
  const room = normalizeCode()
  if (!room) return
  emit('inspect', room)
}

const submitLabel = computed(() => (owned.value ? '继续游戏' : occupied.value ? '申请替换' : '入座'))
</script>

<template>
  <form class="join-panel" :class="{ 'join-panel--compact': compact }" @submit.prevent="submit">
    <template v-if="!compact">
      <h2 class="panel-title">加入牌桌</h2>
      <p class="muted">输入房间号与座位号；座位被占用时可申请替换，等待房主同意。</p>
    </template>
    <div class="form-grid">
      <label class="field">
        房间号
        <input v-model="code" type="text" autocomplete="off" maxlength="10" placeholder="如 8F3K" />
      </label>
      <label class="field">
        座位
        <select v-model.number="seat">
          <option v-for="id in seatOptions" :key="id" :value="id">{{ seatLabel(id) }}</option>
        </select>
      </label>
      <label class="field">
        昵称
        <input v-model="name" type="text" autocomplete="nickname" maxlength="8" placeholder="最多 8 个字" />
      </label>
    </div>

    <div v-if="roster" class="room-roster">
      <div
        v-for="entry in roster"
        :key="entry.id"
        class="roster-row"
        :class="{ 'is-empty': !entry.name, offline: !entry.connected && !entry.isBot && !entry.autoPlay }"
      >
        <span class="seat-name">{{ entry.name ?? `${entry.id + 1} 号座（空）` }}</span>
        <span v-if="entry.name" class="automation-status">{{ seatStatus(entry) }}</span>
      </div>
    </div>

    <p v-if="seatInvalid" class="muted" role="alert">
      链接指向的 {{ seat + 1 }} 号座在这个房间并不存在，请从上面的座位里重新选择一个。
    </p>
    <p v-else-if="owned" class="muted">这台设备就是该座位的主人，继续即恢复原有手牌与牌局。</p>
    <p v-else-if="occupied" class="muted">
      该座位由 {{ target?.name }} 占用（{{ target ? seatStatus(target) : '' }}），申请后需房主同意才会接手。
    </p>
    <p v-if="notice" class="muted" role="alert">{{ notice }}</p>
    <p v-if="requestStatusText" class="muted" role="status">{{ requestStatusText }}</p>

    <div class="dock-actions">
      <button class="button ghost" type="button" :disabled="busy" @click="inspect">查看房间</button>
      <button class="button primary" type="submit" :disabled="busy || pendingHere">{{ submitLabel }}</button>
    </div>
  </form>
</template>
