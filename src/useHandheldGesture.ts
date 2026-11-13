import { getCurrentScope, onScopeDispose } from 'vue';
import type { Card } from '../shared/protocol';
import { cardIndexAt, type HandheldGeometry } from './handheldLayout';

export interface HandheldGestureOptions {
  /** The `.handheld-hand` element, used to reject hits from other card surfaces. */
  root: () => HTMLElement | null;
  /** Cards in hand, index-aligned with `geometry().angles`. */
  cards: () => Card[];
  geometry: () => HandheldGeometry;
  selected: () => string[];
  toggleCard: (id: string) => void;
  play: () => Promise<void>;
  enabled: () => boolean;
  /** Drives the big focused-card preview (`null` clears it). */
  setFocusedIndex: (index: number | null) => void;
}

export interface HandheldGestureHandlers {
  pointerDown: (event: PointerEvent) => void;
  pointerMove: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  pointerCancel: () => void;
  /** Idempotent teardown: ends any gesture and clears focus. */
  dispose: () => void;
}

/** Upward travel that counts as a play swipe. */
const SWIPE_MIN_PX = 65;
/** Horizontal travel before a drag starts painting cards. */
const PAINT_SLOP_PX = 16;
/** How clearly horizontal a drag must be before it paints instead of swiping. */
const PAINT_DOMINANCE = 1.35;
const CARD_SELECTOR = '[data-card-id]';
/** `overflow` values that crop an element's contents. */
const CLIPPING_OVERFLOW: Record<string, true> = { hidden: true, clip: true, auto: true, scroll: true };

/** Viewport-space rectangle a card can actually be painted in. */
interface Surface {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface GestureState {
  pointerId: number;
  originId: string;
  startX: number;
  startY: number;
  mode: 'idle' | 'paint' | 'swipe';
  /** Selection state this drag paints onto every card it crosses. */
  paintTo: boolean;
  /** Index under the finger the last time a paint decision was taken. */
  paintedIndex: number;
  /** Indices already painted by this drag: keeps paint correct under fast sweeps. */
  painted: Set<number>;
  /** Selection as this drag sees it, kept in step with every painted toggle. */
  selectedIds: Set<string>;
  /**
   * Hand-local left edge and painted surface, measured once per drag. Nothing about the
   * hand's box can move while the finger is down (focus lift and selection are pure
   * transforms), so re-reading layout on every sample would only cost frames.
   */
  surface: Surface | null;
  surfaceLeft: number;
  surfaceMeasured: boolean;
  captureTarget: Element | null;
}

/**
 * Pointer handling for the spread handheld fan.
 *
 * Every card keeps an exposed corner strip, so `elementsFromPoint` alone resolves
 * most sweeps; the strip mapping covers the few samples that land between bodies
 * (and the outer cards, whose strips are the only part of them not covered).
 *
 * The stage crops the gripped lower card ends, but the pointer stays captured past
 * that crop: samples over the cropped band, the footer and the action tray are not
 * card targets, so they clear the preview instead of painting cards nobody can see,
 * while the gesture itself — including an upward play swipe that leaves the hand —
 * keeps running until pointerup or pointercancel.
 *
 * A sweep is only as smooth as its slowest frame, so samples are consumed once per
 * frame: the newest one wins, the surface is measured once per drag, and every paint
 * decision runs against plain sets instead of live DOM reads.
 */
export function useHandheldGesture(options: HandheldGestureOptions): HandheldGestureHandlers {
  let gesture: GestureState | null = null;
  /** Newest pointer sample not yet painted. */
  let pending: { x: number; y: number } | null = null;
  let frame = 0;

  function indexOfId(id: string | null | undefined): number {
    if (!id) return -1;
    return options.cards().findIndex((card) => card.id === id);
  }

  /** Padding box of an element that crops its own contents, else `null`. */
  function cropOf(element: HTMLElement): Surface | null {
    const style = getComputedStyle(element);
    if (!CLIPPING_OVERFLOW[style.overflowX] && !CLIPPING_OVERFLOW[style.overflowY]) return null;
    const rect = element.getBoundingClientRect();
    const left = rect.left + element.clientLeft;
    const top = rect.top + element.clientTop;
    return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
  }

  /**
   * Rectangle the hand really paints cards in: the root's own box trimmed by every
   * cropping ancestor. `.hand-stage--handheld` crops the gripped lower card ends,
   * so that band — and the footer/action tray under it — holds no visible card even
   * though pointer capture keeps delivering samples there.
   */
  function paintedSurface(root: HTMLElement, rect: DOMRect): Surface {
    const left = rect.left + root.clientLeft;
    const top = rect.top + root.clientTop;
    const surface: Surface = { left, top, right: left + root.clientWidth, bottom: top + root.clientHeight };
    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const crop = cropOf(ancestor);
      if (!crop) continue;
      surface.left = Math.max(surface.left, crop.left);
      surface.top = Math.max(surface.top, crop.top);
      surface.right = Math.min(surface.right, crop.right);
      surface.bottom = Math.min(surface.bottom, crop.bottom);
    }
    return surface;
  }

