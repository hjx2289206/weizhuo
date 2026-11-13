// Permanent client-behaviour tests for the controller's persistence rules.
//
// F2: the server closes a superseded socket with code 4000. That window must yield the seat to the
// newer window instead of reconnecting forever, while its durable seat credential survives so
// "继续牌局" can take the seat back on purpose. Ordinary drops must still reconnect.
// F3: invalidating a stale credential must never erase the newer identity another window was
// approved into (same seat slot), a record describing another identity, or a usable Continue path.
//
// The controller runs against a deterministic fake browser: no real socket, storage or wall clock.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { DoudizhuSnapshot, GameKind, GuandanSnapshot, RoomMode } from '../shared/protocol';
import { useGame } from '../src/useGame';
import {
  LAST_ROOM_KEY,
  TAB_SESSION_KEY,
  forgetCredential,
  persistCredential,
  readRoomRecord,
  readRoomToken,
  readSavedSession,
  readTabCredential,
  removeRoomToken,
  type Credential,
  type StorageLike,
  type Stores,
} from '../src/sessionStore';

/* ------------------------------------------------------------------ *
 * fake browser
 * ------------------------------------------------------------------ */

interface MemoryStore extends StorageLike {
  dump: Record<string, string>;
}

function memoryStore(seed: Record<string, string> = {}): MemoryStore {
  const dump: Record<string, string> = { ...seed };
  return {
    dump,
    getItem: (key) => (key in dump ? dump[key] : null),
    setItem: (key, value) => {
      dump[key] = value;
    },
    removeItem: (key) => {
      delete dump[key];
    },
  };
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, ((event: unknown) => void)[]> = {};

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.serverClose(1000);
  }

  open(): void {
    if (this.readyState === FakeSocket.OPEN) return;
    this.readyState = FakeSocket.OPEN;
    this.emit('open', {});
  }

  /** Server → client. */
  deliver(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  /** A close initiated by the server; 4000 is what a superseded socket receives. */
  serverClose(code: number): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', { code });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

interface Clock {
  setTimeout(fn: () => void, delay?: number): number;
  clearTimeout(id: number): void;
  advance(ms: number): void;
  pending(): number;
}

function createClock(): Clock {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn, delay = 0) => {
      sequence += 1;
      timers.set(sequence, { at: now + Math.max(0, delay), fn });
      return sequence;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    // Runs every timer due within the window, including ones scheduled while running.
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        let next: { id: number; at: number; fn: () => void } | null = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (next === null || timer.at < next.at)) next = { id, at: timer.at, fn: timer.fn };
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

interface Browser {
  sockets: FakeSocket[];
  local: MemoryStore;
  session: MemoryStore;
  clock: Clock;
  url(): string;
}

const scope = globalThis as unknown as Record<string, unknown>;
const originals = {
  window: scope.window,
  WebSocket: scope.WebSocket,
  location: scope.location,
  history: scope.history,
  fetch: scope.fetch,
};

after(() => {
  scope.window = originals.window;
  scope.WebSocket = originals.WebSocket;
  scope.location = originals.location;
  scope.history = originals.history;
  scope.fetch = originals.fetch;
});

function installBrowser(href: string, seed: { local?: Record<string, string>; session?: Record<string, string> } = {}): Browser {
  const local = memoryStore(seed.local);
  const session = memoryStore(seed.session);
  const clock = createClock();
  let url = new URL(href);
  scope.window = {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: local,
    sessionStorage: session,
  };
  scope.WebSocket = FakeSocket;
  scope.location = {
    get href() {
      return url.href;
    },
    get search() {
      return url.search;
    },
    get pathname() {
      return url.pathname;
    },
    get origin() {
      return url.origin;
    },
    get host() {
      return url.host;
    },
    get hostname() {
      return url.hostname;
    },
    get protocol() {
      return url.protocol;
    },
  };
  scope.history = {
    replaceState: (_state: unknown, _title: unknown, next: string) => {
      url = new URL(next, url);
    },
  };
  scope.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  FakeSocket.instances.length = 0;
  return { sockets: FakeSocket.instances, local, session, clock, url: () => url.href };
}

interface WireMessage {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

function lastSent(socket: FakeSocket): WireMessage {
  const raw = socket.sent.at(-1);
  if (!raw) assert.fail('no message was sent');
  return JSON.parse(raw) as WireMessage;
}

function openSocket(browser: Browser, index = browser.sockets.length - 1): FakeSocket {
  const socket = browser.sockets[index];
  assert.ok(socket, `socket #${index} exists`);
  socket.open();
  return socket;
}

/**
 * Lets the controller's awaited promises settle (open → resume send). A queue drain rather than a
 * delay: every timer the controller uses runs on the fake clock above, so tests stay instantaneous.
 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The real server answers a bind with session + ack. */
function ack(socket: FakeSocket): void {
  socket.deliver({ type: 'ack', id: lastSent(socket).id });
}

function snapshot(overrides: Partial<DoudizhuSnapshot> = {}): DoudizhuSnapshot {
  return {
    code: 'AB12',
    game: 'doudizhu',
    roomMode: 'tablet',
    phase: 'playing',
    seats: [
      { id: 0, name: '甲', connected: true, ready: true, count: 17, passed: false, x: 0.2, y: 0.2, angle: 0, isBot: false, autoPlay: false },
      { id: 1, name: '阿伟', connected: true, ready: true, count: 17, passed: false, x: 0.8, y: 0.2, angle: 0, isBot: false, autoPlay: false },
    ],
    turn: 1,
    landlord: 1,
    bid: 3,
    bottom: [],
    lastPlay: null,
    tablePlays: [],
    trickStartIndex: 0,
    isHost: false,
    hostSeatId: null,
    hostConnected: true,
    turnLimitSeconds: 0,
    turnRemainingMs: null,
    turnSeatId: null,
    seatRequests: [],
    automation: { available: false, message: null },
    winner: null,
    multiplier: 1,
    hand: [],
    selfSeat: 1,
    role: 'player',
    message: '',
    version: 2,
    scores: [0, 0],
    ...overrides,
  };
}

/* A Guandan board fixture: the same room identity, only the game-specific fields differ. */
function guandanSnapshot(overrides: Partial<GuandanSnapshot> = {}): GuandanSnapshot {
  return {
    code: 'AB12',
    game: 'guandan',
    roomMode: 'tablet',
    phase: 'playing',
    seats: [],
    hand: [],
    selfSeat: 1,
    role: 'player',
    isHost: false,
    hostSeatId: null,
    hostConnected: true,
    turnLimitSeconds: 0,
    turnRemainingMs: null,
    turnSeatId: null,
    seatRequests: [],
    automation: { available: false, message: '掼蛋暂不支持机器人托管' },
    message: '',
    version: 3,
    turn: 1,
    lastPlay: null,
    tablePlays: [],
    trickStartIndex: 0,
    guandan: {
      deal: 1,
      levels: [2, 2],
      playedLevel: 2,
      finishOrder: [],
      result: null,
      matchWinner: null,
      exchange: { stage: 'none', givers: [], submitted: [], pairs: [], leader: null },
    },
    privateAction: null,
    ...overrides,
  };
}

/* Storage layout under test: these key strings are the durable storage contract. */
const seatRecord = (code: string, seat: number, name: string, roomMode: RoomMode = 'tablet') =>
  JSON.stringify({ code, role: 'player', seatId: seat, roomMode, name });
const tabCredential = (code: string, seat: number, token: string) =>
  JSON.stringify({ code, token, role: 'player', seatId: seat, roomMode: 'tablet' });
const seatTokenKey = (code: string, seat: number) => `ddz:token:player:${code}:${seat}`;
const roomRecordKey = (code: string) => `ddz:room:${code}`;

/* ------------------------------------------------------------------ *
 * F2 — superseded sockets
 * ------------------------------------------------------------------ */

test('a superseded socket yields the seat instead of reconnecting against the newer window', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/?room=AB12&seat=1', {
    local: {
      [seatTokenKey('AB12', 1)]: 't1',
      [roomRecordKey('AB12')]: seatRecord('AB12', 1, '阿伟'),
      [LAST_ROOM_KEY]: 'AB12',
    },
    session: { [TAB_SESSION_KEY]: tabCredential('AB12', 1, 't1') },
  });
  const controller = useGame();
  const socket = openSocket(browser);
  await flush();
  assert.equal(lastSent(socket).type, 'resume');
  socket.deliver({ id: lastSent(socket).id, type: 'session', code: 'AB12', token: 't1', role: 'player', seatId: 1, roomMode: 'tablet' });
  ack(socket);
  socket.deliver({ type: 'state', state: snapshot({ hand: [{ id: 'c1', rank: 5, suit: 'spade' }] }) });
  assert.equal(controller.state.value?.hand.length, 1);

  socket.serverClose(4000);

  assert.equal(controller.mode.value, 'home');
  assert.equal(controller.state.value, null);
  assert.match(controller.error.value, /另一个窗口或设备/);
  assert.equal(browser.url(), 'http://192.168.1.9:5180/', 'the hall, not a seat page that invites a new join');
  assert.equal(readTabCredential(browser.session), null, 'this tab is no longer in the room');

  // Durable credential and Continue survive untouched: the seat is given up, not destroyed.
  assert.equal(readRoomToken(browser.local, 'AB12', 'player', 1), 't1');
  assert.equal(readRoomRecord(browser.local, 'AB12')?.name, '阿伟');
  assert.equal(browser.local.getItem(LAST_ROOM_KEY), 'AB12');
  assert.equal(controller.savedSession.value?.seatId, 1);

  browser.clock.advance(120_000);
  assert.equal(browser.sockets.length, 1, 'no automatic re-dial after a superseded close');
  assert.equal(browser.clock.pending(), 0, 'no timer is left to restart the fight');

  const back = controller.resumeLastRoom();
  await flush();
  const again = openSocket(browser);
  await flush();
  assert.equal(lastSent(again).type, 'resume');
  assert.equal(lastSent(again).payload.token, 't1');
  again.deliver({ id: lastSent(again).id, type: 'session', code: 'AB12', token: 't1', role: 'player', seatId: 1, roomMode: 'tablet' });
  ack(again);
  await back;
  assert.equal(controller.mode.value, 'hand');
});

