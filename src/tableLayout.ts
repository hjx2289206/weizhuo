import { orientationForSeat } from '../shared/tableSeats'
// Pure geometry for the physical tabletop felt. No DOM access: every value is
// derived from the stage size the caller measured, so the layout is deterministic
// and can be proved without a browser.
//
// Orientation convention (shared with the server payload and the card CSS):
//   rotation = normalize(atan2(0.5 - y, 0.5 - x) * 180/PI + 90)
//   bottom seat 0deg (upright), left 90deg, top 180deg, right -90deg.
// A card's top edge therefore always points at the board centre, so the rank is
// legible from the seat that owns it. Rendering always re-derives the angle from
// x/y; the stored `angle` field is only kept for protocol compatibility.
//
// Public plays are physical objects: every accepted play of the round is thrown
// onto the felt and stays there, so plays are *allowed* to cover each other and
// the bottom-3 block. Nothing searches for free space any more — the block always
// sits on the felt centre, a throw lands on its actor's side of the centre plus
// the server's authoritative scatter, and only one group may wrap or overlap
// itself to stay on the felt. Later throws land on top of earlier ones.

export interface Size {
  w: number
  h: number
}

/** Centred reference of the felt: the bottom block and every throw bias from it. */
export const BOARD_CENTRE = { x: 0.5, y: 0.48 } as const
/** Physical card aspect ratio from PlayingCard's viewBox (100x144). */
export const CARD_ASPECT = 1.44

const DEG_PER_RAD = 180 / Math.PI
/** Stage edge inset the fit tests respect. */
const MARGIN = 26
/** Preferred centre-bias anchor distance, as a fraction of the smaller stage side. */
const STRIDE_RATIO = 0.27
/** A throw lands this fraction of the smaller side from the centre, toward its actor. */
const ACTOR_BIAS_RATIO = 0.12
/** Public play card width: ~148px at a 1280x800 tablet, much closer in than before. */
const PLAY_CARD_RATIO = 0.185
const PLAY_CARD_MIN = 128
const PLAY_CARD_MAX = 168
/** Every card keeps at least this fraction of its width exposed inside its own row. */
const MIN_REVEAL = 0.34
/** Widest gap a row may open between neighbours, as a fraction of the card width. */
const MAX_SPREAD = 0.62
/** Vertical growth of a row stack: only the top strip of the row below stays visible. */
const ROW_REVEAL = 0.42
/** `.physical-bottom-cards` gap, mirrored for the block footprint. */
const BOTTOM_GAP = 7
const BOTTOM_COUNT = 3
const BOTTOM_CARD_MIN = 105
const BOTTOM_CARD_MAX = 140
const EPSILON = 1e-6

function clamp(value: number, low: number, high: number): number {
  if (low > high) return (low + high) / 2
  return Math.min(high, Math.max(low, value))
}

