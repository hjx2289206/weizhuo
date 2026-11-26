import type { Position } from './protocol';

export const MAX_SEATS = 8;

export interface SeatCountSettings {
  count: number;
  min: number;
  max: number;
}

export function isTableSeatCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= MAX_SEATS;
}

/** Cards point inward: bottom 0°, right −90°, top 180°, left 90°. */
export function orientationForSeat(position: { x: number; y: number }): number {
  const angle = Math.atan2(.5 - position.y, .5 - position.x) * (180 / Math.PI) + 90;
  if (!Number.isFinite(angle)) return 0;
  const wrapped = ((angle % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

// Start at the midpoint of the bottom edge. Each segment covers the same
// distance in normalized table coordinates, moving toward the right edge.
const perimeter = [
  [.5, .9], [.9, .9], [.9, .5], [.9, .1], [.5, .1],
  [.1, .1], [.1, .5], [.1, .9], [.5, .9],
] as const;

export function phoneSeats(count: number): Position[] {
  if (!isTableSeatCount(count)) throw new RangeError(`座位数必须为 2 至 ${MAX_SEATS} 的整数`);
  return Array.from({ length: count }, (_, seat) => {
    const distance = seat * (perimeter.length - 1) / count;
    const segment = Math.floor(distance);
    const fraction = distance - segment;
    const [[x0, y0], [x1, y1]] = [perimeter[segment]!, perimeter[segment + 1]!];
    const x = x0 + (x1 - x0) * fraction;
    const y = y0 + (y1 - y0) * fraction;
    return { x, y, angle: orientationForSeat({ x, y }) };
  });
}