test('a superseded close during an in-flight resume does not restart the fight', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/?room=AB12&seat=1', {
    local: {
      [seatTokenKey('AB12', 1)]: 't1',
      [roomRecordKey('AB12')]: seatRecord('AB12', 1, '阿伟'),
      [LAST_ROOM_KEY]: 'AB12',
    },
  });
  const controller = useGame();
  const socket = openSocket(browser);
  await flush();
  assert.equal(lastSent(socket).type, 'resume', 'this window is resuming its own seat');

  // The other window got there first, so the server supersedes this socket while it waits.
  socket.serverClose(4000);
  await flush();

  assert.equal(controller.mode.value, 'home');
  assert.match(controller.error.value, /另一个窗口或设备/);
  assert.equal(controller.state.value, null);
  assert.equal(readRoomToken(browser.local, 'AB12', 'player', 1), 't1');
  assert.equal(controller.savedSession.value?.seatId, 1);
  browser.clock.advance(120_000);
  assert.equal(browser.sockets.length, 1, 'the superseded window never dials again');
  assert.equal(browser.clock.pending(), 0);
});

test('an ordinary network drop keeps the credential and reconnects on its own', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/?room=AB12&seat=1', {
    local: {
      [seatTokenKey('AB12', 1)]: 't1',
      [roomRecordKey('AB12')]: seatRecord('AB12', 1, '阿伟'),
      [LAST_ROOM_KEY]: 'AB12',
    },
  });
  const controller = useGame();
  const socket = openSocket(browser);
  await flush();
  socket.deliver({ id: lastSent(socket).id, type: 'session', code: 'AB12', token: 't1', role: 'player', seatId: 1, roomMode: 'tablet' });
  ack(socket);
  socket.deliver({ type: 'state', state: snapshot({ hand: [{ id: 'c1', rank: 5, suit: 'spade' }] }) });

  socket.serverClose(1006);

  assert.equal(controller.mode.value, 'hand', 'a dropped connection is not a reason to leave the room');
  assert.equal(controller.error.value, '');
  assert.equal(controller.state.value?.hand.length, 1, 'the board keeps what the server last confirmed');

  browser.clock.advance(30_000);
  assert.equal(browser.sockets.length, 2, 'the reconnect loop dials once');
  const again = openSocket(browser, 1);
  await flush();
  assert.equal(lastSent(again).type, 'resume');
  assert.equal(lastSent(again).payload.token, 't1');
  again.deliver({ id: lastSent(again).id, type: 'session', code: 'AB12', token: 't1', role: 'player', seatId: 1, roomMode: 'tablet' });
  ack(again);
  assert.equal(controller.mode.value, 'hand');
  assert.equal(readRoomToken(browser.local, 'AB12', 'player', 1), 't1');
});

