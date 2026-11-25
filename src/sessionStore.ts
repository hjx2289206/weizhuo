// Durable identity store for the game controller.
//
// Two things must survive a closed browser: the secret credential of the seat this browser
// occupies (one record per room/role/seat) and enough non-secret metadata to offer a resume from
// the hall. Everything here is a pure function over injectable `Storage`-shaped objects, so the
// identity-resolution rules stay checkable without a browser.
//
// Storage layout (all opt-in; a private-mode browser simply gets no durable identity):
//   sessionStorage  ddz:session      active identity of THIS tab, includes the token
//   sessionStorage  ddz:last         room code this tab last used (Continue preference)
//   localStorage    ddz:last         room code this browser last used
//   localStorage    ddz:room:<CODE>  resumable identity metadata, never the token
//   localStorage    ddz:token:host:<CODE>          tablet host credential
//   localStorage    ddz:token:player:<CODE>:<SEAT>  player credential
//   sessionStorage  ddz:spectator:<CODE>        viewer credential, scoped to this tab
import { isGameKind } from '../shared/gameCatalog';
import type { GameKind, RoomMode, RoomRole } from '../shared/protocol';

export type Role = RoomRole;

/** Active identity of one tab: metadata plus the secret the server authenticates. */
export interface Credential {
  code: string;
  token: string;
  role: Role;
  seatId: number | null;
  roomMode: RoomMode;
  /** Kind of the room, once the server confirmed a known one; absent otherwise. */
  game?: GameKind;
  name?: string;
}

/** Resumable identity metadata, deliberately without the token. */
export interface SavedSession {
  code: string;
  role: Role;
  seatId: number | null;
  roomMode: RoomMode;
  /** Kind of the room, once the server confirmed a known one; absent otherwise. */
  game?: GameKind;
  name?: string;
}

/** What the URL of this page asks for. An empty `code` means "no room link was opened". */
export interface IdentityIntent {
  code: string;
  seat: number | null;
  view: 'table' | 'spectator' | null;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface Stores {
  /** Per-tab storage (sessionStorage): isolates two tabs of the same browser. */
  tab: StorageLike | null;
  /** Cross-tab storage (localStorage): what a re-opened or fresh tab can resume. */
  durable: StorageLike | null;
}

export const TAB_SESSION_KEY = 'ddz:session';
export const LAST_ROOM_KEY = 'ddz:last';

const roomRecordKey = (code: string) => `ddz:room:${code}`;
const hostTokenKey = (code: string) => `ddz:token:host:${code}`;
const playerTokenKey = (code: string, seat: number) => `ddz:token:player:${code}:${seat}`;
const spectatorKey = (code: string) => `ddz:spectator:${code}`;

/* ------------------------------------------------------------------ *
 * storage access
 * ------------------------------------------------------------------ */

function safeStorage(kind: 'local' | 'session'): StorageLike | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    /* blocked cookies / sandboxed frame: no durable identity, the caller must say so */
    return null;
  }
}

export function browserStores(): Stores {
  return { tab: safeStorage('session'), durable: safeStorage('local') };
}

function readKey(store: StorageLike | null, key: string): string | null {
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(store: StorageLike | null, key: string, value: string): void {
  if (!store) return;
  try {
    store.setItem(key, value);
  } catch {
    /* quota / private mode: the in-memory session still works */
  }
}

function removeKey(store: StorageLike | null, key: string): void {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * parsing
 * ------------------------------------------------------------------ */

export function normalizeCode(raw: string | null | undefined): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

export function readIntent(params: URLSearchParams): IdentityIntent {
  const rawSeat = params.get('seat');
  const trimmedSeat = rawSeat === null ? '' : rawSeat.trim();
  // Seat 0 is a real seat, so '' and 'x' must fall back to null instead of becoming 0.
  const seatValue = /^\d+$/.test(trimmedSeat) ? Number(trimmedSeat) : Number.NaN;
  const view = params.get('view');
  return {
    code: normalizeCode(params.get('room')),
    seat: view !== 'spectator' && Number.isSafeInteger(seatValue) ? seatValue : null,
    view: view === 'table' || view === 'spectator' ? view : null,
  };
}

/** Shared shape check for both stored record kinds; the token is validated by the caller. */
function parseIdentity(raw: string | null): SavedSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const code = normalizeCode(typeof parsed.code === 'string' ? parsed.code : '');
    if (!code) return null;
    const seatId = parsed.seatId;
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    const game = parsed.game;
    return {
      code,
      role: parsed.role === 'table' || parsed.role === 'spectator' ? parsed.role : 'player',
      seatId: typeof seatId === 'number' && Number.isSafeInteger(seatId) && seatId >= 0 ? seatId : null,
      roomMode: parsed.roomMode === 'phone' ? 'phone' : 'tablet',
      // Absent or unknown kinds stay absent: an old record is still a valid record.
      ...(isGameKind(game) ? { game } : {}),
      ...(name ? { name } : {}),
    };
  } catch {
    return null;
  }
}

