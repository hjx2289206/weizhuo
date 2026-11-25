import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeBoardAiPolicy, type BoardAiMove, type BoardAiPolicy } from '../server/bots/boardAi'
import { chooseGomokuMove, GOMOKU_PROFILES, type GomokuPosition } from '../server/bots/gomokuAi'
import { searchGomokuWorker } from '../server/bots/gomokuWorker'
import { Room, type Peer } from '../server/room'
import { BOARD_AI_DIFFICULTIES, type BoardAiDifficulty } from '../shared/boardAi'
import { BOARD_UNDO_LIMIT } from '../shared/boardUndo'
import type { Snapshot } from '../shared/protocol'
import { gomokuLine, type StoneBoard, type StoneSide } from '../shared/stones'

const SIZE = 15
const at = (x: number, y: number) => y * SIZE + x
const opening = at(7, 7)
const levels = BOARD_AI_DIFFICULTIES.map(level => level.id)

function board(black: readonly number[], white: readonly number[]): StoneBoard {
  const result: StoneBoard = Array(SIZE ** 2).fill(null)
  for (const point of black) result[point] = 0
  for (const point of white) { assert.equal(result[point], null); result[point] = 1 }
  return result
}

function position(board: StoneBoard, toMove: StoneSide = 0): GomokuPosition {
  return { board, size: SIZE, toMove, history: board.flatMap((side, point) => side === null ? [] : [point]) }
}

function seeded(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x1_0000_0000
  }
}

function choose(board: StoneBoard, difficulty: BoardAiDifficulty, side: StoneSide = 0): number {
  // Deterministic clock for fixed tactics. It still advances so a regression cannot run unbounded.
  let clock = 0
  const point = chooseGomokuMove(position(board, side), difficulty, { random: seeded(42), now: () => clock += 0.25 })
  assert.ok(point !== null && Number.isInteger(point) && point >= 0 && point < board.length)
  assert.equal(board[point], null)
  return point
}

function withStone(board: StoneBoard, point: number, side: StoneSide): StoneBoard {
  assert.equal(board[point], null)
  const next = [...board]
  next[point] = side
  return next
}

function winningPoints(board: StoneBoard, side: StoneSide): number[] {
  return board.flatMap((value, point) => value === null && gomokuLine(withStone(board, point, side), point).length >= 5 ? [point] : [])
}

function forkPoints(board: StoneBoard, side: StoneSide): number[] {
  return board.flatMap((value, point) => value === null && winningPoints(withStone(board, point, side), side).length >= 2 ? [point] : [])
}

const midgame = () => board([112, 80, 126, 142, 57, 69], [111, 99, 125, 143, 40, 104])

test('Every profile opens at the center and returns only empty in-range points', () => {
  const nearFull = Array.from({ length: SIZE ** 2 }, (_, p): StoneSide | null =>
    p === 223 ? null : (Math.floor(Math.floor(p / SIZE) / 2) + p % 2) % 2 === 0 ? 0 : 1)
  const empty = board([], [])
  for (const difficulty of levels) {
    assert.equal(choose(empty, difficulty), opening)
    assert.equal(choose(nearFull, difficulty), 223)
    const sample = midgame(), original = [...sample]
    choose(sample, difficulty)
    choose(sample, difficulty, 1)
    assert.deepEqual(sample, original)
    assert.equal(chooseGomokuMove(position(nearFull.map(cell => cell ?? 0)), difficulty), null)
  }
})

test('Fixed seeds reproduce the randomized beginner and easy choices', () => {
  for (const difficulty of ['beginner', 'easy'] as const) {
    const input = position(board([112], [113]))
    const run = (seed: number) => {
      let clock = 0
      return chooseGomokuMove(input, difficulty, { random: seeded(seed), now: () => clock += 0.05 })
    }
    assert.equal(run(13579), run(13579))
    assert.ok(new Set([0, 511, 1024, 4096, 8192, 12000, 32000].map(run)).size > 1, difficulty)
  }
})

