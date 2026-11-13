// Pointer-pipeline tests for the two phone hands.
//
// The sweep path is latency-sensitive: a sample may only cost one hit test per frame,
// the painted surface is measured once per drag, and toggles must follow the strip of
// cards the thumb crossed even when frames drop samples. The DOM here is deterministic:
// cards are plain objects, `elementsFromPoint` returns a scripted stack, and animation
// frames only run when a test says so.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import type { Card } from '../shared/protocol';
import { computeHandheldGeometry } from '../src/handheldLayout';
import { useHandGesture } from '../src/useHandGesture';
import { useHandheldGesture } from '../src/useHandheldGesture';

/* ------------------------------------------------------------------ *
 * fake DOM
 * ------------------------------------------------------------------ */

const CARD_SELECTOR = '[data-card-id]';

class FakeElement {
  parentElement: FakeElement | null = null;
  dataset: Record<string, string> = {};
  rect = { left: 0, top: 0, width: 0, height: 0 };
  overflowX = 'visible';
  overflowY = 'visible';
  clientLeft = 0;
  clientTop = 0;
  clientWidth = 0;
  clientHeight = 0;
  rectReads = 0;

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    this.rectReads += 1;
    return this.rect;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) child.parentElement = this;
  }

  contains(other: FakeElement | null): boolean {
    for (let node = other; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parentElement) {
      if (node instanceof FakeCard && selector === CARD_SELECTOR) return node;
    }
    return null;
  }
}

class FakeHTMLElement extends FakeElement {
  private readonly captured = new Set<number>();

  setPointerCapture(pointerId: number): void {
    this.captured.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.captured.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.captured.delete(pointerId);
  }
}

class FakeCard extends FakeHTMLElement {
  readonly id: string;

  constructor(id: string) {
    super();
    this.id = id;
    this.dataset = { cardId: id };
  }
}

interface Listener {
  type: string;
  listener: unknown;
  capture: boolean;
}

interface FakeDocument {
  stack: FakeElement[];
  hitTests: number;
  listeners: Listener[];
  elementsFromPoint: (x: number, y: number) => FakeElement[];
  elementFromPoint: (x: number, y: number) => FakeElement | null;
  addEventListener: (type: string, listener: unknown, capture?: boolean) => void;
  removeEventListener: (type: string, listener: unknown, capture?: boolean) => void;
}

function fakeDocument(): FakeDocument {
  const doc: FakeDocument = {
    stack: [],
    hitTests: 0,
    listeners: [],
    elementsFromPoint: () => {
      doc.hitTests += 1;
      return [...doc.stack];
    },
    elementFromPoint: () => {
      doc.hitTests += 1;
      return doc.stack[0] ?? null;
    },
    addEventListener: (type, listener, capture = false) => {
      doc.listeners.push({ type, listener, capture });
    },
    removeEventListener: (type, listener, capture = false) => {
      const index = doc.listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
      );
      if (index >= 0) doc.listeners.splice(index, 1);
    },
  };
  return doc;
}

/* ------------------------------------------------------------------ *
 * controllable frame clock + saved globals
 * ------------------------------------------------------------------ */

const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
const completionScope = globalThis as unknown as Record<string, unknown>;
const originals = new Map<string, unknown>();

function pendingFrames(): number {
  return frames.size;
}

function runFrames(): void {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(0);
}

function resetFrames(): void {
  frames.clear();
  nextFrameId = 1;
  completionScope.document = fakeDocument();
}

function install(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, completionScope[name]);
  completionScope[name] = value;
}

install('Element', FakeElement);
install('HTMLElement', FakeHTMLElement);
install('document', fakeDocument());
install('getComputedStyle', (element: FakeElement) => ({
  overflowX: element.overflowX,
  overflowY: element.overflowY,
}));
install('requestAnimationFrame', (callback: FrameRequestCallback) => {
  const id = nextFrameId;
  nextFrameId += 1;
  frames.set(id, callback);
  return id;
});
install('cancelAnimationFrame', (id: number) => {
  frames.delete(id);
});

after(() => {
  for (const [name, value] of originals) {
    if (value === undefined) delete completionScope[name];
    else completionScope[name] = value;
  }
  frames.clear();
});

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

function fakeCards(count = 10): FakeCard[] {
  return Array.from({ length: count }, (_, index) => new FakeCard(`c${index}`));
}

