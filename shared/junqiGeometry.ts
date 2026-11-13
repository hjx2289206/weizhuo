import { fourJunqiXY, JUNQI_FOUR_EDGES, type JunqiVariant } from './junqi'
export interface BoardPosition { x: number; y: number }
export type BoardBox = [number, number, number, number]
export const junqiFullBox = (variant: JunqiVariant): BoardBox => variant === 'four' ? [0, 0, 872, 872] : [0, 0, 500, 760]
export function junqiPointPosition(p: number, variant: JunqiVariant, side: number | null): BoardPosition {
  if (variant === 'two') { const d = side === 1 ? 59 - p : p, row = Math.floor(d / 5); return { x: 70 + d % 5 * 90, y: 52 + row * 56 + (row >= 6 ? 48 : 0) } }
  let [x, y] = fourJunqiXY(p)
  for (let n = 0; n < (side ?? 0); n++) [x, y] = [y, 16 - x]
  return { x: 52 + x * 48, y: 52 + y * 48 }
}
export function junqiCurveControl(a: number, b: number, side: number | null): BoardPosition {
  const [ax, ay] = fourJunqiXY(a), [bx, by] = fourJunqiXY(b)
  let [x, y] = [ax === 5 || ax === 11 ? bx : ax, ay === 5 || ay === 11 ? by : ay]
  for (let n = 0; n < (side ?? 0); n++) [x, y] = [y!, 16 - x!]
  return { x: 52 + x! * 48, y: 52 + y! * 48 }
}
export function junqiEdgePath(a: number, b: number, variant: JunqiVariant, side: number | null, curve = false): string {
  const start = junqiPointPosition(a, variant, side), end = junqiPointPosition(b, variant, side)
  const edge = curve ? JUNQI_FOUR_EDGES.find(edge => edge.a === a && edge.b === b || edge.a === b && edge.b === a) : undefined
  const control = curve ? junqiCurveControl(edge?.a ?? a, edge?.b ?? b, side) : null
  return `M${start.x} ${start.y}${control ? `Q${control.x} ${control.y} ` : 'L'}${end.x} ${end.y}`
}
export function junqiRouteGeometry(route: readonly number[], variant: JunqiVariant, side: number | null) {
  const points: BoardPosition[] = [], lengths: number[] = []
  let path = '', distance = 0
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!, start = junqiPointPosition(a, variant, side), end = junqiPointPosition(b, variant, side)
    const edge = variant === 'four' ? JUNQI_FOUR_EDGES.find(e => e.a === a && e.b === b || e.a === b && e.b === a) : undefined
    const control = edge?.curve ? junqiCurveControl(edge.a, edge.b, side) : null
    path += junqiEdgePath(a, b, variant, side, Boolean(control))
    for (let n = i === 1 ? 0 : 1; n <= 20; n++) {
      const t = n / 20, point = control ? { x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x, y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y } : { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
      if (points.length) { const previous = points.at(-1)!; distance += Math.hypot(point.x - previous.x, point.y - previous.y) }
      points.push(point); lengths.push(distance)
    }
  }
  const at = (progress: number): BoardPosition => {
    if (!points.length) return route.length ? junqiPointPosition(route[0]!, variant, side) : { x: 0, y: 0 }
    const target = Math.max(0, Math.min(1, progress)) * distance, index = lengths.findIndex(value => value >= target)
    if (index <= 0) return points[0]!
    const before = points[index - 1]!, after = points[index]!, ratio = (target - lengths[index - 1]!) / (lengths[index]! - lengths[index - 1]! || 1)
    return { x: before.x + (after.x - before.x) * ratio, y: before.y + (after.y - before.y) * ratio }
  }
  return { points, path, at }
}
export function junqiFocusBox(route: readonly number[], variant: JunqiVariant, side: number | null): BoardBox {
  const full = junqiFullBox(variant)
  if (!route.length) return full
  const points = [...junqiRouteGeometry(route, variant, side).points, ...route.map(p => junqiPointPosition(p, variant, side))]
  const padding = variant === 'two' ? 76 : 62
  const minX = Math.min(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y)), maxX = Math.max(...points.map(p => p.x)), maxY = Math.max(...points.map(p => p.y))
  const w = Math.min(full[2], Math.max(variant === 'two' ? 270 : 230, maxX - minX + padding * 2)), h = Math.min(full[3], Math.max(230, maxY - minY + padding * 2))
  return [Math.max(0, Math.min(full[2] - w, (minX + maxX - w) / 2)), Math.max(0, Math.min(full[3] - h, (minY + maxY - h) / 2)), w, h]
}
