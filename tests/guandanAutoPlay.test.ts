import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref } from 'vue';
import { Room, type Peer } from '../server/room';
import type { GuandanPolicy, GuandanTurnInput } from '../server/bots/guandan';
import type { ServerMessage, Snapshot } from '../shared/protocol';
import type { GameController } from '../src/useGame';
import { useGuandanView } from '../src/screens/useGuandanView';
import { useDoudizhuView } from '../src/screens/useDoudizhuView';
import { useGuandanActions } from '../src/useGuandanActions';
import { dealDuration } from '../shared/dealAnimation';

function peer(id: string): Peer & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return { id, role: 'table', seatId: null, token: null, room: null, requestRoom: null,
    sent, send: message => sent.push(message), supersede() {} };
}
function snapshot(room: Room, client: Peer): Snapshot { return room.snapshotFor(client); }
function controller(initial: Snapshot) {
  const calls: boolean[] = [];
  const state = ref(initial);
  const game = { state, busy: ref(false), selected: ref<string[]>([]), error: ref(''),
    setAutoPlay: async (enabled: boolean) => { calls.push(enabled); },
    playSelected: async () => { throw Error('manual command must stay disabled'); },
  } as unknown as GameController;
  return { game, state, calls };
}

// Scripted policy verifies room authority and model selection, not model quality.
test('Guandan hosting defaults to the easy agent, blocks manual play, and cancels during inference', async () => {
  const calls: GuandanTurnInput[] = [];
  let aborted = false;
  let inferenceAt = 0;
  const policy: GuandanPolicy = {
    availability: () => ({ available: true, message: null }),
    chooseTurn: (input, signal) => {
      calls.push(input);
      inferenceAt = Date.now();
      return new Promise((_, reject) => signal?.addEventListener('abort', () => {
        aborted = true; reject(new Error('cancelled'));
      }, { once: true }));
    },
  };
  const room = new Room('AUTO', 'phone', 'guandan', undefined, policy);
  const host = peer('host');
  try {
    room.bindCreator(host, 'create', '测试');
    const players = [host];
    for (let seat = 1; seat < 4; seat++) {
      const client = peer(`seat-${seat}`); room.bindJoin(client, seat, `玩家${seat}`, `join-${seat}`);
      room.command(client, 'ready', { ready: true }, `ready-${seat}`); players.push(client);
    }
    room.command(host, 'autoPlay', { enabled: true }, 'enable');
    assert.equal(room.players[0]!.ready, true);
    assert.equal(room.players[0]!.botAgent, 'danzero_v1t');
    assert.equal(room.players[0]!.botStrength, 'easy');
    room.command(host, 'autoPlay', { enabled: false }, 'disable-lobby');
    room.command(host, 'start', {}, 'start');
    const deal = room.snapshotFor(host).dealAnimation!;
    const earliestInferenceAt = Date.now() + dealDuration(deal.seatCount, deal.cardsPerSeat) - deal.elapsedMs;
    assert.equal(room.engine.phase, 'playing');
    // Force this synthetic fixture to the managed human's decision point.
    (room.engine as unknown as { turnSeat: number }).turnSeat = 0;
    room.command(host, 'autoPlay', { enabled: true }, 'enable-playing');
    const deadline = earliestInferenceAt + 2000;
    while (!calls.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls[0]?.selfSeat, 0);
    assert.ok(inferenceAt >= earliestInferenceAt - 20, 'AI waits for all 108 dealing flights to finish');
    assert.equal(calls[0]?.agent, 'danzero_v1t');
    const before = JSON.stringify(room.engine.view(null));
    room.command(host, 'play', { cards: [room.engine.handOf(0)[0]!.id] }, 'manual-play');
    assert.equal(JSON.stringify(room.engine.view(null)), before);
    assert.ok(host.sent.some(m => m.type === 'error' && m.message === '托管中，请先取消托管'));
    room.command(host, 'autoPlay', { enabled: false }, 'cancel');
    assert.equal(aborted, true);
    assert.equal(room.players[0]!.autoPlay, false);
    assert.equal(snapshot(room, host).automation.available, true);
  } finally { room.dispose(); }
});

