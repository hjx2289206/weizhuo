import { nextTick, onScopeDispose, watch, type Ref } from 'vue';
import type { Snapshot } from '../shared/protocol';
import { dealCardDelay, dealTravelDuration, DEAL_FLIGHT_MS, DEAL_REVEAL_MS } from '../shared/dealAnimation';
import { cardBitmap, warmCardArt } from './cardAnimationArt';
import type { DealMotion } from './useDealAnimation';

interface Flight { node: HTMLElement; animations: Animation[]; reveal?: () => void }
interface Pose { element: HTMLElement; face: SVGSVGElement; x: number; y: number; width: number; height: number; angle: number }

/** Private card motion uses cached pixels; only the resting hand keeps live SVG artwork. */
export function useHandMotion(state: Ref<Snapshot | null>, stage: Ref<HTMLElement | null>, deal: Ref<DealMotion | null>, departures: boolean, enabled: () => boolean = () => true) {
  const flights = new Set<Flight>(), hidden = new Map<HTMLElement, string>();
  let generation = 0, receivingAt = 0;
  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function reveal(element: HTMLElement) {
    const visibility = hidden.get(element);
    if (visibility !== undefined) element.style.visibility = visibility;
    hidden.delete(element);
  }
  function finish(flight: Flight) {
    if (!flights.delete(flight)) return;
    flight.reveal?.(); flight.animations.forEach(a => a.cancel()); flight.node.remove();
  }
  function cancel() {
    generation++;
    for (const flight of flights) finish(flight);
    for (const element of hidden.keys()) reveal(element);
  }

  /** Freeze every transition together, read every pose, then restore together. */
  function capture(elements: HTMLElement[], settle = false): Pose[] {
    const transitions = elements.map(el => el.style.transition);
    if (settle) elements.forEach(el => { el.style.transition = 'none'; });
    try {
      return elements.flatMap(element => {
        const face = element.querySelector<SVGSVGElement>('svg');
        const rect = element.getBoundingClientRect();
        if (!face || !rect.width || !rect.height) return [];
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        return [{ element, face, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
          width: element.offsetWidth || rect.width, height: element.offsetHeight || rect.height, angle: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI }];
      });
    } finally { if (settle) elements.forEach((el, i) => { el.style.transition = transitions[i]; }); }
  }
  function copy(bitmap: HTMLCanvasElement): HTMLCanvasElement {
    const canvas = document.createElement('canvas'); canvas.className = 'playing-card';
    canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    return canvas;
  }
  function ghost(pose: Pose, bitmap: HTMLCanvasElement): HTMLElement {
    const node = document.createElement('div'); node.className = 'hand-flight-card'; node.setAttribute('aria-hidden', 'true');
    node.dataset.motionCardId = pose.element.dataset.cardId;
    Object.assign(node.style, { position:'fixed', left:`${pose.x - pose.width / 2}px`, top:`${pose.y - pose.height / 2}px`,
      width:`${pose.width}px`, height:`${pose.height}px`, transform:`rotate(${pose.angle}deg)`, zIndex:'900', pointerEvents:'none' });
    node.appendChild(copy(bitmap));
    return node;
  }
  function flipArtwork(node: HTMLElement, bitmap: HTMLCanvasElement): HTMLElement {
    const front = node.firstElementChild!, back = copy(bitmap);
    front.setAttribute('data-motion-side', 'front'); back.setAttribute('data-motion-side', 'back');
    const inner = document.createElement('div'); inner.className = 'hand-flight-flip'; inner.append(back, front);
    node.replaceChildren(inner); node.style.perspective = '700px';
    return inner;
  }
  function fly(node: HTMLElement, frames: Keyframe[], duration: number, delay = 0, done?: () => void, flip?: { element: HTMLElement; delay: number }) {
    const animations = [node.animate(frames, { duration, delay, fill:'both', easing:'cubic-bezier(.22,.68,.3,1)' })];
    if (flip) animations.push(flip.element.animate([{ transform:'rotateY(0deg)' }, { transform:'rotateY(180deg)' }], {
      duration:DEAL_REVEAL_MS, delay:flip.delay, fill:'both', easing:'cubic-bezier(.4,0,.2,1)',
    }));
    const flight: Flight = { node, animations, reveal:done }; flights.add(flight);
    animations.at(-1)!.finished.then(() => finish(flight), () => finish(flight));
  }

  async function receive(ids: string[], motion: DealMotion | null) {
    const stamp = generation;
    try {
      await nextTick();
      if (stamp !== generation || reduced()) return;
      const wanted = new Set(ids);
      const elements = Array.from(stage.value?.querySelectorAll<HTMLElement>('[data-card-id]') ?? []).filter(el => wanted.has(el.dataset.cardId!));
      for (const el of elements) { hidden.set(el, el.style.visibility); el.style.visibility = 'hidden'; }
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (stamp !== generation) return;
      const poses = capture(elements, true);
      const deck = !departures && motion ? stage.value?.closest('.phone-table-screen')?.querySelector<HTMLElement>('.deal-spinning-deck') : null;
      const origin = deck?.getBoundingClientRect(), deckWidth = deck?.offsetWidth;
      const backFace = deck?.querySelector<SVGSVGElement>('svg');
      // Resolve all artwork before touching the overlay DOM. Cached cards do not decode again.
      const [bitmaps, back] = await Promise.all([Promise.all(poses.map(pose => cardBitmap(pose.face))), backFace ? cardBitmap(backFace) : Promise.resolve(null)]);
      if (stamp !== generation) return;
      const remaining = new Set(state.value?.hand.map(card => card.id));
      const fragment = document.createDocumentFragment();
      const nodes = poses.flatMap((pose, i) => {
        if (!pose.element.isConnected || !remaining.has(pose.element.dataset.cardId!)) { reveal(pose.element); return []; }
        const node = ghost(pose, bitmaps[i]); fragment.appendChild(node);
        const flip = back ? flipArtwork(node, back) : null;
        return [{ pose, node, flip, index:ids.indexOf(pose.element.dataset.cardId!) }];
      });
      document.body.appendChild(fragment);
      const elapsed = motion ? motion.elapsedMs + performance.now() - receivingAt : 0;
      for (const { pose, node, flip, index } of nodes) {
        const delay = motion ? dealCardDelay(index, state.value?.selfSeat ?? 0, motion.seatCount) - elapsed : index * 90;
        const duration = motion ? DEAL_FLIGHT_MS : 440;
        if (!back && delay + duration <= 0) { node.remove(); reveal(pose.element); continue; }
        if (origin && deckWidth && flip && motion) {
          const dx = origin.x + origin.width / 2 - pose.x, dy = origin.y + origin.height / 2 - pose.y;
          fly(node, [{ translate:`${dx}px ${dy}px`, transform:`rotate(0deg) scale(${deckWidth / pose.width})`, opacity:0 },
            { offset:.04, opacity:1 }, { translate:'0 0', transform:node.style.transform, opacity:1 }], duration, delay,
            () => reveal(pose.element), { element:flip, delay:dealTravelDuration(motion.seatCount, motion.cardsPerSeat) - elapsed });
        } else {
          fly(node, [{ translate:`${innerWidth * .5 - pose.x}px ${-pose.y - pose.height / 2 - 30}px`, rotate:'-14deg', opacity:.25 },
            { translate:'0 0', rotate:'0deg', opacity:1 }], duration, delay, () => reveal(pose.element));
        }
      }
    } catch { if (stamp === generation) cancel(); }
  }

  async function depart(poses: Pose[]) {
    const stamp = generation;
    try {
      const bitmaps = await Promise.all(poses.map(pose => cardBitmap(pose.face)));
      if (stamp !== generation) return;
      const fragment = document.createDocumentFragment(), nodes = poses.map((pose, i) => ghost(pose, bitmaps[i]));
      nodes.forEach(node => fragment.appendChild(node)); document.body.appendChild(fragment);
      nodes.forEach(node => fly(node, [{ translate:'0 0', opacity:1 }, { translate:`0 ${-innerHeight - 220}px`, opacity:.8 }], 420));
    } catch { /* the accepted state already shows the correct hand */ }
  }

  watch(deal, motion => {
    if (!enabled()) { cancel(); return; }
    if (!motion) return;
    cancel(); receivingAt = performance.now(); void receive((state.value?.hand ?? []).map(c => c.id), motion);
  }, { immediate:true });
  watch(state, (snapshot, previous) => {
    if (!enabled()) { cancel(); return; }
    if (!snapshot || !previous || snapshot.code !== previous.code || snapshot.phase === 'lobby') { cancel(); return; }
    if (reduced()) return;
    const remaining = new Set(snapshot.hand.map(card => card.id));
    for (const flight of flights) if (flight.reveal && !remaining.has(flight.node.dataset.motionCardId!)) finish(flight);
    const oldIds = new Set(previous.hand.map(c => c.id)), added = snapshot.hand.filter(c => !oldIds.has(c.id)).map(c => c.id);
    if (added.length && !deal.value && previous.phase !== 'lobby') void receive(added, null);
    if (!departures || snapshot.selfSeat == null) return;
    const oldPlays = new Set(previous.tablePlays.map(p => p.id));
    const played = new Set(snapshot.tablePlays.filter(p => p.seatId === snapshot.selfSeat && !oldPlays.has(p.id)).flatMap(p => p.cards.map(c => c.id)));
    if (played.size) void depart(capture(Array.from(stage.value?.querySelectorAll<HTMLElement>('[data-card-id]') ?? []).filter(el => played.has(el.dataset.cardId!))));
  }, { flush:'pre' });
  watch([stage, () => state.value?.hand.map(card => card.id).join(',')], async (_, __, cleanup) => {
    let stopped = false, stopWarm = () => {};
    cleanup(() => { stopped = true; stopWarm(); });
    await nextTick();
    if (!stopped && stage.value) stopWarm = warmCardArt(stage.value);
  }, { flush:'post', immediate:true });
  window.addEventListener('resize', cancel); window.addEventListener('orientationchange', cancel);
  document.addEventListener('fullscreenchange', cancel); document.addEventListener('webkitfullscreenchange', cancel);
  const visibility = () => { if (document.visibilityState === 'hidden') cancel(); };
  document.addEventListener('visibilitychange', visibility);
  onScopeDispose(() => {
    cancel(); window.removeEventListener('resize', cancel); window.removeEventListener('orientationchange', cancel);
    document.removeEventListener('fullscreenchange', cancel); document.removeEventListener('webkitfullscreenchange', cancel);
    document.removeEventListener('visibilitychange', visibility);
  });
  return { cancel };
}
