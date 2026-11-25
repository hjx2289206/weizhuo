import assert from 'node:assert/strict';
import test from 'node:test';
import { GuandanGame } from '../server/games/guandan';
import { Room, type Peer } from '../server/room';
import { GAME_KINDS } from '../shared/gameCatalog';
import type { JunqiBoard } from '../shared/junqi';
import type { Card, GameKind, ServerMessage, Snapshot } from '../shared/protocol';

let sequence = 0;
const nextId = () => 'spectator-test-' + ++sequence;

function client() {
  const sent: ServerMessage[] = [];
  const peer: Peer = {
    id: nextId(), role: 'table', room: null, requestRoom: null, seatId: null, token: null,
    send(message) { sent.push(structuredClone(message)); }, supersede() {},
  };
  return {
    peer, sent,
    state(): Snapshot {
      const message = [...sent].reverse().find(message => message.type === 'state');
      assert.ok(message?.type === 'state', 'expected a snapshot sent over the connection');
      return message.state;
    },
    command(room: Room, type: string, payload: Record<string, unknown> = {}, id = nextId()) {
      const before = sent.length;
      room.command(peer, type, payload, id);
      assert.ok(sent.slice(before).some(message => message.type === 'ack' && message.id === id),
        JSON.stringify(sent.slice(before).find(message => message.type === 'error')));
    },
  };
}

function table(game: GameKind, mode: 'phone' | 'tablet' = 'phone') {
  const room = new Room('VIEW', mode, game);
  const host = client(), spectator = client();
  room.bindCreator(host.peer, nextId(), '房主');
  const players = mode === 'phone' ? [host] : [];
  for (let seat = players.length; seat < room.seatCount; seat++) {
    const player = client();
    room.bindJoin(player.peer, seat, '玩家' + seat, nextId());
    players.push(player);
  }
  room.bindSpectator(spectator.peer, nextId());
  function start() {
    for (const player of players) player.command(room, 'ready', { ready: true });
    host.command(room, 'start');
  }
  return { room, host, players, spectator, start };
}

function* jsonNodes(value: unknown): Generator<unknown> {
  yield value;
  if (Array.isArray(value)) {
    for (const child of value) yield* jsonNodes(child);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      yield key;
      yield* jsonNodes(child);
    }
  }
}

function publicSnapshot(room: Room, spectator: ReturnType<typeof client>, players: ReturnType<typeof client>[]) {
  const state = spectator.state();
  const engineView = room.engine.view(null);
  assert.deepEqual(Object.fromEntries(Object.keys(engineView).map(key => [key, Reflect.get(state, key)])), engineView);
  assert.equal(state.role, 'spectator');
  assert.equal(state.selfSeat, null);
  assert.equal(state.isHost, false);
  assert.deepEqual(state.hand, []);
  assert.deepEqual(state.seatRequests, []);

  const nodes = [...jsonNodes(JSON.parse(JSON.stringify(state)))];
  const alreadyPublic = new Set(jsonNodes(JSON.parse(JSON.stringify(engineView))));
  for (const player of players) {
    for (const card of player.state().hand) {
      if (!alreadyPublic.has(card.id)) assert.ok(!nodes.includes(card.id), `leaked card ${card.id}`);
    }
  }
  return { state, nodes };
}

test('Doudizhu spectator receives only public facts before and after bidding, with no hints or host queue', () => {
  const { room, host, players, spectator, start } = table('doudizhu');
  try {
    start();
    const bidding = publicSnapshot(room, spectator, players);
    assert.equal(bidding.state.phase, 'bidding');
    for (const player of players) assert.equal(player.state().hand.length, 17);
    const bidder = bidding.state.turn!;
    players[bidder]!.command(room, 'bid', { value: 3 });
    const playing = publicSnapshot(room, spectator, players);
    assert.equal(playing.state.game, 'doudizhu');
    assert.equal(playing.state.phase, 'playing');
    // The three cards now public in the landlord's hand were private during bidding.
    assert.equal(playing.state.bottom.length, 3);
    for (const card of playing.state.bottom) {
      assert.ok(players[bidder]!.state().hand.some(held => held.id === card.id));
      assert.ok(!bidding.nodes.includes(card.id), `leaked unrevealed bottom card ${card.id}`);
    }
    const hintStart = spectator.sent.length;
    players[bidder]!.command(room, 'hint');
    assert.ok(players[bidder]!.sent.some(message => message.type === 'hint' && message.plays.length > 0));
    for (const player of players.filter((_, seat) => seat !== bidder)) {
      assert.ok(!player.sent.some(message => message.type === 'hint'));
    }
    assert.equal(spectator.sent.length, hintStart);

    const waiter = client(), requestId = nextId();
    room.requestSeat(waiter.peer, 1, '私密申请者', requestId);
    assert.equal(host.state().seatRequests[0]?.id, requestId);
    const waiting = publicSnapshot(room, spectator, players);
    assert.ok(!waiting.nodes.includes(requestId));
    assert.ok(!waiting.nodes.includes('私密申请者'));
  } finally { room.dispose(); }
});

