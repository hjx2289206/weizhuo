export type PhonePlayPosition = 'left' | 'right' | 'top' | 'self';
export interface PhonePlayLayout {
  x: number; y: number; width: number; height: number;
  cardWidth: number; step: number; rowStep: number; columns: number;
}

/** Public plays have their own board regions, independent of names and avatar widths. */
export function phonePlayLayout(size: { width: number; height: number }, position: PhonePlayPosition, count: number, seats: number): PhonePlayLayout {
  const w = Math.max(120, size.width), h = Math.max(90, size.height), edge = 6;
  const side = position === 'left' || position === 'right';
  const regionX = side ? (position === 'left' ? edge : w * .73 + edge) : w * .29;
  const regionW = side ? w * .27 - edge * 2 : w * .42;
  const top = side ? Math.min(56, h * .4) : 30;
  const splitCenter = seats >= 4;
  const regionH = side || !splitCenter ? h - top - edge : (h - top - edge - 8) / 2;
  const regionY = position === 'self' && splitCenter ? top + regionH + 8 : top;
  if (count === 0) {
    const width = Math.min(86, regionW), height = Math.min(34, regionH);
    return { x: side ? position === 'right' ? regionX + regionW - width : regionX : regionX + (regionW - width) / 2,
      y: position === 'self' ? h - edge - height : regionY + (side ? (regionH - height) / 2 : 0),
      width, height, cardWidth: width, step: width, rowStep: height, columns: 1 };
  }
  let cardWidth = splitCenter ? 39 : 46;
  let columns = 1, rows = count;
  for (; cardWidth > 8; cardWidth -= .5) {
    columns = Math.max(1, Math.min(count, Math.floor((regionW - cardWidth) / (cardWidth * .48)) + 1));
    rows = Math.ceil(count / columns);
    if (cardWidth * 1.44 + (rows - 1) * cardWidth * .28 <= regionH) break;
  }
  const step = cardWidth * .48;
  const rowStep = rows > 1 ? Math.min(cardWidth * .5, (regionH - cardWidth * 1.44) / (rows - 1)) : cardWidth * .5;
  const width = cardWidth + (columns - 1) * step, height = cardWidth * 1.44 + (rows - 1) * rowStep;
  return { x: side ? position === 'right' ? regionX + regionW - width : regionX : regionX + (regionW - width) / 2,
    y: position === 'self' ? h - edge - height : regionY + (side ? (regionH - height) / 2 : 0),
    width, height, cardWidth, step, rowStep, columns };
}