function pointer(x: number, y: number, currentTarget: FakeHTMLElement | null = null): PointerEvent {
  return {
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    type: 'pointermove',
    clientX: x,
    clientY: y,
    currentTarget,
  } as unknown as PointerEvent;
}

/** Selection writes, as the store would apply them: one toggle flips one id. */
function selectionState(seed: string[]) {
  const selected = ref<string[]>([...seed]);
  const toggles: string[] = [];
  return {
    selected,
    toggles,
    toggleCard: (id: string) => {
      toggles.push(id);
      selected.value = selected.value.includes(id)
        ? selected.value.filter((entry) => entry !== id)
        : [...selected.value, id];
    },
  };
}

function handheldHarness(seed: string[] = [], enabled = true) {
  resetFrames();
  const doc = completionScope.document as FakeDocument;
  const cards = fakeCards();
  const hand = new FakeHTMLElement();
  hand.clientWidth = 600;
  hand.clientHeight = 300;
  hand.rect = { left: 0, top: 0, width: 600, height: 300 };
  // The stage crops the gripped card ends: cards below this band are not visible.
  const stage = new FakeHTMLElement();
  stage.overflowX = 'hidden';
  stage.overflowY = 'hidden';
  stage.clientWidth = 600;
  stage.clientHeight = 220;
  stage.rect = { left: 0, top: 0, width: 600, height: 220 };
  stage.append(hand);
  hand.append(...cards);

  const geometry = computeHandheldGeometry({ width: 600, height: 300, count: 10 });
  const selection = selectionState(seed);
  const focus: Array<number | null> = [];
  let plays = 0;

  const gesture = useHandheldGesture({
    root: () => hand as unknown as HTMLElement,
    cards: () => cards as unknown as Card[],
    geometry: () => geometry,
    selected: () => selection.selected.value,
    toggleCard: selection.toggleCard,
    play: async () => {
      plays += 1;
    },
    enabled: () => enabled,
    setFocusedIndex: (index) => {
      focus.push(index);
    },
  });

  return {
    doc,
    cards,
    hand,
    stage,
    geometry,
    selection,
    focus,
    plays: () => plays,
    down: (index: number) => {
      doc.stack = [cards[index]];
      gesture.pointerDown(pointer(geometry.stripX[index], 100, hand));
    },
    move: (x: number, y = 100) => {
      doc.stack = [];
      gesture.pointerMove(pointer(x, y));
    },
    up: (x: number, y = 100) => gesture.pointerUp(pointer(x, y)),
    cancel: () => gesture.pointerCancel(),
    gesture,
  };
}

function fanHarness(seed: string[] = [], enabled = true) {
  resetFrames();
  const doc = completionScope.document as FakeDocument;
  const cards = fakeCards();
  const hand = new FakeHTMLElement();
  hand.clientWidth = 600;
  hand.clientHeight = 210;
  hand.rect = { left: 0, top: 0, width: 600, height: 210 };
  hand.append(...cards);

  const selection = selectionState(seed);
  let plays = 0;
  const gesture = useHandGesture({
    selected: selection.selected,
    toggleCard: selection.toggleCard,
    play: async () => {
      plays += 1;
    },
    enabled: () => enabled,
  });

  return {
    doc,
    cards,
    hand,
    selection,
    plays: () => plays,
    down: (index: number, x = 200, y = 100) => {
      doc.stack = [cards[index]];
      gesture.pointerDown(pointer(x, y, hand));
    },
    move: (index: number, x = 200, y = 100) => {
      doc.stack = index < 0 ? [] : [cards[index]];
      gesture.pointerMove(pointer(x, y));
    },
    up: (x = 200, y = 100) => gesture.pointerUp(pointer(x, y)),
    cancel: () => gesture.pointerCancel(),
    gesture,
  };
}

/* ------------------------------------------------------------------ *
 * handheld fan
 * ------------------------------------------------------------------ */

test('handheld tap toggles the card under the finger and clears the preview', () => {
  const hand = handheldHarness();
  hand.down(2);
  assert.equal(hand.focus.at(-1), 2);
  assert.equal(hand.doc.listeners.length, 2, 'document pointerup/pointercancel fallbacks installed');

  hand.up(hand.geometry.stripX[2], 100);
  assert.deepEqual(hand.selection.toggles, ['c2']);
  assert.deepEqual(hand.selection.selected.value, ['c2']);
  assert.equal(hand.focus.at(-1), null, 'preview dropped on release');
  assert.equal(hand.doc.listeners.length, 0, 'document fallbacks removed');
});

