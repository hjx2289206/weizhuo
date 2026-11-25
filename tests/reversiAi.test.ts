import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTick, setTimeout as delay } from 'node:timers/promises'
import { BOARD_AI_DIFFICULTIES } from '../shared/boardAi'
import {
  REVERSI_FLIP_MS, applyMove, initialReversiBoard, legalMoves, otherReversiSide, score, type ReversiBoard, type ReversiSide,
} from '../shared/reversi'
import { chooseReversiMove } from '../server/bots/reversiAi'
import { searchBoardWorker } from '../server/bots/boardSearchWorker'
import { NativeBoardAiPolicy, type BoardAiPolicy } from '../server/bots/boardAi'
import { Room, type Peer } from '../server/room'
import type { Snapshot } from '../shared/protocol'

function diagram(text: string): ReversiBoard {
  assert.equal(text.length, 64)
  return [...text].map(cell => cell === '.' ? null : cell === 'X' ? 0 : 1)
}

function seeded(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x1_0000_0000
  }
}

const exactLevels = ['normal', 'hard', 'challenge'] as const

test('All five Reversi profiles pick a legal move, preserve input and support fixed randomness', () => {
  const board = applyMove(initialReversiBoard(), 0, 19)!.board
  const original = [...board]
  for (const { id } of BOARD_AI_DIFFICULTIES) {
    let tick = 0
    const run = () => { tick = 0; return chooseReversiMove({ board, toMove: 1 }, id, { random: seeded(3000), now: () => tick += 0.5 }) }
    const move = run()
    assert.ok(legalMoves(board, 1).includes(move!))
    assert.equal(run(), move)
    assert.deepEqual(board, original)
    assert.equal(chooseReversiMove({ board: Array(64).fill(0), toMove: 1 }, id), null)
  }
})

test('Normal and stronger Reversi profiles choose an available corner in the midgame', () => {
  const board = initialReversiBoard()
  board[1] = 1; board[2] = 0
  assert.ok(legalMoves(board, 0).length > 1)
  for (const id of exactLevels) assert.equal(chooseReversiMove({ board, toMove: 0 }, id), 0)
})

function brute(board: ReversiBoard, side: ReversiSide, passed = false): number {
  const moves = legalMoves(board, side), other = otherReversiSide(side)
  if (!moves.length) {
    if (!passed) return -brute(board, other, true)
    const [black, white] = score(board)
    return side === 0 ? black - white : white - black
  }
  return Math.max(...moves.map(point => -brute(applyMove(board, side, point)!.board, other)))
}

const endgames = [
  'OOOOOOOXOOOOOOXXOOOOOXOXOOOOXOOXOOOOXOOXOOOOOOXXOOOOOO.XX.......',
  '.XOOOOO...XOXOXXOOOOOXXX.OOOOOXXO.OOXXOXOOOOOOOO..OOXOOO.XOO.OOO',
  '..OOO.X..OOOOOOXOOOXOOOOOOOXOXOOOXOXXOXOOXOXOO.OOOOOOOOO.XOOOOX.',
]
for (const [index, text] of endgames.entries()) {
  test('Reversi exact search agrees with exhaustive terminal disk margin on fixture ' + (index + 1), () => {
    const board = diagram(text)
    assert.ok(board.filter(cell => cell === null).length <= 10)
    const optimal = brute(board, 0)
    for (const id of exactLevels) {
      // A tiny simulated midgame budget deliberately cannot truncate exact reading.
      let time = 0
      const move = chooseReversiMove({ board, toMove: 0 }, id, { now: () => time += 1000 })
      const next = applyMove(board, 0, move)
      assert.ok(next, id)
      assert.equal(-brute(next.board, 1), optimal, id)
    }
  })
}

test('With twelve empty squares Reversi keeps the two lowest profiles varied and solves exactly from normal up', () => {
  const board = diagram('O.OOOOOOOOOOOOOO.OO.OOOOOO.OOO.OO..OO.XOOOOO..OOOOO.O.OOOOOXOOOO')
  const position = { board, toMove: 1 } as const
  assert.equal(board.filter(cell => cell === null).length, 12)
  const margins = legalMoves(board, 1).map(point => [point, -brute(applyMove(board, 1, point)!.board, 0)])
  assert.deepEqual(margins, [[30, 53], [37, 57], [45, 51]])
  for (const id of exactLevels) {
    assert.equal(chooseReversiMove(position, id), 37, id)
  }
  for (const id of ['beginner', 'easy'] as const) {
    const choices = [1, 1234].map(seed => chooseReversiMove(position, id, { random: seeded(seed), now: () => 0 }))
    assert.ok(choices.every(point => margins.some(([legal]) => legal === point)), id)
    assert.notEqual(choices[0], choices[1], id)
  }
})