test('Guandan spectator never receives privateAction or hidden cards during tribute and return', () => {
  const { room, host, players, spectator, start } = table('guandan', 'tablet');
  try {
    start();
    const game = room.engine;
    assert.ok(game instanceof GuandanGame);
    const lead = game.view(null).turn!;
    const card = (id: string, rank: number, suit: Card['suit'] = 'spade'): Card => ({ id, rank, suit });
    for (let seat = 0; seat < 4; seat++) game.hands[seat] = [card('first-' + seat, 3)];
    players[lead]!.command(room, 'play', { cards: ['first-' + lead] });
    const partner = (lead + 2) % 4;
    for (let i = 1; i <= 3; i++) {
      const seat = game.view(null).turn!;
      players[seat]!.command(room, 'pass');
    }
    assert.equal(game.view(null).turn, partner);
    players[partner]!.command(room, 'play', { cards: ['first-' + partner] });
    assert.equal(game.result?.doubleDown, true);
    host.command(room, 'again');
    start();
    for (let seat = 0; seat < 4; seat++) {
      game.hands[seat] = [card('owed-' + seat, 11 + seat), card('return-' + seat, 9)];
    }
    game.beginExchange();
    room.broadcast();

    function check(stage: 'tribute' | 'return') {
      const { state, nodes } = publicSnapshot(room, spectator, players);
      assert.equal(state.game, 'guandan');
      assert.equal(state.guandan.exchange.stage, stage);
      assert.equal(state.privateAction, null);
      assert.deepEqual(host.state().tablePlays, state.tablePlays);
      const actions = players.flatMap(player => {
        const mine = player.state();
        return mine.game === 'guandan' && mine.privateAction ? [mine.privateAction] : [];
      });
      assert.equal(actions.length, 2);
      for (const action of actions) {
        assert.equal(action.kind, stage);
        assert.ok(action.eligibleIds.length);
        for (const id of action.eligibleIds) assert.ok(!nodes.includes(id), `leaked eligible card ${id}`);
        if (action.committed) assert.ok(!nodes.includes(action.committed.id), 'leaked committed card');
      }
    }

    check('tribute');
    const givers = [...game.exchange.givers];
    players[givers[0]!]!.command(room, 'tribute', { cardId: 'owed-' + givers[0] });
    check('tribute');
    players[givers[1]!]!.command(room, 'tribute', { cardId: 'owed-' + givers[1] });
    check('return');
    players[lead]!.command(room, 'returnTribute', { cardId: 'return-' + lead });
    check('return');
  } finally { room.dispose(); }
});

