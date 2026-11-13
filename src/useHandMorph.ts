import { getCurrentScope, nextTick, onScopeDispose, ref, type Ref } from 'vue';
import { prepareCardArt, type CardAnimationArt, type Raster } from './cardAnimationArt';
import { interpolateBox, easeHandMorph, type GlyphBox } from './handMorphGeometry';
import { BoundedCache } from './boundedCache';

const MORPH_MS = 380;
const metrics = new BoundedCache<GlyphBox>(16 * 1024);
interface Pose {
  key: string; face: SVGSVGElement; narrow: boolean; selected: boolean;
  x: number; y: number; width: number; height: number; angle: number;
  rank: GlyphBox; suit: GlyphBox;
}
interface Clip { left: number; top: number; right: number; bottom: number }
interface ActiveMorph { layer: HTMLCanvasElement; frame: number; timer: number; abort: () => void; done: () => void }
export interface HandMorphApi {
  morphing: Ref<boolean>;
  run(container: HTMLElement | null, apply: () => void): Promise<void>;
  cancel(): void;
}

function box(glyph: SVGGraphicsElement): GlyphBox {
  const key = [glyph.textContent, ...['x','y','font-family','font-size','font-weight','font-style','textLength','lengthAdjust'].map(name => glyph.getAttribute(name))].join('|');
  const cached = metrics.get(key);
  if (cached) return cached;
  const b = glyph.getBBox();
  const result = { x: b.x, y: b.y, width: b.width, height: b.height };
  // Coordinates are included: rank/suit positions differ between the two modes.
  if (b.width > 0 && b.height > 0) metrics.set(key, result, 96);
  return result;
}

/** One write batch, one read batch. Only two corner metrics per card are needed. */
function capture(container: HTMLElement): Pose[] {
  const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-card-id]'));
  const transitions = elements.map(el => el.style.transition);
  elements.forEach(el => { el.style.transition = 'none'; });
  try {
    return elements.flatMap(el => {
      const face = el.querySelector<SVGSVGElement>('svg');
      const rank = face?.querySelector<SVGGraphicsElement>('[data-card-corner="top-rank"]');
      const suit = face?.querySelector<SVGGraphicsElement>('[data-card-corner="top-suit"]');
      if (!face || !rank || !suit) return [];
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return [{ key: el.dataset.cardId!, face, narrow: rank.getAttribute('font-size') === '20',
        selected: el.classList.contains('selected') || el.getAttribute('aria-pressed') === 'true',
        x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
        width: el.offsetWidth, height: el.offsetHeight, angle: Math.atan2(matrix.b, matrix.a), rank: box(rank), suit: box(suit) }];
    });
  } finally { elements.forEach((el, i) => { el.style.transition = transitions[i]; }); }
}

