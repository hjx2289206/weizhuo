import test from 'node:test';
import assert from 'node:assert/strict';
import { JunqiGame } from '../server/games/junqi';
import { Room, type Peer } from '../server/room';
import { JUNQI_COUNTS, JUNQI_FOUR_EDGES, canDeployJunqi, fourJunqiXY, isJunqiCamp, isJunqiHQ, junqiAllied, junqiDestinations, type JunqiBoard, type JunqiRank, type JunqiSide } from '../shared/junqi';
import type { JunqiSnapshot, ServerMessage } from '../shared/protocol';
import { resultFromSnapshot } from '../src/resultHistory';

const piece = (side: JunqiSide, rank: JunqiRank, id = `${side}-${rank}`) => ({ side, rank, id });
function started() {
  const game = new JunqiGame('four'); game.start();
  for (let side = 0; side < 4; side++) assert.ok(game.command(side, 'junqiSetup', { action: 'confirm' }).ok);
  return game;
}
function fixture(game: JunqiGame, entries: [number, JunqiSide, JunqiRank][]) {
  const board: JunqiBoard = Array(129).fill(null);
  entries.forEach(([p, side, rank], i) => { board[p] = piece(side, rank, `opaque-${i}`); });
  Reflect.set(game, 'board', board);
}
const armies: [number, JunqiSide, JunqiRank][] = [[5, 0, 'company'], [26, 0, 'flag'], [35, 1, 'company'], [56, 1, 'flag'], [65, 2, 'company'], [86, 2, 'flag'], [95, 3, 'company'], [116, 3, 'flag']];

test('four-dark armies have 25 legal pieces per side, and allies and spectators see no hidden ranks', () => {
  for (let n = 0; n < 25; n++) {
    const game = new JunqiGame('four'); game.start();
    assert.equal(game.seatCount, 4);
    for (const side of [0, 1, 2, 3] as const) {
      const j = game.view(side).junqi;
      assert.equal(j.board.length, 129);
      assert.equal(j.board.filter(p => p?.rank).length, 25);
      for (const [rank, count] of Object.entries(JUNQI_COUNTS)) assert.equal(j.board.filter(p => p?.side === side && p.rank === rank).length, count);
      j.board.forEach((p, point) => {
        if (p?.side === side) assert.ok(canDeployJunqi(p.rank!, side, point, 'four'));
        else if (p) assert.equal(p.rank, null);
      });
    }
    const publicBoard = game.view(null).junqi.board;
    assert.equal(publicBoard.filter(Boolean).length, 100);
    assert.equal(new Set(publicBoard.filter(Boolean).map(p => p!.id)).size, 100);
    assert.ok(publicBoard.every(p => !p || p.rank === null));
  }
});

test('four-country geometry has 129 unique stations, 20 camps, 8 HQs and a symmetric connected railway', () => {
  const points = Array.from({ length: 129 }, (_, p) => p);
  assert.equal(new Set(points.map(p => fourJunqiXY(p).join(','))).size, 129);
  assert.equal(points.filter(p => isJunqiCamp(p, 'four')).length, 20);
  assert.equal(points.filter(p => isJunqiHQ(p, 'four')).length, 8);
  assert.equal(JUNQI_FOUR_EDGES.filter(e => e.curve).length, 4);
  for (const edge of JUNQI_FOUR_EDGES) {
    const rotated = (p: number) => p < 120 ? (p + 30) % 120 : {
      120: 122, 121: 125, 122: 128, 123: 121, 124: 124, 125: 127, 126: 120, 127: 123, 128: 126,
    }[p]!;
    const a = rotated(edge.a), b = rotated(edge.b);
    assert.ok(JUNQI_FOUR_EDGES.some(e => e.rail === edge.rail && ((e.a === a && e.b === b) || (e.a === b && e.b === a))));
  }
  assert.equal(canDeployJunqi('flag', 0, 124, 'four'), false);
  assert.equal(canDeployJunqi('bomb', 3, 90, 'four'), false);
  assert.equal(canDeployJunqi('mine', 2, 85, 'four'), true);
});