test('Junqi spectator sees only publicly revealed flags until all remaining ranks become public at finish', () => {
  const { room, players, spectator, start } = table('junqi');
  try {
    start();
    function check(expected: Snapshot['phase']) {
      const { state, nodes } = publicSnapshot(room, spectator, players);
      assert.equal(state.game, 'junqi');
      assert.equal(state.phase, expected);
      const publicRanks = state.junqi.board.flatMap(piece => piece?.rank ? [piece.rank] : []);
      const ownRanks = new Set<string>();
      for (const player of players) {
        const mine = player.state();
        assert.equal(mine.game, 'junqi');
        const ownArmy = mine.junqi.board.filter(piece => piece?.side === mine.selfSeat && piece.rank);
        assert.ok(ownArmy.length);
        for (const piece of ownArmy) ownRanks.add(piece!.rank!);
      }
      if (expected !== 'finished') {
        for (const piece of state.junqi.board) {
          if (piece?.rank) {
            assert.equal(piece.rank, 'flag');
            assert.equal(state.junqi.revealedFlags[piece.side], true);
          }
        }
        for (const rank of ownRanks) {
          assert.equal(nodes.filter(node => node === rank).length, publicRanks.filter(value => value === rank).length);
        }
      } else {
        assert.ok(publicRanks.length > 0);
        assert.equal(publicRanks.length, state.junqi.board.filter(Boolean).length);
      }
      return state;
    }

    const deploying = check('deploying');
    assert.ok(deploying.junqi.board.every(piece => !piece || piece.rank === null));
    for (const player of players) player.command(room, 'junqiSetup', { action: 'confirm' });
    const board: JunqiBoard = Array(60).fill(null);
    board[25] = { id: 'opaque-one', side: 0, rank: 'commander' };
    board[30] = { id: 'opaque-two', side: 1, rank: 'bomb' };
    board[58] = { id: 'opaque-three', side: 0, rank: 'flag' };
    board[1] = { id: 'opaque-four', side: 1, rank: 'flag' };
    board[9] = { id: 'opaque-five', side: 1, rank: 'engineer' };
    board[35] = { id: 'opaque-six', side: 0, rank: 'company' };
    Reflect.set(room.engine, 'board', board);
    players[0]!.command(room, 'junqiMove', { from: 25, to: 30 });
    const playing = check('playing');
    assert.deepEqual(playing.junqi.revealedFlags, [true, false]);
    assert.equal(playing.junqi.board[58]?.rank, 'flag');
    players[1]!.command(room, 'junqiResign');
    check('finished');
  } finally { room.dispose(); }
});

for (const game of GAME_KINDS.filter(kind => kind !== 'doudizhu' && kind !== 'guandan' && kind !== 'junqi')) {
  test(`${game} spectator receives exactly the public engine projection during play`, () => {
    const { room, players, spectator, start } = table(game);
    try {
      start();
      if (game === 'chess') players[0]!.command(room, 'chessMove', { from: 52, to: 36 });
      if (game === 'xiangqi') players[0]!.command(room, 'xiangqiMove', { from: 54, to: 45 });
      if (game === 'go' || game === 'gomoku') players[0]!.command(room, 'stoneMove', { point: 0 });
      if (game === 'reversi') players[0]!.command(room, 'reversiMove', { point: 19 });
      const { state } = publicSnapshot(room, spectator, players);
      assert.equal(state.phase, 'playing');
      assert.equal(state.game, game);
    } finally { room.dispose(); }
  });
}

test('Spectator commands fail before host, seat and replay handling; quick phrases can be disabled by the host', () => {
  const { room, host, players, spectator, start } = table('doudizhu');
  try {
    start();
    const { version } = spectator.state();
    const forbidden = [
      'ready', 'addBot', 'removeBot', 'autoPlay', 'boardAi', 'boardAiRetry', 'bid', 'play', 'pass',
      'tribute', 'returnTribute', 'chessMove', 'xiangqiMove', 'stoneMove', 'reversiMove', 'junqiMove',
      'junqiSetup', 'chessUndo', 'xiangqiUndo', 'stoneUndo', 'reversiUndo', 'hint', 'start', 'again',
      'decideSeat', 'seats', 'rename', 'transferHost', 'removeOffline', 'clearEmptySeats', 'turnTimer',
      'dissolve', 'spectatorPhrases',
    ];
    for (const command of forbidden) {
      const id = nextId(), before = spectator.sent.length;
      room.command(spectator.peer, command, { seatId: 1, enabled: true, approve: true }, id);
      assert.deepEqual(spectator.sent.slice(before), [{ type: 'error', id, message: '旁观者不能操作对局' }]);
    }
    assert.equal(spectator.state().version, version);
    const usedId = nextId();
    host.command(room, 'spectatorPhrases', { enabled: true }, usedId);
    room.command(spectator.peer, 'hint', {}, usedId);
    assert.ok(spectator.sent.at(-1)?.type === 'error');
    const phraseId = 'hello';
    spectator.command(room, 'phrase', { phraseId, text: '伪造文本', name: '伪造房主', seatId: 0 });
    for (const connection of [host, ...players.slice(1), spectator]) {
      const phrase = connection.sent.find(message => message.type === 'phrase');
      assert.ok(phrase?.type === 'phrase');
      assert.equal(phrase.seatId, null);
      assert.equal(phrase.name, '旁观者');
      assert.equal(phrase.phraseId, phraseId);
      assert.match(phrase.text, /大家好/);
    }
    host.command(room, 'spectatorPhrases', { enabled: false });
    assert.equal(spectator.state().spectatorPhrases, false);
    const id = nextId();
    room.command(spectator.peer, 'phrase', { phraseId }, id);
    assert.deepEqual(spectator.sent.at(-1), { type: 'error', id, message: '房主已关闭旁观快捷语' });
  } finally { room.dispose(); }
});