/** Wraps any degree value into (-180, 180]. */
function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  const wrapped = ((deg % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

export { orientationForSeat } from '../shared/tableSeats'

/** Public play card width: ~148px at 1280x800, ~142px at 1024x768, never a postage stamp. */
function playCardWidth(size: Size): number {
  if (!(size.w > 0) || !(size.h > 0)) return PLAY_CARD_MIN
  return Math.round(clamp(Math.min(size.w, size.h) * PLAY_CARD_RATIO, PLAY_CARD_MIN, PLAY_CARD_MAX))
}

/** Bottom-3 card width: ~120px at a 1280x800 tablet, ~115px at 1024x768. */
function bottomCardWidth(size: Size): number {
  if (!(size.w > 0) || !(size.h > 0)) return BOTTOM_CARD_MIN
  return Math.round(clamp(Math.min(size.w, size.h) * 0.15, BOTTOM_CARD_MIN, BOTTOM_CARD_MAX))
}

/** Server scatter is a fraction of the smaller stage side, bounded to ±0.045. */
const SCATTER_LIMIT = 0.045

function scatterOffset(value: number, unit: number): number {
  if (!Number.isFinite(value)) return 0
  return clamp(value, -SCATTER_LIMIT, SCATTER_LIMIT) * unit
}

export interface ThrowLayout {
  /** Percent of stage width for `.table-thrown-play` left (the group centre). */
  left: number
  /** Percent of stage height for `.table-thrown-play` top (the group centre). */
  top: number
  /** `--seat-angle`: the actor's physical orientation plus the scatter angle. */
  angle: number
  /** `--play-card-width` in px. */
  cardWidth: number
  /** `--card-overlap` in px, positive: the CSS turns it into a negative left margin. */
  overlap: number
  /** Per-row overlap, for rows whose card count differs from the widest row. */
  rowOverlaps: number[]
  /** Cards per row, in DOM order, so straights/tractors stay in sequence. */
  rows: number[]
  /** Negative top margin between rows (rows overlap like stacked hands). */
  rowGap: number
  /** Vector from the group centre back to the actor's seat, in stage px (throw origin). */
  fromX: number
  fromY: number
  /** Unrotated footprint of the whole group. */
  width: number
  height: number
}

export interface BottomLayout {
  /** Block centre in stage px. */
  cx: number
  cy: number
  /** `--bottom-card-width` in px. */
  cardWidth: number
  /** `--bottom-angle`: the block faces the landlord once one is chosen. */
  angle: number
  /** Unrotated footprint of the three cards. */
  width: number
  height: number
  /** Axis-aligned half extents of the rotated footprint. */
  halfX: number
  halfY: number
}

/** A rotated rectangle, the only shape the label search reasons about. */
interface Obstacle {
  cx: number
  cy: number
  width: number
  height: number
  rad: number
}

/** Unit frame around the board centre used by the label search. */
interface Ray {
  ux: number
  uy: number
  vx: number
  vy: number
}

interface Plan {
  cardWidth: number
  rows: number[]
  rowOverlaps: number[]
  width: number
  height: number
  rowGap: number
}

/** Half extents of the axis-aligned box that contains a width x height box rotated by `rad`. */
function footprintHalf(width: number, height: number, rad: number): { x: number; y: number } {
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  return { x: (width * cos + height * sin) / 2, y: (width * sin + height * cos) / 2 }
}

/** How far a rotated box reaches along a unit axis. */
function supportAlong(width: number, height: number, rad: number, ax: number, ay: number): number {
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return (width / 2) * Math.abs(ax * cos + ay * sin) + (height / 2) * Math.abs(-ax * sin + ay * cos)
}

/**
 * Lays `count` cards out in rows of at most `perRow`, keeping card runs
 * contiguous so straights/tractors stay in order. `step` is the distance between
 * neighbouring card centres, so the row overlap is `cardWidth - step`.
 */
function buildPlan(cardWidth: number, count: number, perRow: number, step: number): Plan {
  const rows: number[] = []
  const rowOverlaps: number[] = []
  const overlap = Math.max(0, Math.round((cardWidth - step) * 100) / 100)
  let remaining = count
  while (remaining > 0) {
    const take = Math.min(perRow, remaining)
    remaining -= take
    rows.push(take)
    rowOverlaps.push(overlap)
  }
  const widest = Math.max(1, Math.min(perRow, count))
  const rowHeight = cardWidth * CARD_ASPECT
  return {
    cardWidth,
    rows,
    rowOverlaps,
    width: Math.round(cardWidth + (widest - 1) * step),
    height: Math.round(rowHeight * (1 + (rows.length - 1) * ROW_REVEAL)),
    rowGap: Math.round(-rowHeight * (1 - ROW_REVEAL)),
  }
}

/**
 * Arrangement for one throw: the fewest balanced rows whose rotated footprint
 * still fits the free room around the anchor. Cards never shrink to fit, only the
 * in-row overlap changes, so a big legal play stays legible wherever it lands.
 */
function planFor(cardWidth: number, count: number, rad: number, roomX: number, roomY: number): Plan {
  const rowHeight = cardWidth * CARD_ASPECT
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const stepMin = cardWidth * MIN_REVEAL
  const stepCap = cardWidth * MAX_SPREAD
  for (let rowCount = 1; rowCount <= count; rowCount += 1) {
    const perRow = Math.ceil(count / rowCount)
    const widest = Math.min(perRow, count)
    const height = rowHeight * (1 + (rowCount - 1) * ROW_REVEAL)
    // Widest row the rotated group may open without leaving the free room.
    let room = Number.POSITIVE_INFINITY
    if (cos > EPSILON) room = Math.min(room, (2 * roomX - height * sin) / cos)
    else if (height * sin > 2 * roomX + EPSILON) continue
    if (sin > EPSILON) room = Math.min(room, (2 * roomY - height * cos) / sin)
    else if (height * cos > 2 * roomY + EPSILON) continue
    if (room + EPSILON < cardWidth + (widest - 1) * stepMin) continue
    const step = widest > 1 ? clamp((room - cardWidth) / (widest - 1), stepMin, stepCap) : cardWidth
    return buildPlan(cardWidth, count, perRow, step)
  }
  // Degenerate felt: one wide row keeps the play in order instead of stacking it.
  return buildPlan(cardWidth, count, count, stepMin)
}

/**
 * The bottom-3 block. It keeps its original size, its felt-centre place and its
 * landlord-facing rotation; throws are allowed to cover it, so nothing else has
 * to be reserved for it.
 */
export function bottomLayout(size: Size, angle: number): BottomLayout {
  const w = Math.max(1, size.w)
  const h = Math.max(1, size.h)
  const cardWidth = bottomCardWidth(size)
  const width = cardWidth * BOTTOM_COUNT + BOTTOM_GAP * (BOTTOM_COUNT - 1)
  const height = cardWidth * CARD_ASPECT
  const resolved = normalizeAngle(angle)
  const half = footprintHalf(width, height, resolved / DEG_PER_RAD)
  return {
    cx: w * BOARD_CENTRE.x,
    cy: h * BOARD_CENTRE.y,
    cardWidth,
    angle: resolved,
    width,
    height,
    halfX: half.x,
    halfY: half.y,
  }
}

/** Unit frame from the board centre toward one seat, in stage px. */
function rayFor(position: { x: number; y: number }, w: number, h: number): Ray {
  const centreX = w * BOARD_CENTRE.x
  const centreY = h * BOARD_CENTRE.y
  let ux = position.x * w - centreX
  let uy = position.y * h - centreY
  const length = Math.hypot(ux, uy)
  if (length < 1) {
    ux = 0
    uy = 1
  } else {
    ux /= length
    uy /= length
  }
  return { ux, uy, vx: -uy, vy: ux }
}

/**
 * Places one accepted play. The group lands on the actor's side of the felt
 * centre, offset by the server's authoritative scatter, and is rotated to read
 * from the actor's seat. Only this group ever wraps or overlaps itself, so the
 * same event keeps the same place on every screen and after every refresh.
 */
export function playLayout(
  actor: { x: number; y: number },
  size: Size,
  count: number,
  scatter: { x: number; y: number; angle: number },
): ThrowLayout {
  const w = Math.max(1, size.w)
  const h = Math.max(1, size.h)
  const cards = Math.max(1, Math.floor(count) || 1)
  const unit = Math.min(w, h)
  const frame = rayFor(actor, w, h)
  const angle = normalizeAngle(orientationForSeat(actor) + normalizeAngle(scatter.angle))
  const rad = angle / DEG_PER_RAD
  const anchorX = w * BOARD_CENTRE.x + frame.ux * unit * ACTOR_BIAS_RATIO + scatterOffset(scatter.x, unit)
  const anchorY = h * BOARD_CENTRE.y + frame.uy * unit * ACTOR_BIAS_RATIO + scatterOffset(scatter.y, unit)
  const cardWidth = playCardWidth(size)
  const roomX = Math.max(cardWidth / 2, Math.min(anchorX - MARGIN, w - MARGIN - anchorX))
  const roomY = Math.max(cardWidth / 2, Math.min(anchorY - MARGIN, h - MARGIN - anchorY))
  const plan = planFor(cardWidth, cards, rad, roomX, roomY)
  return {
    left: Math.round((anchorX / w) * 10000) / 100,
    top: Math.round((anchorY / h) * 10000) / 100,
    angle,
    cardWidth: plan.cardWidth,
    overlap: plan.rowOverlaps.length > 0 ? Math.max(...plan.rowOverlaps) : 0,
    rowOverlaps: plan.rowOverlaps,
    rows: plan.rows,
    rowGap: plan.rowGap,
    fromX: Math.round(actor.x * w - anchorX),
    fromY: Math.round(actor.y * h - anchorY),
    width: plan.width,
    height: plan.height,
  }
}

/** A rotated rectangle in stage px (used to keep pass labels clear of live throws). */
export interface StageBox {
  cx: number
  cy: number
  width: number
  height: number
  angle: number
}

/** Default pass footprint; tablet callers supply their larger SVG + caption size. */
const LABEL_WIDTH = 52
const LABEL_HEIGHT = 26
/** Bounded distances a pass label may take, as multiples of the centre-bias stride. */
const LABEL_SCALES = [1, 0.85, 1.15, 0.7, 1.3, 0.55, 1.45, 1.6, 0.4, 1.75, 1.9, 0.25]
/** Lateral lanes let a large indicator clear the centre block without covering a placard. */
const LABEL_SHIFTS = [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
/** Tangential shift unit of the label search, as a fraction of the smaller stage side. */
const SHIFT_RATIO = 0.05

function boxesApart(a: Obstacle, b: Obstacle): boolean {
  const axes: Array<[number, number]> = [
    [Math.cos(a.rad), Math.sin(a.rad)],
    [-Math.sin(a.rad), Math.cos(a.rad)],
    [Math.cos(b.rad), Math.sin(b.rad)],
    [-Math.sin(b.rad), Math.cos(b.rad)],
  ]
  for (const [ax, ay] of axes) {
    const centre = a.cx * ax + a.cy * ay
    const reach = supportAlong(a.width, a.height, a.rad, ax, ay)
    const otherCentre = b.cx * ax + b.cy * ay
    const otherReach = supportAlong(b.width, b.height, b.rad, ax, ay)
    if (centre + reach <= otherCentre - otherReach + EPSILON) return true
    if (otherCentre + otherReach <= centre - reach + EPSILON) return true
  }
  return false
}

/** The bottom block inflated by the clearance a label keeps from it. */
function blockObstacle(layout: BottomLayout): Obstacle {
  return {
    cx: layout.cx,
    cy: layout.cy,
    width: layout.width + 2 * LABEL_HEIGHT,
    height: layout.height + 2 * LABEL_HEIGHT,
    rad: layout.angle / DEG_PER_RAD,
  }
}

/**
 * Search along the actor's ray and neighbouring lanes using the rotated footprint.
 * Guandan passes null for the bottom block and supplies its actual level panel instead.
 */
export function passLayout(
  position: { x: number; y: number },
  size: Size,
  block: BottomLayout | null,
  groups: StageBox[],
  labelSize: Size = { w: LABEL_WIDTH, h: LABEL_HEIGHT },
): { left: number; top: number; angle: number } {
  const w = Math.max(1, size.w)
  const h = Math.max(1, size.h)
  const angle = orientationForSeat(position)
  const frame = rayFor(position, w, h)
  const stride = Math.min(w, h) * STRIDE_RATIO
  const shiftUnit = Math.min(w, h) * SHIFT_RATIO
  const obstacles: Obstacle[] = [
    ...(block ? [blockObstacle(block)] : []),
    ...groups.map((group) => ({
      cx: group.cx,
      cy: group.cy,
      width: group.width,
      height: group.height,
      rad: group.angle / DEG_PER_RAD,
    })),
  ]
  const centreX = w * BOARD_CENTRE.x
  const centreY = h * BOARD_CENTRE.y
  let best = { cx: centreX + frame.ux * stride, cy: centreY + frame.uy * stride }
  let bestCost = Number.POSITIVE_INFINITY
  for (const scale of LABEL_SCALES) {
    for (const step of LABEL_SHIFTS) {
      const distance = stride * scale
      const shift = step * shiftUnit
      const box: Obstacle = {
        cx: centreX + frame.ux * distance + frame.vx * shift,
        cy: centreY + frame.uy * distance + frame.vy * shift,
        width: labelSize.w,
        height: labelSize.h,
        rad: angle / DEG_PER_RAD,
      }
      const halfX = supportAlong(box.width, box.height, box.rad, 1, 0)
      const halfY = supportAlong(box.width, box.height, box.rad, 0, 1)
      if (box.cx - halfX < MARGIN || box.cx + halfX > w - MARGIN) continue
      if (box.cy - halfY < MARGIN || box.cy + halfY > h - MARGIN) continue
      if (!obstacles.every((obstacle) => boxesApart(box, obstacle))) continue
      const cost = Math.abs(distance - stride) + Math.abs(shift) * 0.5
      if (cost < bestCost - EPSILON) {
        bestCost = cost
        best = { cx: box.cx, cy: box.cy }
      }
    }
  }
  return {
    left: Math.round((best.cx / w) * 10000) / 100,
    top: Math.round((best.cy / h) * 10000) / 100,
    angle,
  }
}