test('four-country records printed curves, engineer turns and no unnecessary rank clues', () => {
  const curve = started();
  fixture(curve, [...armies, [0, 0, 'division'], [54, 1, 'company']]);
  assert.equal(curve.view(1).junqi.board[0]?.rank, null);
  assert.ok(curve.command(0, 'junqiMove', { from: 0, to: 54 }).ok);
  const curved = curve.view(1).junqi.moves.at(-1)!;
  assert.equal(curved.outcome, 'attacker');
  assert.deepEqual(curved.path, [0, 34, 39, 44, 49, 54]);
  for (let i = 1; i < curved.path.length; i++) {
    const a = curved.path[i - 1]!, b = curved.path[i]!;
    assert.ok(JUNQI_FOUR_EDGES.some(edge => edge.rail && (edge.a === a && edge.b === b || edge.b === a && edge.a === b)));
  }
  assert.equal(curve.view(1).junqi.board[54]?.side, 0);
  assert.equal(curve.view(1).junqi.board[54]?.rank, null);
  assert.ok(!JSON.stringify(curve.view(1).junqi.moves).includes('division'));

  // Only an engineer may change tracks at the central junction, so this route is the unavoidable fallback.
  const turn = started();
  fixture(turn, [...armies, [0, 0, 'engineer']]);
  const ordinary: JunqiBoard = Array(129).fill(null); ordinary[0] = piece(0, 'division');
  assert.ok(!junqiDestinations(ordinary, 0, 'four').includes(128));
  assert.equal(turn.view(1).junqi.board[0]?.rank, null);
  assert.ok(turn.command(0, 'junqiMove', { from: 0, to: 128 }).ok);
  const route = turn.view(1).junqi.moves.at(-1)!;
  assert.equal(route.outcome, 'move');
  assert.deepEqual(route.path, [0, 126, 127, 128]);
  assert.deepEqual(turn.view(0).junqi.moves.at(-1)?.path, route.path);
  assert.deepEqual(turn.view(null).junqi.moves.at(-1)?.path, route.path);
  assert.equal(turn.view(1).junqi.board[128]?.rank, null);
  assert.equal(turn.view(0).junqi.board[128]?.rank, 'engineer');
  assert.ok(!JSON.stringify(turn.view(1).junqi.moves).includes('engineer'));

  // A straight line any ordinary piece can travel must stay the published route even for an engineer.
  const straight = started();
  fixture(straight, [[0, 0, 'engineer'], [26, 0, 'flag'], [35, 1, 'company'], [56, 1, 'flag'], [65, 2, 'company'], [86, 2, 'flag'], [95, 3, 'company'], [116, 3, 'flag']]);
  const plain: JunqiBoard = Array(129).fill(null); plain[0] = piece(0, 'company');
  assert.ok(junqiDestinations(plain, 0, 'four').includes(4));
  assert.ok(straight.command(0, 'junqiMove', { from: 0, to: 4 }).ok);
  assert.deepEqual(straight.view(null).junqi.moves.at(-1)?.path, [0, 1, 2, 3, 4]);
});

test('four railways retain bend tangents, engineer junction turns, allied blockers and camp protection', () => {
  const board: JunqiBoard = Array(129).fill(null); board[0] = piece(0, 'division');
  const normal = junqiDestinations(board, 0, 'four');
  assert.ok(normal.includes(64)); // straight through the central grid to the opposite arm
  assert.ok(normal.includes(54)); // printed curved track into the adjacent arm
  assert.ok(!normal.includes(128)); // cannot change tracks at the central junction
  board[0] = piece(0, 'engineer');
  assert.ok(junqiDestinations(board, 0, 'four').includes(128));
  board[126] = piece(2, 'platoon');
  assert.ok(!junqiDestinations(board, 0, 'four').includes(126));
  board[0] = piece(0, 'division');
  assert.ok(!junqiDestinations(board, 0, 'four').includes(123));
  board[126] = piece(1, 'platoon');
  assert.ok(junqiDestinations(board, 0, 'four').includes(126));
  assert.ok(!junqiDestinations(board, 0, 'four').includes(123));
  board[6] = piece(1, 'engineer');
  assert.ok(!junqiDestinations(board, 0, 'four').includes(6));
  board[26] = piece(0, 'engineer'); assert.deepEqual(junqiDestinations(board, 26, 'four'), []);
});

