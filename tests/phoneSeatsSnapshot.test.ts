import assert from 'node:assert/strict';
import test from 'node:test';
import { Room, type Peer } from '../server/room';
import { GAME_KINDS } from '../shared/gameCatalog';
import type { GameKind, Position } from '../shared/protocol';

const twoSeats: Position[] = [
  { x: 0.5, y: 0.88, angle: 0 },
  { x: 0.5, y: 0.12, angle: 180 },
];
const phoneSeatSnapshot: Record<GameKind, Position[]> = {
  doudizhu: [
    { x: 0.5, y: 0.88, angle: 0 },
    { x: 0.1, y: 0.5, angle: 90 },
    { x: 0.9, y: 0.5, angle: -90 },
  ],
  guandan: [
    { x: 0.5, y: 0.88, angle: 0 },
    { x: 0.9, y: 0.5, angle: -90 },
    { x: 0.5, y: 0.12, angle: 180 },
    { x: 0.1, y: 0.5, angle: 90 },
  ],
  xiangqi: twoSeats,
  go: twoSeats,
  gomoku: twoSeats,
  reversi: twoSeats,
  chess: twoSeats,
  junqi: twoSeats,
};

function phonePositions(room: Room): Position[] {
  return room.summary().seats.map(({ x, y, angle }) => ({ x, y, angle }));
}

test('The current games keep the exact phone coordinates and seat ordering', () => {
  for (const game of GAME_KINDS) {
    const room = new Room('MAP', 'phone', game);
    try {
      assert.deepEqual(phonePositions(room), phoneSeatSnapshot[game], game);
    } finally {
      room.dispose();
    }
  }
});

test('Junqi keeps the exact four-country phone layout and restores its two-seat layout', () => {
  const room = new Room('MAP', 'phone', 'junqi');
  const host: Peer = {
    id: 'host', role: 'table', seatId: null, token: null, room: null, requestRoom: null,
    send() {}, supersede() {},
  };
  try {
    room.bindCreator(host, 'create');
    room.command(host, 'junqiMode', { variant: 'four' }, 'four');
    assert.deepEqual(phonePositions(room), [
      { x: 0.5, y: 0.88, angle: 0 },
      { x: 0.12, y: 0.5, angle: 90 },
      { x: 0.5, y: 0.12, angle: 180 },
      { x: 0.88, y: 0.5, angle: -90 },
    ]);
    room.command(host, 'junqiMode', { variant: 'two' }, 'two');
    assert.deepEqual(phonePositions(room), phoneSeatSnapshot.junqi);
  } finally {
    room.dispose();
  }
});