test('a resume that stalls on an open socket reconnects instead of dropping the credential', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/?room=AB12&seat=1', {
    local: {
      [seatTokenKey('AB12', 1)]: 't1',
      [roomRecordKey('AB12')]: seatRecord('AB12', 1, '阿伟'),
      [LAST_ROOM_KEY]: 'AB12',
    },
  });
  const controller = useGame();
  const socket = openSocket(browser);
  await flush();
  assert.equal(lastSent(socket).type, 'resume');

  browser.clock.advance(15_000);
  await flush();
  assert.equal(socket.readyState, FakeSocket.CLOSED, 'the stalled socket is dropped');
  assert.equal(readRoomToken(browser.local, 'AB12', 'player', 1), 't1', 'the credential survives a stall');
  assert.equal(controller.mode.value, 'hand');
  browser.clock.advance(5_000);
  const second = browser.sockets.at(-1);
  assert.ok(second && second !== socket, 'a fresh socket is dialed for the retry');

  openSocket(browser);
  await flush();
  assert.equal(lastSent(second).type, 'resume');
  second.deliver({ id: lastSent(second).id, type: 'session', code: 'AB12', token: 't1', role: 'player', seatId: 1, roomMode: 'tablet' });
  ack(second);
  assert.equal(controller.mode.value, 'hand');
});

