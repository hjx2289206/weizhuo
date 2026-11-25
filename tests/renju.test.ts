import assert from 'node:assert/strict'
import test from 'node:test'
import { boardAiContext } from '../server/bots/boardAiAdapters'
import { chooseGomokuMove } from '../server/bots/gomokuAi'
import { StoneGame } from '../server/games/stones'
import { Room, type Peer } from '../server/room'
import { teachingClips } from '../server/tutorials/session'
import { BOARD_AI_DIFFICULTIES } from '../shared/boardAi'
import type { ServerMessage } from '../shared/protocol'
import { createRenjuAnalyzer, gomokuLine, renjuForbidden, renjuForbiddenText, type RenjuForbidden, type StoneBoard } from '../shared/stones'
import { readResults, resultFromSnapshot } from '../src/resultHistory'

const size = 15
type Offset = readonly [x: number, y: number]
const at = (x: number, y: number) => y * size + x
const center: Offset = [7, 7]
const point = at(...center)
const row = (...values: number[]): Offset[] => values.map(x => [x, 0])
const col = (...values: number[]): Offset[] => values.map(y => [0, y])
const diagonal = (...values: number[]): Offset[] => values.map(n => [n, n])
const crossThree = [...row(-1, 1), ...col(-1, 1)]
const brokenCross = [...row(-2, 1), ...col(-1, 1)]
const crossFour = [...row(-2, -1, 1), ...col(-2, -1, 1)]
const sameLineFour = row(-3, -1, 1, 3)
const overline = row(-3, -2, -1, 1, 2)
const five = row(-2, -1, 1, 2)
const fakeRecursive: Offset[] = [...brokenCross, [-1, -1], [-1, 1], [-2, -1]]

function diagram(black: readonly Offset[], white: readonly Offset[] = [], anchor = center): StoneBoard {
  const board: StoneBoard = Array(size ** 2).fill(null)
  for (const [side, stones] of [black, white].entries()) {
    for (const [dx, dy] of stones) board[at(anchor[0] + dx, anchor[1] + dy)] = side === 0 ? 0 : 1
  }
  return board
}

const fixtures: { name: string; black: Offset[]; white?: Offset[]; anchor?: Offset; reason: RenjuForbidden | null; wins?: boolean }[] = [
  { name: 'one straight open three', black: row(-1, 1), reason: null },
  { name: 'standard crossing double-three', black: crossThree, reason: 'double-three' },
  { name: 'two broken threes', black: [...row(-2, 1), ...col(-2, 1)], reason: 'double-three' },
  { name: 'two diagonal threes', black: [...diagonal(-1, 1), [-1, 1], [1, -1]], reason: 'double-three' },
  { name: 'board edge blocks a would-be open three', black: crossThree, anchor: [1, 7], reason: null },
  { name: 'white stones block the live-four extensions', black: crossThree, white: row(-2, 2), reason: null },
  { name: 'a straight four with two ends is one four', black: row(-2, -1, 1), reason: null },
  { name: 'a four and a three are allowed together', black: [...row(-2, -1, 1), ...col(-1, 1)], reason: null },
  { name: 'double-four in different directions', black: crossFour, reason: 'double-four' },
  { name: 'two different fours on one line', black: sameLineFour, reason: 'double-four' },
  { name: 'one of the same-line fours leads only to an overline', black: [...sameLineFour, [-4, 0]], reason: null },
  { name: 'black six-in-a-row', black: overline, reason: 'overline' },
  { name: 'black seven-in-a-row', black: [...overline, [3, 0]], reason: 'overline' },
  { name: 'a supposed three extends only into an overline', black: [...brokenCross, [-1,-3], [-1,-2], [-1,-1], [-1,1], [-1,2]], reason: null },
  { name: 'a supposed three extends only into a double-four', black: [...brokenCross, [-1,-3], [-1,-2], [-1,-1]], reason: null },
  { name: 'a supposed three extends only into a forbidden double-three', black: fakeRecursive, reason: null },
  { name: 'blocking the nested three makes the original double-three real', black: fakeRecursive, white: [[-1, 2]], reason: 'double-three' },
  { name: 'exact five takes precedence over double-three', black: [...five, ...col(-1, 1), ...diagonal(-1, 1)], reason: null, wins: true },
  { name: 'exact five takes precedence over double-four', black: [...five, ...col(-2, -1, 1), ...diagonal(-2, -1, 1)], reason: null, wins: true },
  { name: 'exact five on another axis takes precedence over long line', black: [...overline, ...col(-2, -1, 1, 2)], reason: null, wins: true },
  { name: 'a win on the extension itself does not constitute an open three', black: [...brokenCross, [-1,-3], [-1,-2], [-1,-1], [-1,1]], reason: null },
]

