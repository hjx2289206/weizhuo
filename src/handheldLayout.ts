/**
 * Geometry for the handheld (phone) card fan.
 *
 * `style.css` declares
 *
 *   .handheld-card {
 *     transform: translate(-50%, calc(-50% - var(--card-lift))) rotate(var(--card-angle));
 *     transform-origin: 50% 150%;
 *   }
 *
 * so `--card-x`/`--card-y` publish the pre-rotation centre of a card and its
 * rotation origin sits half a card height below the card's bottom edge.
 *
 * This is a deep fan held from underneath, not a flat filmstrip. The wedge runs
 * to about ±41° and the whole fan hangs from a grip below the surface, so the
 * outer cards' lower corners converge on the fist while every covered card still
 * shows its whole rank+suit corner.
 *
 * The arc alone cannot separate twenty cards at that depth: the radial part
 * moves a card by `cardHeight · sin(step)`, far less than the corner box is wide.
 * Each pair therefore also gets the *smallest* sideways offset that keeps the
 * left card's whole corner box on the outer side of its right neighbour's left
 * edge. Those offsets are solved per pair — larger at the outer, strongly rotated
 * pairs, where the neighbour's left edge leans away — which is what lets the face
 * stay wide while the fan still fits between the screen edges. A single uniform
 * offset large enough for the worst pair costs roughly a quarter of the face
 * width here, which is exactly the flat, narrow layout this geometry replaces.
 */

/** Phone faces stay readable: 122–154px wide at every landscape breakpoint. */
const MIN_CARD_WIDTH = 122;
const MAX_CARD_WIDTH = 154;
/** PlayingCard artwork aspect ratio (viewBox 100x144). */
const CARD_ASPECT = 1.44;

/** Face width as a fraction of the hand height, plus a flat margin. */
const WIDTH_PER_HEIGHT = 0.28;
const WIDTH_FLAT = 60;
/** A shorter hand is a little more generous, without jumping when a card is played. */
const COUNT_BONUS_BASE = 20;
const COUNT_BONUS_PER_CARD = 0.01;
const MAX_COUNT_BONUS = 0.05;

/** Strip of a covered card that must stay visible, as a fraction of its width. */
const CORNER_REVEAL = 0.175;
/** Rank+suit box of the narrow handheld index, in artwork design units. */
const CORNER_LEFT_UNITS = 4;
const CORNER_RIGHT_UNITS = 17.5;
const CORNER_TOP_UNITS = 7;
const CORNER_BOTTOM_UNITS = 42;
/** PlayingCard artwork viewBox size, for the design-unit conversions above. */
const ART_WIDTH_UNITS = 100;
const ART_HEIGHT_UNITS = 144;

/** Total wedge: 70° for 17 cards, 82° for 20 — the fan is a fan, not a fan-line. */
const WEDGE_PER_CARD_DEG = 4;
const WEDGE_OFFSET_DEG = 2;
const MIN_WEDGE_DEG = 10;
const MAX_WEDGE_DEG = 82;
/** Slack added to every solved centre gap, in card widths (≈0.5px on a phone). */
const SPREAD_MARGIN = 0.004;

/** Keep the outermost rotated corner this far from the hand's side edges, px. */
const SIDE_GUTTER = 2;
/** The gripped bottoms hang this fraction of a card height below the surface. */
const BOTTOM_CROP = 0.18;
const MAX_BOTTOM_CROP = 0.28;
/** Headroom the temporary focused lift (18px) needs above the fan's top edge. */
const FOCUS_HEADROOM = 18;

/** Distance of the card's top edge from the rotation origin, in card heights (150%). */
const ORIGIN_DEPTH = 1.5;
/** Depth of the middle of the rank+suit corner box, in card heights. */
const CORNER_DEPTH = ORIGIN_DEPTH - (CORNER_TOP_UNITS + CORNER_BOTTOM_UNITS) / 2 / ART_HEIGHT_UNITS;
const EPSILON = 1e-9;
const DEG_PER_RAD = 180 / Math.PI;

export interface HandheldGeometry {
  count: number;
  /** Card width in CSS px, fed to `--card-width`. */
  cardWidth: number;
  /** Card height in CSS px (`cardWidth * 1.44`), the fan radius. */
  cardHeight: number;
  /** Centre of the fan, in hand-local px. */
  pivotX: number;
  /** Rotation origin height of every card, in hand-local px (on/below the surface). */
  pivotY: number;
  /** Pre-rotation centre x of every card, published as `--card-x`. */
  cardX: number[];
  /** Shared pre-rotation centre y, published as `--card-y`. */
  cardY: number;
  /** Per-card rotation, published as `--card-angle`. */
  angles: number[];
  /** Hand-local x of every card's exposed corner strip, increasing with the index. */
  stripX: number[];
  /** Half of the total wedge, in degrees. */
  halfAngleDeg: number;
  /** Mean sideways gap between neighbouring card centres, px. */
  spread: number;
  /** Width the fan covers, px. */
  fanWidth: number;
  /** Narrowest strip left visible on a covered card, px. */
  minStrip: number;
}

