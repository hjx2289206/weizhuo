import { orientationForSeat } from './tableLayout'

export const TABLET_SEAT_WIDTH = 168
export const TABLET_SEAT_HEIGHT = 112

/** Rotate the complete placard, then clamp its actual footprint inside the felt. */
export function tabletSeatLayout(position: { x: number; y: number }, size: { w: number; h: number }) {
  const w = Math.max(1, size.w), h = Math.max(1, size.h)
  const scale = Math.max(.72, Math.min(1, w / 900, h / 560))
  const angle = orientationForSeat(position)
  const rad = angle * Math.PI / 180
  const width = scale * (Math.abs(Math.cos(rad)) * TABLET_SEAT_WIDTH + Math.abs(Math.sin(rad)) * TABLET_SEAT_HEIGHT)
  const height = scale * (Math.abs(Math.sin(rad)) * TABLET_SEAT_WIDTH + Math.abs(Math.cos(rad)) * TABLET_SEAT_HEIGHT)
  const clamp = (value: number, extent: number, length: number) =>
    Math.max(Math.min(length / 2, extent / 2 + 12), Math.min(length - extent / 2 - 12, value))
  return { left: clamp(position.x * w, width, w) / w * 100,
    top: clamp(position.y * h, height, h) / h * 100, angle, scale, width, height }
}