test('shared hosting view exposes Guandan controls and keeps manual buttons and gestures off', async () => {
  const policy: GuandanPolicy = { availability: () => ({ available: true, message: null }), chooseTurn: async () => [] };
  const room = new Room('VIEW', 'phone', 'guandan', undefined, policy);
  const host = peer('view-host'); room.bindCreator(host, 'create', '测试');
  const source = snapshot(room, host);
  source.phase = 'playing'; source.turn = 0;
  source.hand = [{ id: 'single', rank: 3, suit: 'spade' }];
  source.seats.forEach(s => { s.name = '玩家'; s.connected = true; s.count = 2; });
  const { game, state, calls } = controller(source);
  const scope = effectScope();
  try {
    const { view, actions } = scope.run(() => ({ view: useGuandanView(game), actions: useGuandanActions(game) }))!;
    assert.equal(view.canToggleAutoPlay.value, true);
    assert.match(view.autoPlayTitle.value, /简单 AI/);
    game.selected.value = ['single']; await nextTick();
    assert.equal(actions.canPlay.value, true);
    view.toggleAutoPlay(); await nextTick(); assert.deepEqual(calls, [true]);
    state.value = { ...state.value, seats: state.value.seats.map(s => s.id === 0 ? { ...s, autoPlay: true } : s) };
    await nextTick();
    assert.equal(view.autoPlayEnabled.value, true);
    assert.equal(view.playEnabled.value, false);
    assert.equal(view.canPass.value, false);
    assert.equal(actions.canPlay.value, false);
    await actions.playFromGesture(); assert.equal(game.error.value, '托管中，请先取消托管');
    assert.equal(useDoudizhuView(game).canToggleAutoPlay.value, true); // dedicated hand uses the shared view
    view.toggleAutoPlay(); await nextTick(); assert.deepEqual(calls, [true, false]);
    state.value = { ...state.value, automation: { available: false, message: '运行时故障' } };
    assert.equal(view.autoPlayStatus.value, '运行时故障');
    assert.equal(view.canToggleAutoPlay.value, true); // cancellation remains reachable on failure
  } finally { scope.stop(); room.dispose(); }
});

test('Guandan selection automatically follows the strongest reading and recomputes against the live cursor', () => {
  const policy: GuandanPolicy = { availability: () => ({ available: true, message: null }), chooseTurn: async () => [] };
  const room = new Room('BEST', 'phone', 'guandan', undefined, policy);
  const host = peer('best-host'); room.bindCreator(host, 'create', '测试');
  const source = snapshot(room, host);
  if (source.game !== 'guandan') throw new Error('expected Guandan');
  source.phase = 'playing'; source.turn = 0;
  source.hand = [
    { id: 'q-spade', rank: 12, suit: 'spade' }, { id: 'q-club', rank: 12, suit: 'club' },
    { id: '2-club', rank: 15, suit: 'club' }, { id: '2-diamond', rank: 15, suit: 'diamond' },
    { id: 'wild', rank: 15, suit: 'heart' },
  ];
  source.seats.forEach(s => { s.name = '玩家'; s.connected = true; s.count = 6; });
  const { game, state } = controller(source);
  game.selected.value = source.hand.map(c => c.id);
  const scope = effectScope();
  try {
    const actions = scope.run(() => useGuandanActions(game))!;
    assert.equal(actions.chosenOption.value?.declaration.primaryRank, 15);
    assert.equal(actions.canPlay.value, true);
    const claim = actions.chosenOption.value!.declaration;
    state.value = { ...source, lastPlay: { seatId: 1, cards: source.hand, kind: '三带二', claim } };
    assert.equal(actions.canPlay.value, false, 'an equal level fullhouse cannot be beaten');
    assert.equal(actions.status.value, 'losing');
    state.value = source;
    assert.equal(actions.canPlay.value, true);
    game.selected.value = [...game.selected.value, 'stale-card'];
    assert.equal(actions.canPlay.value, false);
    assert.equal(actions.status.value, 'illegal');
  } finally { scope.stop(); room.dispose(); }
});