test('handheld horizontal sweep paints the crossed run and fills samples dropped between frames', () => {
  const hand = handheldHarness();
  hand.down(0);
  hand.move(hand.geometry.stripX[2]);
  runFrames();
  assert.deepEqual(hand.selection.toggles, ['c0', 'c1', 'c2']);

  // Three samples in one frame: only the newest is hit-tested, the gap filler keeps
  // the cards the two dropped samples crossed.
  const before = hand.doc.hitTests;
  hand.move(hand.geometry.stripX[4]);
  hand.move(hand.geometry.stripX[5]);
  hand.move(hand.geometry.stripX[7]);
  assert.equal(hand.doc.hitTests, before, 'moves do not hit-test before the frame');
  runFrames();
  assert.equal(hand.doc.hitTests, before + 1, 'one hit test for the whole frame');
  assert.deepEqual(hand.selection.toggles, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);

  hand.up(hand.geometry.stripX[7]);
  assert.deepEqual(hand.selection.toggles.slice(-1), ['c7'], 'release never taps after a paint');
});

test('handheld release consumes the last pending sample instead of dropping it', () => {
  const hand = handheldHarness();
  hand.down(0);
  hand.move(hand.geometry.stripX[3]);
  assert.equal(pendingFrames(), 1);

  hand.up(hand.geometry.stripX[3]);
  assert.equal(pendingFrames(), 0, 'release cancels the scheduled frame');
  assert.deepEqual(hand.selection.toggles, ['c0', 'c1', 'c2', 'c3']);
  assert.deepEqual(hand.selection.selected.value, ['c0', 'c1', 'c2', 'c3']);
});

test('handheld sweep starting on a selected card erases exactly the crossed run', () => {
  const hand = handheldHarness(['c2', 'c3', 'c4']);
  hand.down(2);
  hand.move(hand.geometry.stripX[5]);
  runFrames();
  assert.deepEqual(hand.selection.toggles, ['c2', 'c3', 'c4'], 'unselected cards are left alone');
  assert.deepEqual(hand.selection.selected.value, []);

  hand.up(hand.geometry.stripX[5]);
  assert.deepEqual(hand.selection.selected.value, []);
});

test('handheld sweep does not toggle the same card twice when the thumb jitters back', () => {
  const hand = handheldHarness();
  hand.down(0);
  hand.move(hand.geometry.stripX[3]);
  runFrames();
  const painted = [...hand.selection.toggles];

  hand.move(hand.geometry.stripX[1]);
  runFrames();
  assert.deepEqual(hand.selection.toggles, painted, 're-crossed cards keep their selection');
  assert.equal(hand.focus.at(-1), 1, 'the preview still follows the finger');

  hand.move(hand.geometry.stripX[4]);
  runFrames();
  assert.deepEqual(hand.selection.toggles, [...painted, 'c4']);
});

test('handheld measures the painted surface once per drag', () => {
  const hand = handheldHarness();
  hand.down(0);
  assert.equal(hand.hand.rectReads, 0, 'pointerdown trusts the hit test');

  hand.move(hand.geometry.stripX[3]);
  runFrames();
  assert.equal(hand.hand.rectReads, 1);
  assert.equal(hand.stage.rectReads, 1);

  hand.move(hand.geometry.stripX[5]);
  runFrames();
  hand.move(hand.geometry.stripX[7]);
  runFrames();
  assert.equal(hand.hand.rectReads, 1, 'the hand box cannot move while the finger is down');
  assert.equal(hand.stage.rectReads, 1, 'the crop is reused across samples');
});

test('handheld samples over the cropped grip clear the preview without painting', () => {
  const hand = handheldHarness();
  hand.down(0);
  hand.move(hand.geometry.stripX[3], 100);
  runFrames();
  assert.deepEqual(hand.selection.toggles, ['c0', 'c1', 'c2', 'c3']);

  hand.move(hand.geometry.stripX[6], 250);
  runFrames();
  assert.deepEqual(
    hand.selection.toggles,
    ['c0', 'c1', 'c2', 'c3'],
    'cropped card ends are not visible targets',
  );
  assert.equal(hand.focus.at(-1), null);

  hand.move(hand.geometry.stripX[5], 100);
  runFrames();
  assert.deepEqual(
    hand.selection.toggles,
    ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'],
    'the drag survives the cropped band',
  );
});

