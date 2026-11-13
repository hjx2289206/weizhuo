import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket, WebSocketServer } from 'ws'
import { once } from 'node:events'
import { TUTORIAL_VERSION, type TeachingRequest } from '../shared/tutorialProtocol'
import { TeachingSession, teachingCourse, teachingClips } from '../server/tutorials/session'
import { execute, snapshot } from '../server/tutorials/model'
import { connectTutorialSocket } from '../server/tutorials/socket'
import { junqiMovePath } from '../shared/junqiMovePath'
import { JunqiGame } from '../server/games/junqi'
import { fullBoard } from '../server/tutorials/junqi'
import { junqiRouteGeometry, junqiFocusBox, junqiPointPosition } from '../shared/junqiGeometry'
import { JUNQI_FOUR_EDGES } from '../shared/junqi'
import { clipPosition, clipDuration, INTRO_DURATION } from '../src/tutorials/motion'

for (const game of ['doudizhu', 'guandan', 'junqi'] as const) {
  test(`${game}: every full scripted match replays legally with real cards, legal routes and a genuine ending`, () => {
    const course = teachingCourse(game)
    const ids = new Set<string>()
    for (const match of course.matches) {
      const engine = match.create()
      for (const step of match.steps) {
        if (step.lesson) { assert.ok(!ids.has(step.lesson.id)); ids.add(step.lesson.id); assert.equal(step.action.seat, match.player) }
        if (step.action.type === 'junqiMove') {
          const before = fullBoard(engine as JunqiGame), variant = (engine as JunqiGame).view(0).junqi.variant
          const path = junqiMovePath(before, Number(step.action.payload.from), Number(step.action.payload.to), variant)
          assert.ok(path.length >= 2, `${match.id}: no legal animation path`)
          for (const point of path.slice(1, -1)) assert.equal(before[point], null, `${match.id}: animation crossed a piece`)
        }
        execute(engine, step.action)
        const view = engine.view(match.player)
        if (game !== 'junqi' && view.phase !== 'lobby') {
          const all = Array.from({ length: engine.seatCount }, (_, seat) => [...engine.handOf(seat)]).flat().concat(view.tablePlays.flatMap(play => play.cards))
          assert.equal(all.length, game === 'guandan' ? 108 : view.phase === 'bidding' ? 51 : 54, match.id)
          assert.equal(new Set(all.map(card => card.id)).size, all.length, `${match.id}: a physical card exists twice`)
        }
      }
      assert.equal(engine.phase, 'finished', match.id)
      if (game === 'doudizhu') {
        const view = engine.view(0)
        if (view.game === 'doudizhu') {
          const tags = new Set(match.steps.flatMap(step => step.lesson?.tags ?? []))
          if (tags.has('spring')) { assert.equal(view.winner, 'landlord'); assert.ok(view.tablePlays.every(play => play.seatId === view.landlord)) }
          if (tags.has('reverse-spring')) { assert.equal(view.winner, 'farmers'); assert.equal(view.tablePlays.filter(play => play.seatId === view.landlord).length, 1) }
        }
      }
      if (game === 'guandan') { const view = engine.view(0); assert.equal(view.game, 'guandan'); if (view.game === 'guandan') assert.notEqual(view.guandan.matchWinner, null) }
      const replay = match.create(); for (const step of match.steps) execute(replay, step.action)
      assert.deepEqual(snapshot(replay, match.player, 'test'), snapshot(engine, match.player, 'test'))
    }
  })
}

