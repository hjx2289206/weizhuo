import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref } from 'vue';
import { attachGameSounds, receivesGameAudio, type SfxName } from '../src/sound';
import { Room, type Peer } from '../server/room';
import type { Snapshot } from '../shared/protocol';

function initial(game: 'guandan' | 'doudizhu', role: 'table' | 'player', roomMode: 'tablet' | 'phone'): Snapshot {
  const room = new Room('SFXA', 'tablet', game);
  const peer: Peer = { id: 'table', role: 'table', seatId: null, token: null, room: null, requestRoom: null,
    send() {}, supersede() {} };
  room.bindCreator(peer, 'create');
  const snapshot = room.snapshotFor(peer);
  room.dispose();
  return { ...snapshot, roomMode, role, selfSeat: role === 'player' ? 0 : null,
    phase: 'playing', turn: 0,
    seats: [0, 1, 2, ...(game === 'guandan' ? [3] : [])].map(id => ({ id, x: .5, y: .5, angle: 0,
      name: `玩家${id}`, connected: true, ready: true, count: 17, passed: false, isBot: false, autoPlay: false })) };
}

for (const kind of ['guandan', 'doudizhu'] as const) {
  test(`${kind}: tablet rooms play all game effects on the table and keep players silent`, async () => {
    for (const role of ['table', 'player'] as const) {
      const scope = effectScope();
      const state = ref<Snapshot | null>(null);
      const calls: SfxName[] = [];
      scope.run(() => attachGameSounds(state, name => calls.push(name)));
      try {
        state.value = initial(kind, role, 'tablet'); await nextTick();
        assert.equal(calls.length, 0, 'joining mid-game only primes the event markers');
        const emit = async (patch: Partial<Snapshot>) => { state.value = { ...state.value!, ...patch } as Snapshot; await nextTick(); };
        await emit({ tablePlays: [{ id: 'play-1', seatId: 0, kind: 'single', cards: [{id:'c',rank:3,suit:'heart'}],scatter:{x:0,y:0,angle:0} }], turn: 1 });
        await emit({ seats: state.value!.seats.map(seat => ({...seat, passed: seat.id === 1})), turn: 2 });
        if (kind === 'guandan' && state.value!.game === 'guandan') {
          await emit({ phase: 'tribute', guandan: {...state.value!.guandan, exchange: {stage:'tribute',givers:[1],submitted:[],pairs:[],leader:null}} });
        }
        await emit({ phase: 'finished' });
        if (role === 'table') {
          assert.ok(calls.includes('play')); assert.ok(calls.includes('pass'));
          assert.equal(calls.filter(name => name === 'turn').length, 2);
          assert.ok(calls.includes('win'));
          if (kind === 'guandan') assert.ok(calls.includes('tribute'));
        } else assert.equal(calls.length, 0);
        const count = calls.length;
        state.value = {...state.value!}; await nextTick();
        assert.equal(calls.length, count, 'duplicate snapshots do not replay audio');
      } finally { scope.stop(); }
    }
  });
}

test('phone-only rooms retain personal turn effects; tablet phones also mute card selection', async () => {
  assert.equal(receivesGameAudio({role:'player',roomMode:'tablet'}), false);
  assert.equal(receivesGameAudio({role:'table',roomMode:'tablet'}), true);
  assert.equal(receivesGameAudio({role:'player',roomMode:'phone'}), true);
  assert.equal(receivesGameAudio(null), false);
  const scope = effectScope(), state = ref<Snapshot | null>(null), calls: SfxName[] = [];
  scope.run(() => attachGameSounds(state, name => calls.push(name)));
  try {
    state.value = {...initial('doudizhu','player','phone'), turn: 1}; await nextTick();
    state.value = {...state.value!, turn: 2}; await nextTick();
    assert.equal(calls.length, 0);
    state.value = {...state.value!, turn: 0}; await nextTick();
    assert.deepEqual(calls, ['turn']);
    state.value = null; await nextTick();
    state.value = initial('doudizhu','player','phone'); await nextTick();
    assert.deepEqual(calls, ['turn'], 're-entry remains silent');
  } finally { scope.stop(); }
});