test('handheld upward swipe plays the selection without painting', () => {
  const hand = handheldHarness(['c4']);
  hand.down(0);
  hand.move(hand.geometry.stripX[0] + 4, 20);
  runFrames();
  assert.equal(hand.focus.at(-1), null, 'swipes drop the preview');

  hand.up(hand.geometry.stripX[0] + 4, 20);
  assert.equal(hand.plays(), 1);
  assert.deepEqual(hand.selection.toggles, [], 'a swipe never toggles a card');
  assert.deepEqual(hand.selection.selected.value, ['c4']);
});

test('handheld upward swipe with nothing selected plays nothing', () => {
  const hand = handheldHarness([]);
  hand.down(0);
  hand.move(hand.geometry.stripX[0] + 4, 20);
  runFrames();
  hand.up(hand.geometry.stripX[0] + 4, 20);
  assert.equal(hand.plays(), 0);
  assert.deepEqual(hand.selection.toggles, [], 'and it never falls back to selecting the origin');
});

test('handheld pointercancel drops the pending sample and never plays', () => {
  const hand = handheldHarness(['c4']);
  hand.down(0);
  hand.move(hand.geometry.stripX[5]);
  assert.equal(pendingFrames(), 1);

  hand.cancel();
  assert.equal(pendingFrames(), 0, 'the scheduled frame is cancelled');
  assert.deepEqual(hand.selection.toggles, [], 'the unflushed sample never paints');
  assert.equal(hand.plays(), 0);
  assert.equal(hand.focus.at(-1), null);

  hand.move(hand.geometry.stripX[7]);
  runFrames();
  assert.deepEqual(hand.selection.toggles, [], 'samples after cancel are ignored');
});

test('handheld pointercancel after painting keeps painted cards and drops the rest', () => {
  const hand = handheldHarness();
  hand.down(0);
  hand.move(hand.geometry.stripX[2]);
  runFrames();
  assert.deepEqual(hand.selection.toggles, ['c0', 'c1', 'c2']);

  hand.move(hand.geometry.stripX[6]);
  hand.cancel();
  runFrames();
  assert.deepEqual(hand.selection.toggles, ['c0', 'c1', 'c2'], 'the pending run is not painted');
  assert.equal(hand.plays(), 0);
});

/* ------------------------------------------------------------------ *
 * counter / fan hand
 * ------------------------------------------------------------------ */

test('fan tap toggles the card under the finger', () => {
  const fan = fanHarness();
  fan.down(1);
  fan.up();
  assert.deepEqual(fan.selection.toggles, ['c1']);
  assert.deepEqual(fan.selection.selected.value, ['c1']);
  assert.equal(fan.doc.listeners.length, 0);
});

test('fan sweep paints the newest card once per frame', () => {
  const fan = fanHarness();
  fan.down(0);
  const before = fan.doc.hitTests;

  fan.move(1, 220);
  fan.move(2, 240);
  assert.equal(fan.doc.hitTests, before, 'moves do not hit-test before the frame');
  runFrames();
  assert.equal(fan.doc.hitTests, before + 1);
  assert.deepEqual(fan.selection.toggles, ['c2'], 'only the newest sample is painted');

  fan.up();
  assert.deepEqual(fan.selection.toggles, ['c2'], 'release never taps after a paint');
});

test('fan upward swipe with no selection plays the origin card', () => {
  const fan = fanHarness();
  fan.down(0, 200, 160);
  fan.move(0, 200, 90);
  runFrames();
  fan.up(200, 90);
  assert.deepEqual(fan.selection.toggles, ['c0']);
  assert.equal(fan.plays(), 1);
});

test('fan upward swipe with a selection plays without toggling', () => {
  const fan = fanHarness(['c5']);
  fan.down(0, 200, 160);
  fan.move(0, 200, 90);
  runFrames();
  fan.up(200, 90);
  assert.deepEqual(fan.selection.toggles, []);
  assert.equal(fan.plays(), 1);
});

test('fan pointercancel drops the pending sample and never plays', () => {
  const fan = fanHarness();
  fan.down(0, 200, 160);
  fan.move(0, 200, 90);
  assert.equal(pendingFrames(), 1);

  fan.cancel();
  assert.equal(pendingFrames(), 0);
  runFrames();
  assert.deepEqual(fan.selection.toggles, []);
  assert.equal(fan.plays(), 0);
});