export function parseCredential(raw: string | null): Credential | null {
  const identity = parseIdentity(raw);
  if (!identity) return null;
  try {
    const parsed = JSON.parse(raw as string) as Record<string, unknown> | null;
    const token = parsed && typeof parsed.token === 'string' ? parsed.token : '';
    return token ? { ...identity, token } : null;
  } catch {
    return null;
  }
}

export function readTabCredential(store: StorageLike | null): Credential | null {
  return parseCredential(readKey(store, TAB_SESSION_KEY));
}

/** Writes this tab's active identity; `null` clears it (return to hall) without touching records. */
export function writeTabCredential(store: StorageLike | null, credential: Credential | null): void {
  if (!credential) {
    removeKey(store, TAB_SESSION_KEY);
    return;
  }
  writeKey(store, TAB_SESSION_KEY, JSON.stringify(credential));
}

/* ------------------------------------------------------------------ *
 * durable records
 * ------------------------------------------------------------------ */

function tokenKey(role: Role, code: string, seatId: number | null): string | null {
  if (role === 'table') return hostTokenKey(code);
  return role === 'player' && seatId !== null ? playerTokenKey(code, seatId) : null;
}

export function readRoomToken(store: StorageLike | null, code: string, role: Role, seatId: number | null): string | null {
  const key = tokenKey(role, code, seatId);
  return key ? readKey(store, key) : null;
}

export function writeRoomToken(store: StorageLike | null, code: string, role: Role, seatId: number | null, token: string): void {
  const key = tokenKey(role, code, seatId);
  if (key) writeKey(store, key, token);
}

export function removeRoomToken(store: StorageLike | null, code: string, role: Role, seatId: number | null): void {
  const key = tokenKey(role, code, seatId);
  if (key) removeKey(store, key);
}

export function readRoomRecord(store: StorageLike | null, code: string): SavedSession | null {
  const record = parseIdentity(readKey(store, roomRecordKey(code)));
  return record && record.code === code ? record : null;
}

export function readLastCode(stores: Stores): string | null {
  const tab = readKey(stores.tab, LAST_ROOM_KEY);
  if (tab) return normalizeCode(tab) || null;
  const durable = readKey(stores.durable, LAST_ROOM_KEY);
  return durable ? normalizeCode(durable) || null : null;
}

export function writeLastCode(stores: Stores, code: string): void {
  writeKey(stores.tab, LAST_ROOM_KEY, code);
  writeKey(stores.durable, LAST_ROOM_KEY, code);
}

export function clearLastCode(stores: Stores, code: string): void {
  if (readKey(stores.tab, LAST_ROOM_KEY) === code) removeKey(stores.tab, LAST_ROOM_KEY);
  if (readKey(stores.durable, LAST_ROOM_KEY) === code) removeKey(stores.durable, LAST_ROOM_KEY);
}

/** The room the hall offers to continue, or null when nothing resumable is left. */
export function readSavedSession(stores: Stores): SavedSession | null {
  const code = readLastCode(stores);
  if (!code) return null;
  const record = readRoomRecord(stores.durable, code);
  if (!record) return null;
  if (!readRoomToken(stores.durable, record.code, record.role, record.seatId)) return null;
  return record;
}

/** Records a freshly authenticated identity everywhere it must be remembered. */
export function persistCredential(stores: Stores, credential: Credential): SavedSession {
  const record: SavedSession = {
    code: credential.code,
    role: credential.role,
    seatId: credential.seatId,
    roomMode: credential.roomMode,
    ...(credential.game ? { game: credential.game } : {}),
    ...(credential.name ? { name: credential.name } : {}),
  };
  writeTabCredential(stores.tab, credential);
  if (credential.role === 'spectator') {
    writeKey(stores.tab, spectatorKey(credential.code), JSON.stringify(credential));
    return record;
  }
  writeRoomToken(stores.durable, credential.code, credential.role, credential.seatId, credential.token);
  writeKey(stores.durable, roomRecordKey(credential.code), JSON.stringify(record));
  writeLastCode(stores, credential.code);
  return record;
}

