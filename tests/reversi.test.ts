import assert from 'node:assert/strict'
import test from 'node:test'
import { ReversiGame } from '../server/games/reversi'
import type { GameResult } from '../server/games/types'
import { Room, type Peer } from '../server/room'
import { teachingClips } from '../server/tutorials/session'
import { applyMove, initialReversiBoard, legalMoves, score, type ReversiBoard, type ReversiSide } from '../shared/reversi'
import type { ServerMessage } from '../shared/protocol'
import { resultFromSnapshot, resultSeatLabel } from '../src/resultHistory'

function accepted(result: GameResult): void {
  assert.ok(result.ok, result.ok ? undefined : result.message)
}

function place(game: ReversiGame, side: ReversiSide, point: number): void {
  accepted(game.command(side, 'reversiMove', { point }))
}

function passPosition(): ReversiBoard {
  const board: ReversiBoard = Array(64).fill(1)
  board[0] = board[56] = null
  board[1] = board[57] = 0
  return board
}

test('Reversi starts with four alternating center disks and exactly four legal moves for black', () => {
  const board = initialReversiBoard()
  assert.deepEqual([board[27], board[28], board[35], board[36]], [1, 0, 0, 1])
  assert.deepEqual(legalMoves(board, 0), [19, 26, 37, 44])
  const game = new ReversiGame()
  game.start()
  assert.equal(game.view().turn, 0)
  assert.deepEqual(game.view().reversi.counts, [2, 2])
  assert.deepEqual(game.view().reversi.legal, [19, 26, 37, 44])
})

test('Reversi flips every bracketed direction and restores each flipped disk after undo', () => {
  const board: ReversiBoard = Array(64).fill(null)
  for (const point of [25, 29, 11, 43, 9, 45, 61]) board[point] = 0
  for (const point of [26, 28, 19, 35, 18, 36, 62]) board[point] = 1
  const game = new ReversiGame({ board, turn: 0 })
  game.start()
  place(game, 0, 27)
  const flipped = [18, 19, 26, 28, 35, 36]
  assert.deepEqual(game.view().reversi.moves[0]!.flipped, flipped)
  assert.ok(flipped.every(point => game.view().reversi.board[point] === 0))
  assert.equal(game.view().turn, 1)
  assert.deepEqual(game.view().reversi.counts, [14, 1])
  accepted(game.command(0, 'reversiUndo', { action: 'request' }))
  accepted(game.command(1, 'reversiUndo', { action: 'accept' }))
  assert.deepEqual(game.view().reversi.board, board)
  assert.deepEqual(game.view().reversi.counts, [7, 7])
  assert.deepEqual(game.view().reversi.moves, [])
  assert.deepEqual(game.view().reversi.undoUsed, [1, 0])
  assert.equal(game.view().turn, 0)
})

test('Reversi rejects non-bracketing, occupied, wrapped and out-of-turn moves without mutation', () => {
  const game = new ReversiGame()
  game.start()
  const before = game.view()
  for (const point of [0, 27, -1, 64, 19.5, '19', null]) assert.equal(game.command(0, 'reversiMove', { point }).ok, false)
  assert.equal(game.command(1, 'reversiMove', { point: 19 }).ok, false)
  assert.deepEqual(game.view(), before)
  const board: ReversiBoard = Array(64).fill(null)
  board[8] = 1; board[9] = 0
  assert.equal(applyMove(board, 0, 7), null)
  assert.ok(!legalMoves(board, 0).includes(7))
})

test('Forced Reversi pass is recorded and undo returns to before the placement that caused it', () => {
  const board = passPosition()
  const game = new ReversiGame({ board, turn: 1 })
  game.start()
  place(game, 1, 0)
  const after = game.view()
  assert.equal(after.turn, 1)
  assert.deepEqual(after.reversi.legal, [56])
  assert.deepEqual(after.reversi.moves.map(move => [move.side, move.point]), [[1, 0], [0, null]])
  assert.equal(after.reversi.moves.at(-1)!.notation, '黑方无处可下，停一手')
  assert.match(game.statusText(0, String), /^黑方无处可下，停一手/)
  accepted(game.command(0, 'reversiUndo', { action: 'request' }))
  accepted(game.command(1, 'reversiUndo', { action: 'accept' }))
  assert.deepEqual(game.view().reversi.board, board)
  assert.equal(game.view().reversi.moves.length, 0)
  assert.equal(game.view().turn, 1)
  assert.deepEqual(game.view().reversi.undoUsed, [1, 0])
  place(game, 1, 0)
  place(game, 1, 56)
  assert.equal(game.view().reversi.winner, 1)
  assert.deepEqual(game.view().reversi.counts, [0, 64])
})

