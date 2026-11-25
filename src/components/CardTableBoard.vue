<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Snapshot, Seat } from '../../shared/protocol'
import type { DealMotion } from '../useDealAnimation'
import { usePhonePlayLayout } from '../usePhonePlayLayout'
import { bottomCardText } from '../screens/cardText'
import PhonePlayZone from './PhonePlayZone.vue'
import TableDealAnimation from './TableDealAnimation.vue'
import AppIcon from './AppIcon.vue'
import RobotIcon from './RobotIcon.vue'

const props = defineProps<{ state: Snapshot | null; deal?: DealMotion | null; selfHint?: string }>()
const board = ref<HTMLElement | null>(null)
const guandan = computed(() => props.state?.game === 'guandan')
const ddzLayout = usePhonePlayLayout(board, 3), gdLayout = usePhonePlayLayout(board, 4)
const self = computed(() => props.state?.selfSeat ?? 0)
const seats = computed(() => props.state?.seats ?? [])
const observing = computed(() => props.state?.role === 'spectator')
const seatCount = computed(() => guandan.value ? 4 : 3)
const lanes = computed(() => (guandan.value ? [{ offset: -1, position: 'left' as const }, { offset: 2, position: 'top' as const }, { offset: 1, position: 'right' as const }]
  : [{ offset: -1, position: 'left' as const }, { offset: 1, position: 'right' as const }]).map(lane => ({ ...lane, seat: seats.value.find(seat => seat.id === (self.value + lane.offset + seatCount.value) % seatCount.value) })))
const mySeat = computed(() => seats.value.find(seat => seat.id === self.value))
function play(seat: number) { const s = props.state; return s?.tablePlays.slice(s.trickStartIndex).filter(play => play.seatId === seat).at(-1) }
const ownPlay = computed(() => play(self.value))
function landlord(seat: number) { return props.state?.game === 'doudizhu' && props.state.landlord === seat }
function seatAria(seat: Seat | undefined): string {
  if (!seat?.name) return `${(seat?.id ?? 0) + 1} 号座 · 待加入`
  const state = props.state, bits = [seat.name, state?.phase === 'lobby' ? seat.ready ? '已准备' : '未准备' : `剩 ${seat.count} 张`]
  if (state?.game === 'doudizhu' && state.landlord !== null) bits.push(landlord(seat.id) ? '地主' : '农民')
  if (seat.isBot) bits.push(seat.botTier === 'easy' ? '易机器人' : '强机器人')
  else if (seat.autoPlay) bits.push('托管中')
  else if (!seat.connected) bits.push('离线')
  if (state?.game === 'guandan' && state.guandan.finishOrder.includes(seat.id)) bits.push(['头游', '二游', '三游', '末游'][state.guandan.finishOrder.indexOf(seat.id)]!)
  return bits.join(' · ')
}
const bottom = computed(() => props.state?.game === 'doudizhu' ? props.state.bottom : [])
function layout(position: 'left' | 'right' | 'top' | 'self', count: number) { return (guandan.value ? gdLayout : ddzLayout)(position, count) }
</script>

<template>
  <div ref="board" class="phone-board" :class="{ 'guandan-phone-board': guandan }" aria-label="公开牌桌">
    <TableDealAnimation :deal="deal ?? null" :seats="seats" :self-seat="self" compact />
    <div v-if="state?.game === 'doudizhu' && state.phase !== 'lobby'" class="phone-bottom-cards" role="group" aria-label="本局底牌"><span v-for="(card, i) in bottom.length ? bottom : [null, null, null]" :key="i" class="phone-bottom-card" :aria-label="card ? undefined : '未知底牌'" :class="{ 'is-red': card && bottomCardText(card).red }">{{ card ? bottomCardText(card).text : '?' }}</span></div>
    <slot />
    <div v-for="lane in lanes" :key="lane.position" :class="[...(guandan ? ['guandan-seat', `guandan-seat--${lane.position}`] : ['phone-opponent', `is-${lane.position}`]), { 'is-active': state?.turn === lane.seat?.id, offline: lane.seat?.name && !lane.seat.connected && !lane.seat.isBot && !lane.seat.autoPlay }]" :data-seat-id="lane.seat?.id">
      <span class="phone-player-badge"><span class="phone-player-avatar" :class="{ 'is-landlord': lane.seat && landlord(lane.seat.id), 'is-partner': guandan && lane.position === 'top' }" :title="lane.seat?.name || '待加入'" :aria-label="seatAria(lane.seat)">{{ (lane.seat?.name || '待').slice(0, 1) }}<AppIcon v-if="lane.seat && landlord(lane.seat.id)" class="landlord-mark" name="crown" /><span v-if="lane.seat?.isBot" class="robot-marker" role="img" :aria-label="lane.seat.botTier === 'easy' ? '易机器人' : '强机器人'"><RobotIcon /></span></span><span class="opponent-count">{{ !lane.seat?.name ? '待加入' : state?.phase === 'lobby' ? lane.seat.ready ? '已准备' : '未准备' : `剩 ${lane.seat.count} 张` }}</span></span>
      <span v-if="lane.seat?.name && !lane.seat.connected && !lane.seat.isBot && !lane.seat.autoPlay" class="seat-offline">离线</span>
      <span v-if="lane.seat?.autoPlay && !lane.seat.isBot" class="automation-status">托管中</span>
      <span v-if="state?.game === 'guandan' && lane.seat && state.guandan.finishOrder.includes(lane.seat.id)" class="guandan-finish-tag">{{ ['头游', '二游', '三游', '末游'][state.guandan.finishOrder.indexOf(lane.seat.id)] }}</span>
    </div>
    <PhonePlayZone v-for="lane in lanes" :key="`play-${lane.position}`" :position="lane.position" :cards="lane.seat?.passed ? [] : lane.seat ? play(lane.seat.id)?.cards ?? [] : []" :passed="lane.seat?.passed" :seat-id="lane.seat?.id" :layout="layout(lane.position, lane.seat?.passed ? 0 : lane.seat ? play(lane.seat.id)?.cards.length ?? 0 : 0)" />
    <PhonePlayZone position="self" :cards="mySeat?.passed ? [] : ownPlay?.cards ?? []" :passed="mySeat?.passed" :seat-id="self" :layout="layout('self', mySeat?.passed ? 0 : ownPlay?.cards.length ?? 0)" :active="state?.turn === self" :hint="selfHint ?? state?.message ?? '等待开始'" />
    <div v-if="observing" class="watch-bottom-seat phone-player-badge" :class="{ 'is-current': state?.turn === self }" :aria-label="seatAria(mySeat)">
      <span class="phone-player-avatar" :class="{ 'is-landlord': landlord(self) }">{{ (mySeat?.name || '待').slice(0, 1) }}<AppIcon v-if="landlord(self)" class="landlord-mark" name="crown" /></span>
      <span class="opponent-count">{{ !mySeat?.name ? '待加入' : state?.phase === 'lobby' ? mySeat.ready ? '已准备' : '未准备' : `剩 ${mySeat.count} 张` }}</span>
    </div>
  </div>
</template>

<style scoped>
.watch-bottom-seat { position: absolute; z-index: 3; left: 50%; bottom: 6px; transform: translateX(-50%); }
.watch-bottom-seat.is-current .phone-player-avatar { border-color: #b99e5f; box-shadow: 0 0 0 3px #cfb56d47; }
</style>