test('Guandan automatic turns keep a short gap instead of adding 600ms per seat', async () => {
  const times: number[] = [];
  const policy: GuandanPolicy = {
    availability: () => ({ available: true, message: null }),
    chooseTurn: async input => {
      times.push(Date.now());
      return input.cursor ? [] : [input.hand.find(c => c.suit !== 'heart')!.id];
    },
  };
  const room = new Room('FAST', 'phone', 'guandan', undefined, policy);
  const host = peer('fast-host');
  try {
    room.bindCreator(host, 'create', '测试');
    for (const seat of [1, 2, 3]) room.command(host, 'addBot', { seatId: seat, strength: 'easy' }, `bot-${seat}`);
    room.command(host, 'autoPlay', { enabled: true }, 'managed');
    room.command(host, 'start', {}, 'start');
    // Deal-wait behavior is covered above; advance only its presentation clock here.
    const internal = room as unknown as { dealPresentation: { startedAt: number }; invalidateAutomation(): void; refreshAutomation(): void };
    internal.dealPresentation.startedAt = Date.now() - 20_000;
    internal.invalidateAutomation(); internal.refreshAutomation();
    const deadline = Date.now() + 2000;
    while (times.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.ok(times.length >= 2, 'two managed seats should act');
    const gap = times[1]! - times[0]!;
    assert.ok(gap >= 200 && gap < 575, `expected a readable 250ms gap, got ${gap}ms`);
    assert.equal(room.snapshotFor(host).automation.available, true);
  } finally { room.dispose(); }
});

test('exchange notices explain resistance and preserve public exchange details across phases', () => {
  const room = new Room('NOTE', 'phone', 'guandan');
  const host = peer('notice-host'); room.bindCreator(host, 'create', '甲');
  const initial = room.snapshotFor(host);
  assert.equal(initial.game, 'guandan');
  if (initial.game !== 'guandan') throw Error('wrong game');
  initial.phase = 'playing';
  initial.seats.forEach((s, i) => { s.name = ['甲','乙','丙','丁'][i]!; });
  initial.guandan.exchange = { stage: 'resisted', givers: [1,3], submitted: [], pairs: [], leader: 0 };
  const { game, state } = controller(initial);
  const scope = effectScope();
  try {
    const view = scope.run(() => useGuandanView(game))!;
    assert.equal(view.exchangeNotice.value?.title, '抗贡成功 · 本副免进贡');
    assert.equal(view.exchangeNotice.value?.detail, '乙、丁合计持有两张大王，由甲先出牌。');
    const change = (stage: 'tribute' | 'return' | 'complete' | 'none') => {
      const current = state.value;
      if (current.game !== 'guandan') throw Error('wrong game');
      state.value = { ...current, phase: stage === 'tribute' || stage === 'return' ? 'tribute' : 'playing',
        guandan: { ...current.guandan, exchange: { ...current.guandan.exchange, stage, pairs: [{ giver:1, receiver:0,
          tribute:{id:'big',rank:17,suit:'joker'}, returned:stage==='complete'?{id:'three',rank:3,suit:'spade'}:null }] } } };
    };
    change('tribute'); assert.match(view.exchangeNotice.value!.title, /双贡/);
    assert.doesNotMatch(view.exchangeNotice.value!.detail, /大王/, 'unsubmitted faces stay private');
    change('return'); assert.match(view.exchangeNotice.value!.detail, /甲选牌还贡/);
    change('complete'); assert.match(view.exchangeNotice.value!.detail, /乙向甲进贡大王/);
    assert.match(view.exchangeNotice.value!.detail, /还.*3/);
    for (const stage of ['complete', 'resisted'] as const) {
      for (const role of ['table', 'player'] as const) {
        const current = state.value;
        if (current.game !== 'guandan') throw Error('wrong game');
        state.value = { ...current, role, selfSeat: role === 'table' ? null : 0,
          roomMode: role === 'table' ? 'tablet' : 'phone', tablePlays: [],
          guandan: { ...current.guandan, exchange: { ...current.guandan.exchange, stage } } };
        assert.ok(view.exchangeNotice.value, 'results remain visible before the opening play');
        assert.ok(view.exchangeStageText.value);
        const plays = [{ id: 'opening', seatId: 0, cards: [{ id: 'opening-card', rank: 3, suit: 'spade' as const }],
          kind: 'single', scatter: { x: 0, y: 0, angle: 0 } }];
        state.value = { ...state.value, tablePlays: plays };
        assert.equal(view.exchangeNotice.value, null, 'the first accepted play dismisses the result');
        assert.equal(view.exchangeStageText.value, '');
        assert.equal(view.resistNote.value, '');
        const reconnected = scope.run(() => useGuandanView(game))!;
        assert.equal(reconnected.exchangeNotice.value, null, 'reconnecting after the opening play stays dismissed');
        state.value = { ...state.value, lastPlay: null, trickStartIndex: 1 };
        assert.equal(view.exchangeNotice.value, null, 'clearing a trick cannot restore the result');
        assert.equal(view.exchangeStageText.value, '');
        const next = state.value;
        if (next.game !== 'guandan') throw Error('wrong game');
        state.value = { ...next, tablePlays: [], guandan: { ...next.guandan, deal: next.guandan.deal + 1 } };
        assert.ok(view.exchangeNotice.value, 'a new deal can show its own exchange result');
      }
    }
    change('none'); assert.equal(view.exchangeNotice.value, null);
  } finally { scope.stop(); room.dispose(); }
});
