import type { XiangqiPiece } from '../../shared/xiangqi'
import { xiangqiPoint } from '../../shared/xiangqiGeometry'
import { clamp } from './chessMotion'
export interface XiangqiPlayback { from: number; to: number; path: number[]; phase: number; piece: XiangqiPiece; capture: boolean; rejected?: string }
export function xiangqiPathPoint(path: readonly number[], progress: number, side: number | null) {
  const points=path.map(point=>xiangqiPoint(point,side)), lengths=points.slice(1).map((p,i)=>Math.hypot(p.x-points[i]!.x,p.y-points[i]!.y)), total=lengths.reduce((a,b)=>a+b,0)
  let distance=clamp(progress)*total
  for(let i=0;i<lengths.length;i++){if(distance<=lengths[i]!){const from=points[i]!,to=points[i+1]!,t=lengths[i]?distance/lengths[i]!:0;return {x:from.x+(to.x-from.x)*t,y:from.y+(to.y-from.y)*t}}distance-=lengths[i]!}
  return points.at(-1)??{x:0,y:0}
}
export function xiangqiPlaybackProgress(phase:number,rejected=false) { const t=clamp((phase-.12)/.55);return rejected?Math.sin(clamp((phase-.08)/.7)*Math.PI)*.45:t*t*(3-2*t) }
