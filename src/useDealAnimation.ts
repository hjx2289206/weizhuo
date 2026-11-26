import { getCurrentScope, onScopeDispose, shallowRef, watch, type Ref } from 'vue';
import type { Snapshot } from '../shared/protocol';
import { dealDuration } from '../shared/dealAnimation';

export interface DealMotion {
  key: string;
  elapsedMs: number;
  seatCount: number;
  cardsPerSeat: number;
}

/** Elapsed time comes from the server; device clocks need not agree. Old deals never replay. */
export function useDealAnimation(state: Ref<Snapshot | null>) {
  const deal = shallowRef<DealMotion | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastKey = '';
  let fallbackSequence = 0;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function clear() {
    clearTimeout(timer);
    deal.value = null;
  }
  watch(state, (snapshot, previous) => {
    if (!snapshot || snapshot.phase === 'lobby') {
      clear();
      lastKey = '';
      return;
    }
    const stamp = snapshot.dealAnimation;
    let motion: DealMotion | null = stamp ? { ...stamp, key: `${snapshot.code}:${stamp.id}` } : null;
    // Compatibility with a running server predating deal clocks. A first mid-round
    // snapshot is settled; only a witnessed start / all-pass redeal gets motion.
    if (!stamp && previous?.code === snapshot.code) {
      const redealt = snapshot.game === 'doudizhu' && previous.phase === 'bidding' && snapshot.phase === 'bidding'
        && snapshot.hand.length > 0 && snapshot.hand.map(c => c.id).join() !== previous.hand.map(c => c.id).join();
      if (previous.phase === 'lobby' || redealt) {
        const seatCount = snapshot.seatCountSettings?.count ?? snapshot.seats.length;
        const cardsPerSeat = snapshot.seatCountSettings
          ? Math.max(snapshot.hand.length, ...snapshot.seats.map(seat => seat.count))
          : snapshot.game === 'guandan' ? 27 : snapshot.game === 'doudizhu' ? 17 : 0;
        if (seatCount && cardsPerSeat) {
          motion = { key: `${snapshot.code}:legacy:${++fallbackSequence}`, elapsedMs: 0, seatCount, cardsPerSeat };
        }
      }
    }
    if (!motion || motion.key === lastKey) return;
    clear();
    lastKey = motion.key;
    const remaining = dealDuration(motion.seatCount, motion.cardsPerSeat) - motion.elapsedMs;
    if (remaining <= 0 || reduced) return;
    deal.value = motion;
    timer = setTimeout(clear, remaining);
  }, { immediate: true });
  if (getCurrentScope()) onScopeDispose(clear);
  return deal;
}