test('Beginner sometimes ignores a live three using the 30% random threshold', () => {
  const sample = board([57, 58, 167], [111, 112, 113])
  const chooseFirst = (bias: number) => {
    const draws = [bias, 0]
    return chooseGomokuMove(position(sample), 'beginner', { random: () => draws.shift()! })!
  }
  assert.ok(forkPoints(withStone(sample, chooseFirst(0.29), 0), 1).length > 0)
  assert.deepEqual(forkPoints(withStone(sample, chooseFirst(0.30), 0), 1), [])
})

test('Every level above beginner takes a five even when the opponent also threatens one', () => {
  const sample = board([at(3, 8), at(4, 8), at(5, 8), at(6, 8)], [at(3, 10), at(4, 10), at(5, 10), at(6, 10)])
  assert.ok(winningPoints(sample, 1).length > 0)
  for (const difficulty of levels.slice(1)) {
    const point = choose(sample, difficulty)
    assert.ok(gomokuLine(withStone(sample, point, 0), point).length >= 5, difficulty)
  }
})

test('Every level above beginner blocks a closed four and covers one end of an inevitable open four', () => {
  const threat = [at(3, 8), at(4, 8), at(5, 8), at(6, 8)]
  const open = board([at(7, 6), at(8, 6)], threat)
  const closed = withStone(open, at(2, 8), 0)
  for (const difficulty of levels.slice(1)) {
    assert.equal(choose(closed, difficulty), at(7, 8))
    assert.ok([at(2, 8), at(7, 8)].includes(choose(open, difficulty)), difficulty)
  }
})

test('Normal, hard and challenge stop straight and broken live threes from becoming open fours', () => {
  const threats = [[at(6, 7), at(7, 7), at(8, 7)], [at(6, 7), at(7, 7), at(9, 7)]]
  for (const threat of threats) {
    const sample = board([at(12, 3), at(13, 3), at(2, 11)], threat)
    assert.deepEqual(winningPoints(sample, 1), [])
    assert.ok(forkPoints(sample, 1).length > 0)
    for (const difficulty of ['normal', 'hard', 'challenge'] as const) {
      const point = choose(sample, difficulty)
      assert.deepEqual(forkPoints(withStone(sample, point, 0), 1), [], difficulty)
    }
  }
})

const vcfFixtures = [
  {
    name: 'a one-ended horizontal four leading to a vertical double threat',
    black: [109, 110, 111, 82, 97], white: [108, 0, 14, 210, 224],
    attack: 112, forcedDefense: 113,
  },
  {
    name: 'a broken diagonal four leading to a horizontal double threat',
    black: [65, 81, 129, 112, 114], white: [0, 14, 210, 224, 17],
    attack: 113, forcedDefense: 97,
  },
  {
    name: 'a broken horizontal four leading to a diagonal double threat',
    black: [109, 110, 111, 82, 97, 128, 129], white: [108, 67, 0, 14, 210, 224, 17],
    attack: 113, forcedDefense: 112,
  },
]
for (const fixture of vcfFixtures) {
  test('Hard proves VCF through ' + fixture.name, () => {
    const initial = board(fixture.black, fixture.white)
    assert.deepEqual(winningPoints(initial, 0), [])
    assert.deepEqual(forkPoints(initial, 0), [])
    const first = choose(initial, 'hard')
    assert.equal(first, fixture.attack)
    const afterAttack = withStone(initial, first, 0)
    assert.deepEqual(winningPoints(afterAttack, 1), [])
    assert.deepEqual(winningPoints(afterAttack, 0), [fixture.forcedDefense])
    const reply = withStone(afterAttack, fixture.forcedDefense, 1)
    const afterSecondAttack = withStone(reply, choose(reply, 'hard'), 0)
    assert.deepEqual(winningPoints(afterSecondAttack, 1), [])
    const winning = winningPoints(afterSecondAttack, 0)
    assert.ok(winning.length >= 2)
    for (const defense of winning) {
      const afterDefense = withStone(afterSecondAttack, defense, 1)
      const final = choose(afterDefense, 'hard')
      assert.ok(gomokuLine(withStone(afterDefense, final, 0), final).length >= 5)
    }
  })
}

