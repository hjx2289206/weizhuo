/** Chinese dark Junqi. Legality works on a player's masked board in both variants. */
export type JunqiSide = 0 | 1 | 2 | 3;
export type JunqiVariant = 'two' | 'four';
export const junqiSideName = (side: number) => ['红方', '蓝方', '绿方', '紫方'][side] ?? '未知方';
export const junqiTeam = (side: number, variant: JunqiVariant): 0 | 1 => (variant === 'four' ? side % 2 : side) as 0 | 1;
export const junqiAllied = (a: number, b: number, variant: JunqiVariant) => junqiTeam(a, variant) === junqiTeam(b, variant);
export const junqiTeamName = (team: number, variant: JunqiVariant) => variant === 'four' ? team === 0 ? '红绿队' : '蓝紫队' : junqiSideName(team);
export type JunqiRank = 'commander' | 'general' | 'division' | 'brigade' | 'regiment' | 'battalion' | 'company' | 'platoon' | 'engineer' | 'bomb' | 'mine' | 'flag';
export const JUNQI_NAMES: Record<JunqiRank, string> = { commander: '司令', general: '军长', division: '师长', brigade: '旅长', regiment: '团长', battalion: '营长', company: '连长', platoon: '排长', engineer: '工兵', bomb: '炸弹', mine: '地雷', flag: '军旗' };
export const JUNQI_COUNTS: Record<JunqiRank, number> = { commander: 1, general: 1, division: 2, brigade: 2, regiment: 2, battalion: 2, company: 3, platoon: 3, engineer: 3, bomb: 2, mine: 3, flag: 1 };
export const JUNQI_POWER: Record<JunqiRank, number> = { commander: 9, general: 8, division: 7, brigade: 6, regiment: 5, battalion: 4, company: 3, platoon: 2, engineer: 1, bomb: 0, mine: 0, flag: 0 };
export interface JunqiPiece { id: string; side: JunqiSide; rank: JunqiRank | null }
export type JunqiBoard = (JunqiPiece | null)[];
/** `path` is the authoritative pre-move route, both endpoints included. It contains public points only. */
export interface JunqiMove { ply: number; side: JunqiSide; from: number; to: number; path: number[]; outcome: 'move' | 'attacker' | 'defender' | 'both' }
export interface JunqiView {
  variant: JunqiVariant; round: number; roundId: string; board: JunqiBoard; deployed: boolean[]; revealedFlags: boolean[];
  eliminated: boolean[]; eliminationReasons: string[]; winnerTeam: 0 | 1 | null;
  winner: JunqiSide | null; draw: boolean; reason: string; moves: JunqiMove[]; quietPlies: number;
}
export const junqiRow = (p: number) => Math.floor(p / 5);
export const junqiCol = (p: number) => p % 5;
export const validJunqiPoint = (p: unknown, variant: JunqiVariant = 'two'): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 0 && p < (variant === 'four' ? 129 : 60);
export const junqiHomeSide = (p: number, variant: JunqiVariant = 'two'): JunqiSide | null => variant === 'four' ? p < 120 ? Math.floor(p / 30) as JunqiSide : null : p < 30 ? 1 : 0;
export const isJunqiCamp = (p: number, variant: JunqiVariant = 'two') => variant === 'four' ? p < 120 && [6, 8, 12, 16, 18].includes(p % 30) : [6, 8, 12, 16, 18, 41, 43, 47, 51, 53].includes(p);
export const isJunqiHQ = (p: number, variant: JunqiVariant = 'two') => variant === 'four' ? p < 120 && [26, 28].includes(p % 30) : [1, 3, 56, 58].includes(p);
export const junqiCoordinate = (p: number, variant: JunqiVariant = 'two') => variant === 'four' ? p >= 120 ? `中${p - 119}` : `${['南', '西', '北', '东'][Math.floor(p / 30)]}${'ABCDE'[p % 5]}${Math.floor(p % 30 / 5) + 1}` : `${'ABCDE'[junqiCol(p)]}${12 - junqiRow(p)}`;
export function canDeployJunqi(rank: JunqiRank, side: JunqiSide, p: number, variant: JunqiVariant = 'two'): boolean {
  if (!validJunqiPoint(p, variant) || junqiHomeSide(p, variant) !== side || isJunqiCamp(p, variant)) return false;
  const depth = variant === 'four' ? 5 - Math.floor(p % 30 / 5) : side === 0 ? 11 - junqiRow(p) : junqiRow(p);
  return rank === 'flag' ? isJunqiHQ(p, variant) : rank === 'mine' ? depth <= 1 : rank === 'bomb' ? depth !== 5 : true;
}
export function junqiRailEdge(a: number, b: number): boolean {
  const ar = junqiRow(a), br = junqiRow(b), ac = junqiCol(a), bc = junqiCol(b);
  if (ar === br && Math.abs(ac - bc) === 1) return [1, 5, 6, 10].includes(ar);
  if (ac !== bc || Math.abs(ar - br) !== 1) return false;
  if (ar + br === 11) return [0, 2, 4].includes(ac);
  return [0, 4].includes(ac) && Math.min(ar, br) >= 1 && Math.max(ar, br) <= 10;
}
export function junqiRoadEdge(a: number, b: number): boolean {
  const dr = Math.abs(junqiRow(a) - junqiRow(b)), dc = Math.abs(junqiCol(a) - junqiCol(b));
  if (junqiHomeSide(a) !== junqiHomeSide(b)) return dr === 1 && dc === 0 && [0, 2, 4].includes(junqiCol(a));
  if (dr + dc === 1) return true;
  return dr === 1 && dc === 1 && (isJunqiCamp(a) || isJunqiCamp(b));
}
export const JUNQI_EDGES = Array.from({ length: 60 }, (_, a) => Array.from({ length: 60 - a - 1 }, (_, i) => [a, a + i + 1] as const)).flat().filter(([a, b]) => junqiRoadEdge(a, b));

