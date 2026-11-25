import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ChessGame } from '../server/games/chess'
import { XiangqiGame } from '../server/games/xiangqi'
import { StoneGame } from '../server/games/stones'
import type { GameCommandType, GameResult, RoomGame } from '../server/games/types'
import type { BoardAiMove, BoardAiPolicy, BoardSearchPosition } from '../server/bots/boardAi'
import { Room, type Peer } from '../server/room'
import { BOARD_UNDO_LIMIT, type BoardUndoAction, type BoardUndoSide } from '../shared/boardUndo'
import { chessIndex } from '../shared/chess'
import type { ServerMessage } from '../shared/protocol'
import type { StoneBoard } from '../shared/stones'

function ok(result: GameResult): void { assert.equal(result.ok, true, result.ok ? undefined : result.message) }
function refused(result: GameResult, message: RegExp): void {
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, message)
}
function boardOf(game: RoomGame) {
  const view = game.view(null)
  if (view.game === 'chess') return view.chess
  if (view.game === 'xiangqi') return view.xiangqi
  if (view.game === 'go' || view.game === 'gomoku') return view.stones
  throw new Error('expected an undo-enabled game')
}
const moves = {
  chess: [{ from: 52, to: 36 }, { from: 12, to: 28 }, { from: 62, to: 45 }],
  xiangqi: [{ from: 54, to: 45 }, { from: 27, to: 36 }, { from: 45, to: 36 }],
  stone: [{ point: 40 }, { point: 41 }, { point: 42 }],
}
const cases = [
  { kind: 'chess', make: () => new ChessGame(), move: 'chessMove', undo: 'chessUndo', moves: moves.chess },
  { kind: 'xiangqi', make: () => new XiangqiGame(), move: 'xiangqiMove', undo: 'xiangqiUndo', moves: moves.xiangqi },
  { kind: 'go', make: () => new StoneGame('go'), move: 'stoneMove', undo: 'stoneUndo', moves: moves.stone },
  { kind: 'gomoku', make: () => new StoneGame('gomoku'), move: 'stoneMove', undo: 'stoneUndo', moves: moves.stone },
] as const

for (const entry of cases) {
  test(`${entry.kind}: accepted two-ply and one-ply undos restore exact board state and turn`, () => {
    const game = entry.make()
    const undo = (seat: BoardUndoSide, action: BoardUndoAction) => game.command(seat, entry.undo, { action })
    refused(undo(0, 'request'), /开始对局/)
    game.start()
    const initial = boardOf(game)
    refused(undo(0, 'request'), /没有.*着法/)
    ok(game.command(0, entry.move, entry.moves[0]))
    const afterFirst = boardOf(game)
    ok(game.command(1, entry.move, entry.moves[1]))
    ok(game.command(0, entry.move, entry.moves[2]))
    ok(undo(1, 'request'))
    ok(undo(0, 'accept'))
    assert.equal(game.view().turn, 1)
    assert.deepEqual(boardOf(game), { ...afterFirst, undoUsed: [0, 1] })
    ok(undo(0, 'request'))
    ok(undo(1, 'accept'))
    assert.equal(game.view().turn, 0)
    assert.deepEqual(boardOf(game), { ...initial, undoUsed: [1, 1] })
  })
}

test('Only the other player can accept or decline; only the requester can cancel; a new move expires the offer', () => {
  const game = new ChessGame()
  const undo = (seat: BoardUndoSide, action: BoardUndoAction) => game.command(seat, 'chessUndo', { action })
  game.start()
  ok(game.command(0, 'chessMove', moves.chess[0]!))
  ok(game.command(1, 'chessMove', moves.chess[1]!))
  ok(undo(0, 'request'))
  assert.equal(game.view().chess.undoOffer, 0)
  refused(undo(0, 'request'), /已有悔棋请求/)
  refused(undo(1, 'request'), /已有悔棋请求/)
  refused(undo(0, 'accept'), /没有对方/)
  refused(undo(0, 'decline'), /没有对方/)
  refused(undo(1, 'cancel'), /没有可以撤回/)
  ok(undo(1, 'decline'))
  ok(undo(0, 'request'))
  ok(undo(0, 'cancel'))
  refused(undo(1, 'accept'), /没有对方/)
  assert.deepEqual(game.view().chess.undoUsed, [0, 0])
  ok(undo(1, 'request'))
  ok(game.command(0, 'chessMove', moves.chess[2]!))
  assert.equal(game.view().chess.undoOffer, null)
  refused(undo(0, 'accept'), /没有对方/)
  assert.equal(game.view().chess.moves.length, 3)
})

