// Quick phrases: fixed whitelist only, ephemeral broadcast, no state/version churn and no free text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_PHRASES } from '../shared/phrases';
import type { ServerMessage } from '../shared/protocol';
import { Room, type Peer } from '../server/room';

type FakePeer = Peer & { sent: ServerMessage[]; superseded: number };
let peerSeq = 0;

function fakePeer(): FakePeer {
  const sent: ServerMessage[] = [];
  peerSeq += 1;
  return {
    id: `phrase-peer${peerSeq}`,
    role: 'table',
    seatId: null,
    token: null,
    room: null,
    requestRoom: null,
    sent,
    superseded: 0,
    send(message) {
      sent.push(message);
    },
    supersede() {
      this.superseded += 1;
    },
  };
}

function phrases(peer: FakePeer): Extract<ServerMessage, { type: 'phrase' }>[] {
  return peer.sent.filter((message): message is Extract<ServerMessage, { type: 'phrase' }> => message.type === 'phrase');
}

function lastError(peer: FakePeer): string | undefined {
  for (let index = peer.sent.length - 1; index >= 0; index -= 1) {
    const message = peer.sent[index];
    if (message.type === 'error') return message.message;
  }
  return undefined;
}

function lastAck(peer: FakePeer): string | undefined {
  for (let index = peer.sent.length - 1; index >= 0; index -= 1) {
    const message = peer.sent[index];
    if (message.type === 'ack') return message.id;
  }
  return undefined;
}

const PLACED = [
  { x: 0.5, y: 0.88, angle: 0 },
  { x: 0.1, y: 0.5, angle: 90 },
  { x: 0.9, y: 0.5, angle: -90 },
];

function setup(): { room: Room; host: FakePeer; players: FakePeer[] } {
  const room = new Room('PHR', 'tablet', 'doudizhu');
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

test('quick phrases: a whitelisted id reaches every bound device without a state snapshot', () => {
  const { room, host, players } = setup();
  players.forEach((peer) => peer.sent.length = 0);
  host.sent.length = 0;
  room.command(players[1]!, 'phrase', { phraseId: 'nice' }, 'say-1');

  const hello = QUICK_PHRASES.find((phrase) => phrase.id === 'nice');
  assert.ok(hello);
  for (const peer of [players[0]!, players[1]!, players[2]!, host]) {
    const delivered = phrases(peer);
    assert.equal(delivered.length, 1, 'each bound device sees the phrase exactly once');
    assert.equal(delivered[0]!.seatId, 1);
    assert.equal(delivered[0]!.name, '玩家1');
    assert.equal(delivered[0]!.text, `${hello.emoji} ${hello.text}`);
  }
  assert.equal(lastAck(players[1]!), 'say-1');
  assert.equal(host.sent.some((message) => message.type === 'state'), false, 'a phrase does not broadcast layout work');
})

test('quick phrases: free text and unknown ids are rejected, and the table cannot speak', () => {
  const { room, host, players } = setup();
  room.command(players[0]!, 'phrase', { phraseId: 'free chat' }, 'bad-id');
  assert.equal(lastError(players[0]!), '快捷语无效');
  room.command(players[0]!, 'phrase', { text: 'hello everyone' }, 'free-text');
  assert.equal(lastError(players[0]!), '快捷语无效');
  room.command(host, 'phrase', { phraseId: 'hello' }, 'table');
  assert.equal(lastError(host), '只有玩家可以执行该操作');
  assert.equal(phrases(players[0]!).length, 0);
})

test('quick phrases: rapid repeats are rate-limited but another seat may follow immediately', () => {
  const { room, players } = setup();
  room.command(players[0]!, 'phrase', { phraseId: 'hello' }, 'first');
  assert.equal(phrases(players[2]!).length, 1);
  room.command(players[0]!, 'phrase', { phraseId: 'hurry' }, 'second');
  assert.equal(lastError(players[0]!), '快捷语发得太快了，请稍后再试');
  assert.equal(phrases(players[2]!).length, 1, 'the suppressed phrase is not delivered');
  room.command(players[1]!, 'phrase', { phraseId: 'cheer' }, 'other-seat');
  assert.equal(phrases(players[2]!).length, 2, 'the cooldown is per seat');
})