test('Search deadlines stay within 1.5× each configured budget on a controlled monotonic clock', () => {
  for (const difficulty of levels) {
    const budget = GOMOKU_PROFILES[difficulty].milliseconds
    let clock = 0
    const move = chooseGomokuMove(position(midgame()), difficulty, { random: seeded(123), now: () => clock += budget / 100 })
    assert.ok(move !== null)
    assert.ok(clock <= budget * 1.5, difficulty + ': ' + clock + ' > ' + budget * 1.5)
    if (difficulty === 'challenge') assert.ok(clock >= budget, 'the fixture exercises the deadline')
  }
})

test('Worker search leaves the event loop responsive and terminates when aborted', async () => {
  const signal = new AbortController()
  let settled = false
  const pending = searchGomokuWorker(position(midgame()), 'challenge', signal.signal)
  const rejected = assert.rejects(pending.finally(() => { settled = true }), /思考已取消/)
  try {
    await delay(125)
    assert.equal(settled, false, 'main-thread timer fires during a challenge search')
    const start = performance.now()
    signal.abort()
    await rejected
    // Target is 100 ms. Reserve an additional 250 ms for OS scheduling on loaded CI hosts.
    assert.ok(performance.now() - start < 350, 'worker termination exceeded the scheduling allowance')
    await assert.rejects(searchGomokuWorker(position(midgame()), 'challenge', signal.signal), /思考已取消/)
  } finally { signal.abort(); await rejected.catch(() => {}) }
})

function client() {
  let snapshot: Snapshot | undefined
  let error: string | null = null
  const peer: Peer = {
    id: 'test', role: 'table', seatId: null, token: null, room: null, requestRoom: null,
    send(message) {
      if (message.type === 'state') snapshot = message.state
      if (message.type === 'error') error = message.message
    },
    supersede() {},
  }
  let id = 0
  return {
    peer,
    get state() { assert.ok(snapshot); return snapshot },
    send(room: Room, type: string, payload: Record<string, unknown> = {}, expectedError?: RegExp) {
      error = null
      room.command(peer, type, payload, String(++id))
      if (expectedError) assert.match(error ?? '', expectedError)
      else assert.equal(error, null)
    },
  }
}

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 10_000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message)
    await delay(15)
  }
}

function gomoku(room: Room) {
  const view = room.engine.view(null)
  assert.equal(view.game, 'gomoku')
  return view
}

test('Gomoku has five available levels with a missing native manifest; Go refuses configuration', async () => {
  const policy = new NativeBoardAiPolicy('/nonexistent/weizhuo-board-ai')
  await policy.initialize()
  for (const difficulty of levels) assert.deepEqual(policy.availability('gomoku', difficulty), { available: true, message: null })
  const room = new Room('GOAI', 'tablet', 'go', undefined, undefined, policy)
  const host = client()
  try {
    room.bindCreator(host.peer, 'create')
    assert.equal(host.state.boardAi, undefined)
    host.send(room, 'boardAi', { enabled: true, side: 1, difficulty: 'normal' }, /不支持/)
  } finally { room.dispose() }
})

test('The actual challenge worker wins a complete phone room game', async () => {
  const room = new Room('GMAI', 'phone', 'gomoku'), host = client()
  try {
    room.bindCreator(host.peer, 'create', '测试')
    host.send(room, 'boardAi', { enabled: true, side: 1, difficulty: 'challenge' })
    assert.equal(host.state.seats[1]?.ready, true)
    host.send(room, 'ready', { ready: true })
    host.send(room, 'start')
    // The human spreads their stones around the perimeter after opening at the center.
    const weak = [112, 0, 224, 14, 210, 4, 220, 10, 214, 60, 74, 150, 164, 30, 194]
    for (const next of weak) {
      if (room.phase === 'finished') break
      const view = gomoku(room), ply = view.stones.moves.length
      assert.equal(view.turn, 0)
      const point = view.stones.board[next] === null ? next : weak.find(cell => view.stones.board[cell] === null)!
      host.send(room, 'stoneMove', { point })
      await until(() => room.phase === 'finished' || !!host.state.boardAi?.error || gomoku(room).stones.moves.length === ply + 2, 'challenge worker never replied')
      assert.equal(host.state.boardAi?.error, null)
    }
    const result = gomoku(room)
    assert.equal(result.phase, 'finished')
    assert.equal(result.stones.winner, 1)
    assert.ok(result.stones.winningLine.length >= 5)
    const points = result.stones.moves.map(move => move.point)
    assert.equal(new Set(points).size, points.length)
  } finally { room.dispose() }
})