test('Reversi ends on mutual immobility with a square left empty', () => {
  const board = passPosition()
  board[57] = 1
  const game = new ReversiGame({ board, turn: 1 })
  game.start()
  place(game, 1, 0)
  const result = game.view()
  assert.equal(result.phase, 'finished')
  assert.equal(result.turn, null)
  assert.equal(result.reversi.winner, 1)
  assert.deepEqual(result.reversi.counts, [0, 63])
  assert.equal(result.reversi.board[56], null)
  assert.equal(result.reversi.reason, '双方均无合法落点')
})

test('Reversi counts a 32–32 full board as a draw; terminal undo is rejected and restart resets the round', () => {
  const board: ReversiBoard = Array.from({ length: 64 }, (_, point) => point === 0 ? null : point >= 2 && point < 32 ? 0 : 1)
  const game = new ReversiGame({ board, turn: 0 })
  game.start()
  place(game, 0, 0)
  const { phase, reversi } = game.view()
  assert.equal(phase, 'finished')
  assert.equal(reversi.draw, true)
  assert.equal(reversi.winner, null)
  assert.deepEqual(score(reversi.board), [32, 32])
  assert.equal(game.command(0, 'reversiUndo', { action: 'direct' }).ok, false)
  accepted(game.restart())
  assert.notEqual(game.view().reversi.roundId, reversi.roundId)
  assert.deepEqual(game.view().reversi.board, board)
  assert.deepEqual(game.view().reversi.moves, [])
})

test('Undo of a Reversi placement works after a reply and human-side resign awards the opponent', () => {
  const game = new ReversiGame()
  game.start()
  place(game, 0, 19); place(game, 1, 18)
  accepted(game.command(0, 'reversiUndo', { action: 'direct' }, { unlimitedUndo: true }))
  assert.equal(game.view().turn, 0)
  assert.deepEqual(game.view().reversi.board, initialReversiBoard())
  accepted(game.command(0, 'reversiResign', {}))
  assert.equal(game.view().reversi.winner, 1)
  assert.equal(game.view().reversi.reason, '黑方认输')
})

test('Reversi shared tablet completes a game with real room authority, pass records and result history', () => {
  const room = new Room('RV01', 'tablet', 'reversi')
  const sent: ServerMessage[] = []
  const host: Peer = { id: 'RV01', role: 'table', seatId: null, token: null, room: null, requestRoom: null, send: message => sent.push(message), supersede() {} }
  try {
    room.bindCreator(host, 'create')
    room.command(host, 'start', {}, 'start')
    room.command(host, 'reversiMove', { point: 19 }, 'first')
    room.command(host, 'reversiUndo', { action: 'direct' }, 'forged-direct')
    assert.ok(sent.some(message => message.type === 'error' && message.id === 'forged-direct'))
    room.command(host, 'reversiUndo', { action: 'request' }, 'confirmed-undo')
    let view = room.engine.view(null)
    assert.equal(view.game, 'reversi')
    assert.equal(view.reversi.moves.length, 0)
    for (let index = 0; view.phase === 'playing' && index < 60; index++) {
      const point = view.reversi.legal[0]
      assert.notEqual(point, undefined)
      room.command(host, 'reversiMove', { point }, 'move-' + index)
      view = room.engine.view(null)
      assert.equal(view.game, 'reversi')
    }
    assert.equal(view.phase, 'finished')
    assert.deepEqual(view.reversi.counts, [19, 45])
    const message = sent.filter(message => message.type === 'state').at(-1)
    assert.ok(message?.type === 'state')
    const result = resultFromSnapshot(message.state)
    assert.equal(result?.title, '白方获胜')
    assert.match(result?.detail ?? '', /黑 19 子 · 白 45 子/)
    assert.ok(result?.plays.some(play => play.cards === '黑方无处可下，停一手'))
    assert.deepEqual([resultSeatLabel('reversi', 0), resultSeatLabel('reversi', 1)], ['黑方', '白方'])
  } finally { room.dispose() }
})

test('Eight Reversi lessons use rule-engine snapshots including flips, passes, rejection, count and draw', () => {
  const clips = teachingClips('reversi')
  assert.deepEqual(clips.map(clip => clip.id), ['opening','legal','flip','directions','pass','corner','count','draw'].map(id => 'reversi-' + id))
  for (const clip of clips) {
    assert.equal(clip.snapshot.game, 'reversi')
    assert.ok(clip.frames.length >= 2)
    let previous = clip.snapshot
    for (const frame of clip.frames) {
      assert.equal(frame.snapshot.game, 'reversi')
      if (frame.rejected) assert.deepEqual(frame.snapshot, previous)
      previous = frame.snapshot
    }
  }
  const pass = clips[4]!.frames[0]!.snapshot
  assert.equal(pass.game, 'reversi')
  assert.equal(pass.reversi.moves.at(-1)!.point, null)
  const draw = clips[7]!.frames.at(-1)!.snapshot
  assert.equal(draw.game, 'reversi')
  assert.equal(draw.reversi.draw, true)
})