test('Three successful undo requests exhaust only the requester’s quota; a rematch resets both quotas', () => {
  const game = new StoneGame('gomoku')
  game.start()
  for (let used = 0; used < BOARD_UNDO_LIMIT; used++) {
    ok(game.command(0, 'stoneMove', { point: 112 }))
    ok(game.command(0, 'stoneUndo', { action: 'request' }))
    ok(game.command(1, 'stoneUndo', { action: 'accept' }))
  }
  ok(game.command(0, 'stoneMove', { point: 112 }))
  refused(game.command(0, 'stoneUndo', { action: 'request', unlimitedUndo: true }), /次数已用完/)
  ok(game.command(1, 'stoneMove', { point: 113 }))
  ok(game.command(1, 'stoneUndo', { action: 'request' }))
  ok(game.command(0, 'stoneUndo', { action: 'accept' }))
  ok(game.command(0, 'stoneResign', {}))
  refused(game.command(0, 'stoneUndo', { action: 'direct' }), /开始对局/)
  ok(game.restart())
  assert.deepEqual(game.view().stones.undoUsed, [0, 0])
  assert.equal(game.view().stones.undoOffer, null)
})

for (const entry of cases.slice(0, 2)) {
  test(`${entry.kind}: a draw offer blocks undo and discarded plies no longer throttle draw offers`, () => {
    const game = entry.make()
    const draw = (entry.kind + 'Draw') as GameCommandType
    game.start()
    ok(game.command(0, draw, { action: 'offer' }))
    ok(game.command(1, draw, { action: 'decline' }))
    ok(game.command(0, entry.move, entry.moves[0]))
    ok(game.command(0, draw, { action: 'offer' }))
    refused(game.command(0, entry.undo, { action: 'request' }), /先处理和棋请求/)
    ok(game.command(1, draw, { action: 'decline' }))
    ok(game.command(0, entry.undo, { action: 'request' }))
    refused(game.command(1, draw, { action: 'offer' }), /已有悔棋请求/)
    ok(game.command(1, entry.undo, { action: 'accept' }))
    assert.equal((boardOf(game) as ReturnType<ChessGame['view']>['chess']).drawOffer, null)
    refused(game.command(0, draw, { action: 'offer' }), /本步已经提过和棋/)
    ok(game.command(0, entry.move, entry.moves[0]))
    ok(game.command(0, draw, { action: 'offer' }))
  })
}

test('Go undo restores captures; the discarded shape may be played again and the original ko still applies', () => {
  const board: StoneBoard = Array(81).fill(null)
  for (const point of [11, 19, 29]) board[point] = 0
  for (const point of [20, 12, 22, 30]) board[point] = 1
  const game = new StoneGame('go', { board })
  game.start()
  ok(game.command(0, 'stoneMove', { point: 21 }))
  assert.equal(game.view().stones.board[20], null)
  assert.deepEqual(game.view().stones.captured, [1, 0])
  ok(game.command(1, 'stoneMove', { point: 60 }))
  ok(game.command(0, 'stoneUndo', { action: 'request' }))
  ok(game.command(1, 'stoneUndo', { action: 'accept' }))
  assert.deepEqual(game.view().stones.board, board)
  assert.deepEqual(game.view().stones.captured, [0, 0])
  ok(game.command(0, 'stoneMove', { point: 21 }))
  refused(game.command(1, 'stoneMove', { point: 20 }), /同形再现/)
  ok(game.command(1, 'stoneMove', { point: 60 }))
})