test('mechanism coverage includes actual special endings and exchange branches', () => {
  const required = {
    doudizhu: ['all-pass-redeal', 'bid-three', 'single', 'pair', 'triple', 'triple-single', 'triple-pair', 'straight', 'pairs-run', 'triples-run', 'airplane-single', 'airplane-pair', 'four-two-single', 'four-two-pair', 'bomb', 'rocket', 'pass', 'spring', 'reverse-spring', 'scoring'],
    guandan: ['teams', 'level-beats-ace', 'wild', 'wild-no-joker', 'triple-pair', 'straight', 'three-pairs', 'two-triples', 'bomb-four', 'bomb-five', 'bomb-six-plus', 'straight-flush', 'four-jokers', 'multiple-claims', 'wild-suit', 'wind', 'single-tribute', 'double-tribute', 'equal-tribute', 'simultaneous-tribute', 'return-fallback', 'free-low-return', 'single-resist', 'double-resist', 'upgrade-1', 'upgrade-2', 'upgrade-3', 'fail-ace', 'pass-ace'],
    junqi: ['dark-view', 'rail', 'camp-protection', 'immobile', 'engineer-turn', 'rank-combat', 'smaller-loses', 'equal-ranks', 'engineer-mine', 'ordinary-mine', 'bomb-mine', 'commander-reveal', 'flag-capture', 'four-dark', 'printed-curve', 'army-elimination', 'ally-continues', 'team-elimination', 'resign', 'draw-70', 'no-legal-move'],
  }
  for (const game of ['doudizhu', 'guandan', 'junqi'] as const) {
    const tags = new Set(teachingClips(game).flatMap(clip => clip.tags))
    for (const tag of required[game]) assert.ok(tags.has(tag), `${game}: missing ${tag}`)
  }
  const noMoves = teachingCourse('junqi').matches.find(match => match.id === 'jq-no-moves')!
  const engine = noMoves.create(); for (const step of noMoves.steps) execute(engine, step.action)
  assert.equal((engine as JunqiGame).view(0).junqi.reason, '对方无棋可走')
})

for (const game of ['doudizhu', 'guandan', 'junqi'] as const) {
  test(`${game}: all clips play from start to real result without a practice command`, () => {
    const session = new TeachingSession(game), catalog = session.start().clips
    let version = 0
    assert.equal(new Set(catalog.map(clip => clip.id)).size, catalog.length)
    for (const item of catalog) {
      const state = session.request({ id: `select-${item.id}`, type: 'scene', clipId: item.id, version: version++ })
      const clip = state.clip, untouched = JSON.stringify(clip)
      assert.equal(clip.id, item.id); assert.ok(clip.frames.length >= 2)
      let before = clip.snapshot
      for (const frame of clip.frames) {
        assert.ok(frame.caption); assert.ok(frame.duration > 0)
        if (frame.rejected) assert.deepEqual(frame.snapshot, before, `${item.id}: rejected command changed state`)
        if (frame.action?.type === 'junqiMove' && !frame.rejected) {
          assert.ok(frame.path && frame.path.length >= 2)
          if (before.game === 'junqi') for (const point of frame.path!.slice(1, -1)) assert.equal(before.junqi.board[point], null)
        }
        if (frame.snapshot.game !== 'junqi' && frame.snapshot.phase !== 'lobby') {
          const state = frame.snapshot, all = state.tablePlays.flatMap(play => play.cards)
          assert.equal(all.length + state.seats.reduce((count, seat) => count + seat.count, 0) + (state.phase === 'bidding' ? 3 : 0), game === 'guandan' ? 108 : 54)
        }
        before = frame.snapshot
      }
      const duration = clipDuration(clip), end = clipPosition(clip, duration)
      assert.ok(end.ended); assert.deepEqual(end.snapshot, clip.frames.at(-1)!.snapshot)
      assert.deepEqual(clipPosition(clip, 0).snapshot, clip.snapshot)
      assert.equal(JSON.stringify(clip), untouched, 'local playback mutated the clip')
      assert.deepEqual(new TeachingSession(game, item.id).start().clip, clip, 'resume changed deterministic clip')
    }
    assert.equal(session.state().version, catalog.length)
  })
}

test('result clips contain a genuine transition into an engine-computed ending', () => {
  for (const game of ['doudizhu', 'guandan', 'junqi'] as const) {
    for (const clip of teachingClips(game).filter(clip => clip.id.endsWith('result') || clip.tags.includes('scoring'))) {
      assert.notEqual(clip.snapshot.phase, 'finished', `${clip.id}: starts with a static result`)
      assert.equal(clip.frames.at(-1)!.snapshot.phase, 'finished', clip.id)
      assert.ok(clip.frames.some(frame => frame.action), clip.id)
    }
  }
})