test('four-country confirmation waits for every army; turns are red-blue-green-purple, and modes lock', () => {
  const game = new JunqiGame('four'); game.start();
  for (let side = 0; side < 3; side++) game.command(side, 'junqiSetup', { action: 'confirm' });
  assert.equal(game.phase, 'deploying');
  assert.equal(game.setVariant('two').ok, false);
  assert.ok(game.command(3, 'junqiSetup', { action: 'confirm' }).ok);
  fixture(game, armies);
  for (const side of [0, 1, 2, 3] as const) {
    assert.equal(game.view(null).turn, side);
    assert.ok(game.command(side, 'junqiMove', { from: side * 30 + 5, to: side * 30 + 10 }).ok);
  }
  assert.equal(game.view(null).turn, 0);
  const before = game.view(0);
  assert.equal(game.command(4, 'junqiMove', { from: 0, to: 1 }).ok, false);
  assert.equal(game.command(0, 'junqiMove', { from: 0, to: 129 }).ok, false);
  assert.deepEqual(game.view(0), before);
});

test('capturing one flag clears only that army, skips it, and victory belongs to a whole team', () => {
  const game = started(); fixture(game, [...armies, [51, 0, 'engineer']]);
  assert.ok(game.command(0, 'junqiMove', { from: 51, to: 56 }).ok);
  const view = game.view(0);
  assert.equal(game.phase, 'playing'); assert.equal(view.turn, 2);
  assert.deepEqual(view.junqi.eliminated, [false, true, false, false]);
  assert.ok(!view.junqi.board.some(p => p?.side === 1));
  assert.equal(game.requiresConnection(1), false);
  assert.equal(game.command(1, 'junqiResign', {}).ok, false);
  assert.ok(game.command(3, 'junqiResign', {}).ok);
  assert.equal(game.phase, 'finished'); assert.equal(game.view(null).junqi.winnerTeam, 0);
  assert.ok(game.view(null).junqi.board.filter(Boolean).every(p => p!.rank));
  assert.ok(game.restart().ok); assert.equal(game.seatCount, 4);
  assert.deepEqual(game.view(null).junqi.eliminated, [false, false, false, false]);
});

test('out-of-turn resignation preserves the current turn and a remaining ally keeps playing', () => {
  const game = started(); fixture(game, armies);
  assert.ok(game.command(2, 'junqiResign', {}).ok);
  assert.equal(game.view(null).turn, 0); assert.equal(game.phase, 'playing');
  assert.ok(game.command(0, 'junqiMove', { from: 5, to: 10 }).ok);
  assert.equal(game.view(null).turn, 1);
  assert.ok(game.command(1, 'junqiMove', { from: 35, to: 40 }).ok);
  assert.equal(game.view(null).turn, 3);
  assert.ok(game.command(0, 'junqiResign', {}).ok);
  assert.equal(game.view(null).junqi.winnerTeam, 1);
});

test('commander death reveals only its flag; immobile armies are removed, and quiet games draw', () => {
  const game = started(); fixture(game, [...armies, [0, 0, 'commander'], [126, 1, 'bomb']]);
  assert.ok(game.command(0, 'junqiMove', { from: 0, to: 126 }).ok);
  const view = game.view(2).junqi;
  assert.equal(view.board[26]?.rank, 'flag'); assert.equal(view.board[5]?.rank, null);
  assert.deepEqual(view.revealedFlags, [true, false, false, false]);
  const blocked = started(); fixture(blocked, armies.filter(([p]) => p !== 65));
  assert.ok(blocked.command(0, 'junqiMove', { from: 5, to: 10 }).ok);
  assert.equal(blocked.view(null).junqi.eliminated[2], true); assert.equal(blocked.phase, 'playing');
  const draw = started(); fixture(draw, armies); Reflect.set(draw, 'quietPlies', 69);
  assert.ok(draw.command(0, 'junqiMove', { from: 5, to: 10 }).ok);
  assert.equal(draw.view(null).junqi.draw, true); assert.equal(draw.view(null).junqi.winnerTeam, null);
});