test('返回大厅 keeps the seat credential and the Continue entry', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/?room=AB12&seat=1', {
    local: {
      [seatTokenKey('AB12', 1)]: 't1',
      [roomRecordKey('AB12')]: seatRecord('AB12', 1, '阿伟'),
      [LAST_ROOM_KEY]: 'AB12',
    },
  });
  const controller = useGame();
  const socket = openSocket(browser);
  await flush();
  socket.deliver({ id: lastSent(socket).id, type: 'session', code: 'AB12', token: 't1', role: 'player', seatId: 1, roomMode: 'tablet' });
  ack(socket);

  controller.leaveRoom();

  assert.equal(controller.mode.value, 'home');
  assert.equal(controller.state.value, null);
  assert.equal(browser.url(), 'http://192.168.1.9:5180/');
  assert.equal(readTabCredential(browser.session), null);
  assert.equal(readRoomToken(browser.local, 'AB12', 'player', 1), 't1');
  assert.equal(controller.savedSession.value?.seatId, 1);
  browser.clock.advance(120_000);
  assert.equal(browser.sockets.length, 1, 'leaving never dials a new socket');
});

/* ------------------------------------------------------------------ *
 * F3 — guarded invalidation
 * ------------------------------------------------------------------ */

test('a stale window cannot erase the identity it was replaced by', async () => {
  // Another window was approved into seat 1 and stored the rotated token; this tab still holds
  // the old one and is about to be told that it is invalid.
  const browser = installBrowser('http://192.168.1.9:5180/?room=AB12&seat=1', {
    local: {
      [seatTokenKey('AB12', 1)]: 'T2-approved',
      [roomRecordKey('AB12')]: seatRecord('AB12', 1, '新主人'),
      [LAST_ROOM_KEY]: 'AB12',
    },
    session: { [TAB_SESSION_KEY]: tabCredential('AB12', 1, 'stale-T1') },
  });
  const controller = useGame();
  const socket = openSocket(browser);
  await flush();
  assert.equal(lastSent(socket).payload.token, 'stale-T1');
  socket.deliver({ id: lastSent(socket).id, type: 'error', message: '凭证已失效', code: 'INVALID_CREDENTIAL' });
  await flush();

  assert.equal(readRoomToken(browser.local, 'AB12', 'player', 1), 'T2-approved');
  assert.equal(readRoomRecord(browser.local, 'AB12')?.name, '新主人');
  assert.equal(browser.local.getItem(LAST_ROOM_KEY), 'AB12');
  assert.equal(readSavedSession({ tab: browser.session, durable: browser.local })?.name, '新主人');
  assert.equal(controller.savedSession.value?.name, '新主人');
  assert.equal(readTabCredential(browser.session), null, 'only this tab loses its dead credential');
  assert.equal(controller.state.value, null);
  assert.match(controller.error.value, /失效/);

  // Continue is a usable path, not a dangling record.
  const back = controller.resumeLastRoom();
  await flush();
  const again = openSocket(browser);
  await flush();
  assert.equal(lastSent(again).type, 'resume');
  assert.equal(lastSent(again).payload.token, 'T2-approved');
  again.deliver({ id: lastSent(again).id, type: 'session', code: 'AB12', token: 'T2-approved', role: 'player', seatId: 1, roomMode: 'tablet' });
  ack(again);
  await back;
  assert.equal(controller.mode.value, 'hand');
});

