import { BoundedCache } from './boundedCache';
import { cardCornerLayout } from './cardCornerLayout';

export interface Raster { canvas: HTMLCanvasElement; scale: number }
export interface CardAnimationArt { body: Raster; narrow: Raster; regular: Raster }
const cache = new BoundedCache<Raster>(16 * 1024 * 1024);
const pending = new Map<string, Promise<Raster>>();
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Motion is rasterized once; resting cards remain their original sharp SVGs. */
const SCALE = 2.5;

function raster(source: string, width: number, height: number): Promise<Raster> {
  const key = `${width}:${height}:${source}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const task = new Promise<Raster>((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(width * SCALE); canvas.height = Math.ceil(height * SCALE);
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas unavailable')); return; }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const result = { canvas, scale: SCALE };
      cache.set(key, result, canvas.width * canvas.height * 4);
      resolve(result);
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Card artwork unavailable')); };
    image.src = url;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

function snapshot(svg: SVGSVGElement): SVGSVGElement {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('xmlns', SVG_NS);
  copy.setAttribute('width', '100'); copy.setAttribute('height', '144');
  copy.removeAttribute('class');
  // Level/wild borders come from the owner's CSS, so carry their resolved ink.
  const rect = svg.querySelector('rect');
  if (rect && copy.querySelector('rect')) {
    const style = getComputedStyle(rect);
    copy.querySelector('rect')!.setAttribute('stroke', style.stroke);
    copy.querySelector('rect')!.setAttribute('stroke-width', style.strokeWidth);
  }
  const text = svg.querySelector('[data-card-corner="top-rank"]');
  if (text) copy.setAttribute('data-corner-ink', getComputedStyle(text).fill);
  return copy;
}

function cornerSprite(face: SVGSVGElement, narrow: boolean): string {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS); svg.setAttribute('viewBox', '0 0 34 52');
  svg.setAttribute('width', '34'); svg.setAttribute('height', '52');
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('fill', face.getAttribute('data-corner-ink') ?? '#203e36');
  const layout = cardCornerLayout(narrow);
  for (const kind of ['rank', 'suit'] as const) {
    const text = face.querySelector(`[data-card-corner="top-${kind}"]`)?.cloneNode(true) as SVGTextElement | undefined;
    if (!text) continue;
    const style = layout[kind];
    text.setAttribute('x', `${style.x}`); text.setAttribute('y', `${style.y}`); text.setAttribute('font-size', `${style.size}`);
    if (kind === 'rank') { text.setAttribute('font-family', layout.rank.family); text.setAttribute('textLength', `${layout.rank.width}`); }
    group.appendChild(text);
  }
  svg.appendChild(group);
  return new XMLSerializer().serializeToString(svg);
}

export function prepareCardArt(svg: SVGSVGElement): Promise<CardAnimationArt> {
  const face = snapshot(svg);
  const narrow = cornerSprite(face, true), regular = cornerSprite(face, false);
  face.removeAttribute('data-corner-ink');
  for (const text of face.querySelectorAll('[data-card-corner]')) text.remove();
  return Promise.all([raster(new XMLSerializer().serializeToString(face), 100, 144), raster(narrow, 34, 52), raster(regular, 34, 52)])
    .then(([body, narrow, regular]) => ({ body, narrow, regular }));
}

export async function cardBitmap(svg: SVGSVGElement): Promise<HTMLCanvasElement> {
  // Back art is only needed by the phone-only flip; use the same bounded cache.
  if (svg.classList.contains('card-back')) return (await raster(new XMLSerializer().serializeToString(snapshot(svg)), 100, 144)).canvas;
  const art = await prepareCardArt(svg);
  const narrow = svg.querySelector('[data-card-corner="top-rank"]')?.getAttribute('font-size') === '20';
  const corner = narrow ? art.narrow : art.regular;
  const canvas = document.createElement('canvas');
  canvas.width = art.body.canvas.width; canvas.height = art.body.canvas.height;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(SCALE, SCALE);
  ctx.drawImage(art.body.canvas, 0, 0, 100, 144);
  ctx.drawImage(corner.canvas, 0, 0, 34, 52);
  ctx.translate(100, 144); ctx.rotate(Math.PI);
  ctx.drawImage(corner.canvas, 0, 0, 34, 52);
  return canvas;
}

/** Warm both corner styles in small idle batches, never all 27 during a tap. */
export function warmCardArt(container: HTMLElement): () => void {
  const faces = Array.from(container.querySelectorAll<SVGSVGElement>('[data-card-id] > svg'));
  let cancelled = false, timer: ReturnType<typeof setTimeout>;
  const step = async () => {
    if (cancelled || !container.isConnected) return;
    const face = faces.shift();
    if (!face) return;
    try { await prepareCardArt(face); } catch { /* live SVG remains available */ }
    if (!cancelled) timer = setTimeout(step, 16);
  };
  timer = setTimeout(step, 80);
  return () => { cancelled = true; clearTimeout(timer); };
}
