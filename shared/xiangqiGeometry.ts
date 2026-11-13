import type { XiangqiPiece } from './xiangqi'
export type XiangqiBox = readonly [number, number, number, number]
export const XIANGQI_FULL_BOX: XiangqiBox = [0, 0, 500, 540]
export function xiangqiPoint(point: number, side: number | null = 0) { return { x: 50 + (side === 1 ? 8 - point % 9 : point % 9) * 50, y: 45 + (side === 1 ? 9 - Math.floor(point / 9) : Math.floor(point / 9)) * 50 } }
/** Include the leg/eye of a horse or elephant, and every station of a straight move. */
export function xiangqiMotionPath(piece: XiangqiPiece, from: number, to: number): number[] {
  const r = Math.floor(from / 9), c = from % 9, dr = Math.floor(to / 9) - r, dc = to % 9 - c
  if (piece.rank === 'horse') return [from, Math.abs(dr) === 2 ? from + Math.sign(dr) * 9 : from + Math.sign(dc), to]
  if (piece.rank === 'elephant') return [from, from + dr / 2 * 9 + dc / 2, to]
  if (dr === 0 || dc === 0) { const step = dr === 0 ? Math.sign(dc) : Math.sign(dr) * 9, points = [from]; if (!step) return points; for (let p = from + step; p !== to; p += step) points.push(p); return [...points, to] }
  return [from, to]
}
export function xiangqiFocusBox(points: readonly number[], side: number | null = 0): XiangqiBox {
  if (!points.length) return XIANGQI_FULL_BOX
  const coords = points.map(point => xiangqiPoint(point, side)), xs = coords.map(p => p.x), ys = coords.map(p => p.y)
  const width = Math.min(500, Math.max(210, Math.max(...xs) - Math.min(...xs) + 100)), height = Math.min(540, Math.max(230, Math.max(...ys) - Math.min(...ys) + 100))
  const x = Math.max(0, Math.min(500 - width, (Math.min(...xs) + Math.max(...xs) - width) / 2)), y = Math.max(0, Math.min(540 - height, (Math.min(...ys) + Math.max(...ys) - height) / 2))
  return [x, y, width, height]
}