test('a dead credential of our own leaves no dangling record or Continue entry', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/?room=CD34&seat=2', {
    local: {
      [seatTokenKey('CD34', 2)]: 'dead',
      [roomRecordKey('CD34')]: seatRecord('CD34', 2, '我'),
      [LAST_ROOM_KEY]: 'CD34',
    },
  });
  const controller = useGame();
  const socket = openSocket(browser);
  await flush();
  socket.deliver({ id: lastSent(socket).id, type: 'error', message: '凭证已失效', code: 'INVALID_CREDENTIAL' });
  await flush();

  assert.equal(readRoomToken(browser.local, 'CD34', 'player', 2), null);
  assert.equal(readRoomRecord(browser.local, 'CD34'), null);
  assert.equal(browser.local.getItem(LAST_ROOM_KEY), null);
  assert.equal(readSavedSession({ tab: browser.session, durable: browser.local }), null);
  assert.equal(controller.savedSession.value, null);
  assert.equal(controller.mode.value, 'hand', 'the seat link stays actionable');
});

test('invalidating one seat spares the identity this browser holds in another seat', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/?room=AB12&seat=1', {
    local: {
      [seatTokenKey('AB12', 2)]: 'T-seat2',
      [roomRecordKey('AB12')]: seatRecord('AB12', 2, '我'),
      [LAST_ROOM_KEY]: 'AB12',
    },
    session: { [TAB_SESSION_KEY]: tabCredential('AB12', 1, 'stale-seat1') },
  });
  const controller = useGame();
  const socket = openSocket(browser);
  await flush();
  socket.deliver({ id: lastSent(socket).id, type: 'error', message: '凭证已失效', code: 'INVALID_CREDENTIAL' });
  await flush();

  assert.equal(readRoomToken(browser.local, 'AB12', 'player', 2), 'T-seat2');
  assert.equal(readRoomRecord(browser.local, 'AB12')?.seatId, 2);
  assert.equal(browser.local.getItem(LAST_ROOM_KEY), 'AB12');
  assert.equal(controller.savedSession.value?.seatId, 2);
  assert.equal(readTabCredential(browser.session), null);
});

