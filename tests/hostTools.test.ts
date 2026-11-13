// Host tools: transfer host, remove offline seats, trim trailing empty seats and dissolve a room.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, Snapshot } from '../shared/protocol';
import { Room, type Peer } from '../server/room';

type FakePeer = Peer & { sent: ServerMessage[]; superseded: number };
let peerSeq = 0;

function fakePeer(): FakePeer {
  const sent: ServerMessage[] = [];
  peerSeq += 1;
  return {
    id: `host-tools-peer${peerSeq}`,
    role: 'table',
    seatId: null,
    token: null,
    room: null,
    requestRoom: null,
    sent,
    superseded: 0,
    send(message) {
      this.sent.push(message);
    },
    supersede() {
      this.superseded += 1;
    },
  };
}

function lastState(peer: FakePeer): Snapshot {
  for (let index = peer.sent.length - 1; index >= 0; index -= 1) {
    const message = peer.sent[index];
    if (message.type === 'state') return message.state;
  }
  throw new Error('no state');
}

function lastError(peer: FakePeer): string | undefined {
  for (let index = peer.sent.length - 1; index >= 0; index -= 1) {
    const message = peer.sent[index];
    if (message.type === 'error') return message.message;
  }
  return undefined;
}

function dissolved(peer: FakePeer): Extract<ServerMessage, { type: 'dissolved' }>[] {
  return peer.sent.filter((message): message is Extract<ServerMessage, { type: 'dissolved' }> => message.type === 'dissolved');
}

const PLACED = [
  { x: 0.5, y: 0.88, angle: 0 },
  { x: 0.1, y: 0.5, angle: 90 },
  { x: 0.9, y: 0.5, angle: -90 },
];

function tablet(): { room: Room; host: FakePeer; players: FakePeer[] } {
  const room = new Room('HTL', 'tablet', 'doudizhu');
  const host = fakePeer();
  room.bindHost(host, 'create');
  room.command(host, 'seats', { positions: PLACED.map((position) => ({ ...position })) }, 'seats');
  const players = [0, 1, 2].map((seat) => {
    const peer = fakePeer();
    room.bindJoin(peer, seat, `玩家${seat}`, `join-${seat}`);
    return peer;
  });
  return { room, host, players };
}

function phone(): { room: Room; host: FakePeer; players: FakePeer[] } {
  const room = new Room('HTP', 'phone', 'doudizhu');
  const host = fakePeer();
  room.bindCreator(host, 'create', '房主');
  const players = [1, 2].map((seat) => {
    const peer = fakePeer();
    room.bindJoin(peer, seat, `玩家${seat}`, `join-${seat}`);
    return peer;
  });
  return { room, host, players };
}

test('host tools: a phone host can transfer rights to a connected human only', () => {
  const { room, host, players } = phone();
  assert.equal(lastState(host).isHost, true);
  assert.equal(lastState(players[0]!).isHost, false);

  room.command(players[0]!, 'transferHost', { seatId: 0 }, 'not-host');
  assert.equal(lastError(players[0]!), '只有房主可以转让房主');

  // Seat 1 is online at this point, so this succeeds and proves the happy path first.
  room.command(host, 'transferHost', { seatId: 1 }, 'to-online');
  assert.equal(lastState(host).isHost, false);
  assert.equal(lastState(players[0]!).isHost, true);

  // The old owner disconnects: only a connected human may receive host rights.
  room.detach(host);
  room.command(players[0]!, 'transferHost', { seatId: 0 }, 'to-offline');
  assert.equal(lastError(players[0]!), '只能转让给在线玩家');

  room.command(players[0]!, 'transferHost', { seatId: 999 }, 'bad-seat');
  assert.equal(lastError(players[0]!), '座位号无效');
  const { room: tabletRoom, host: tabletHost } = tablet();
  tabletRoom.command(tabletHost, 'transferHost', { seatId: 0 }, 'tablet-host');
  assert.equal(lastError(tabletHost), '平板房主是公共牌桌，无需转让');
  room.dispose();
  tabletRoom.dispose();
});