/**
 * The server rejected this credential for good (revoked token / vanished room). Remove only the
 * data that still belongs to it: a newer token another window wrote into the same seat slot, a
 * record describing another identity, and the Continue pointer of a still-resumable room all
 * survive, so an out-of-date window cannot erase the identity it was replaced by.
 */
export function forgetCredential(stores: Stores, credential: Credential): void {
  const tab = readTabCredential(stores.tab);
  if (tab && tab.code === credential.code && tab.token === credential.token) writeTabCredential(stores.tab, null);
  if (credential.role === 'spectator') {
    const key = spectatorKey(credential.code);
    if (parseCredential(readKey(stores.tab, key))?.token === credential.token) removeKey(stores.tab, key);
    return;
  }

  const stored = readRoomToken(stores.durable, credential.code, credential.role, credential.seatId);
  const tokenIsOurs = stored !== null && stored === credential.token;
  if (tokenIsOurs) removeRoomToken(stores.durable, credential.code, credential.role, credential.seatId);

  const record = readRoomRecord(stores.durable, credential.code);
  const recordIsOurs = record !== null && record.role === credential.role && record.seatId === credential.seatId;
  // A record whose token is gone would be a dangling Continue; drop it only when nothing newer
  // occupies the slot, and never when it describes a different seat or role.
  if (recordIsOurs && (tokenIsOurs || stored === null)) removeKey(stores.durable, roomRecordKey(credential.code));

  if (readSavedSession(stores) === null) clearLastCode(stores, credential.code);
}

/**
 * Every local trace of a room the server reports as non-existent. Only ever called for that code,
 * and a room that is gone has no newer credential worth protecting, so this purge stays whole-room.
 */
export function forgetRoom(stores: Stores, code: string): void {
  const tab = readTabCredential(stores.tab);
  if (tab && tab.code === code) removeKey(stores.tab, TAB_SESSION_KEY);
  removeKey(stores.tab, spectatorKey(code));
  const record = readRoomRecord(stores.durable, code);
  if (record) removeRoomToken(stores.durable, code, record.role, record.seatId);
  removeKey(stores.durable, roomRecordKey(code));
  removeRoomToken(stores.durable, code, 'table', null);
  clearLastCode(stores, code);
}

/* ------------------------------------------------------------------ *
 * identity resolution
 * ------------------------------------------------------------------ */

/**
 * Which stored identity this page is asking for. An explicit `seat` / `view` link always wins, so a
 * cached host credential can never answer a seat invite and one tab never assumes another seat.
 */
export function resolveCredential(intent: IdentityIntent, stores: Stores): Credential | null {
  if (!intent.code) return null;

  if (intent.view === 'spectator') {
    const saved = parseCredential(readKey(stores.tab, spectatorKey(intent.code)));
    return saved?.role === 'spectator' && saved.code === intent.code ? saved : null;
  }

  const tab = readTabCredential(stores.tab);
  if (tab && tab.code === intent.code) {
    if (intent.seat !== null) {
      if (tab.role === 'player' && tab.seatId === intent.seat) return tab;
    } else if (intent.view === 'table') {
      if (tab.role === 'table') return tab;
    } else if (tab.role !== 'spectator') {
      return tab;
    }
  }

  const record = readRoomRecord(stores.durable, intent.code);
  const roomMode: RoomMode = record ? record.roomMode : 'tablet';

  if (intent.seat !== null) {
    const token = readRoomToken(stores.durable, intent.code, 'player', intent.seat);
    if (!token) return null;
    const name = record && record.role === 'player' && record.seatId === intent.seat ? record.name : undefined;
    return { code: intent.code, token, role: 'player', seatId: intent.seat, roomMode, name };
  }

  if (intent.view === 'table') {
    const token = readRoomToken(stores.durable, intent.code, 'table', null);
    if (!token) return null;
    return { code: intent.code, token, role: 'table', seatId: null, roomMode };
  }

  if (!record) return null;
  const token = readRoomToken(stores.durable, record.code, record.role, record.seatId);
  if (!token) return null;
  return { ...record, token };
}