test('invalidation removes storage only while it still holds that exact credential', () => {
  const tab = memoryStore();
  const durable = memoryStore();
  const stores: Stores = { tab, durable };
  const mine: Credential = { code: 'AB12', token: 'T1', role: 'player', seatId: 1, roomMode: 'tablet', name: '阿伟' };
  persistCredential(stores, mine);
  persistCredential(stores, { ...mine, token: 'T2', name: '新主人' });

  forgetCredential(stores, mine);
  assert.equal(readRoomToken(durable, 'AB12', 'player', 1), 'T2');
  assert.equal(readRoomRecord(durable, 'AB12')?.name, '新主人');
  assert.equal(durable.getItem(LAST_ROOM_KEY), 'AB12');
  assert.equal(readTabCredential(tab)?.token, 'T2');
  assert.equal(readSavedSession(stores)?.name, '新主人');

  forgetCredential(stores, { ...mine, token: 'T2', name: '新主人' });
  assert.equal(readRoomToken(durable, 'AB12', 'player', 1), null);
  assert.equal(readRoomRecord(durable, 'AB12'), null);
  assert.equal(durable.getItem(LAST_ROOM_KEY), null);
  assert.equal(readSavedSession(stores), null);

  // A record whose token already disappeared is dropped with it, even without a token match.
  persistCredential(stores, { ...mine, token: 'T3' });
  removeRoomToken(durable, 'AB12', 'player', 1);
  forgetCredential(stores, { ...mine, token: 'T3' });
  assert.equal(readRoomRecord(durable, 'AB12'), null);
  assert.equal(durable.getItem(LAST_ROOM_KEY), null);
});

/* ------------------------------------------------------------------ *
 * F4 — the room's game is durable metadata, never a guess
 * ------------------------------------------------------------------ */


test('a stored kind this build does not implement is dropped instead of coerced', () => {
  const durable = memoryStore();
  durable.setItem(roomRecordKey('AB12'), JSON.stringify({ code: 'AB12', role: 'player', seatId: 1, roomMode: 'tablet', game: 'poker' }));

  const record = readRoomRecord(durable, 'AB12');
  assert.ok(record, 'the rest of the record still describes a usable identity');
  assert.equal(record.game, undefined, 'an unknown kind must never become Doudizhu');
  assert.equal(record.seatId, 1);
});

test('a legacy record without a game resumes and is backfilled once the server confirms the kind', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/?room=AB12&seat=1', {
    local: {
      [seatTokenKey('AB12', 1)]: 't1',
      [roomRecordKey('AB12')]: seatRecord('AB12', 1, '阿伟'),
      [LAST_ROOM_KEY]: 'AB12',
    },
  });
  const controller = useGame();
  assert.equal(controller.gameKind.value, null, 'a remembered record is not proof of the live kind');

  const socket = openSocket(browser);
  await flush();
  socket.deliver({ id: lastSent(socket).id, type: 'session', code: 'AB12', token: 't1', role: 'player', seatId: 1, roomMode: 'tablet', game: 'guandan' });
  ack(socket);

  assert.equal(controller.gameKind.value, 'guandan');
  assert.equal(controller.savedSession.value?.game, 'guandan');
  assert.equal(readRoomRecord(browser.local, 'AB12')?.game, 'guandan', 'the confirmed kind lands in the durable record');

  socket.deliver({ type: 'state', state: guandanSnapshot() });
  assert.equal(controller.gameKind.value, 'guandan');
  assert.equal(controller.state.value?.game, 'guandan');
});

test('回到大厅 forgets the live kind but keeps the stored one for Continue', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/?room=AB12&seat=1', {
    local: {
      [seatTokenKey('AB12', 1)]: 't1',
      [roomRecordKey('AB12')]: seatRecord('AB12', 1, '阿伟'),
      [LAST_ROOM_KEY]: 'AB12',
    },
  });
  const controller = useGame();
  const socket = openSocket(browser);
  await flush();
  socket.deliver({ id: lastSent(socket).id, type: 'session', code: 'AB12', token: 't1', role: 'player', seatId: 1, roomMode: 'tablet', game: 'guandan' });
  ack(socket);
  assert.equal(controller.gameKind.value, 'guandan');

  controller.leaveRoom();

  assert.equal(controller.gameKind.value, null, 'no live room, no live kind');
  assert.equal(controller.savedSession.value?.game, 'guandan', 'Continue still knows which game it was');
});