test('stale, duplicate, unknown and old practice commands cannot change the selected clip', () => {
  const session = new TeachingSession('junqi'), state = session.start(), before = JSON.stringify(session.state())
  for (const type of ['act', 'practice', 'demo', 'retry', 'next', 'create', 'junqiMove']) assert.throws(() => session.request({ id: type, type: type as never, version: 0 }))
  assert.throws(() => session.request({ id: 'bad', type: 'scene', version: 0, clipId: 'missing' }))
  assert.equal(JSON.stringify(session.state()), before)
  const request = { id: 'once', type: 'scene' as const, clipId: state.clips[1]!.id, version: 0 }
  session.request(request)
  assert.throws(() => session.request(request))
  assert.throws(() => session.request({ ...request, id: 'old' }))
  assert.equal(session.state().index, 1)
})

test('camera bounds contain the full actual route and reverse curves use the same geometry for all four perspectives', () => {
  for (const side of [0, 1, 2, 3]) for (const edge of JUNQI_FOUR_EDGES.filter(edge => edge.curve)) {
    const forward = junqiRouteGeometry([edge.a, edge.b], 'four', side), back = junqiRouteGeometry([edge.b, edge.a], 'four', side)
    for (const t of [0, .1, .5, .8, 1]) {
      assert.ok(Math.hypot(forward.at(t).x - back.at(1 - t).x, forward.at(t).y - back.at(1 - t).y) < .001)
    }
    const [x, y, w, h] = junqiFocusBox([edge.a, edge.b], 'four', side)
    for (const point of forward.points) assert.ok(point.x > x && point.x < x + w && point.y > y && point.y < y + h)
    assert.deepEqual(forward.at(0), junqiPointPosition(edge.a, 'four', side))
  }
})

test('one logical time controls the board, result, caption and replay checkpoints', () => {
  const clip = teachingClips('junqi').find(clip => clip.id === 'jq-equal-ranks')!
  const a = clipPosition(clip, INTRO_DURATION + clip.frames[0]!.duration * .5)
  assert.equal(a.frame?.combat?.outcome, 'both'); assert.equal(a.snapshot.phase, 'playing')
  assert.deepEqual(clipPosition(clip, INTRO_DURATION + clip.frames[0]!.duration * .5), a, 'same paused time changed the board')
  assert.deepEqual(clipPosition(clip, 0).snapshot, clip.snapshot)
  const last = clipPosition(clip, clipDuration(clip))
  if (last.snapshot.game === 'junqi') { assert.equal(last.snapshot.junqi.board[30], null); assert.equal(last.snapshot.junqi.board[25], null) }
})

test('watch-only websocket resumes clips, resets old progress and rejects formal and practice commands', async () => {
  const server = new WebSocketServer({ port: 0, maxPayload: 16384 }); server.on('connection', connectTutorialSocket)
  await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); await once(socket, 'open')
  const request = async (message: Partial<TeachingRequest>) => { const reply = once(socket, 'message'); socket.send(JSON.stringify(message)); return JSON.parse(String((await reply)[0])) }
  try {
    let state = await request({ id: 'start', type: 'start', game: 'junqi', courseVersion: TUTORIAL_VERSION, clipId: 'jq-engineer-junction' })
    assert.equal(state.type, 'tutorial-state'); assert.equal(state.clip.id, 'jq-engineer-junction'); assert.equal(state.id, 'start')
    for (const type of ['create', 'act', 'practice', 'junqiMove']) assert.equal((await request({ id: type, type: type as never, version: state.version })).type, 'tutorial-error')
    state = await request({ id: 'old-course', type: 'start', game: 'junqi', courseVersion: 'animated-v1', clipId: 'jq-engineer-junction' })
    assert.equal(state.index, 0)
  } finally { socket.close(); await once(socket, 'close'); await new Promise<void>(resolve => server.close(() => resolve())) }
})
