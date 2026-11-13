import { JUNQI_FOUR_EDGES, junqiDestinations, junqiRailEdge, junqiRoadEdge, type JunqiBoard, type JunqiVariant } from './junqi'

/** The same legal destination check gates this explanatory route; occupied stations never get crossed. */
export function junqiMovePath(board: JunqiBoard, from: number, to: number, variant: JunqiVariant): number[] {
  if (!junqiDestinations(board, from, variant).includes(to)) return []
  if (variant === 'two' && junqiRoadEdge(from, to)) return [from, to]
  if (variant === 'four' && JUNQI_FOUR_EDGES.some(edge => edge.a === from && edge.b === to || edge.b === from && edge.a === to)) return [from, to]
  const engineer = board[from]?.rank === 'engineer'
  const queue = [{ point: from, direction: -1, path: [from] }], seen = new Set<string>()
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!
    const edges = variant === 'four' ? JUNQI_FOUR_EDGES.flatMap(edge => !edge.rail ? [] : edge.a === current.point ? [{ to: edge.b, out: edge.out, into: edge.into }] : edge.b === current.point ? [{ to: edge.a, out: (edge.into + 2) % 4, into: (edge.out + 2) % 4 }] : [])
      : Array.from({ length: 60 }, (_, p) => p).filter(p => junqiRailEdge(current.point, p)).map(p => {
        const direction = p % 5 === current.point % 5 ? p > current.point ? 1 : 3 : p > current.point ? 0 : 2
        return { to: p, out: direction, into: direction }
      })
    for (const edge of edges) {
      if (!engineer && current.direction !== -1 && edge.out !== current.direction) continue
      const key = `${edge.to}:${engineer ? -1 : edge.into}`
      if (seen.has(key) || edge.to === from) continue
      seen.add(key)
      const path = [...current.path, edge.to]
      if (edge.to === to) return path
      if (!board[edge.to]) queue.push({ point: edge.to, direction: edge.into, path })
    }
  }
  return []
}