  /** The hand root and its box, or `null` while it is not laid out. */
  function handBox(): { root: HTMLElement; rect: DOMRect } | null {
    const root = options.root();
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { root, rect };
  }

  function idAt(index: number): string | null {
    const card = options.cards()[index];
    return card ? card.id : null;
  }

  function cardIdAtPoint(x: number, y: number): string | null {
    if (typeof document === 'undefined') return null;
    // elementsFromPoint returns the whole stack at the pixel, so overlapping
    // neighbours cannot swallow a sample the way a single elementFromPoint does:
    // at any pixel the rightmost card present is the one the thumb is visually on
    // (bodies overlap to the right, and the focused card keeps its normal depth).
    const stack =
      typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(x, y)
        : [document.elementFromPoint(x, y)];
    const root = options.root();
    const cards = options.cards();
    let bestIndex = -1;
    let bestId: string | null = null;
    for (const entry of stack) {
      if (!(entry instanceof Element)) continue;
      const element = entry.closest(CARD_SELECTOR);
      if (!(element instanceof HTMLElement)) continue;
      if (root && !root.contains(element)) continue;
      const index = cards.findIndex((card) => card.id === element.dataset.cardId);
      if (index > bestIndex) {
        bestIndex = index;
        bestId = element.dataset.cardId ?? null;
      }
    }
    return bestId;
  }

  /**
   * Painted surface of this drag, measured once and reused: the strip fallback is the
   * only consumer, so a sweep that never leaves the card art pays nothing for it.
   */
  function dragSurface(active: GestureState): { surface: Surface; left: number } | null {
    if (!active.surfaceMeasured) {
      active.surfaceMeasured = true;
      const hand = handBox();
      if (hand) {
        active.surface = paintedSurface(hand.root, hand.rect);
        active.surfaceLeft = hand.rect.left;
      }
    }
    return active.surface ? { surface: active.surface, left: active.surfaceLeft } : null;
  }

  /**
   * Visibly painted card under the pointer, or `-1` when no card is visible there.
   *
   * A real hit always wins: `elementsFromPoint` already ignores the card parts the
   * stage crops away, and it keeps working outside the root's own box. The
   * exposed-strip mapping below only fills the gaps *between* cards, so it is
   * limited to the painted surface — over the cropped grip, the footer or the
   * action tray it would otherwise select cards the thumb cannot see.
   */
  function indexAt(x: number, y: number, active: GestureState): number {
    const hit = indexOfId(cardIdAtPoint(x, y));
    if (hit >= 0) return hit;
    const drag = dragSurface(active);
    if (!drag) return -1;
    const { surface, left } = drag;
    if (x < surface.left || x > surface.right || y < surface.top || y > surface.bottom) return -1;
    // The mapping works in hand-local pixels (the geometry is hand-local, the
    // pointer is viewport-based) and reads the exposed corner strips, which the
    // spread fan lays out left to right across the whole width of the hand.
    return cardIndexAt(options.geometry(), x - left);
  }

  function paintIndex(active: GestureState, index: number): void {
    if (index < 0) {
      // No visible card under the sample (cropped grip, footer, action tray): the
      // drag keeps running, but nothing may be painted or previewed there.
      options.setFocusedIndex(null);
      return;
    }
    // Fast sweeps skip indices between two pointer samples; fill the gap so the
    // painted run always matches the strip of cards the thumb crossed. Membership
    // is decided against the drag's own selection set: no live DOM or array scans.
    const low = active.paintedIndex < 0 ? index : Math.min(active.paintedIndex, index);
    const high = active.paintedIndex < 0 ? index : Math.max(active.paintedIndex, index);
    for (let i = low; i <= high; i += 1) {
      if (active.painted.has(i)) continue;
      active.painted.add(i);
      const id = idAt(i);
      if (!id || active.selectedIds.has(id) === active.paintTo) continue;
      if (active.paintTo) active.selectedIds.add(id);
      else active.selectedIds.delete(id);
      options.toggleCard(id);
    }
    active.paintedIndex = index;
    options.setFocusedIndex(index);
  }