test('A room admits eight spectators and resumes a disconnected viewer without reserving any player seat', () => {
  const room = new Room('CAPS', 'phone', 'junqi');
  const host = client();
  room.bindCreator(host.peer, nextId());
  try {
    const watchers = Array.from({ length: 8 }, () => {
      const watcher = client();
      room.bindSpectator(watcher.peer, nextId());
      assert.equal(watcher.state().role, 'spectator');
      return watcher;
    });
    assert.equal(room.summary().spectatorCount, 8);
    const overflow = client(), id = nextId();
    room.bindSpectator(overflow.peer, id);
    assert.deepEqual(overflow.sent, [{ type: 'error', id, message: '房间旁观人数已满（最多 8 人）' }]);
    const token = watchers[0]!.peer.token!;
    assert.notEqual(token, host.peer.token);
    assert.notEqual(token, room.hostToken);
    room.detach(watchers[0]!.peer);
    assert.equal(host.state().spectatorCount, 7);
    room.bindResume(overflow.peer, token, nextId());
    assert.equal(overflow.state().spectatorCount, 8);
    assert.equal(overflow.state().role, 'spectator');
    assert.equal(overflow.state().selfSeat, null);
    assert.equal(overflow.state().isHost, false);
    assert.equal(overflow.state().seats.filter(seat => seat.name !== null).length, 1);
    const forged = client();
    room.bindResume(forged.peer, token, nextId());
    room.command(overflow.peer, 'phrase', { phraseId: 'hello' }, nextId());
    assert.ok(overflow.sent.at(-1)?.type === 'error');
    room.detach(overflow.peer);
    assert.equal(forged.state().spectatorCount, 8, 'closing superseded socket must not release the new viewer');
  } finally { room.dispose(); }
});

test('Spectators do not keep an empty room alive or pause a running game when they disconnect', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const { room, host, players, spectator, start } = table('reversi');
  try {
    start();
    const token = spectator.peer.token!;
    room.detach(spectator.peer);
    host.command(room, 'reversiMove', { point: 19 });
    const playing = host.state();
    assert.equal(playing.game, 'reversi');
    assert.equal(playing.spectatorCount, 0);
    assert.equal(playing.reversi.moves.length, 1);
    room.detach(host.peer);
    room.detach(players[1]!.peer);
    assert.equal(room.empty, true);
    t.mock.timers.setTime(30_000);
    const reconnected = client();
    room.bindResume(reconnected.peer, token, nextId());
    assert.equal(reconnected.state().spectatorCount, 1);
    assert.equal(reconnected.state().hostConnected, false);
    assert.equal(reconnected.state().hostSeatId, null);
    assert.equal(reconnected.state().isHost, false);
    assert.equal(room.empty, true);
    assert.equal(room.isExpired(39_999, 30_000), false);
    assert.equal(room.isExpired(40_000, 30_000), true);
    room.dispose('房间已过期');
    assert.deepEqual(reconnected.sent.at(-1), { type: 'dissolved', code: 'VIEW', message: '房间已过期' });
    assert.equal(reconnected.peer.room, null);
  } finally { room.dispose(); }
});