for (const fixture of fixtures) {
  test('Renju — ' + fixture.name, () => {
    const board = diagram(fixture.black, fixture.white, fixture.anchor)
    const target = at(...(fixture.anchor ?? center))
    const before = [...board]
    assert.equal(renjuForbidden(board, target, size), fixture.reason)
    assert.deepEqual(board, before)
    const game = new StoneGame('gomoku', { rule: 'renju', board })
    game.start()
    const view = game.view()
    const result = game.command(0, 'stoneMove', { point: target })
    if (fixture.reason) {
      assert.deepEqual(result, { ok: false, message: renjuForbiddenText(fixture.reason) })
      assert.deepEqual(game.view(), view, 'the same side can choose another legal point')
    } else {
      assert.deepEqual(result, { ok: true })
      assert.equal(game.view().stones.winner, fixture.wins ? 0 : null)
      assert.equal(game.view().stones.winningLine.length, fixture.wins ? 5 : 0)
    }
  })
}

test('The recursive three classification checks the extension on the board with the first black stone present', () => {
  const board = diagram(fakeRecursive)
  const analyzer = createRenjuAnalyzer(size, p => board[p])
  assert.deepEqual(analyzer.analyze(point).openThrees, [false, true, false, false])
  board[point] = 0
  assert.equal(analyzer.forbidden(point - 1), 'double-three')
  board[point + 2 * size - 1] = 1
  assert.equal(analyzer.forbidden(point - 1), null)
  assert.deepEqual(analyzer.analyze(point - 1).replies, [2, 0, 0, 0])
})

test('White may play a double-three and wins with an overline in Renju; freestyle black also wins with six', () => {
  for (const offsets of [crossThree, overline]) {
    const game = new StoneGame('gomoku', { board: diagram([], offsets), turn: 1, rule: 'renju' })
    game.start()
    assert.ok(game.command(1, 'stoneMove', { point }).ok)
    assert.equal(game.view().stones.winner, offsets === overline ? 1 : null)
    assert.equal(game.view().stones.winningLine.length, offsets === overline ? 6 : 0)
  }
  const freestyle = new StoneGame('gomoku', { board: diagram(overline) })
  freestyle.start()
  assert.equal(freestyle.view().stones.rule, 'freestyle')
  assert.ok(freestyle.command(0, 'stoneMove', { point }).ok)
  assert.equal(freestyle.view().stones.winningLine.length, 6)
})

test('All five Renju Gomoku AI levels playing black avoid double-threes, double-fours and overlines', () => {
  for (const [pattern, reason] of [[crossThree,'double-three'], [crossFour,'double-four'], [sameLineFour,'double-four'], [overline,'overline']] as const) {
    const board = diagram(pattern)
    assert.equal(renjuForbidden(board, point, size), reason)
    for (const { id } of BOARD_AI_DIFFICULTIES) {
      let tick = 0
      const chosen = chooseGomokuMove({ board, size, toMove: 0, history: [], rule: 'renju' }, id, { now: () => tick += 0.5, random: () => 0.4 })
      assert.notEqual(chosen, null, id)
      assert.equal(board[chosen!], null, id)
      assert.equal(renjuForbidden(board, chosen!, size), null, id + ' picked forbidden point ' + chosen)
    }
  }
})

test('White AI attacks rather than blocks a black four with only an overline completion', () => {
  const gap = at(5, 7)
  const board: StoneBoard = Array(225).fill(null)
  for (const x of [2, 3, 4, 6, 7]) board[at(x, 7)] = 0
  board[at(1, 7)] = 1
  for (const x of [7, 8, 9]) board[at(x, 2)] = 1
  assert.equal(renjuForbidden(board, gap, size), 'overline')
  const ownStraightFour = [at(6, 2), at(10, 2)]
  for (const id of ['normal', 'hard', 'challenge'] as const) {
    let tick = 0
    const input = { board, size, toMove: 1 as const, history: [] }
    const options = { now: () => tick += 0.5, random: () => 0.4 }
    assert.equal(chooseGomokuMove(input, id, options), gap, 'freestyle still blocks the long line')
    tick = 0
    assert.ok(ownStraightFour.includes(chooseGomokuMove({ ...input, rule: 'renju' }, id, options)!), id)
  }
})

test('A true exact-five threat remains a compulsory defense in Renju', () => {
  const board = diagram(row(-2, -1, 1, 2), row(-3))
  let tick = 0
  const chosen = chooseGomokuMove({ board, size, toMove: 1, history: [], rule: 'renju' }, 'normal', { now: () => tick += .5 })
  assert.equal(chosen, point)
  const completed = [...board]
  completed[point] = 0
  assert.equal(gomokuLine(completed, point, size, 'renju').length, 5)
})