  function cancelFrame(): void {
    if (frame === 0) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = 0;
  }

  /**
   * One paint decision per frame, always from the newest sample. A janky frame can
   * deliver several samples at once, and painting each of them would only repeat the
   * same hit test and the same reactive writes — the gap filler already restores the
   * crossed cards the dropped samples would have added.
   */
  function applySample(x: number, y: number): void {
    const active = gesture;
    if (!active) return;
    const dx = x - active.startX;
    const dy = y - active.startY;
    if (active.mode === 'idle') {
      // Vertical jitter must never start painting, and a clearly upward drag is
      // a play swipe rather than a paint sweep. Both are measured from the start
      // point, so a swipe beyond the hand's top edge still plays the selection.
      if (-dy >= SWIPE_MIN_PX && Math.abs(dy) > Math.abs(dx)) {
        active.mode = 'swipe';
        options.setFocusedIndex(null);
        return;
      }
      if (Math.abs(dx) >= PAINT_SLOP_PX && Math.abs(dx) > Math.abs(dy) * PAINT_DOMINANCE) {
        active.mode = 'paint';
      } else {
        // Still deciding: sliding off the painted surface only drops the preview.
        if (indexAt(x, y, active) < 0) options.setFocusedIndex(null);
        return;
      }
    }
    // The gesture lives until pointerup/cancel even while the captured pointer
    // travels over the cropped grip, the footer or the action tray.
    if (active.mode !== 'paint') return;
    paintIndex(active, indexAt(x, y, active));
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
    if (target instanceof HTMLElement) {
      try {
        if (target.hasPointerCapture(active.pointerId)) target.releasePointerCapture(active.pointerId);
      } catch {
        /* element already detached */
      }
    }
  }

  function endGesture(event: PointerEvent): void {
    const active = gesture;
    if (!active) return;
    const upward = active.startY - event.clientY;
    const horizontal = Math.abs(event.clientX - active.startX);
    const swiping = active.mode !== 'paint' && upward >= SWIPE_MIN_PX && upward > horizontal;
    const tapping = active.mode === 'idle';
    finishGesture();
    options.setFocusedIndex(null);
    if (swiping) {
      // Only the current selection is played, and only when the game allows it.
      if (!options.enabled() || options.selected().length === 0) return;
      try {
        void options.play().catch(() => {
          /* surfaced through useGame().error */
        });
      } catch {
        /* synchronous failure: surfaced through useGame().error */
      }
      return;
    }
    if (tapping) options.toggleCard(active.originId);
  }

  function cancelGesture(): void {
    if (!gesture) return;
    finishGesture();
    options.setFocusedIndex(null);
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
    // A gesture starts only on a card that is actually painted at the finger: the browser
    // may retarget a touch (touch adjustment) and a blank pixel owns nothing. Ongoing
    // paint/sweep samples keep using indexAt(), whose exposed-strip fallback fills the
    // gaps between cards on purpose.
    const originId = cardIdAtPoint(event.clientX, event.clientY);
    const originIndex = indexOfId(originId);
    if (originId === null || originIndex < 0) return;
    const captureTarget = event.currentTarget instanceof Element ? event.currentTarget : null;
    gesture = {
      pointerId: event.pointerId,
      originId,
      startX: event.clientX,
      startY: event.clientY,
      mode: 'idle',
      paintTo: !options.selected().includes(originId),
      paintedIndex: originIndex,
      painted: new Set<number>(),
      selectedIds: new Set<string>(options.selected()),
      surface: null,
      surfaceLeft: 0,
      surfaceMeasured: false,
      captureTarget,
    };
    options.setFocusedIndex(gesture.paintedIndex >= 0 ? gesture.paintedIndex : null);
    if (captureTarget instanceof HTMLElement) {
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

  function dispose(): void {
    cancelGesture();
  }

  if (getCurrentScope()) onScopeDispose(dispose);

  return { pointerDown, pointerMove, pointerUp, pointerCancel: cancelGesture, dispose };
}
