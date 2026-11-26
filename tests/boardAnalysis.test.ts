import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createBoardAnalysisPolicy, type BoardAnalysisPolicy } from '../server/bots/boardAnalysis'
import { withUciSession, type RunUciSession } from '../server/bots/uci'
import { ChessGame } from '../server/games/chess'
import { XiangqiGame } from '../server/games/xiangqi'
import { Room, type Peer } from '../server/room'
import {
  analysisCurveValue, analysisGrade, analysisLoss, analysisRecommendations, analysisScoreFor, type AnalysisPosition,
} from '../shared/boardAnalysis'
import type { GameKind, RoomMode, ServerMessage } from '../shared/protocol'
import type { XiangqiBoard } from '../shared/xiangqi'

function position(ply: number, evalCp: number, turn: 0 | 1 = ply % 2 === 0 ? 0 : 1): AnalysisPosition {
  return { ply, turn, evalCp, bestMove: null }
}

test('A selected move shows the recommendation from before it and names the side to move after it', () => {
  const e4 = { from: 52, to: 36 }, d4 = { from: 51, to: 35 }, e5 = { from: 12, to: 28 }
  const positions = new Map<number, AnalysisPosition>([
    [0, { ...position(0, 25, 0), bestMove: d4 }],
    [1, { ...position(1, -10, 1), bestMove: e5 }],
    [2, { ...position(2, 15, 0), bestMove: { from: 62, to: 45 } }],
  ])
  assert.deepEqual(analysisRecommendations('chess', positions, [e4, e5], 1), {
    played: { move: d4, matches: false },
    next: { move: e5, sideName: '黑方' },
  })
  assert.deepEqual(analysisRecommendations('chess', positions, [d4, e5], 1).played, { move: d4, matches: true })
  assert.equal(analysisRecommendations('chess', positions, [e4, e5], 2).next?.sideName, '白方')
  assert.equal(analysisRecommendations('xiangqi', positions, [e4, e5], 2).next?.sideName, '红方')
  const promotion = { from: 8, to: 0, promotion: 'q' } as const
  positions.set(0, { ...position(0, 25), bestMove: promotion })
  assert.equal(analysisRecommendations('chess', positions, [promotion], 1).played?.matches, true)
  assert.equal(analysisRecommendations('chess', positions, [{ ...promotion, promotion: 'n' }], 1).played?.matches, false)
})

test('Initial and final board selections show only the next recommendation when available', () => {
  const first = { from: 52, to: 36 }, next = { from: 12, to: 28 }
  const positions = new Map<number, AnalysisPosition>([
    [0, { ...position(0, 25, 0), bestMove: first }],
    [1, { ...position(1, -10, 1), bestMove: next }],
  ])
  assert.deepEqual(analysisRecommendations('chess', positions, [first], 0), {
    played: null, next: { move: first, sideName: '白方' },
  })
  assert.deepEqual(analysisRecommendations('chess', positions, [first], null), {
    played: null, next: { move: next, sideName: '黑方' },
  })
  positions.set(0, position(0, 25))
  assert.deepEqual(analysisRecommendations('chess', positions, [first], 1), {
    played: null, next: { move: next, sideName: '黑方' },
  })
  positions.delete(1)
  assert.deepEqual(analysisRecommendations('chess', positions, [first], null), { played: null, next: null })
})

test('Analysis converts engine scores to the requested side and clamps the curve and mover loss separately', () => {
  assert.equal(analysisScoreFor(position(1, 75), 0), -75)
  assert.equal(analysisScoreFor(position(1, 75), 1), 75)
  assert.equal(analysisScoreFor({ mate: 3, turn: 0 }, 0), 9_970)
  assert.equal(analysisScoreFor({ mate: -4, turn: 1 }, 0), 9_960)
  assert.equal(analysisScoreFor({ mate: 0, turn: 1 }, 1), -10_000)
  assert.equal(analysisCurveValue(position(1, 1_500)), -1_000)
  assert.equal(analysisLoss(position(0, 1_800), { ...position(1, 0), evalCp: undefined, mate: 3 }, 0), 3_000)
  assert.equal(analysisLoss(position(1, 1_900), position(2, -1_550), 1), 0)
  assert.equal(analysisLoss(position(1, 200), position(2, -120), 1), 80)
  assert.equal(analysisLoss(position(0, 20), position(1, -100), 0), 0)
  for (const [loss, grade] of [[69, null], [70, 'inaccuracy'], [149, 'inaccuracy'],
    [150, 'mistake'], [299, 'mistake'], [300, 'blunder']] as const) {
    assert.equal(analysisGrade(loss)?.id ?? null, grade)
  }
})

