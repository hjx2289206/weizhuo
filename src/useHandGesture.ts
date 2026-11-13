import { getCurrentScope, onScopeDispose } from 'vue';
import type { Ref } from 'vue';

export interface HandGestureOptions {
  selected: Ref<string[]>;
  toggleCard: (id: string) => void;
  play: () => Promise<void>;
  enabled: () => boolean;
}

export interface HandGestureHandlers {
  pointerDown: (event: PointerEvent) => void;
  pointerMove: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  pointerCancel: () => void;
}

/** Finger travel that counts as a play swipe. */
const SWIPE_MIN_PX = 65;
/** Horizontal travel before a drag starts painting cards. */
const PAINT_SLOP_PX = 20;
/** How clearly horizontal a drag must be before it paints instead of swiping. */
const PAINT_DOMINANCE = 1.4;
const CARD_SELECTOR = '[data-card-id]';

interface GestureState {
  pointerId: number;
  originId: string;
  startX: number;
  startY: number;
  mode: 'idle' | 'paint' | 'swipe';
  /** Selection state this drag paints onto every card it crosses. */
  paintTo: boolean;
  lastPaintedId: string | null;
  captureTarget: Element | null;
}

export function useHandGesture(options: HandGestureOptions): HandGestureHandlers {
  let gesture: GestureState | null = null;
  /** Newest pointer sample not yet painted: a sweep paints at most once per frame. */
  let pending: { x: number; y: number } | null = null;
  let frame = 0;

  function cardIdAt(x: number, y: number): string | null {
    if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;
    const hit = document.elementFromPoint(x, y);
    const element = hit instanceof Element ? hit.closest(CARD_SELECTOR) : null;
    const id = element instanceof HTMLElement ? element.dataset.cardId : undefined;
    return id && id.length > 0 ? id : null;
  }

  function paintAt(x: number, y: number): void {
    const active = gesture;
    if (!active) return;
    const id = cardIdAt(x, y);
    if (!id || id === active.lastPaintedId) return;
    if (active.paintTo !== options.selected.value.includes(id)) options.toggleCard(id);
    active.lastPaintedId = id;
  }

  function cancelFrame(): void {
    if (frame === 0) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = 0;
  }

  /** One paint decision per frame, always from the newest sample. */
  function applySample(x: number, y: number): void {
    const active = gesture;
    if (!active) return;
    const dx = x - active.startX;
    const dy = y - active.startY;
    if (active.mode === 'idle') {
      if (-dy >= SWIPE_MIN_PX && Math.abs(dy) > Math.abs(dx)) {
        active.mode = 'swipe';
        return;
      }
      if (Math.abs(dx) >= PAINT_SLOP_PX && Math.abs(dx) > Math.abs(dy) * PAINT_DOMINANCE) {
        active.mode = 'paint';
      }
    }
    if (active.mode === 'paint') paintAt(x, y);
  }

  function scheduleSample(x: number, y: number): void {
    pending = { x, y };
    if (typeof requestAnimationFrame !== 'function') {
      flushSample();
      return;
    }
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      flushSample();
    });
  }

  /** Consume the pending sample now: ending the gesture must paint where the finger stopped. */
  function flushSample(): void {
    cancelFrame();
    const sample = pending;
    pending = null;
    if (!sample) return;
    applySample(sample.x, sample.y);
  }

  function finishGesture(): void {
    const active = gesture;
    if (!active) return;
    gesture = null;
    cancelFrame();
    pending = null;
    document.removeEventListener('pointerup', onDocumentEnd, true);
    document.removeEventListener('pointercancel', onDocumentEnd, true);
    const target = active.captureTarget;
    if (target) {
      try {
        if (target.hasPointerCapture(active.pointerId)) target.releasePointerCapture(active.pointerId);
      } catch {
        /* element already detached */
      }
    }
  }

  function playGesture(originId: string): void {
    // Swiping up with nothing selected plays the card the swipe started on.
    if (options.selected.value.length === 0) options.toggleCard(originId);
    if (!options.enabled()) return;
    try {
      void options.play().catch(() => {
        /* surfaced through useGame().error */
      });
    } catch {
      /* synchronous failure: surfaced through useGame().error */
    }
  }

  function endGesture(event: PointerEvent): void {
    const active = gesture;
    if (!active) return;
    const vertical = active.startY - event.clientY;
    const horizontal = Math.abs(event.clientX - active.startX);
    const swiping = active.mode !== 'paint' && vertical >= SWIPE_MIN_PX && vertical > horizontal;
    const tapping = active.mode === 'idle';
    finishGesture();
    if (swiping) {
      playGesture(active.originId);
      return;
    }
    if (tapping) options.toggleCard(active.originId);
    // A finished paint drag keeps the selection it painted.
  }

  function cancelGesture(): void {
    // pointercancel: never toggle, never submit.
    if (gesture) finishGesture();
  }

  function onDocumentEnd(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    // A cancelled pointer never publishes its last sample; a real end consumes it.
    if (event.type === 'pointercancel') {
      cancelGesture();
      return;
    }
    flushSample();
    endGesture(event);
  }

  function pointerDown(event: PointerEvent): void {
    if (gesture) {
      if (gesture.pointerId !== event.pointerId) return; // ignore extra fingers
      finishGesture();
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Touch browsers may retarget to a neighbouring button: trust painted pixels instead.
    const id = cardIdAt(event.clientX, event.clientY);
    if (!id) return;
    const captureTarget = event.currentTarget instanceof Element ? event.currentTarget : null;
    gesture = {
      pointerId: event.pointerId,
      originId: id,
      startX: event.clientX,
      startY: event.clientY,
      mode: 'idle',
      paintTo: !options.selected.value.includes(id),
      lastPaintedId: null,
      captureTarget,
    };
    if (captureTarget) {
      try {
        captureTarget.setPointerCapture(event.pointerId);
      } catch {
        /* capture unsupported: document fallback still ends the gesture */
      }
    }
    document.addEventListener('pointerup', onDocumentEnd, true);
    document.addEventListener('pointercancel', onDocumentEnd, true);
  }

  function pointerMove(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    scheduleSample(event.clientX, event.clientY);
  }

  function pointerUp(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    flushSample();
    endGesture(event);
  }

  if (getCurrentScope()) onScopeDispose(cancelGesture);

  return { pointerDown, pointerMove, pointerUp, pointerCancel: cancelGesture };
}