/** Never needs an opponent's rank: every hidden defender is an attackable occupant. */
export function junqiDestinations(board: readonly (JunqiPiece | null)[], from: number, variant: JunqiVariant = 'two'): number[] {
  if (variant === 'four') return fourDestinations(board, from);
  if (!validJunqiPoint(from)) return [];
  const piece = board[from];
  if (!piece?.rank || piece.rank === 'mine' || piece.rank === 'flag' || isJunqiHQ(from)) return [];
  const canLand = (p: number) => board[p]?.side !== piece.side && !(board[p] && isJunqiCamp(p));
  const result = new Set<number>();
  for (let p = 0; p < 60; p++) if (junqiRoadEdge(from, p) && canLand(p)) result.add(p);
  if (piece.rank === 'engineer') {
    const seen = new Set([from]), queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]!;
      for (let p = 0; p < 60; p++) {
        if (seen.has(p) || !junqiRailEdge(current, p)) continue;
        seen.add(p);
        if (canLand(p)) result.add(p);
        if (!board[p]) queue.push(p);
      }
    }
  } else {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let current = from;
      for (;;) {
        const r = junqiRow(current) + dr!, c = junqiCol(current) + dc!;
        if (r < 0 || r > 11 || c < 0 || c > 4) break;
        const next = r * 5 + c;
        if (!junqiRailEdge(current, next)) break;
        if (canLand(next)) result.add(next);
        if (board[next]) break;
        current = next;
      }
    }
  }
  return [...result].sort((a, b) => a - b);
}

