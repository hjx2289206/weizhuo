import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { Room, type Peer } from '../server/room'
import type { DoudizhuSnapshot, ServerMessage } from '../shared/protocol'
import type { GameController } from '../src/useGame'
import { useDoudizhuView } from '../src/screens/useDoudizhuView'
import { resultFromSnapshot, appendResult, readResults, RESULT_HISTORY_KEY } from '../src/resultHistory'

function fixture(): DoudizhuSnapshot {
  const room = new Room('TEST', 'phone', 'doudizhu')
  const peer: Peer = { id: 'host', role: 'table', seatId: null, token: null, room: null, requestRoom: null, send(_m: ServerMessage) {}, supersede() {} }
  room.bindCreator(peer, 'create', '小明')
  const snapshot = room.snapshotFor(peer) as DoudizhuSnapshot
  room.dispose()
  return { ...snapshot, phase: 'playing', turn: 0, selfSeat: 0, landlord: 0, dealAnimation: undefined,
    hand: [{ id: 'a', rank: 3, suit: 'spade' }, { id: 'b', rank: 3, suit: 'heart' }, { id: 'c', rank: 4, suit: 'spade' }],
    seats: snapshot.seats.map(s => ({ ...s, connected: true, name: `玩家${s.id + 1}` })) }
}
test('Doudizhu selection feedback rejects a mixed pair and a lower pair while preserving a legal lead', async () => {
  const state = ref(fixture()); const selected = ref<string[]>([]); let submitted = 0
  const game = { state, selected, busy: ref(false), error: ref(''), playSelected: async () => { submitted++ } } as unknown as GameController
  const scope = effectScope(); const view = scope.run(() => useDoudizhuView(game))!
  selected.value = ['a', 'c']
  assert.equal(view.canPlay.value, false); assert.match(view.selectionStatus.value, /不构成/)
  await view.playFromGesture(); assert.equal(submitted, 0)
  selected.value = ['a', 'b']
  assert.equal(view.canPlay.value, true); assert.match(view.selectionStatus.value, /对子/)
  state.value = { ...state.value, lastPlay: { seatId: 1, kind: 'pair', cards: [{ id: 'd', rank: 5, suit: 'heart' }, { id: 'e', rank: 5, suit: 'club' }] } }
  assert.equal(view.canPlay.value, false); assert.match(view.selectionStatus.value, /管不上/)
  scope.stop()
})
test('result archive records correct public deltas and excludes private hands, credentials and duplicate deals', () => {
  const snapshot = fixture()
  snapshot.phase = 'finished'; snapshot.bid = 2; snapshot.multiplier = 4; snapshot.winner = 'landlord'
  snapshot.scores = [16, -8, -8]
  snapshot.tablePlays = [{ id: '1', seatId: 0, cards: [snapshot.hand[0]!], kind: 'single', scatter: { x: 0, y: 0, angle: 0 } }]
  const record = resultFromSnapshot(snapshot, '2026-10-20T00:00:00Z')!
  assert.equal(record.players[0]!.delta, 16)
  assert.match(record.detail, /春天/)
  const serialized = JSON.stringify(record)
  assert.equal(serialized.includes('"hand"'), false)
  assert.equal(serialized.includes('token'), false)
  assert.equal(serialized.includes('"id":"b"'), false)
  assert.equal(appendResult([record], record).length, 1)
  assert.deepEqual(readResults({ getItem: key => key === RESULT_HISTORY_KEY ? JSON.stringify([record]) : null }), [record])
  assert.equal(readResults({ getItem: () => 'garbage' }).length, 0)
})