type TestPeer = Peer & { received: ServerMessage[] }
function peer(id: string): TestPeer {
  const received: ServerMessage[] = []
  return { id, role: 'table', seatId: null, token: null, room: null, requestRoom: null, received,
    send: message => { received.push(message) }, supersede() {} }
}

function gate() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { resolve, reject, promise }
}

function controlledPolicy() {
  const jobs: { signal: AbortSignal; publish: (point: AnalysisPosition) => void; done: ReturnType<typeof gate> }[] = []
  const policy: BoardAnalysisPolicy = {
    availability: () => ({ available: true, message: null }),
    analyze(_view, signal, publish) {
      const done = gate()
      jobs.push({ signal, publish, done })
      return done.promise
    },
  }
  return { jobs, policy }
}

let sequence = 0
function table(t: TestContext, policy: BoardAnalysisPolicy, game: GameKind = 'chess', mode: RoomMode = 'tablet',
  now?: () => number) {
  const serial = String(++sequence)
  let elapsed = 0
  const room = new Room(serial, mode, game, undefined, undefined, undefined, now ?? (() => elapsed), policy)
  t.after(() => room.dispose())
  const host = peer('host-' + serial), guest = peer('guest-' + serial)
  room.bindCreator(host, 'create', '先手')
  if (mode === 'phone') {
    room.bindJoin(guest, 1, '后手', 'join')
    room.command(host, 'ready', { ready: true }, 'ready-host')
    room.command(guest, 'ready', { ready: true }, 'ready-guest')
  }
  let commandSeq = 0
  const command = (type: string, payload: Record<string, unknown> = {}, as = host) => {
    const id = 'cmd-' + ++commandSeq
    room.command(as, type, payload, id)
    const reply = as.received.find(message => (message.type === 'ack' || message.type === 'error') && message.id === id)
    assert.ok(reply && (reply.type === 'ack' || reply.type === 'error'))
    return reply
  }
  const ok = (type: string, payload: Record<string, unknown> = {}, as = host) => {
    const reply = command(type, payload, as)
    assert.equal(reply.type, 'ack', reply.type === 'error' ? reply.message : undefined)
  }
  const refuse = (type: string, payload: Record<string, unknown>, reason: RegExp, as = host) => {
    const reply = command(type, payload, as)
    assert.equal(reply.type, 'error')
    if (reply.type === 'error') assert.match(reply.message, reason)
  }
  const state = (as = host) => {
    const analysis = room.snapshotFor(as).boardAnalysis
    assert.ok(analysis)
    return analysis
  }
  const finish = () => {
    ok('start')
    ok('chessMove', { from: 52, to: 36 })
    ok('chessResign', { side: 0 })
  }
  return { room, host, guest, command, ok, refuse, state, finish, advance: (ms: number) => { elapsed += ms } }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test('Only finished public board games allow analysis, and spectators cannot start or cancel it', async t => {
  const { jobs, policy } = controlledPolicy()
  const f = table(t, policy, 'chess', 'phone')
  f.refuse('boardAnalyze', { action: 'start' }, /结束后/)
  f.ok('start')
  f.refuse('boardAnalyze', { action: 'start' }, /结束后/)
  f.ok('chessResign')
  const spectator = peer('observer')
  f.room.bindSpectator(spectator, 'watch')
  f.refuse('boardAnalyze', { action: 'start' }, /旁观者/, spectator)
  f.ok('boardAnalyze', { action: 'start' }, f.guest)
  await flush()
  assert.equal(f.state(spectator).status, 'running')
  f.refuse('boardAnalyze', { action: 'cancel' }, /旁观者/, spectator)
  f.ok('boardAnalyze', { action: 'cancel' }, f.host)
  assert.equal(f.state(spectator).status, 'idle')
  assert.ok(jobs[0]?.signal.aborted)
  jobs[0]?.done.resolve()
  await flush()
  const junqi = table(t, policy, 'junqi', 'phone')
  junqi.refuse('boardAnalyze', { action: 'start' }, /不支持复盘分析/)
  assert.equal(junqi.room.snapshotFor(junqi.host).boardAnalysis, undefined)
})

test('The analysis slot stays busy until cancellation finishes and distinguishes room ownership', async t => {
  const { jobs, policy } = controlledPolicy()
  const first = table(t, policy), second = table(t, policy)
  first.finish()
  second.finish()
  first.ok('boardAnalyze', { action: 'start' })
  first.refuse('boardAnalyze', { action: 'start' }, /本局正在分析/)
  second.refuse('boardAnalyze', { action: 'start' }, /服务器正在分析其他对局，请稍后再试/)
  await flush()
  first.advance(500)
  jobs[0]!.publish(position(0, 1))
  assert.equal(first.state().completed, 1)
  first.ok('boardAnalyze', { action: 'cancel' })
  assert.equal(first.state().completed, 0)
  first.refuse('boardAnalyze', { action: 'start' }, /^上一次分析正在停止，请稍后再试$/)
  second.refuse('boardAnalyze', { action: 'start' }, /^服务器正在分析其他对局，请稍后再试$/)
  jobs[0]!.publish(position(1, 1))
  jobs[0]!.done.resolve()
  await flush()
  assert.equal(jobs.length, 1)
  assert.equal(first.state().status, 'idle')
  first.ok('boardAnalyze', { action: 'start' })
  await flush()
  assert.equal(jobs.length, 2)
  assert.equal(first.state().status, 'running')
  jobs[1]!.done.resolve()
  await flush()
})

test('Running progress is throttled to each 500 ms and final results are published immediately', async t => {
  const { jobs, policy } = controlledPolicy()
  const f = table(t, policy)
  f.ok('start')
  f.ok('chessMove', { from: 52, to: 36 })
  f.ok('chessMove', { from: 12, to: 28 })
  f.ok('chessMove', { from: 62, to: 45 })
  f.ok('chessResign', { side: 0 })
  const observer = peer('observer')
  f.room.bindSpectator(observer, 'watch')
  f.ok('boardAnalyze', { action: 'start' })
  await flush()
  assert.equal(f.state().total, 4)
  const count = () => observer.received.filter(message => message.type === 'state').length
  const initial = count()
  f.advance(499)
  jobs[0]!.publish(position(0, 1))
  assert.equal(count(), initial)
  assert.equal(f.state(observer).completed, 0)
  f.advance(1)
  jobs[0]!.publish(position(1, 2))
  assert.equal(count(), initial + 1)
  assert.equal(f.state(observer).completed, 2)
  f.advance(499)
  jobs[0]!.publish(position(2, 3))
  assert.equal(count(), initial + 1)
  assert.equal(f.state(observer).completed, 2)
  f.advance(1)
  jobs[0]!.publish(position(3, 4))
  assert.equal(count(), initial + 2)
  jobs[0]!.done.resolve()
  await flush()
  assert.equal(count(), initial + 3)
  assert.equal(f.state(observer).status, 'done')
  assert.equal(f.state(observer).completed, 4)
})

test('A rematch drops old results and ignores progress delivered under the old round id', async t => {
  const { jobs, policy } = controlledPolicy()
  const f = table(t, policy)
  f.finish()
  const old = f.state().roundId
  f.ok('boardAnalyze', { action: 'start' })
  await flush()
  f.advance(500)
  jobs[0]!.publish(position(0, 3))
  f.ok('again')
  assert.ok(jobs[0]!.signal.aborted)
  assert.notEqual(f.state().roundId, old)
  assert.equal(f.state().status, 'idle')
  jobs[0]!.publish(position(1, 5))
  jobs[0]!.done.resolve()
  await flush()
  assert.deepEqual(f.state().positions, [])
})

test('Analysis failure retains all partial results and permits retry', async t => {
  const { jobs, policy } = controlledPolicy()
  const f = table(t, policy)
  f.finish()
  f.ok('boardAnalyze', { action: 'start' })
  await flush()
  jobs[0]!.publish(position(0, 40))
  jobs[0]!.done.reject(new Error('引擎提前退出'))
  await flush()
  assert.equal(f.state().status, 'failed')
  assert.equal(f.state().error, '引擎提前退出')
  assert.deepEqual(f.state().positions, [position(0, 40)])
  f.ok('boardAnalyze', { action: 'start' })
  await flush()
  assert.equal(f.state().status, 'running')
  assert.equal(f.state().completed, 0)
  jobs[1]!.done.resolve()
  await flush()
})

function scriptedSearch(responses: string[]) {
  const searches: { position: string; go: string }[] = []
  let launches = 0
  const run: RunUciSession = async (request, work) => {
    launches++
    assert.ok(!Object.hasOwn(request.options, 'Skill Level'))
    if (request.options.UCI_Variant === 'xiangqi' || request.binary === 'stockfish') {
      assert.equal(request.options.UCI_LimitStrength, false)
    }
    return work(async search => {
      const move = responses[searches.length] ?? '0000'
      searches.push(search)
      return { move, score: { evalCp: 34 }, output: '', options: new Map() }
    })
  }
  return { run, searches, launches: () => launches }
}

test('Replay directly scores chess checkmate or board draws and Xiangqi immobilization', async () => {
  const scripted = scriptedSearch(['f2f3', 'e7e5', 'g2g4', 'd8h4'])
  const policy = createBoardAnalysisPolicy(() => ({ available: true, key: 'stockfish', binary: 'stockfish' }), scripted.run)
  const chess = new ChessGame()
  chess.start()
  for (const [from, to] of [[53, 45], [12, 28], [54, 38], [3, 39]]) {
    assert.ok(chess.command(chess.view().turn!, 'chessMove', { from, to }).ok)
  }
  const scored: AnalysisPosition[] = []
  const signal = new AbortController().signal
  await policy.analyze(chess.view(), signal, value => scored.push(value))
  assert.equal(scripted.launches(), 1)
  assert.equal(scripted.searches.length, 4)
  assert.equal(scored.length, 5)
  assert.deepEqual(scored.at(-1), { ply: 4, turn: 0, mate: 0, bestMove: null })
  const stalemate = new ChessGame('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')
  stalemate.start()
  await policy.analyze(stalemate.view(), signal, value => scored.push(value))
  assert.equal(stalemate.view().chess.draw, true)
  assert.deepEqual(scored.at(-1), position(0, 0, 1))

  const insufficient = new ChessGame('7k/8/8/8/8/8/8/K7 w - - 0 1')
  insufficient.start()
  await policy.analyze(insufficient.view(), signal, value => scored.push(value))
  assert.equal(insufficient.view().chess.draw, true)
  assert.deepEqual(scored.at(-1), position(0, 0))

  const xiangqi = new XiangqiGame(() => {
    const board: XiangqiBoard = Array(90).fill(null)
    board[4] = { id: 'black-general', side: 1, rank: 'general' }
    board[85] = { id: 'red-general', side: 0, rank: 'general' }
    board[40] = { id: 'black-soldier', side: 1, rank: 'soldier' }
    board[75] = { id: 'left-rook', side: 1, rank: 'rook' }
    board[77] = { id: 'right-rook', side: 1, rank: 'rook' }
    return board
  })
  xiangqi.start()
  assert.match(xiangqi.view().xiangqi.reason, /困毙/)
  await policy.analyze(xiangqi.view(), signal, value => scored.push(value))
  assert.deepEqual(scored.at(-1), { ply: 0, turn: 0, mate: 0, bestMove: null })
  assert.equal(scripted.launches(), 1)
})

test('Fairy transforms sent move history and returned coordinates, discarding illegal recommendations', async () => {
  const scripted = scriptedSearch(['b1c3', 'a7a6', 'a10a1'])
  const policy = createBoardAnalysisPolicy(() => ({ available: true, key: 'fairy', binary: 'fairy' }), scripted.run)
  const game = new XiangqiGame()
  game.start()
  assert.ok(game.command(0, 'xiangqiMove', { from: 82, to: 65 }).ok)
  assert.ok(game.command(1, 'xiangqiMove', { from: 27, to: 36 }).ok)
  assert.ok(game.command(0, 'xiangqiResign', {}).ok)
  const points: AnalysisPosition[] = []
  await policy.analyze(game.view(), new AbortController().signal, point => points.push(point))
  assert.equal(scripted.launches(), 1)
  assert.equal(scripted.searches.length, 3, 'a resignation does not make the last board unsearchable')
  assert.match(scripted.searches[2]!.position, /moves b1c3 a7a6$/)
  assert.ok(scripted.searches.every(search => search.go === 'go nodes 50000 movetime 150'))
  assert.deepEqual(points.map(point => point.bestMove), [{ from: 82, to: 65 }, { from: 27, to: 36 }, null])
})

async function fakeBinary(t: TestContext, script: string) {
  const dir = await mkdtemp(join(tmpdir(), 'board-analysis-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'fake-uci')
  await writeFile(file, '#!' + process.execPath + '\n' + script, { mode: 0o755 })
  return { file, dir }
}

test('A UCI session starts once and prefers an exact score at the latest reported depth', async t => {
  const { file, dir } = await fakeBinary(t, `
    const fs = require('node:fs');
    let search = 0;
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      fs.appendFileSync('commands', line + '\\n');
      if (line === 'uci') console.log('uciok');
      if (line === 'isready') console.log('readyok');
      if (line.startsWith('go ')) {
        if (search++ === 0) console.log('info depth 3 score cp 10\\ninfo depth 4 score cp 75\\ninfo depth 4 score cp 90 lowerbound');
        else console.log('info depth 4 score cp 80\\ninfo depth 5 score mate -2 upperbound');
        console.log('bestmove e2e4');
      }
    });
  `)
  const scores = await withUciSession({ binary: file, options: {}, requiredOptions: [] }, async search =>
    [await search({ position: 'position startpos', go: 'go nodes 50000 movetime 150' }),
      await search({ position: 'position startpos moves e2e4', go: 'go nodes 50000 movetime 150' })])
  assert.deepEqual(scores.map(result => result.score), [{ evalCp: 75 }, { mate: -2 }])
  const commands = await readFile(join(dir, 'commands'), 'utf8')
  assert.equal(commands.match(/^ucinewgame$/gm)?.length, 1)
  assert.equal(commands.match(/^position /gm)?.length, 2)
})

test('Disposing a room aborts and terminates its fake engine process', { timeout: 5_000 }, async t => {
  const { file, dir } = await fakeBinary(t, `
    require('node:fs').writeFileSync('pid', String(process.pid));
    let searched = false;
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      if (line === 'uci') console.log('option name Threads type spin\\noption name Hash type spin\\noption name UCI_LimitStrength type check\\nuciok');
      if (line === 'isready') console.log('readyok');
      if (line.startsWith('go ') && !searched) { searched = true; console.log('info depth 4 score cp 20\\nbestmove e2e4'); }
    });
  `)
  const closed = gate()
  const progress = gate()
  const real = createBoardAnalysisPolicy(() => ({ available: true, key: 'stockfish', binary: file }))
  const policy: BoardAnalysisPolicy = {
    ...real,
    async analyze(view, signal, publish) {
      try {
        await real.analyze(view, signal, point => { publish(point); progress.resolve() })
      } finally { closed.resolve() }
    },
  }
  const f = table(t, policy)
  f.finish()
  f.ok('boardAnalyze', { action: 'start' })
  await progress.promise
  const pid = Number(await readFile(join(dir, 'pid'), 'utf8'))
  f.room.dispose()
  await closed.promise
  await flush()
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(f.state().status, 'idle')
})
