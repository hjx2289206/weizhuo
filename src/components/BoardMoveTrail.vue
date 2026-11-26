<script setup lang="ts">
import { computed } from 'vue'
export interface TrailPoint { x: number; y: number }
export interface TrailRoute { points: readonly TrailPoint[]; width?: number; opacity?: number; dashed?: boolean }
export interface TrailMarker { x: number; y: number; size: number; kind: 'origin' | 'destination'; shape?: 'square' | 'circle'; muted?: boolean }
const props = defineProps<{ color: string; routes?: readonly TrailRoute[]; markers?: readonly TrailMarker[]; title?: string }>()
const halo = '#fff8e4'
function path(points: readonly TrailPoint[]): string { return points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('') }
function at(points: readonly TrailPoint[], fraction: number): TrailPoint {
  const first = points[0]!
  const spans = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y))
  const total = spans.reduce((a, b) => a + b, 0)
  if (!total) return first
  let distance = fraction * total
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!
    if (distance <= span) { const t = span ? distance / span : 0; return { x: points[i]!.x + (points[i + 1]!.x - points[i]!.x) * t, y: points[i]!.y + (points[i + 1]!.y - points[i]!.y) * t } }
    distance -= span
  }
  return points.at(-1)!
}
/** Arrow rides beside the route so it never covers a piece label at either end. */
function arrow(points: readonly TrailPoint[]): string | null {
  const a = at(points, .55), b = at(points, .7)
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy)
  if (length < 1) return null
  const offset = 20
  return `translate(${(a.x + b.x) / 2 - dy / length * offset} ${(a.y + b.y) / 2 + dx / length * offset}) rotate(${Math.atan2(dy, dx) * 180 / Math.PI})`
}
const routes = computed(() => (props.routes ?? []).filter(route => route.points.length > 1).map(route => ({ ...route, d: path(route.points), arrow: arrow(route.points) })))
const markers = computed(() => props.markers ?? [])
</script>
<template>
  <g class="board-move-trail" :data-trail-color="color" pointer-events="none" aria-hidden="true" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <title v-if="title">{{ title }}</title>
    <g v-for="(route, index) in routes" :key="`route-${index}`" :opacity="route.opacity ?? 1">
      <path :d="route.d" :stroke="halo" :stroke-width="(route.width ?? 3) + 4" :stroke-dasharray="route.dashed ? '8 7' : undefined" opacity=".68" />
      <path :d="route.d" :stroke="color" :stroke-width="route.width ?? 3" :stroke-dasharray="route.dashed ? '8 7' : undefined" />
      <g v-if="route.arrow" :transform="route.arrow">
        <path d="M-11-6L0 0L-11 6" :stroke="halo" stroke-width="8" opacity=".68" />
        <path d="M-11-6L0 0L-11 6" :stroke="color" stroke-width="3" />
      </g>
    </g>
    <g v-for="(marker, index) in markers" :key="`marker-${index}`" :opacity="marker.muted ? .72 : 1">
      <template v-if="marker.shape === 'circle'">
        <circle :cx="marker.x" :cy="marker.y" :r="marker.size / 2" :stroke="halo" :stroke-width="marker.kind === 'origin' ? 6.5 : 7.5" />
        <circle :cx="marker.x" :cy="marker.y" :r="marker.size / 2" :stroke="color" :stroke-width="marker.kind === 'origin' ? 2.4 : 3" :stroke-dasharray="marker.kind === 'origin' ? '7 5' : undefined" />
      </template>
      <template v-else>
        <rect :x="marker.x - marker.size / 2" :y="marker.y - marker.size / 2" :width="marker.size" :height="marker.size" rx="10" :stroke="halo" :stroke-width="marker.kind === 'origin' ? 6.5 : 7.5" />
        <rect :x="marker.x - marker.size / 2" :y="marker.y - marker.size / 2" :width="marker.size" :height="marker.size" rx="10" :stroke="color" :stroke-width="marker.kind === 'origin' ? 2.4 : 3" :stroke-dasharray="marker.kind === 'origin' ? '7 5' : undefined" />
      </template>
    </g>
  </g>
</template>