type FakePeer = Peer & { sent: ServerMessage[]; kicked: number };
function peer(id: string): FakePeer { return { id, role: 'table', seatId: null, token: null, room: null, requestRoom: null, sent: [], kicked: 0, send(m) { this.sent.push(m); }, supersede() { this.kicked++; } }; }
function state(p: FakePeer): JunqiSnapshot { const m = p.sent.filter(m => m.type === 'state').at(-1); assert.ok(m?.type === 'state' && m.state.game === 'junqi'); return m.state; }

test('only a lobby host changes mode; identities survive expansion and occupied seats prevent shrinking', () => {
  const room = new Room('FOUR', 'phone', 'junqi'), host = peer('h'), blue = peer('b'), green = peer('g'), purple = peer('p');
  try {
    room.bindCreator(host, 'c', '红'); room.bindJoin(blue, 1, '蓝', 'b');
    room.command(blue, 'junqiMode', { variant: 'four' }, 'forbidden'); assert.equal(room.seatCount, 2);
    room.command(host, 'junqiMode', { variant: 'invalid' }, 'invalid'); assert.equal(room.seatCount, 2);
    const token = host.token;
    room.command(host, 'ready', { ready: true }, 'ready');
    room.command(host, 'junqiMode', { variant: 'four' }, 'expand');
    assert.equal(room.seatCount, 4); assert.equal(host.token, token); assert.equal(state(host).seats.length, 4);
    assert.equal(state(host).seats[0]!.ready, false);
    room.bindJoin(green, 2, '绿', 'g');
    room.command(host, 'junqiMode', { variant: 'two' }, 'occupied'); assert.equal(room.seatCount, 4);
    room.bindJoin(purple, 3, '紫', 'purple');
    for (const p of [host, blue, green, purple]) room.command(p, 'ready', { ready: true }, `r-${p.id}`);
    room.command(host, 'start', {}, 'start');
    room.command(host, 'junqiMode', { variant: 'two' }, 'playing'); assert.equal(room.seatCount, 4);
    for (const p of [host, blue, green, purple]) {
      assert.equal(state(p).junqi.board.filter(q => q?.rank).length, 25);
      assert.ok(state(p).junqi.board.every(q => !q || q.side === p.seatId || q.rank === null));
    }
    const fresh = peer('new-green'); room.bindResume(fresh, green.token!, 'resume');
    assert.equal(green.kicked, 1); assert.deepEqual(state(fresh).junqi.board, state(green).junqi.board);
    assert.equal((room.snapshotFor(green) as JunqiSnapshot).junqi.board.filter(p => p?.rank).length, 0);
  } finally { room.dispose(); }
});

test('eliminated disconnected players do not pause the four-country room, and results record teams', () => {
  const room = new Room('OUT4', 'phone', 'junqi'), ps = [peer('r'), peer('b'), peer('g'), peer('p')];
  try {
    room.bindCreator(ps[0]!, 'c', '红'); room.command(ps[0]!, 'junqiMode', { variant: 'four' }, 'mode');
    for (let side = 1; side < 4; side++) room.bindJoin(ps[side]!, side, `玩家${side}`, `j${side}`);
    for (const p of ps) room.command(p, 'ready', { ready: true }, `r${p.id}`);
    room.command(ps[0]!, 'start', {}, 's');
    for (const p of ps) room.command(p, 'junqiSetup', { action: 'confirm' }, `d${p.id}`);
    fixture(room.engine as JunqiGame, armies);
    room.command(ps[1]!, 'junqiResign', {}, 'resign1'); room.detach(ps[1]!);
    room.command(ps[0]!, 'junqiMove', { from: 5, to: 10 }, 'move1');
    assert.equal(state(ps[0]!).turn, 2);
    room.command(ps[0]!, 'junqiMove', { from: 5, to: 10 }, 'move1'); // duplicate does not advance
    assert.equal(state(ps[0]!).junqi.moves.length, 1);
    room.command(ps[3]!, 'junqiResign', {}, 'resign3');
    const result = resultFromSnapshot(state(ps[0]!)); assert.ok(result);
    assert.equal(result.title, '红绿队获胜'); assert.equal(result.players.length, 4);
    assert.equal(result.junqiVariant, 'four'); assert.ok(!JSON.stringify(result).includes('commander'));
    room.command(ps[0]!, 'again', {}, 'again'); assert.equal(state(ps[0]!).junqi.variant, 'four');
  } finally { room.dispose(); }
});