function clip(container: HTMLElement): Clip {
  const style = getComputedStyle(container);
  if (!['hidden','clip','auto','scroll'].includes(style.overflowX) && !['hidden','clip','auto','scroll'].includes(style.overflowY)) {
    return { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  }
  const rect = container.getBoundingClientRect();
  return { left: rect.left + container.clientLeft, top: rect.top + container.clientTop,
    right: rect.left + container.clientLeft + container.clientWidth, bottom: rect.top + container.clientTop + container.clientHeight };
}
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function glyph(ctx: CanvasRenderingContext2D, sprite: Raster, source: GlyphBox, target: GlyphBox, opacity: number) {
  if (opacity <= 0 || source.width <= 0 || source.height <= 0) return;
  const pad = .7, sx = sprite.canvas.width / 34, sy = sprite.canvas.height / 52;
  const dx = pad * target.width / source.width, dy = pad * target.height / source.height;
  ctx.globalAlpha = opacity;
  ctx.drawImage(sprite.canvas, (source.x - pad) * sx, (source.y - pad) * sy, (source.width + pad * 2) * sx, (source.height + pad * 2) * sy,
    target.x - dx, target.y - dy, target.width + dx * 2, target.height + dy * 2);
}

function drawCard(ctx: CanvasRenderingContext2D, from: Pose, to: Pose, art: CardAnimationArt, p: number) {
  const w = lerp(from.width, to.width, p), h = lerp(from.height, to.height, p);
  ctx.save();
  ctx.translate(lerp(from.x, to.x, p), lerp(from.y, to.y, p));
  ctx.rotate(lerp(from.angle, to.angle, p)); ctx.scale(w / 100, h / 144); ctx.translate(-50, -72);
  ctx.globalAlpha = 1; ctx.drawImage(art.body.canvas, 0, 0, 100, 144);
  if (from.selected) {
    ctx.strokeStyle = '#8caa70'; ctx.lineWidth = 200 / w;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(1, 1, 98, 142, 7); else ctx.rect(1, 1, 98, 142);
    ctx.stroke();
  }
  const sourceSprite = from.narrow ? art.narrow : art.regular, targetSprite = to.narrow ? art.narrow : art.regular;
  const rank = interpolateBox(from.rank, to.rank, p), suit = interpolateBox(from.suit, to.suit, p);
  for (let corner = 0; corner < 2; corner++) {
    ctx.save();
    if (corner) { ctx.translate(100, 144); ctx.rotate(Math.PI); }
    glyph(ctx, sourceSprite, from.rank, rank, 1 - p); glyph(ctx, targetSprite, to.rank, rank, p);
    glyph(ctx, sourceSprite, from.suit, suit, 1 - p); glyph(ctx, targetSprite, to.suit, suit, p);
    ctx.restore();
  }
  ctx.restore();
}

/** One canvas/one frame callback replaces hundreds of independently rasterized SVG animations. */
export function useHandMorph(): HandMorphApi {
  const morphing = ref(false);
  let active: ActiveMorph | null = null, generation = 0;
  function settle() {
    generation++;
    const current = active; active = null; morphing.value = false;
    if (!current) return;
    cancelAnimationFrame(current.frame); clearTimeout(current.timer);
    window.removeEventListener('resize', current.abort); window.removeEventListener('orientationchange', current.abort);
    document.removeEventListener('fullscreenchange', current.abort); document.removeEventListener('webkitfullscreenchange', current.abort);
    current.layer.remove(); current.done();
  }
  async function run(container: HTMLElement | null, apply: () => void) {
    settle();
    if (!container || matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(); return; }
    const token = generation;
    const initialViewport = { width: innerWidth, height: innerHeight };
    const from = capture(container), sourceClip = clip(container);
    if (!from.length) { apply(); return; }
    let applied = false;
    try {
      // Usually already warm. Cold decoding leaves the original hand visible.
      const artwork = await Promise.all(from.map(pose => prepareCardArt(pose.face)));
      if (generation !== token || innerWidth !== initialViewport.width || innerHeight !== initialViewport.height) return;
      const layer = document.createElement('canvas'); layer.className = 'hand-morph-layer'; layer.setAttribute('aria-hidden', 'true');
      const dpr = Math.min(devicePixelRatio || 1, 1.5), width = innerWidth, height = innerHeight;
      layer.width = Math.ceil(width * dpr); layer.height = Math.ceil(height * dpr);
      layer.style.width = `${width}px`; layer.style.height = `${height}px`;
      const ctx = layer.getContext('2d'); if (!ctx) { apply(); return; }
      const current: ActiveMorph = { layer, frame: 0, timer: 0, abort: settle, done: () => {} };
      active = current;
      document.body.appendChild(layer);
      window.addEventListener('resize', settle); window.addEventListener('orientationchange', settle);
      document.addEventListener('fullscreenchange', settle); document.addEventListener('webkitfullscreenchange', settle);
      const draw = (p: number, targets: Map<string, Pose>, targetClip: Clip) => {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height); ctx.save();
        const left = lerp(sourceClip.left, targetClip.left, p), top = lerp(sourceClip.top, targetClip.top, p);
        ctx.beginPath(); ctx.rect(left, top, lerp(sourceClip.right, targetClip.right, p) - left, lerp(sourceClip.bottom, targetClip.bottom, p) - top); ctx.clip();
        from.forEach((pose, i) => { const to = targets.get(pose.key); if (to) drawCard(ctx, pose, to, artwork[i], p); });
        ctx.restore();
      };
      draw(0, new Map(from.map(pose => [pose.key, pose])), sourceClip);
      morphing.value = true; applied = true; apply();
      await nextTick(); await nextTick();
      if (active !== current) return;
      const targets = new Map(capture(container).map(pose => [pose.key, pose])), targetClip = clip(container);
      const start = typeof document.timeline.currentTime === 'number' ? document.timeline.currentTime : performance.now();
      await new Promise<void>(resolve => {
        current.done = resolve;
        current.timer = window.setTimeout(settle, MORPH_MS + 250);
        const frame = (now: number) => {
          if (active !== current) return;
          const progress = Math.min(1, (now - start) / MORPH_MS);
          draw(easeHandMorph(progress), targets, targetClip);
          if (progress >= 1) settle(); else current.frame = requestAnimationFrame(frame);
        };
        current.frame = requestAnimationFrame(frame);
      });
    } catch {
      if (generation !== token) return;
      settle();
      if (!applied) apply();
    }
  }
  if (getCurrentScope()) onScopeDispose(settle);
  return { morphing, run, cancel: settle };
}