function client(name: string) {
  let state: Snapshot | undefined
  let error = ''
  let index = 0
  const peer: Peer = { id: name, role: 'table', token: null, seatId: null, room: null, requestRoom: null,
    send(message) {
      if (message.type === 'state') state = message.state
      if (message.type === 'error') error = message.message
    }, supersede() {} }
  return {
    peer,
    state() { assert.equal(state?.game, 'reversi'); return state },
    command(room: Room, type: string, payload: Record<string, unknown> = {}, expectedError?: RegExp) {
      error = ''
      room.command(peer, type, payload, name + '-' + ++index)
      if (expectedError) assert.match(error, expectedError)
      else assert.equal(error, '')
    },
  }
}

test('A phone room reaches a natural Reversi result against the actual search with simulated scheduling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const policy: BoardAiPolicy = {
    availability: () => ({ available: true, message: null }),
    async chooseMove(position, difficulty) {
      assert.equal(position.kind, 'reversi')
      const point = chooseReversiMove(position, difficulty, { random: seeded(117) })
      assert.notEqual(point, null)
      return { kind: 'reversi', point: point! }
    },
  }
  const room = new Room('RVPH', 'phone', 'reversi', undefined, undefined, policy)
  const host = client('phone')
  try {
    room.bindCreator(host.peer, 'create', '黑方')
    host.command(room, 'boardAi', { enabled: true, side: 1, difficulty: 'beginner' })
    host.command(room, 'ready', { ready: true })
    host.command(room, 'start')
    for (let turn = 0; host.state().phase === 'playing' && turn < 60; turn++) {
      const state = host.state(), count = state.reversi.moves.length
      if (state.turn === 0) host.command(room, 'reversiMove', { point: state.reversi.legal[0] })
      else { t.mock.timers.tick(REVERSI_FLIP_MS); await nextTick() }
      assert.ok(host.state().reversi.moves.length > count)
      assert.equal(host.state().boardAi?.error, null)
    }
    const result = host.state()
    assert.equal(result.phase, 'finished')
    assert.equal(legalMoves(result.reversi.board, 0).length, 0)
    assert.equal(legalMoves(result.reversi.board, 1).length, 0)
  } finally { room.dispose(); t.mock.timers.reset() }
})

test('Built-in Reversi worker plays a real tablet opening and rejects computer impersonation', { timeout: 8500 }, async () => {
  const policy = new NativeBoardAiPolicy('/nonexistent/reversi-native-engines')
  for (const { id } of BOARD_AI_DIFFICULTIES) assert.equal(policy.availability('reversi', id).available, true)
  const room = new Room('RVWK', 'tablet', 'reversi', undefined, undefined, policy)
  const host = client('tablet')
  try {
    room.bindCreator(host.peer, 'create')
    host.command(room, 'boardAi', { enabled: true, side: 0, difficulty: 'normal' })
    host.command(room, 'start')
    assert.equal(host.state().boardAi?.thinking, true)
    host.command(room, 'reversiMove', { point: 19 }, /轮到电脑/)
    host.command(room, 'reversiResign', { side: 0 }, /只能替自己认输/)
    const deadline = performance.now() + 7000
    while (host.state().boardAi?.thinking) {
      assert.ok(performance.now() < deadline, 'worker reply never reached the room')
      await delay(25)
    }
    const state = host.state()
    assert.equal(state.boardAi?.error, null)
    assert.equal(state.reversi.moves.length, 1)
    assert.equal(state.reversi.moves[0]!.side, 0)
    assert.equal(state.turn, 1)
  } finally { room.dispose() }
})

test('The shared worker aborts Reversi jobs before startup and when launched', { timeout: 5000 }, async () => {
  const position = { kind: 'reversi', game: 'reversi', board: initialReversiBoard(), toMove: 0 } as const
  const signal = new AbortController()
  const pending = searchBoardWorker(position, 'challenge', signal.signal)
  signal.abort()
  await assert.rejects(pending, /思考已取消/)
  await assert.rejects(searchBoardWorker(position, 'challenge', signal.signal), /思考已取消/)
})