test('Go undo is blocked during scoring and restores consecutive pass state after resuming', () => {
  const game = new StoneGame('go')
  game.start()
  ok(game.command(0, 'stoneMove', { point: 40 }))
  ok(game.command(1, 'stonePass', {}))
  ok(game.command(0, 'stonePass', {}))
  refused(game.command(0, 'stoneUndo', { action: 'request' }), /确认死子/)
  ok(game.command(1, 'stoneScore', { action: 'resume' }))
  ok(game.command(0, 'stoneUndo', { action: 'direct' }))
  assert.equal(game.view().stones.passes, 1)
  assert.equal(game.view().turn, 0)
  ok(game.command(0, 'stonePass', {}))
  assert.equal(game.view().stones.stage, 'scoring')
})

const chessSpecialMoves = [
  { name: 'castling', fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', from: 'e1', to: 'g1' },
  { name: 'en passant', fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', from: 'e5', to: 'd6' },
  { name: 'a capturing promotion', fen: '1r5k/P6p/8/8/8/8/8/K7 w - - 0 1', from: 'a7', to: 'b8', promotion: 'n' },
]
for (const fixture of chessSpecialMoves) {
  test(`Chess undo restores rules, piece IDs and replay legality after ${fixture.name}`, () => {
    const game = new ChessGame(fixture.fen)
    game.start()
    const start = game.view()
    const command = { from: chessIndex(fixture.from), to: chessIndex(fixture.to), promotion: fixture.promotion }
    ok(game.command(0, 'chessMove', command))
    const played = game.view()
    ok(game.command(0, 'chessUndo', { action: 'direct' }))
    assert.deepEqual(game.view(), { ...start, chess: { ...start.chess, undoUsed: [1, 0] } })
    ok(game.command(0, 'chessMove', command))
    assert.deepEqual(game.view(), { ...played, chess: { ...played.chess, undoUsed: [1, 0] } })
  })
}

test('Xiangqi repetition adjudication counts only retained positions', () => {
  const game = new XiangqiGame()
  game.start()
  const cycle = [{ from: 82, to: 65 }, { from: 1, to: 20 }, { from: 65, to: 82 }, { from: 20, to: 1 }]
  const play = (index: number) => ok(game.command(index % 2, 'xiangqiMove', cycle[index]!))
  cycle.forEach((_, index) => play(index))
  ok(game.command(0, 'xiangqiUndo', { action: 'direct' }))
  play(2); play(3)
  assert.equal(game.phase, 'playing')
  cycle.forEach((_, index) => play(index))
  assert.equal(game.phase, 'finished')
  assert.match(game.view().xiangqi.reason, /三次重复/)
})

function peer(id: string): Peer & { sent: ServerMessage[] } {
  return { id, role: 'table', seatId: null, token: null, room: null, requestRoom: null, sent: [],
    send(message) { this.sent.push(message) }, supersede() {} }
}
function roomSend(room: Room, player: ReturnType<typeof peer>, type: string, payload: Record<string, unknown>, expectedError?: RegExp): void {
  const id = `${player.id}-${player.sent.length}`
  room.command(player, type, payload, id)
  const reply = player.sent.find(message => (message.type === 'ack' || message.type === 'error') && message.id === id)
  assert.ok(reply)
  if (expectedError) {
    assert.ok(reply.type === 'error')
    assert.match(reply.message, expectedError)
  } else assert.equal(reply.type, 'ack', JSON.stringify(reply))
}

test('Phone rooms use the authenticated requester and reject client direct and unapproved takebacks', () => {
  const room = new Room('UNDO', 'phone', 'gomoku'), host = peer('host'), guest = peer('guest')
  try {
    room.bindCreator(host, 'create', '黑方'); room.bindJoin(guest, 1, '白方', 'join')
    for (const player of [host, guest]) roomSend(room, player, 'ready', { ready: true })
    roomSend(room, host, 'start', {})
    roomSend(room, host, 'stoneMove', { point: 112 })
    roomSend(room, host, 'stoneUndo', { action: 'direct' }, /请使用悔棋请求/)
    roomSend(room, guest, 'stoneUndo', { action: 'request', side: 0 }, /没有.*着法/)
    roomSend(room, host, 'stoneUndo', { action: 'request' })
    roomSend(room, host, 'stoneUndo', { action: 'accept' }, /没有对方/)
    roomSend(room, guest, 'stoneUndo', { action: 'accept' })
    assert.deepEqual(boardOf(room.engine).undoUsed, [1, 0])
    assert.equal(boardOf(room.engine).moves.length, 0)
  } finally { room.dispose() }
})

for (const entry of cases) {
  test(`${entry.kind}: tablet derives the latest side from the board and rejects client direct`, () => {
    const room = new Room('UNDO', 'tablet', entry.kind), host = peer('host')
    try {
      room.bindCreator(host, 'create')
      roomSend(room, host, 'start', {})
      roomSend(room, host, entry.move, entry.moves[0])
      roomSend(room, host, entry.undo, { action: 'direct' }, /请使用悔棋请求/)
      roomSend(room, host, entry.undo, { action: 'accept' }, /没有协商/)
      assert.equal(boardOf(room.engine).moves.length, 1)
      roomSend(room, host, entry.undo, { action: 'request', side: 1 })
      assert.deepEqual(boardOf(room.engine).undoUsed, [1, 0])
      assert.equal(boardOf(room.engine).moves.length, 0)
    } finally { room.dispose() }
  })
}

test('Junqi refuses every undo command', () => {
  const room = new Room('UNDO', 'phone', 'junqi'), host = peer('host')
  try {
    room.bindCreator(host, 'create', '房主')
    for (const type of ['chessUndo', 'xiangqiUndo', 'stoneUndo']) roomSend(room, host, type, { action: 'request' }, /不支持/)
  } finally { room.dispose() }
})

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (condition()) return
    await delay(20)
  }
  assert.fail('timed out waiting for computer')
}