test('host tools: only the lobby host may remove disconnected human seats', () => {
  const { room, host, players } = tablet();
  room.command(players[0]!, 'removeOffline', {}, 'not-host');
  assert.equal(lastError(players[0]!), '只有房主可以清理离线座位');

  room.command(host, 'removeOffline', {}, 'none');
  assert.equal(lastError(host), '没有需要清理的离线座位');

  room.detach(players[1]!);
  // A disconnected human who opted into 托管 is still being played by the room, so it stays.
  room.players[1]!.autoPlay = true;
  room.command(host, 'removeOffline', {}, 'managed');
  assert.equal(lastError(host), '没有需要清理的离线座位');
  room.players[1]!.autoPlay = false;
  room.command(host, 'removeOffline', {}, 'clean-one');
  assert.equal(room.players[1], null);
  assert.equal(lastState(host).seats[1]!.name, null, 'the seat becomes claimable again');

  const newcomer = fakePeer();
  room.bindJoin(newcomer, 1, '新玩家', 'new-join');
  assert.equal(lastState(host).seats[1]!.name, '新玩家');
  room.command(host, 'removeOffline', {}, 'again');
  assert.equal(lastError(host), '没有需要清理的离线座位');
  room.dispose();
});

test('host tools: tablet Doudizhu trims only trailing empty positions', () => {
  const { room, host } = tablet();
  // Keep seat 0 occupied; seats 1 and 2 are empty and safe to trim.
  const players = [0, 1, 2].map(() => fakePeer());
  const empty = new Room('HTM', 'tablet', 'doudizhu');
  const emptyHost = fakePeer();
  empty.bindHost(emptyHost, 'create');
  empty.command(emptyHost, 'seats', { positions: PLACED.map((position) => ({ ...position })) }, 'seats');
  empty.bindJoin(players[0]!, 0, '玩家0', 'join-0');

  empty.command(emptyHost, 'clearEmptySeats', {}, 'trim');
  assert.equal(lastState(emptyHost).seats.length, 1, 'trailing empty positions are gone');
  empty.command(emptyHost, 'clearEmptySeats', {}, 'trim-again');
  assert.equal(lastError(emptyHost), '没有空位需要清理');

  const phoneRoom = phone();
  phoneRoom.room.command(phoneRoom.host, 'clearEmptySeats', {}, 'phone');
  assert.equal(lastError(phoneRoom.host), '手机开一桌使用固定座位，不能清理空位');

  const guandan = new Room('HTG', 'tablet', 'guandan');
  const guandanHost = fakePeer();
  guandan.bindHost(guandanHost, 'create');
  guandan.command(guandanHost, 'clearEmptySeats', {}, 'guandan');
  assert.equal(lastError(guandanHost), '掼蛋使用固定座位，不能清理空位');

  room.dispose();
  empty.dispose();
  phoneRoom.room.dispose();
  guandan.dispose();
});

test('host tools: dissolution notifies every bound device and pending waiter, then dies', () => {
  const { room, host, players } = tablet();
  const waiter = fakePeer();
  room.requestSeat(waiter, 1, '等待者', 'wait-1');
  assert.equal(waiter.requestRoom, room);

  room.command(players[0]!, 'dissolve', {}, 'not-host');
  assert.equal(lastError(players[0]!), '只有房主可以解散房间');

  let callbackRoom: Room | null = null;
  room.onDissolve = (dissolvedRoom) => {
    callbackRoom = dissolvedRoom;
  };
  const statesBefore = host.sent.filter((message) => message.type === 'state').length;
  room.command(host, 'dissolve', {}, 'boom');

  for (const peer of [host, ...players, waiter]) {
    assert.equal(dissolved(peer).length, 1, `${peer.id} learns the room is gone`);
    assert.equal(dissolved(peer)[0]!.code, 'HTL');
    assert.equal(peer.room, null);
    assert.equal(peer.requestRoom, null);
    assert.equal(peer.token, null);
  }
  assert.equal(room.hostPeer, null);
  assert.equal(room.players.every((player) => player === null), true);
  assert.equal(callbackRoom, room, 'the socket layer gets its registry-removal hook');
  assert.equal(host.sent.some((message) => message.type === 'ack' && message.id === 'boom'), true);
  assert.equal(
    host.sent.filter((message) => message.type === 'state').length,
    statesBefore,
    'no snapshot is broadcast after dissolution',
  );
})
