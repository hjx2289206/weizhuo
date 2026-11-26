<script setup lang="ts">
import { computed } from 'vue';
import { phoneSeats } from '../../shared/tableSeats';
import type { Seat } from '../../shared/protocol';
import { dealCardDelay, dealTravelDuration, DEAL_FLIGHT_MS } from '../../shared/dealAnimation';
import type { DealMotion } from '../useDealAnimation';
import PlayingCard from './PlayingCard.vue';

const props = defineProps<{ deal: DealMotion | null; seats: Seat[]; compact?: boolean; selfSeat?: number | null }>();
const flights = computed(() => {
  const deal = props.deal;
  if (!deal) return [];
  const phonePositions = !props.compact ? null : deal.seatCount === 3 ? [[.5,.9],[.9,.5],[.1,.5]]
    : deal.seatCount === 4 ? [[.5,.9],[.9,.5],[.5,.1],[.1,.5]]
      : phoneSeats(deal.seatCount).map(({ x, y }) => [x, y]);
  return Array.from({ length: deal.cardsPerSeat * deal.seatCount }, (_, index) => {
    const seatIndex = index % deal.seatCount;
    const seat = props.seats[seatIndex];
    const relative = ((seat?.id ?? seatIndex) - (props.selfSeat ?? 0) + deal.seatCount) % deal.seatCount;
    const [x,y] = phonePositions?.[relative] ?? [seat?.x ?? .5,seat?.y ?? .9];
    const dx = x - .5, dy = y - .5;
    const scale = .72 / Math.max(Math.abs(dx), Math.abs(dy), .1);
    return {
      key: index,
      own: (seat?.id ?? seatIndex) === props.selfSeat,
      delay: dealCardDelay(Math.floor(index / deal.seatCount), seatIndex, deal.seatCount) - deal.elapsedMs,
      x: `${dx * scale * 100}cqw`, y: `${dy * scale * 100}cqh`,
      angle: `${Math.atan2(dy, dx) * 180 / Math.PI + 450}deg`,
    };
  }).filter(flight => flight.delay + DEAL_FLIGHT_MS > 0 && !(props.compact && flight.own));
});
</script>

<template>
  <div v-if="deal" :key="deal.key" class="table-deal-layer" :class="{ 'is-compact': compact }" :style="{ '--deal-origin-y': deal.seatCount === 3 ? (compact ? '65%' : '29%') : '48%' }" aria-hidden="true">
    <div class="deal-spinning-deck" :style="{ animationDuration: `${dealTravelDuration(deal.seatCount, deal.cardsPerSeat)}ms`, animationDelay: `${-deal.elapsedMs}ms` }">
      <PlayingCard back />
    </div>
    <div v-for="flight in flights" :key="flight.key" class="deal-flight" :style="{
      '--deal-x': flight.x, '--deal-y': flight.y, '--deal-angle': flight.angle,
      animationDelay: `${flight.delay}ms`, animationDuration: `${DEAL_FLIGHT_MS}ms`,
    }"><PlayingCard back /></div>
  </div>
</template>

<style scoped>
.table-deal-layer { position:absolute;inset:0;z-index:12;pointer-events:none;overflow:hidden;container-type:size; }
.deal-spinning-deck,.deal-flight { position:absolute;left:50%;top:var(--deal-origin-y);width:clamp(48px,8cqw,90px);aspect-ratio:100/144;filter:drop-shadow(0 6px 4px #102d3450); }
.deal-spinning-deck { animation:deal-spin linear both; }
.deal-flight { animation:deal-out cubic-bezier(.38,.02,.74,.58) both; }
.is-compact .deal-spinning-deck,.is-compact .deal-flight { width:clamp(30px,5cqw,52px); }
@keyframes deal-spin { 0%{transform:translate(-50%,-50%) rotate(-30deg) scale(.65);opacity:0} 8%{opacity:1;transform:translate(-50%,-50%) rotate(0deg) scale(1)} 90%{opacity:1} 100%{transform:translate(-50%,-50%) rotate(1080deg) scale(.78);opacity:0} }
@keyframes deal-out { 0%{transform:translate(-50%,-50%) rotate(0deg);opacity:0} 7%{opacity:1} 72%{opacity:1} 100%{transform:translate(calc(-50% + var(--deal-x)),calc(-50% + var(--deal-y))) rotate(var(--deal-angle)) scale(.72);opacity:0} }
@media(prefers-reduced-motion:reduce) { .table-deal-layer{display:none} }
</style>