test('createRoom refuses an unknown game instead of opening a Doudizhu room', async () => {
  installBrowser('http://192.168.1.9:5180/');
  const controller = useGame();

  await assert.rejects(
    () => controller.createRoom({ game: 'poker' as GameKind, roomMode: 'tablet' }),
    /游戏/,
  );

  assert.equal(controller.mode.value, 'home');
  assert.equal(controller.roomCode.value, '');
  assert.equal(controller.gameKind.value, null);
});

test('a newly created room resumes once on foreground and returns to an idle controller', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/');
  const listeners = new Map<string, () => void>();
  (scope.window as { addEventListener(type: string, listener: () => void): void }).addEventListener = (type, listener) => { listeners.set(type, listener); };
  const controller = useGame();
  const socket = openSocket(browser);
  const creating = controller.createRoom({ game: 'junqi', roomMode: 'phone', name: '教程验证' });
  await flush();
  const session = { type: 'session', code: 'AB12', token: 'new-token', role: 'player', seatId: 0, roomMode: 'phone', game: 'junqi' };
  socket.deliver(session); ack(socket); await creating;
  assert.equal(controller.busy.value, false);
  const resumes = () => socket.sent.map(raw => JSON.parse(raw) as WireMessage).filter(message => message.type === 'resume');
  for (let expected = 1; expected <= 2; expected++) {
    listeners.get('pageshow')!(); await flush();
    assert.equal(resumes().length, expected);
    socket.deliver(session); ack(socket);
    await flush(); await flush();
    assert.equal(resumes().length, expected, 'successful resume recursively restarted itself');
    assert.equal(controller.busy.value, false, 'foreground recovery left the original game busy');
  }
});

test('quick practice waits for the authoritative lobby after create ack before filling bots', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/');
  const controller = useGame(); const socket = openSocket(browser);
  const running = controller.quickPractice('doudizhu', '练习', 'easy');
  await flush();
  assert.equal(lastSent(socket).type, 'create');
  socket.deliver({ type: 'session', id: lastSent(socket).id, code: 'AB12', token: 'practice', role: 'player', seatId: 0, roomMode: 'phone', game: 'doudizhu' });
  ack(socket); await flush();
  assert.equal(lastSent(socket).type, 'create', 'an ack alone cannot confer lobby authority');
  const lobby = snapshot({ phase: 'lobby', selfSeat: 0, isHost: true, roomMode: 'phone', automation: { available: true, message: null } });
  lobby.seats = Array.from({ length: 3 }, (_, id) => ({ ...lobby.seats[0]!, id, name: id === 0 ? '练习' : null, ready: false }));
  socket.deliver({ type: 'state', state: lobby }); await flush();
  assert.equal(lastSent(socket).type, 'addBot'); assert.equal(lastSent(socket).payload.seatId, 1);
  ack(socket); await flush();
  assert.equal(lastSent(socket).type, 'addBot'); assert.equal(lastSent(socket).payload.seatId, 2);
  ack(socket); await flush();
  assert.equal(lastSent(socket).type, 'ready');
  ack(socket); await flush();
  assert.equal(lastSent(socket).type, 'start');
  ack(socket); await running;
  assert.equal(controller.busy.value, false);
  controller.leaveRoom();
});

test('failed quick practice retains its room and credential when the AI runtime is unavailable', async () => {
  const browser = installBrowser('http://192.168.1.9:5180/');
  const controller = useGame(); const socket = openSocket(browser);
  const running = controller.quickPractice('doudizhu', '练习', 'easy');
  const rejected = assert.rejects(running, /未安装机器人/);
  await flush();
  socket.deliver({ type: 'session', id: lastSent(socket).id, code: 'AB12', token: 'practice', role: 'player', seatId: 0, roomMode: 'phone', game: 'doudizhu' });
  ack(socket);
  socket.deliver({ type: 'state', state: snapshot({ phase: 'lobby', selfSeat: 0, isHost: true, roomMode: 'phone', automation: { available: false, message: '未安装机器人' } }) });
  await rejected;
  assert.equal(lastSent(socket).type, 'create');
  assert.equal(controller.busy.value, false);
  assert.equal(controller.mode.value, 'phone-table');
  assert.equal(readRoomToken(browser.local, 'AB12', 'player', 0), 'practice');
  controller.leaveRoom();
});