export interface HandheldGeometryInput {
  /** Measured width of `.handheld-hand` (ResizeObserver). */
  width: number;
  /** Measured height of `.handheld-hand` (ResizeObserver). */
  height: number;
  /** Number of cards in hand; all of them are laid out and rendered. */
  count: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Rotation matrix, in the screen coordinate system the card CSS uses. */
function rotatedX(x: number, y: number, rad: number): number {
  return x * Math.cos(rad) - y * Math.sin(rad);
}

function rotatedY(x: number, y: number, rad: number): number {
  return x * Math.sin(rad) + y * Math.cos(rad);
}

/** Card outline, relative to the rotation origin, in card widths. */
function cardCorners(): Array<[number, number]> {
  const top = -ORIGIN_DEPTH * CARD_ASPECT;
  const bottom = top + CARD_ASPECT;
  return [
    [-0.5, top],
    [0.5, top],
    [-0.5, bottom],
    [0.5, bottom],
  ];
}

/** Rank+suit box of the narrow index, relative to the rotation origin, card widths. */
function cornerBox(): Array<[number, number]> {
  const left = -0.5 + CORNER_LEFT_UNITS / ART_WIDTH_UNITS;
  const right = -0.5 + CORNER_RIGHT_UNITS / ART_WIDTH_UNITS;
  const top = -(ORIGIN_DEPTH - CORNER_TOP_UNITS / ART_HEIGHT_UNITS) * CARD_ASPECT;
  const bottom = -(ORIGIN_DEPTH - CORNER_BOTTOM_UNITS / ART_HEIGHT_UNITS) * CARD_ASPECT;
  return [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ];
}

/** Total wedge of the fan, in degrees. */
function totalWedge(count: number): number {
  if (count < 2) return 0;
  return clamp(WEDGE_PER_CARD_DEG * count + WEDGE_OFFSET_DEG, MIN_WEDGE_DEG, MAX_WEDGE_DEG);
}

/**
 * Smallest centre gap between a card and its right neighbour that puts every
 * point of the card's corner box on the outer side of the neighbour's left edge.
 * Both cards are one card width wide, so the result scales linearly with the face.
 */
function requiredGap(angle: number, nextAngle: number, box: Array<[number, number]>): number {
  const rad = angle / DEG_PER_RAD;
  const nextRad = nextAngle / DEG_PER_RAD;
  const nextCos = Math.cos(nextRad);
  const nextSin = Math.sin(nextRad);
  let required = 0;
  for (const [x, y] of box) {
    // Depth along the neighbour's left edge that crosses this corner's height.
    const depth = (rotatedY(x, y, rad) + 0.5 * nextSin) / nextCos;
    required = Math.max(required, rotatedX(x, y, rad) - rotatedX(-0.5, depth, nextRad));
  }
  return required + SPREAD_MARGIN;
}

/**
 * Exposed width of a covered card's corner at the middle of its box, in card
 * widths. The sideways gap plus the radial arc is what the thumb reads.
 */
function stripBetween(angle: number, nextAngle: number, gap: number): number {
  const rad = angle / DEG_PER_RAD;
  const nextRad = nextAngle / DEG_PER_RAD;
  const depth = -CORNER_DEPTH * CARD_ASPECT;
  const cornerY = rotatedY(-0.5, depth, rad);
  const edgeDepth = (cornerY + 0.5 * Math.sin(nextRad)) / Math.cos(nextRad);
  return gap + rotatedX(-0.5, edgeDepth, nextRad) - rotatedX(-0.5, depth, rad);
}

/** Layout of one fan, expressed in card widths so any face size can scale it. */
interface FanPlan {
  angles: number[];
  radians: number[];
  /** Card centre offsets from the fan centre, in card widths. */
  offsets: number[];
  /** Largest horizontal reach of the fan, in card widths. */
  halfExtent: number;
  /** Vertical extent of the fan, in card widths. */
  span: number;
  /** Lowest card point relative to the pivot, in card widths (negative = above). */
  lowest: number;
  /** Mean gap between neighbouring card centres, in card widths. */
  meanGap: number;
  /** Narrowest exposed corner strip, in card widths. */
  minStrip: number;
}

function fanPlan(count: number): FanPlan {
  const halfSpan = (count - 1) / 2;
  const wedge = totalWedge(count);
  const step = count > 1 ? wedge / (count - 1) : 0;
  const angles = Array.from({ length: count }, (_, index) => (count > 1 ? (index - halfSpan) * step : 0));
  const radians = angles.map((deg) => deg / DEG_PER_RAD);

  const box = cornerBox();
  const gaps: number[] = [];
  for (let index = 0; index + 1 < count; index += 1) {
    gaps.push(Math.max(0, requiredGap(angles[index], angles[index + 1], box)));
  }
  const running = [0];
  for (let index = 0; index + 1 < count; index += 1) running.push(running[index] + gaps[index]);
  const mean = running.length > 0 ? running[running.length - 1] / 2 : 0;
  const offsets = running.map((offset) => offset - mean);

  const corners = cardCorners();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    for (const [x, y] of corners) {
      const px = offsets[index] + rotatedX(x, y, radians[index]);
      const py = rotatedY(x, y, radians[index]);
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
  }

  let minStrip = 1;
  for (let index = 0; index + 1 < count; index += 1) {
    minStrip = Math.min(minStrip, stripBetween(angles[index], angles[index + 1], gaps[index]));
  }

  return {
    angles,
    radians,
    offsets,
    halfExtent: Math.max(-minX, maxX),
    span: maxY - minY,
    lowest: maxY,
    meanGap: count > 1 ? (running[running.length - 1] - running[0]) / (count - 1) : 0,
    minStrip: count > 1 ? minStrip : 1,
  };
}

/**
 * Largest card that keeps the fan readable on this surface: about 28% of the
 * hand height plus a flat margin (a quarter larger than the old flat fan), never
 * wider than the sideways room the solved corner gaps and the deep wedge leave,
 * and never taller than the focused lift and the gripped bottom allow. On a hand
 * too narrow for the minimum landscape face the sideways room wins: a narrow fan
 * is still readable, cards hanging off the screen are not.
 */
function handheldCardWidth(plan: FanPlan | null, width: number, height: number, count: number): number {
  const bonus = clamp((COUNT_BONUS_BASE - count) * COUNT_BONUS_PER_CARD, 0, MAX_COUNT_BONUS);
  const byHeight = (WIDTH_PER_HEIGHT * height + WIDTH_FLAT) * (1 + bonus);
  if (!plan || plan.halfExtent < EPSILON) return clamp(byHeight, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
  const byWidth = (width / 2 - SIDE_GUTTER) / plan.halfExtent;
  const byVertical = (height - FOCUS_HEADROOM) / Math.max(EPSILON, plan.span - CARD_ASPECT * MAX_BOTTOM_CROP);
  return clamp(Math.min(byHeight, byWidth, byVertical), clamp(byWidth, 1, MIN_CARD_WIDTH), MAX_CARD_WIDTH);
}

export function computeHandheldGeometry(input: HandheldGeometryInput): HandheldGeometry {
  const count = Math.max(0, Math.floor(input.count));
  const width = Math.max(1, input.width);
  const height = Math.max(1, input.height);
  const plan = count > 0 ? fanPlan(count) : null;
  const cardWidth = handheldCardWidth(plan, width, height, count);
  const cardHeight = cardWidth * CARD_ASPECT;
  const pivotX = width / 2;
  if (!plan) {
    const pivotY = height + BOTTOM_CROP * cardHeight;
    return {
      count,
      cardWidth,
      cardHeight,
      pivotX,
      pivotY,
      cardX: [],
      cardY: pivotY - cardHeight,
      angles: [],
      stripX: [],
      halfAngleDeg: 0,
      spread: 0,
      fanWidth: 0,
      minStrip: cardWidth,
    };
  }

  const span = plan.span * cardWidth;
  // The gripped bottom hangs below the surface; on short screens the crop is
  // only opened as far as the focused lift above the fan still needs.
  const crop = clamp(
    Math.max(BOTTOM_CROP, (FOCUS_HEADROOM - height + span) / cardHeight),
    0,
    MAX_BOTTOM_CROP,
  );
  const pivotY = height + crop * cardHeight - plan.lowest * cardWidth;
  const cardY = pivotY - cardHeight;
  const cardX = plan.offsets.map((offset) => pivotX + offset * cardWidth);
  const stripX = plan.radians.map(
    (rad, index) => cardX[index] + rotatedX(-0.5 + CORNER_REVEAL / 2, -CORNER_DEPTH * CARD_ASPECT, rad) * cardWidth,
  );

  return {
    count,
    cardWidth,
    cardHeight,
    pivotX,
    pivotY,
    cardX,
    cardY,
    angles: plan.angles,
    stripX,
    halfAngleDeg: totalWedge(count) / 2,
    spread: plan.meanGap * cardWidth,
    fanWidth: 2 * plan.halfExtent * cardWidth,
    minStrip: plan.minStrip * cardWidth,
  };
}

/**
 * Hand-local x → card index, used while the thumb sweeps across the fan. The
 * spread keeps the exposed corner strips ordered left to right, so the strip
 * nearest to the pointer wins and the whole width of the hand stays reachable.
 */
export function cardIndexAt(geometry: HandheldGeometry, x: number): number {
  const strips = geometry.stripX;
  if (strips.length === 0) return -1;
  const last = strips.length - 1;
  if (x <= strips[0]) return 0;
  if (x >= strips[last]) return last;
  for (let index = 0; index < last; index += 1) {
    if (x <= strips[index + 1]) return x < (strips[index] + strips[index + 1]) / 2 ? index : index + 1;
  }
  return last;
}