test('Tablet computer plays black first and the host can only move or resign for white', async () => {
  const room = new Room('GMBK', 'tablet', 'gomoku'), host = client()
  try {
    room.bindCreator(host.peer, 'create')
    host.send(room, 'boardAi', { enabled: true, side: 0, difficulty: 'challenge' })
    host.send(room, 'start')
    assert.equal(host.state.boardAi?.thinking, true)
    host.send(room, 'stoneMove', { point: 10 }, /轮到电脑/)
    host.send(room, 'stoneResign', { side: 0 }, /只能替自己认输/)
    await until(() => gomoku(room).stones.moves.length === 1, 'computer did not open as black')
    const view = gomoku(room)
    assert.equal(view.stones.board[opening], 0)
    assert.equal(view.turn, 1)
    host.send(room, 'stoneResign', { side: 1 })
    assert.equal(gomoku(room).stones.winner, 0)
  } finally { room.dispose() }
})

function heldPolicy() {
  const requests: { signal?: AbortSignal; resolve: (move: BoardAiMove) => void }[] = []
  const policy: BoardAiPolicy = {
    availability: () => ({ available: true, message: null }),
    chooseMove: (position, _difficulty, signal) => {
      assert.equal(position.kind, 'gomoku')
      return new Promise(resolve => requests.push({ signal, resolve }))
    },
  }
  return { policy, requests }
}

test('Human Gomoku undo remains available beyond the per-side limit', () => {
  const { policy } = heldPolicy()
  const room = new Room('GMUL', 'tablet', 'gomoku', undefined, undefined, policy), host = client()
  try {
    room.bindCreator(host.peer, 'create')
    host.send(room, 'boardAi', { enabled: true, side: 1, difficulty: 'normal' })
    host.send(room, 'start')
    for (let attempt = 0; attempt <= BOARD_UNDO_LIMIT; attempt++) {
      host.send(room, 'stoneMove', { point: opening })
      host.send(room, 'stoneUndo', { action: 'request' })
      const view = gomoku(room)
      assert.equal(view.stones.undoUsed[0], attempt + 1)
      assert.equal(view.stones.moves.length, 0)
      assert.equal(view.turn, 0)
    }
  } finally { room.dispose() }
})

test('Rejected undo re-arms the canceled computer search and ignores the stale reply', async t => {
  const { policy, requests } = heldPolicy()
  const room = new Room('GMRE', 'tablet', 'gomoku', undefined, undefined, policy), host = client()
  try {
    room.bindCreator(host.peer, 'create')
    host.send(room, 'boardAi', { enabled: true, side: 1, difficulty: 'normal' })
    host.send(room, 'start')
    host.send(room, 'stoneMove', { point: opening })
    await until(() => requests.length === 1, 'first computer request')
    const command = room.engine.command.bind(room.engine)
    t.mock.method(room.engine, 'command', (...args: Parameters<typeof command>) =>
      args[1] === 'stoneUndo' ? { ok: false, message: '测试引擎拒绝悔棋' } : command(...args))
    host.send(room, 'stoneUndo', { action: 'request' }, /测试引擎拒绝悔棋/)
    assert.equal(requests[0]!.signal?.aborted, true)
    requests[0]!.resolve({ kind: 'gomoku', point: 111 })
    await until(() => requests.length === 2, 'replacement computer request')
    assert.equal(gomoku(room).stones.moves.length, 1)
    requests[1]!.resolve({ kind: 'gomoku', point: 113 })
    await until(() => gomoku(room).stones.moves.length === 2, 'new computer reply applied')
    assert.equal(gomoku(room).stones.board[111], null)
    assert.equal(gomoku(room).stones.board[113], 1)
    assert.equal(gomoku(room).stones.undoUsed[0], 0)
  } finally { room.dispose() }
})