test('A spectator joins a vacant seat directly on the same connection and leaves the public audience', () => {
  const room = new Room('JOIN', 'phone', 'doudizhu');
  const host = client(), spectator = client(), third = client();
  room.bindCreator(host.peer, nextId());
  try {
    room.bindSpectator(spectator.peer, nextId());
    const oldToken = spectator.peer.token!;
    publicSnapshot(room, spectator, [host]);
    room.bindJoin(spectator.peer, 1, '新玩家', nextId());
    assert.equal(spectator.state().role, 'player');
    assert.equal(spectator.state().selfSeat, 1);
    assert.equal(host.state().spectatorCount, 0);
    assert.notEqual(spectator.peer.token, oldToken);
    const old = client();
    room.bindResume(old.peer, oldToken, nextId());
    assert.ok(old.sent[0]?.type === 'error' && old.sent[0].code === 'INVALID_CREDENTIAL');
    room.bindJoin(third.peer, 2, '第三位', nextId());
    for (const player of [host, spectator, third]) player.command(room, 'ready', { ready: true });
    host.command(room, 'start');
    assert.equal(spectator.state().hand.length, 17);
    assert.deepEqual(spectator.state().hand, room.engine.handOf(1));
  } finally { room.dispose(); }
});

test('Refusal keeps a spectator public; approval of an offline-seat takeover changes the same connection to private', () => {
  const { room, host, players, spectator, start } = table('doudizhu');
  const another = new Room('ELSE', 'phone', 'doudizhu');
  try {
    start();
    const seat = players[1]!, before = seat.state(), token = seat.peer.token!;
    room.detach(seat.peer);
    room.requestSeat(spectator.peer, 1, '旁观申请', 'rejected');
    assert.equal(host.state().seatRequests[0]?.id, 'rejected');
    publicSnapshot(room, spectator, players);
    host.command(room, 'decideSeat', { requestId: 'rejected', approve: false });
    assert.ok(spectator.sent.some(message => message.type === 'seat-request' && message.status === 'rejected'));
    assert.equal(spectator.state().spectatorCount, 1);

    another.requestSeat(spectator.peer, 1, '跨房申请', 'foreign');
    assert.ok(spectator.sent.at(-1)?.type === 'error');
    const occupiedJoin = nextId();
    room.bindJoin(spectator.peer, 1, '直接占座', occupiedJoin);
    assert.ok(spectator.sent.at(-1)?.type === 'error');
    const oldSpectatorToken = spectator.peer.token;
    room.requestSeat(spectator.peer, 1, '接替玩家', 'approved');
    publicSnapshot(room, spectator, players);
    const beforeApproval = spectator.sent.length;
    host.command(room, 'decideSeat', { requestId: 'approved', approve: true });
    const upgrade = spectator.sent.slice(beforeApproval);
    assert.ok(upgrade[0]?.type === 'session' && upgrade[0].role === 'player' && upgrade[0].seatId === 1);
    const after = spectator.state();
    assert.deepEqual(after.hand, before.hand);
    assert.notEqual(spectator.peer.token, token);
    assert.notEqual(spectator.peer.token, oldSpectatorToken);
    assert.equal(after.spectatorCount, 0);
    assert.equal(after.isHost, false);
    assert.equal(after.seats[1]?.autoPlay, false);
    assert.equal(host.state().spectatorCount, 0);
    const old = client();
    room.bindResume(old.peer, token, nextId());
    assert.ok(old.sent[0]?.type === 'error' && old.sent[0].code === 'INVALID_CREDENTIAL');
    room.bindResume(old.peer, oldSpectatorToken!, nextId());
    assert.ok(old.sent.at(-1)?.type === 'error');
  } finally { room.dispose(); another.dispose(); }
});

test('Spectators see the public tablet chess position and computer thinking without gaining table rights', () => {
  const room = new Room('TABS', 'tablet', 'reversi');
  const host = client(), spectator = client();
  room.bindCreator(host.peer, nextId());
  try {
    host.command(room, 'boardAi', { enabled: true, side: 0, difficulty: 'normal' });
    room.bindSpectator(spectator.peer, nextId());
    host.command(room, 'start');
    const { state } = publicSnapshot(room, spectator, []);
    assert.equal(state.boardAi?.thinking, true);
    assert.deepEqual(state.boardAi, host.state().boardAi);
    assert.equal(state.game, 'reversi');
    const hostState = host.state();
    assert.equal(hostState.game, 'reversi');
    assert.deepEqual(state.reversi, hostState.reversi);
    host.command(room, 'dissolve');
    assert.equal(spectator.peer.room, null);
    assert.ok(spectator.sent.some(message => message.type === 'dissolved'));
  } finally { room.dispose(); }
});
