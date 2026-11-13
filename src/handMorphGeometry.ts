/** A glyph's bounds in the card SVG's own coordinates, before the card rotates. */
export interface GlyphBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function interpolateBox(from: GlyphBox, to: GlyphBox, p: number): GlyphBox {
  return { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p,
    width: from.width + (to.width - from.width) * p, height: from.height + (to.height - from.height) * p };
}

/** Same cubic-bezier(.24,.72,.24,1) used by the card, crop and corner blend. */
export function easeHandMorph(progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const cubic = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  let low = 0, high = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (low + high) / 2;
    if (cubic(mid, .24, .24) < progress) low = mid; else high = mid;
  }
  return cubic((low + high) / 2, .72, 1);
}

/** Map a source glyph exactly onto the other renderer's bounds; font shape fades separately. */
export function glyphTransform(from: GlyphBox, to: GlyphBox): string {
  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;
  return `matrix(${scaleX}, 0, 0, ${scaleY}, ${to.x - from.x * scaleX}, ${to.y - from.y * scaleY})`;
}