function client(id: string) {
  const sent: ServerMessage[] = []
  const peer: Peer = { id, role: 'table', seatId: null, token: null, room: null, requestRoom: null, send: message => sent.push(message), supersede() {} }
  function state() {
    const message = [...sent].reverse().find(message => message.type === 'state')
    assert.ok(message?.type === 'state' && message.state.game === 'gomoku')
    return message.state
  }
  return { peer, sent, state }
}

test('Only the Gomoku host changes the lobby rule; both seats re-ready and spectators/history see the rule across rounds', () => {
  const room = new Room('RULE', 'phone', 'gomoku')
  const black = client('black'), white = client('white'), watcher = client('watcher')
  try {
    room.bindCreator(black.peer, 'create', '黑')
    room.bindJoin(white.peer, 1, '白', 'join')
    room.bindSpectator(watcher.peer, 'spectate')
    assert.equal(watcher.state().stones.rule, 'freestyle')
    room.command(black.peer, 'ready', { ready: true }, 'ready-black')
    room.command(white.peer, 'ready', { ready: true }, 'ready-white')
    room.command(white.peer, 'stoneSetup', { rule: 'renju' }, 'guest-try')
    const guestReply = white.sent.at(-1)
    assert.ok(guestReply?.type === 'error')
    assert.match(guestReply.message, /房主/)
    room.command(black.peer, 'stoneSetup', { rule: 'unknown' }, 'bad-rule')
    assert.deepEqual(black.state().seats.map(p => p.ready), [true, true])
    room.command(black.peer, 'stoneSetup', { rule: 'renju' }, 'change-rule')
    assert.deepEqual(black.state().seats.map(p => p.ready), [false, false])
    assert.equal(white.state().stones.rule, 'renju')
    assert.equal(watcher.state().stones.rule, 'renju')
    room.command(black.peer, 'start', {}, 'too-early')
    assert.equal(black.state().phase, 'lobby')
    room.command(black.peer, 'ready', { ready: true }, 'ready-black-again')
    room.command(white.peer, 'ready', { ready: true }, 'ready-white-again')
    room.command(black.peer, 'start', {}, 'start')
    assert.equal(black.state().phase, 'playing')
    const ai = boardAiContext(room.engine.view(null))!.position()
    assert.ok(ai.kind === 'gomoku')
    assert.equal(ai.rule, 'renju')
    room.command(black.peer, 'stoneSetup', { rule: 'freestyle' }, 'too-late')
    assert.equal(black.state().stones.rule, 'renju')
    room.command(black.peer, 'stoneMove', { point }, 'placement')
    room.command(white.peer, 'stoneResign', {}, 'resign')
    const finished = watcher.state()
    assert.equal(finished.phase, 'finished')
    const result = resultFromSnapshot(finished)!
    assert.equal(result.gomokuRule, 'renju')
    assert.match(result.detail, /黑方禁手/)
    assert.equal(result.plays.length, 1)
    assert.deepEqual(readResults({ getItem: () => JSON.stringify([result]) }), [result])
    room.command(black.peer, 'again', {}, 'again')
    assert.equal(watcher.state().phase, 'lobby')
    assert.equal(watcher.state().stones.rule, 'renju')
    assert.deepEqual(watcher.state().stones.moves, [])
  } finally { room.dispose() }
})

test('Changing Gomoku rules after configuring a phone AI resets human readiness and preserves computer readiness', () => {
  const room = new Room('AIGK', 'phone', 'gomoku')
  const host = client('host')
  try {
    room.bindCreator(host.peer, 'create')
    room.command(host.peer, 'boardAi', { enabled: true, side: 1, difficulty: 'beginner' }, 'ai-setup')
    room.command(host.peer, 'ready', { ready: true }, 'ready-before')
    room.command(host.peer, 'stoneSetup', { rule: 'renju' }, 'renju')
    assert.deepEqual(host.state().seats.map(entry => entry.ready), [false, true])
    room.command(host.peer, 'ready', { ready: true }, 'ready-after')
    room.command(host.peer, 'start', {}, 'start')
    assert.equal(host.state().phase, 'playing')
    assert.equal(host.state().stones.rule, 'renju')
  } finally { room.dispose() }
})

test('All three Renju tutorial segments use the Renju engine and show the corresponding rejection', () => {
  for (const [id, reason] of [['three','三三'], ['four','四四'], ['overline','长连']]) {
    const clip = teachingClips('gomoku').find(lesson => lesson.id === 'gomoku-renju-' + id)
    assert.ok(clip?.snapshot.game === 'gomoku')
    assert.equal(clip.snapshot.stones.rule, 'renju')
    assert.ok(clip.frames.some(frame => frame.rejected === '禁手：' + reason))
  }
})