test('AI undo cancels pending search, ignores a stale result, searches the replayed line and exceeds the human quota', async () => {
  const requests: { position: BoardSearchPosition; signal: AbortSignal | undefined; resolve: (move: BoardAiMove) => void }[] = []
  const policy: BoardAiPolicy = { availability: () => ({ available: true, message: null }),
    chooseMove: (position, _difficulty, signal) => new Promise(resolve => requests.push({ position, signal, resolve })) }
  const room = new Room('UNDO', 'phone', 'chess', undefined, undefined, policy), host = peer('host')
  try {
    room.bindCreator(host, 'create', '白方')
    roomSend(room, host, 'boardAi', { enabled: true, side: 1, difficulty: 'easy' })
    roomSend(room, host, 'ready', { ready: true })
    roomSend(room, host, 'start', {})
    roomSend(room, host, 'chessMove', moves.chess[0]!)
    await until(() => requests.length === 1)
    roomSend(room, host, 'chessUndo', { action: 'direct' }, /请使用悔棋请求/)
    assert.equal(requests[0]!.signal?.aborted, false)
    roomSend(room, host, 'chessUndo', { action: 'request' })
    assert.equal(requests[0]!.signal?.aborted, true)
    assert.equal(room.engine.view(null).turn, 0)
    requests[0]!.resolve(moves.chess[1]!)
    await delay(0)
    assert.equal(boardOf(room.engine).moves.length, 0)
    roomSend(room, host, 'chessMove', { from: 51, to: 35 })
    await until(() => requests.length === 2)
    assert.match(requests[1]!.position.position, / moves d2d4$/)
    requests[1]!.resolve(moves.chess[1]!)
    await until(() => boardOf(room.engine).moves.length === 2)
    roomSend(room, host, 'chessUndo', { action: 'request' })
    assert.equal(boardOf(room.engine).moves.length, 0)
    for (let index = 0; index < BOARD_UNDO_LIMIT; index++) {
      roomSend(room, host, 'chessMove', moves.chess[0]!)
      roomSend(room, host, 'chessUndo', { action: 'request' })
    }
    assert.deepEqual(boardOf(room.engine).undoUsed, [BOARD_UNDO_LIMIT + 2, 0])
  } finally { room.dispose() }
})