/** Four 6×5 arms and a central 3×3 railway grid. Seats run SOUTH→WEST→NORTH→EAST. */
export function fourJunqiXY(p: number): [number, number] {
  if (p >= 120) return [6 + (p - 120) % 3 * 2, 6 + Math.floor((p - 120) / 3) * 2];
  const side = Math.floor(p / 30), row = Math.floor(p % 30 / 5), col = p % 5;
  let x = 6 + col, y = 11 + row;
  for (let n = 0; n < side; n++) [x, y] = [16 - y, x];
  return [x, y];
}
export interface JunqiFourEdge { a: number; b: number; rail: boolean; curve: boolean; out: number; into: number }
// Directions in screen space: east, south, west, north. Curves retain their printed tangents:
// following a bend is allowed; changing tracks at a junction requires an engineer.
function makeFourEdges(): JunqiFourEdge[] {
  const edges: JunqiFourEdge[] = [];
  const add = (a: number, b: number, rail: boolean, curve = false, out?: number, into?: number) => {
    const [ax, ay] = fourJunqiXY(a), [bx, by] = fourJunqiXY(b);
    const direction = ax === bx ? by > ay ? 1 : 3 : bx > ax ? 0 : 2;
    edges.push({ a, b, rail, curve, out: out ?? direction, into: into ?? direction });
  };
  for (let side = 0; side < 4; side++) {
    const base = side * 30;
    for (let a = 0; a < 30; a++) for (let b = a + 1; b < 30; b++) {
      const ar = Math.floor(a / 5), br = Math.floor(b / 5), ac = a % 5, bc = b % 5;
      const dr = Math.abs(ar - br), dc = Math.abs(ac - bc);
      if (dr + dc !== 1 && !(dr === 1 && dc === 1 && (isJunqiCamp(base + a, 'four') || isJunqiCamp(base + b, 'four')))) continue;
      const rail = ar === br ? [0, 4].includes(ar) : ac === bc && [0, 4].includes(ac) && br <= 4;
      add(base + a, base + b, rail);
    }
    for (const col of [0, 2, 4]) {
      const a = base + col, [x, y] = fourJunqiXY(a);
      const centerX = side === 1 ? 6 : side === 3 ? 10 : x;
      const centerY = side === 0 ? 10 : side === 2 ? 6 : y;
      const center = 120 + (centerY - 6) / 2 * 3 + (centerX - 6) / 2;
      add(a, center, true);
    }
    add(base, ((side + 1) % 4) * 30 + 4, true, true, (3 + side) % 4, (2 + side) % 4);
  }
  for (let p = 120; p < 129; p++) {
    if ((p - 120) % 3 < 2) add(p, p + 1, true);
    if (p < 126) add(p, p + 3, true);
  }
  return edges;
}
export const JUNQI_FOUR_EDGES = makeFourEdges();
const FOUR_NEIGHBORS = Array.from({ length: 129 }, (_, p) => JUNQI_FOUR_EDGES.flatMap(e => e.a === p ? [{ to: e.b, rail: e.rail, out: e.out, into: e.into }] : e.b === p ? [{ to: e.a, rail: e.rail, out: (e.into + 2) % 4, into: (e.out + 2) % 4 }] : []));
function fourDestinations(board: readonly (JunqiPiece | null)[], from: number): number[] {
  if (!validJunqiPoint(from, 'four')) return [];
  const piece = board[from];
  if (!piece?.rank || piece.rank === 'mine' || piece.rank === 'flag' || isJunqiHQ(from, 'four')) return [];
  const canLand = (p: number) => !board[p] || (!junqiAllied(piece.side, board[p]!.side, 'four') && !isJunqiCamp(p, 'four'));
  const result = new Set<number>();
  for (const edge of FOUR_NEIGHBORS[from]!) if (canLand(edge.to)) result.add(edge.to);
  const queue: { point: number; direction: number }[] = [{ point: from, direction: -1 }];
  const seen = new Set<string>([`${from}:-1`]);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const edge of FOUR_NEIGHBORS[current.point]!) {
      if (!edge.rail || (piece.rank !== 'engineer' && current.direction !== -1 && edge.out !== current.direction)) continue;
      const key = `${edge.to}:${piece.rank === 'engineer' ? -1 : edge.into}`;
      if (seen.has(key) || edge.to === from) continue;
      seen.add(key);
      if (canLand(edge.to)) result.add(edge.to);
      if (!board[edge.to]) queue.push({ point: edge.to, direction: edge.into });
    }
  }
  return [...result].sort((a, b) => a - b);
}

export function junqiCombat(attacker: JunqiRank, defender: JunqiRank): 'attacker' | 'defender' | 'both' {
  if (attacker === 'bomb' || defender === 'bomb') return 'both';
  if (defender === 'flag') return 'attacker';
  if (defender === 'mine') return attacker === 'engineer' ? 'attacker' : 'defender';
  return JUNQI_POWER[attacker] === JUNQI_POWER[defender] ? 'both' : JUNQI_POWER[attacker] > JUNQI_POWER[defender] ? 'attacker' : 'defender';
}
