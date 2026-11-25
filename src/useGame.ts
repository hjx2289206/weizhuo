import { getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import type {
  ClientMessage,
  ClientMessageType,
  ClientPayload,
  GameKind,
  HintPlay,
  PhraseMessage,
  Position,
  RoomMode,
  RoomSummary,
  SeatRequestMessage,
  ServerMessage,
  Snapshot,
} from '../shared/protocol';
import { quickPhrase } from '../shared/phrases';
import { isBoardGame, isGameKind } from '../shared/gameCatalog';
import { isBoardAiGame, type BoardAiGame } from '../shared/boardAi';
import type { BoardUndoClientAction } from '../shared/boardUndo';
import {
  browserStores,
  forgetCredential,
  forgetRoom,
  normalizeCode,
  persistCredential,
  readIntent,
  readRoomRecord,
  readRoomToken,
  readSavedSession,
  resolveCredential,
  writeTabCredential,
  type Credential,
  type Role,
  type SavedSession,
} from './sessionStore';
import { attachGameSounds, receivesGameAudio, sfx } from './sound';
import { HAPTIC_TURN, vibrate } from './haptics';
import { createHeartbeat } from './connectionHeartbeat';

type Mode = 'home' | 'table' | 'hand' | 'phone-table' | 'spectator';

interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
}

interface OpenWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Waiting for a host decision: this client is unbound and must not hold cards. */
interface WaitingSeat {
  code: string;
  seatId: number;
}

/** Transport/connection failures: the credential stays valid and is retried. */
class TransportError extends Error {}

/** The server answered with a machine code; only definitive codes may drop a credential. */
class ServerError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
  }
}

/** Only these codes prove a stored credential is dead; anything else keeps it. */
const DEFINITIVE_CODES: Record<string, true> = { INVALID_CREDENTIAL: true, ROOM_NOT_FOUND: true };

/** `Connection.supersede()` in server/index.ts closes a superseded socket with this code. */
const SUPERSEDED_CLOSE_CODE = 4000;

/* ------------------------------------------------------------------ *
 * constants / pure helpers
 * ------------------------------------------------------------------ */

const REQUEST_TIMEOUT_MS = 15000;
const RESUME_TIMEOUT_MS = 10000;
const OPEN_TIMEOUT_MS = 8000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10000;

let idSeed = 0;

function newId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  idSeed += 1;
  return `c${Date.now().toString(36)}${idSeed.toString(36)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]' || value.endsWith('.localhost');
}

function isBidValue(value: number): value is 0 | 1 | 2 | 3 {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function reconnectDelay(attempt: number): number {
  const base = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/* ------------------------------------------------------------------ *
 * useGame
 * ------------------------------------------------------------------ */

export function useGame() {
  const state = ref<Snapshot | null>(null);
  // Synthesized table audio: accepted plays, 不要, your-turn chime, tribute bell, win/lose.
  attachGameSounds(state);
  // A real change of turn (or a new deal) is the only moment that earns a haptic pulse; ordinary
  // snapshots such as renames must stay silent.
  watch(state, (snapshot, previous) => {
    const becameMyTurn = snapshot !== null &&
      previous !== null &&
      snapshot.role === 'player' &&
      snapshot.selfSeat !== null &&
      snapshot.turn === snapshot.selfSeat &&
      (previous.turn !== snapshot.turn || previous.phase !== snapshot.phase);
    if (becameMyTurn) vibrate(HAPTIC_TURN);
  });
  const connected = ref(false);
  const busy = ref(false);
  const error = ref('');
  const mode = ref<Mode>('home');
  const roomCode = ref('');
  const seatId = ref<number | null>(null);
  const inviteBase = ref(location.origin);
  const selected = ref<string[]>([]);
  /** Latest private hint list and its cycling cursor. */
  const hintPlays = ref<HintPlay[]>([]);
  const hintIndex = ref(0);
  let hintRequestInFlight = false;
  /** Read-only public preview of a room the user asked to inspect. */
  const roomInfo = ref<RoomSummary | null>(null);
  /** Latest answer to this client's own seat-replacement request. */
  const seatRequest = ref<SeatRequestMessage | null>(null);
  /** Latest quick phrase shown as a short-lived table banner; never part of game state. */
  const phrase = ref<PhraseMessage | null>(null);
  let phraseTimer: number | null = null;
  /** Resumable identity of this browser, without its secret; null when nothing is resumable. */
  const savedSession = ref<SavedSession | null>(null);
  /**
   * Kind of the room this client is bound to, as last confirmed by the server. Null while nothing
   * is confirmed, so no screen renders a Guandan board from a merely remembered Doudizhu room.
   */
  const gameKind = ref<GameKind | null>(null);

  let socket: WebSocket | null = null;
  let socketOpen = false;
  let session: Credential | null = null;
  let resumePass: Promise<ServerError | null> | null = null;
  let resumedSocket: WebSocket | null = null;
  let disposed = false;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  let openWaiters: OpenWaiter[] = [];
  let lastHandSignature = '';
  let lastPhaseSignature = '';
  let lastTurnSignature: number | null = null;
  let lastPlaySignature = '';
  let waitingSeat: WaitingSeat | null = null;
  let pendingName = '';
  let lastInspectCode = '';
  const pending = new Map<string, PendingRequest>();
  let workflowBusy = false;
  const heartbeat = createHeartbeat({
    send: id => sendMessage({ id, type: 'ping', payload: {} }),
    stale: () => {
      if (disposed) return;
      closeSocket();
      if (session) scheduleReconnect();
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: id => window.clearTimeout(id),
  });
  const stores = browserStores();

  /* ---- mode / url ---- */

  /** Authenticated identity decides the screen; URL intent only covers pre-session and recovery. */
  function syncMode(): void {
    if (session) {
      mode.value = session.role === 'spectator' ? 'spectator' : session.role === 'table' ? 'table' : session.roomMode === 'phone' ? 'phone-table' : 'hand';
      return;
    }
    const intent = readIntent(new URLSearchParams(location.search));
    mode.value = intent.code && intent.seat !== null ? 'hand' : 'home';
  }

  function syncUrl(): void {
    try {
      const next = new URL(location.href);
      if (session) {
        next.searchParams.set('room', session.code);
        if (session.role !== 'player') {
          next.searchParams.set('view', session.role);
          next.searchParams.delete('seat');
        } else {
          next.searchParams.set('seat', String(session.seatId ?? ''));
          next.searchParams.delete('view');
        }
      }
      const target = `${next.pathname}${next.search}${next.hash}`;
      if (target !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, '', target);
    } catch {
      /* navigation restrictions: URL update is cosmetic */
    }
  }

  function clearUrlIntent(): void {
    try {
      const next = new URL(location.href);
      next.searchParams.delete('room');
      next.searchParams.delete('seat');
      next.searchParams.delete('view');
      const target = `${next.pathname}${next.search}${next.hash}`;
      if (target !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, '', target);
    } catch {
      /* ignore */
    }
  }

  /* ---- identity ---- */

  function beginSwitch(): void {
    waitingSeat = null;
    seatRequest.value = null;
    roomInfo.value = null;
    pendingName = '';
    error.value = '';
    state.value = null;
    gameKind.value = null;
    selected.value = [];
    lastHandSignature = '';
    lastPhaseSignature = '';
  }

  function applySession(credential: Credential): void {
    if (session?.role === 'spectator' && credential.role === 'player') {
      forgetCredential(stores, session);
      state.value = null;
    }
    session = credential;
    const record = persistCredential(stores, credential);
    savedSession.value = credential.role === 'spectator' ? readSavedSession(stores) : record;
    gameKind.value = credential.game ?? null;
    roomCode.value = credential.code;
    seatId.value = credential.seatId;
    error.value = '';
    syncUrl();
    syncMode();
  }

  /**
   * The server rejected this identity for good (revoked token / vanished room). Drop the
   * credential, keep an actionable message, and fall back to the URL intent so a seat invite
   * still lands on the join / replacement screen.
   */
  function dropIdentity(credential: Credential, failure: ServerError): void {
    forgetCredential(stores, credential);
    if (session === credential) {
      session = null;
      state.value = null;
      gameKind.value = null;
      selected.value = [];
      lastHandSignature = '';
      lastPhaseSignature = '';
      waitingSeat = null;
      seatRequest.value = null;
    }
    savedSession.value = readSavedSession(stores);
    error.value =
      failure.code === 'ROOM_NOT_FOUND'
        ? '房间不存在或已过期，请重新创建或加入'
        : credential.role === 'spectator' ? '旁观凭证已失效，请重新旁观' : '本机凭证已失效，请重新加入或向房主申请替换座位';
    syncMode();
  }

  /** The snapshot's seat name is authoritative; keep the saved record in step with it. */
  function adoptName(name: string): void {
    if (!session || !name || session.name === name) return;
    session.name = name;
    savedSession.value = persistCredential(stores, session);
  }

  /* ---- pending requests / busy ---- */

  function syncBusy(): void {
    busy.value = workflowBusy || pending.size > 0;
  }

  function settle(id: string, failure: Error | null): void {
    const entry = pending.get(id);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    pending.delete(id);
    syncBusy();
    if (failure) entry.reject(failure);
    else entry.resolve();
  }

  function failPending(message: string): void {
    if (pending.size === 0) return;
    const entries = [...pending.values()];
    pending.clear();
    syncBusy();
    for (const entry of entries) {
      window.clearTimeout(entry.timer);
      entry.reject(new TransportError(message));
    }
  }

  function flushOpenWaiters(): void {
    const waiters = openWaiters;
    openWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  function failOpenWaiters(failure: Error): void {
    const waiters = openWaiters;
    openWaiters = [];
    for (const waiter of waiters) waiter.reject(failure);
  }

  /* ---- socket ---- */

  function ensureSocket(): WebSocket | null {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return socket;
    if (typeof WebSocket === 'undefined') return null;
    let ws: WebSocket;
    try {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return null;
    }
    socket = ws;
    ws.addEventListener('open', () => {
      if (socket !== ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      socketOpen = true;
      connected.value = true;
      heartbeat.start();
      reconnectAttempts = 0;
      flushOpenWaiters();
      resumeOnSocket(ws);
    });
    ws.addEventListener('message', (event: MessageEvent) => {
      if (socket !== ws) return;
      handleMessage(event.data);
    });
    ws.addEventListener('close', (event: CloseEvent) => {
      if (socket !== ws) return;
      socket = null;
      socketOpen = false;
      connected.value = false;
      heartbeat.stop();
      cancelWaitingSeat('连接已断开，请重新申请');
      // 4000 = the server superseded this socket because another window/device resumed the seat.
      // Reconnecting would only supersede that newer window in return, so give the seat up here.
      if (event.code === SUPERSEDED_CLOSE_CODE && session) {
        returnToHall('这个座位已在另一个窗口或设备继续，本窗口已退出。可点击“继续牌局”重新进入。');
      }
      failPending('连接已断开，请重试');
      failOpenWaiters(new TransportError('连接已断开，请重试'));
      if (!disposed && session) scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      /* a failed connection always closes right after; handled there */
    });
    return ws;
  }

  /** Detach this tab's socket without creating a new one. */
  function closeSocket(): void {
    heartbeat.stop();
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = socket;
    socket = null;
    socketOpen = false;
    resumedSocket = null;
    connected.value = false;
    failPending('连接已中断');
    failOpenWaiters(new TransportError('连接已中断'));
    if (ws) {
      try {
        ws.close(1000, 'closed');
      } catch {
        /* ignore */
      }
    }
  }

  function waitForOpen(timeoutMs = OPEN_TIMEOUT_MS): Promise<void> {
    if (socketOpen) return Promise.resolve();
    ensureSocket();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        openWaiters = openWaiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new TransportError('无法连接服务器，请检查网络'));
      }, timeoutMs);
      const waiter: OpenWaiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve();
        },
        reject: (failure: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(failure);
        },
      };
      openWaiters.push(waiter);
    });
  }

  function sendMessage(message: ClientMessage): boolean {
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  async function request(type: ClientMessageType, payload: ClientPayload, timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
    if (disposed) throw new TransportError('会话已关闭');
    await waitForOpen();
    if (disposed) throw new TransportError('会话已关闭');
    const id = newId();
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => settle(id, new TransportError('请求超时，请重试')), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      syncBusy();
      if (!sendMessage({ id, type, payload })) {
        settle(id, new TransportError('连接已断开，请重试'));
      }
    });
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== null || !session) return;
    const delay = reconnectDelay(reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (disposed || !session) return;
      ensureSocket();
    }, delay);
  }

  function handleOnline(): void {
    if (disposed || !session) return;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    ensureSocket();
    if (socketOpen) {
      heartbeat.pulse();
      void resumeSession();
    }
  }

  function handleForeground(): void {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      heartbeat.stop();
      return;
    }
    if (disposed || !session) return;
    // A nominally OPEN socket can be stale after sleep. Request an authenticated snapshot
    // and restart liveness checks; a timeout preserves the credential and reconnects.
    if (socketOpen) heartbeat.start();
    handleOnline();
  }

  function reconnectNow(): void {
    if (disposed || !session) return;
    closeSocket();
    ensureSocket();
  }

  /* ---- incoming messages ---- */

  /**
   * Start a resume for this socket unless one is already running on it. A socket that opened while a
   * pass was running is left unclaimed; the pass that finishes starts the next one.
   */
  function resumeOnSocket(ws: WebSocket | null): void {
    if (!session || !ws || resumePass || resumedSocket === ws) return;
    resumedSocket = ws;
    void resumeSession();
  }

  /**
   * One resume pass at a time: concurrent callers share the running pass, and a socket that appeared
   * while it ran gets a pass of its own, so the client never stays silently unauthenticated.
   */
  function resumeSession(): Promise<ServerError | null> {
    if (resumePass) return resumePass;
    const pass = runResumePass().then((result) => {
      resumePass = null;
      if (session && socket && resumedSocket !== socket) void resumeSession();
      return result;
    });
    resumePass = pass;
    return pass;
  }

  /**
   * Re-authenticates the stored identity. Definitive codes drop the credential; a transport stall
   * keeps it and hands control back to the normal reconnect loop.
   */
  async function runResumePass(): Promise<ServerError | null> {
    const credential = session;
    if (!credential || disposed) return null;
    try {
      await request('resume', { code: credential.code, token: credential.token }, RESUME_TIMEOUT_MS);
      return null;
    } catch (caught) {
      if (disposed || session !== credential) return null;
      if (caught instanceof TransportError) {
        /* Still a valid credential. If the socket is nominally open the resume stalled on it, so
           drop that socket and let the ordinary reconnect loop try again. */
        if (socketOpen) {
          closeSocket();
          scheduleReconnect();
        }
        return null;
      }
      if (caught instanceof ServerError && caught.code !== null && DEFINITIVE_CODES[caught.code] === true) {
        dropIdentity(credential, caught);
        return caught;
      }
      /* Rule errors and timeouts are not proof the credential is dead: keep it and say so. */
      error.value = caught instanceof Error ? caught.message : '恢复会话失败';
      return null;
    }
  }

  /** Resume a known identity and report a definitive rejection to the caller. */
  async function bindResume(credential: Credential): Promise<void> {
    await waitForOpen();
    const background = resumePass;
    resumedSocket = socket;
    session = credential;
    roomCode.value = credential.code;
    seatId.value = credential.seatId;
    syncMode();
    // A pass for the previous identity must end before this credential gets its own.
    if (background) await background;
    const failure = await resumeSession();
    if (failure) throw failure;
  }

  function applySnapshot(snapshot: Snapshot): void {
    state.value = snapshot;
    gameKind.value = snapshot.game;
    const credential = session;
    if (!credential) return;
    const roomMode: RoomMode = snapshot.roomMode === 'phone' ? 'phone' : 'tablet';
    // The server owns both facts. A legacy record that never carried `game` is backfilled here,
    // which is the only place a stored identity learns its kind.
    if (roomMode !== credential.roomMode || credential.game !== snapshot.game) {
      credential.roomMode = roomMode;
      credential.game = snapshot.game;
      const record = persistCredential(stores, credential);
      if (credential.role !== 'spectator') savedSession.value = record;
      syncMode();
    }
    if (credential.role !== 'player' || snapshot.selfSeat === null) return;
    const seat = snapshot.seats.find((entry) => entry.id === snapshot.selfSeat);
    if (seat && seat.name) adoptName(seat.name);
  }

  /** A pending request cannot survive the socket that carried it: the server drops it on close. */
  function cancelWaitingSeat(reason: string): void {
    const waiting = waitingSeat;
    waitingSeat = null;
    if (!waiting) return;
    const current = seatRequest.value;
    if (current && current.code === waiting.code && current.seatId === waiting.seatId) {
      seatRequest.value = { ...current, status: 'cancelled', message: reason };
    }
  }

  function handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const message = parsed as ServerMessage;
    switch (message.type) {
      case 'pong': {
        heartbeat.pong(message.id);
        return;
      }
      case 'session': {
        const code = normalizeCode(message.code);
        const token = typeof message.token === 'string' ? message.token : '';
        if (!code || !token) return;
        const role: Role = message.role === 'table' || message.role === 'spectator' ? message.role : 'player';
        const seat = typeof message.seatId === 'number' && Number.isSafeInteger(message.seatId) ? message.seatId : null;
        const name = pendingName || session?.name || '';
        // A session reply authenticates the current socket after create/join as well as resume.
        // Otherwise the first foreground refresh repeatedly resumes an already bound socket.
        resumedSocket = socket;
        waitingSeat = null;
        pendingName = '';
        seatRequest.value = null;
        roomInfo.value = null;
        applySession({
          code,
          token,
          role,
          seatId: seat,
          roomMode: message.roomMode === 'phone' ? 'phone' : 'tablet',
          ...(isGameKind(message.game) ? { game: message.game } : {}),
          ...(name && role !== 'spectator' ? { name } : {}),
        });
        return;
      }
      case 'state': {
        if (message.state && typeof message.state === 'object') applySnapshot(message.state);
        return;
      }
      case 'room-info': {
        const info = message.room;
        if (info && typeof info.code === 'string' && normalizeCode(info.code) === lastInspectCode) roomInfo.value = info;
        return;
      }
      case 'seat-request': {
        const code = normalizeCode(message.code);
        const status = message.status === 'pending' ? 'pending' : message.status === 'rejected' ? 'rejected' : 'cancelled';
        seatRequest.value = {
          type: 'seat-request',
          id: typeof message.id === 'string' ? message.id : '',
          requestId: typeof message.requestId === 'string' ? message.requestId : '',
          code,
          seatId: typeof message.seatId === 'number' ? message.seatId : 0,
          status,
          message: typeof message.message === 'string' ? message.message : '',
        };
        if (status !== 'pending') waitingSeat = null;
        return;
      }
      case 'phrase': {
        if ((message.seatId !== null && typeof message.seatId !== 'number') || typeof message.text !== 'string') return;
        const valid = quickPhrase(message.phraseId);
        if (!valid) return;
        phrase.value = {
          type: 'phrase',
          seatId: message.seatId,
          name: typeof message.name === 'string' ? message.name : '玩家',
          phraseId: valid.id,
          text: message.text,
          at: typeof message.at === 'number' ? message.at : Date.now(),
        };
        if (phraseTimer !== null) window.clearTimeout(phraseTimer);
        phraseTimer = window.setTimeout(() => {
          phrase.value = null;
          phraseTimer = null;
        }, 3600);
        return;
      }
      case 'hint': {
        if (typeof message.id !== 'string') return;
        const snapshot = state.value;
        const live = new Set(snapshot?.hand.map((card) => card.id) ?? []);
        const plays = Array.isArray(message.plays)
          ? message.plays.filter((play): play is HintPlay =>
              Boolean(play) &&
              Array.isArray(play.cards) &&
              play.cards.length > 0 &&
              play.cards.every((id) => typeof id === 'string' && live.has(id)),
            )
          : [];
        // A hint computed for an older turn or a hand that has since changed is discarded rather
        // than selecting cards the player no longer owns.
        const canApply = snapshot != null &&
          snapshot.role === 'player' &&
          snapshot.phase === 'playing' &&
          snapshot.turn === snapshot.selfSeat;
        hintPlays.value = canApply ? plays : [];
        hintIndex.value = 0;
        if (!canApply) return;
        if (plays.length === 0) {
          const mustFollow = snapshot.lastPlay != null && snapshot.lastPlay.seatId !== snapshot.selfSeat;
          error.value = mustFollow ? '没有能管上的牌，只能不出' : '暂时没有可提示的出牌';
          return;
        }
        applyHintAt(0);
        return;
      }
      case 'dissolved': {
        const code = normalizeCode(typeof message.code === 'string' ? message.code : '');
        if (code && roomCode.value && code !== roomCode.value) return;
        const credential = session;
        returnToHall(typeof message.message === 'string' && message.message ? message.message : '房间已被房主解散');
        if (credential) forgetCredential(stores, credential);
        if (code) forgetRoom(stores, code);
        savedSession.value = readSavedSession(stores);
        return;
      }
      case 'ack': {
        if (typeof message.id === 'string') settle(message.id, null);
        return;
      }
      case 'error': {
        const text = typeof message.message === 'string' && message.message ? message.message : '服务器返回错误';
        const code = typeof message.code === 'string' && message.code ? message.code : null;
        if (typeof message.id === 'string' && pending.has(message.id)) settle(message.id, new ServerError(text, code));
        else error.value = text;
        return;
      }
      default:
        return;
    }
  }

  /* ---- invite base ---- */

  async function loadInviteBase(): Promise<void> {
    const fallback = trimTrailingSlash(location.origin);
    try {
      const response = await fetch('/api/network', { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { urls?: unknown } | null;
      const urls = data && Array.isArray(data.urls) ? data.urls.filter((url): url is string => typeof url === 'string' && url.length > 0) : [];
      if (isLoopbackHost(location.hostname)) {
        const lan = urls.find((url) => {
          try {
            return !isLoopbackHost(new URL(url).hostname);
          } catch {
            return false;
          }
        });
        inviteBase.value = trimTrailingSlash(lan ?? urls[0] ?? fallback);
      } else {
        inviteBase.value = fallback;
      }
    } catch {
      inviteBase.value = fallback;
    }
  }

  function inviteUrl(seat: number | null): string {
    const base = trimTrailingSlash(inviteBase.value || location.origin);
    const params = new URLSearchParams();
    if (roomCode.value) params.set('room', roomCode.value);
    if (seat === null) params.set('view', 'spectator');
    else params.set('seat', String(seat));
    return `${base}/?${params.toString()}`;
  }

  /* ---- commands ---- */

  async function createRoom(options: { game: GameKind; roomMode: RoomMode; name?: string }): Promise<void> {
    // An unknown kind is refused outright: guessing here would open a Doudizhu room under a wrong name.
    const game = options?.game;
    if (!isGameKind(game)) throw new Error('请选择要创建的游戏');
    const roomMode: RoomMode = options && options.roomMode === 'phone' ? 'phone' : 'tablet';
    const name = typeof options?.name === 'string' ? options.name.trim() : '';
    // A phone table has no separate big screen, so the creator needs a visible name up front.
    if (roomMode === 'phone' && !name) throw new Error('请输入昵称');
    if (session) throw new Error('请先返回大厅再开新房间');
    beginSwitch();
    pendingName = name;
    const payload: { game: GameKind; roomMode: RoomMode; name?: string } = { game, roomMode };
    if (name) payload.name = name;
    try {
      await request('create', payload);
    } catch (caught) {
      pendingName = '';
      throw caught;
    }
  }

  async function joinRoom(code: string, seat: number, name: string): Promise<void> {
    const room = normalizeCode(code);
    const nickname = name.trim();
    if (!room) throw new Error('请输入房间号');
    if (!Number.isSafeInteger(seat) || seat < 0) throw new Error('请选择座位');
    if (!nickname) throw new Error('请输入昵称');
    const watchingHere = session?.role === 'spectator' && session.code === room;
    if (session && !watchingHere) throw new Error('请先返回大厅再切换房间');
    if (!watchingHere) beginSwitch();
    // Owned seat: resume that exact identity instead of asking the server to give the seat away.
    const token = watchingHere ? null : readRoomToken(stores.durable, room, 'player', seat);
    if (token) {
      const record = readRoomRecord(stores.durable, room);
      await bindResume({
        code: room,
        token,
        role: 'player',
        seatId: seat,
        roomMode: record && record.roomMode === 'phone' ? 'phone' : 'tablet',
        ...(record && record.name ? { name: record.name } : {}),
      });
      return;
    }
    pendingName = nickname;
    try {
      await request('join', { code: room, seatId: seat, name: nickname });
    } catch (caught) {
      pendingName = '';
      if (caught instanceof ServerError && caught.code === 'ROOM_NOT_FOUND') forgetRoom(stores, room);
      throw caught;
    }
  }

  async function spectateRoom(code: string): Promise<void> {
    const room = normalizeCode(code);
    if (!room) throw new Error('请输入房间号');
    if (session) throw new Error('请先返回大厅再切换房间');
    beginSwitch();
    const remembered = resolveCredential({ code: room, seat: null, view: 'spectator' }, stores);
    if (remembered) {
      try { await bindResume(remembered); return; }
      catch (failure) {
        if (!(failure instanceof ServerError) || failure.code !== 'INVALID_CREDENTIAL') throw failure;
      }
    }
    await request('spectate', { code: room });
  }

  async function setSpectatorPhrases(enabled: boolean): Promise<void> {
    await request('spectatorPhrases', { enabled });
  }

  async function inspectRoom(code: string): Promise<void> {
    const room = normalizeCode(code);
    if (!room) throw new Error('请输入房间号');
    error.value = '';
    lastInspectCode = room;
    roomInfo.value = null;
    await request('inspect', { code: room });
  }

  /** Ask the host of `code` to hand seat `seat` to this client. No session, hence no cards. */
  async function requestSeat(code: string, seat: number, name: string): Promise<void> {
    const room = normalizeCode(code);
    const nickname = name.trim();
    if (!room) throw new Error('请输入房间号');
    if (!Number.isSafeInteger(seat) || seat < 0) throw new Error('请选择座位');
    if (!nickname) throw new Error('请输入昵称');
    if (session && !(session.role === 'spectator' && session.code === room)) throw new Error('请先返回大厅再申请座位');
    error.value = '';
    roomInfo.value = null;
    seatRequest.value = null;
    waitingSeat = { code: room, seatId: seat };
    pendingName = nickname;
    try {
      await request('requestSeat', { code: room, seatId: seat, name: nickname });
    } catch (caught) {
      waitingSeat = null;
      pendingName = '';
      if (caught instanceof ServerError && caught.code === 'ROOM_NOT_FOUND') forgetRoom(stores, room);
      throw caught;
    }
  }

  async function decideSeatRequest(requestId: string, approve: boolean): Promise<void> {
    if (!session) throw new Error('尚未加入房间');
    if (state.value?.isHost !== true) throw new Error('只有房主可以处理替换申请');
    const id = requestId.trim();
    if (!id) throw new Error('该申请已失效');
    error.value = '';
    await request('decideSeat', { requestId: id, approve: approve === true });
  }

  async function renameSelf(name: string): Promise<void> {
    const nickname = name.trim();
    if (!nickname) throw new Error('请输入昵称');
    if (!session) throw new Error('尚未加入房间');
    error.value = '';
    await request('rename', { name: nickname });
    if (session && session.name !== nickname) {
      session.name = nickname;
      savedSession.value = persistCredential(stores, session);
    }
  }

  /** Re-enter the room this browser was last in, using its stored seat credential. */
  async function resumeLastRoom(): Promise<void> {
    if (session) throw new Error('请先返回大厅');
    const record = savedSession.value ?? readSavedSession(stores);
    if (!record) throw new Error('没有可恢复的房间');
    const token = readRoomToken(stores.durable, record.code, record.role, record.seatId);
    if (!token) {
      savedSession.value = readSavedSession(stores);
      throw new Error('本机没有该房间的凭证，请重新加入');
    }
    beginSwitch();
    await bindResume({ ...record, token });
  }

  /**
   * Drop this tab back to the hall without touching durable seat credentials, so "继续牌局" can
   * take the seat back later. Used by 返回大厅 and by a socket the server superseded.
   */
  function returnToHall(notice: string): void {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    session = null;
    waitingSeat = null;
    seatRequest.value = null;
    roomInfo.value = null;
    pendingName = '';
    state.value = null;
    gameKind.value = null;
    selected.value = [];
    lastHandSignature = '';
    lastPhaseSignature = '';
    roomCode.value = '';
    seatId.value = null;
    // This tab forgets the room; the durable seat credential stays for a later resume.
    writeTabCredential(stores.tab, null);
    closeSocket();
    clearUrlIntent();
    savedSession.value = readSavedSession(stores);
    error.value = notice;
    syncMode();
  }

  /** Temporary detach: the server keeps the seat, this tab keeps the credential. */
  function leaveRoom(): void {
    returnToHall('');
  }

  async function junqiSetup(action: 'shuffle' | 'confirm' | 'swap', from?: number, to?: number): Promise<void> {
    error.value = '';
    await request('junqiSetup', { action, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
  }
  async function junqiMove(from: number, to: number): Promise<void> {
    error.value = ''; await request('junqiMove', { from, to });
  }
  async function junqiResign(): Promise<void> { error.value = ''; await request('junqiResign', {}); }
  const boardAiSetupRequested = ref(false);
  async function configureBoardAi(enabled: boolean, side: 0 | 1 = 1, difficulty: import('../shared/boardAi').BoardAiDifficulty = 'normal'): Promise<void> { error.value = ''; await request('boardAi', { enabled, side, difficulty }); }
  async function retryBoardAi(): Promise<void> { error.value = ''; await request('boardAiRetry', {}); }
  async function createBoardPractice(game: BoardAiGame, name: string): Promise<void> {
    if (busy.value) return;
    workflowBusy = true; syncBusy();
    try {
      await createRoom({ game, roomMode: 'phone', name });
      await waitForRoomState(roomCode.value, snapshot => snapshot.isHost && snapshot.phase === 'lobby');
      boardAiSetupRequested.value = true;
    } finally { workflowBusy = false; syncBusy(); }
  }
  async function chessMove(from: number, to: number, promotion?: import('../shared/chess').ChessPromotion): Promise<void> { error.value = ''; await request('chessMove', { from, to, ...(promotion ? { promotion } : {}) }); }
  async function stoneMove(point: number): Promise<void> { error.value = ''; await request('stoneMove', { point }); }
  async function reversiMove(point: number): Promise<void> { error.value = ''; await request('reversiMove', { point }); }
  async function reversiResign(side?: 0 | 1): Promise<void> {
    error.value = '';
    await request('reversiResign', side === undefined ? {} : { side });
  }
  async function boardUndo(action: BoardUndoClientAction): Promise<void> {
    const game = state.value?.game;
    const type = game === 'chess' ? 'chessUndo' : game === 'xiangqi' ? 'xiangqiUndo'
      : game === 'reversi' ? 'reversiUndo'
      : game === 'go' || game === 'gomoku' ? 'stoneUndo' : null;
    if (!type) throw new Error('本游戏不支持悔棋');
    error.value = '';
    await request(type, { action });
  }
  async function stonePass(): Promise<void> { error.value = ''; await request('stonePass', {}); }
  async function stoneResign(side?: 0 | 1): Promise<void> { error.value = ''; await request('stoneResign', side === undefined ? {} : { side }); }
  async function stoneScore(action: 'mark' | 'confirm' | 'resume', point?: number, side?: 0 | 1): Promise<void> {
    error.value = '';
    const current = state.value;
    const agreement = action === 'confirm' && current?.game === 'go' ? { revision: current.stones.scoreRevision, roundId: current.stones.roundId } : {};
    await request('stoneScore', { action, ...agreement, ...(point === undefined ? {} : { point }), ...(side === undefined ? {} : { side }) });
  }
  async function stoneSetup(size: number): Promise<void> { error.value = ''; await request('stoneSetup', { size }); }
  async function chessResign(side?: 0 | 1): Promise<void> { error.value = ''; await request('chessResign', side === undefined ? {} : { side }); }
  async function chessDraw(action: 'offer' | 'accept' | 'decline' | 'agree', side?: 0 | 1): Promise<void> { error.value = ''; await request('chessDraw', { action, ...(side === undefined ? {} : { side }) }); }
  async function xiangqiMove(from: number, to: number): Promise<void> { error.value = ''; await request('xiangqiMove', { from, to }); }
  async function xiangqiResign(side?: 0 | 1): Promise<void> { error.value = ''; await request('xiangqiResign', side === undefined ? {} : { side }); }
  async function xiangqiDraw(action: 'offer' | 'accept' | 'decline' | 'agree', side?: 0 | 1): Promise<void> { error.value = ''; await request('xiangqiDraw', { action, ...(side === undefined ? {} : { side }) }); }
  async function setJunqiMode(variant: 'two' | 'four'): Promise<void> { error.value = ''; await request('junqiMode', { variant }); }

  async function setSeats(positions: Position[]): Promise<void> {
    if (!Array.isArray(positions)) throw new Error('座位位置无效');
    error.value = '';
    await request('seats', {
      positions: positions.map((position) => ({
        x: clamp01(position.x),
        y: clamp01(position.y),
        angle: Number.isFinite(position.angle) ? position.angle : 0,
      })),
    });
  }

  /** Host-only: seat a robot in a placed empty lobby seat; Guandan bots also carry a strength tier. */
  async function addBot(seatId: number, options?: { strength?: 'strong' | 'easy' }): Promise<void> {
    if (!Number.isSafeInteger(seatId) || seatId < 0) throw new Error('座位号无效');
    error.value = '';
    await request('addBot', { seatId, ...(options ? options : {}) });
  }

  /** Sequentially use the existing host commands, stopping on the first failed seat. */
  async function fillBots(strength: 'strong' | 'easy' = 'easy'): Promise<void> {
    const snapshot = state.value;
    if (!snapshot?.isHost || snapshot.phase !== 'lobby') throw new Error('只有房主能在准备阶段补齐机器人');
    if (!snapshot.automation.available) throw new Error(snapshot.automation.message ?? '本机机器人暂不可用');
    const code = snapshot.code;
    for (const seat of snapshot.seats.filter(s => s.name === null)) {
      if (state.value?.code !== code || state.value.phase !== 'lobby' || !state.value.isHost) throw new Error('房间已变化，请重新确认空位');
      if (state.value.seats.find(s => s.id === seat.id)?.name !== null) continue;
      await addBot(seat.id, { strength });
    }
  }

  async function quickPractice(game: GameKind, name: string, strength: 'strong' | 'easy'): Promise<void> {
    if (isBoardGame(game)) throw new Error(isBoardAiGame(game) ? '请使用棋类的人机对弈入口' : '本游戏仅支持真人对弈');
    if (busy.value) return;
    workflowBusy = true;
    syncBusy();
    try {
      await createRoom({ game, roomMode: 'phone', name });
      // The server may acknowledge before the following state frame is delivered.
      // Wait for authority, rather than guessing host rights from the session message.
      const code = roomCode.value;
      await waitForRoomState(code, snapshot => snapshot.isHost && snapshot.phase === 'lobby');
      await fillBots(strength);
      if (!state.value?.seats.find(s => s.id === seatId.value)?.ready) await ready();
      await start();
    } catch (reason) {
      // A partial room stays available for manual invites or retry; never abandon its credential.
      error.value = reason instanceof Error ? reason.message : '快速练习未能启动，可在房间中继续准备';
      throw reason;
    } finally {
      workflowBusy = false;
      syncBusy();
    }
  }

  function waitForRoomState(code: string, accepts: (snapshot: Snapshot) => boolean): Promise<void> {
    const snapshot = state.value;
    if (snapshot?.code === code && accepts(snapshot)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        stop();
        reject(new TransportError('房间状态同步超时，可在房间中继续准备'));
      }, RESUME_TIMEOUT_MS);
      const stop = watch([state, mode], ([next, currentMode]) => {
        if (currentMode === 'home' || (next && next.code !== code)) {
          window.clearTimeout(timer); stop(); reject(new Error('已离开练习房间')); return;
        }
        if (next?.code === code && accepts(next)) {
          window.clearTimeout(timer); stop(); resolve();
        }
      });
    });
  }

  /** Host-only: take a robot seat back. Humans are never removable this way. */
  async function removeBot(seatId: number): Promise<void> {
    if (!Number.isSafeInteger(seatId) || seatId < 0) throw new Error('座位号无效');
    error.value = '';
    await request('removeBot', { seatId });
  }

  /** Host-only: dissolve the room for everyone, including this device. */
  async function dissolveRoom(): Promise<void> {
    error.value = '';
    await request('dissolve', {});
  }

  /** Host-only: remove all disconnected human seats while the room is in its lobby. */
  async function removeOfflineSeats(): Promise<void> {
    error.value = '';
    await request('removeOffline', {});
  }

  /** Host-only phone rooms: hand host rights to another connected human seat. */
  async function transferHost(nextSeatId: number): Promise<void> {
    if (!Number.isSafeInteger(nextSeatId) || nextSeatId < 0) throw new Error('座位号无效');
    error.value = '';
    await request('transferHost', { seatId: nextSeatId });
  }

  /** Host-only tablet Doudizhu: trim the trailing seats nobody occupies. */
  async function clearEmptySeats(): Promise<void> {
    error.value = '';
    await request('clearEmptySeats', {});
  }

  /** Host-only: set the per-decision clock; 0 disables it. The server accepts between deals. */
  async function setTurnTimer(seconds: number): Promise<void> {
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 300) throw new Error('倒计时秒数无效');
    error.value = '';
    await request('turnTimer', { seconds });
  }

  /**
   * The authenticated human's own opt-in: let this game's local AI play this seat. No target
   * seat is sent, so one device can only ever host itself, and nothing is remembered for a later
   * reconnect — the server keeps that state.
   */
  async function setAutoPlay(enabled: boolean): Promise<void> {
    error.value = '';
    await request('autoPlay', { enabled: enabled === true });
  }

  async function ready(): Promise<void> {
    const currentSeat = seatId.value;
    if (currentSeat === null) throw new Error('尚未加入座位');
    const seat = state.value?.seats.find((entry) => entry.id === currentSeat);
    error.value = '';
    await request('ready', { ready: !(seat?.ready ?? false) });
  }

  async function start(): Promise<void> {
    error.value = '';
    await request('start', {});
  }

  async function bid(value: number): Promise<void> {
    if (!isBidValue(value)) throw new Error('叫分无效');
    error.value = '';
    await request('bid', { value });
  }

  async function playSelected(claim?: string): Promise<void> {
    const cards = [...selected.value];
    if (cards.length === 0) {
      error.value = '请先选择要出的牌';
      return;
    }
    error.value = '';
    // One play wire for both games: Guandan adds only the claim key, and the server revalidates it.
    const key = typeof claim === 'string' ? claim.trim() : '';
    await request('play', key ? { cards, claim: key } : { cards });
  }

  /** Guandan exchange: commit one physical card as tribute. The server revalidates eligibility. */
  async function tribute(cardId: string): Promise<void> {
    if (!cardId) throw new Error('请选择要进贡的牌');
    error.value = '';
    await request('tribute', { cardId });
  }

  /** Guandan exchange: return one eligible card to the tribute giver. */
  async function returnTribute(cardId: string): Promise<void> {
    if (!cardId) throw new Error('请选择要还贡的牌');
    error.value = '';
    await request('returnTribute', { cardId });
  }

  async function pass(): Promise<void> {
    error.value = '';
    await request('pass', {});
  }

  async function again(): Promise<void> {
    error.value = '';
    await request('again', {});
  }

  /** Send one fixed-preset phrase. The server rejects anything outside the shared whitelist. */
  async function sayPhrase(phraseId: string): Promise<void> {
    if (!quickPhrase(phraseId)) throw new Error('快捷语无效');
    error.value = '';
    await request('phrase', { phraseId });
  }

  /* ---- hints ---- */

  /** Select one server suggestion without submitting it. The player still presses 出牌. */
  function applyHintAt(index: number): void {
    const play = hintPlays.value[index];
    if (!play) return;
    selected.value = play.cards.slice();
    hintIndex.value = index;
    if (receivesGameAudio(state.value)) sfx('select');
  }

  /**
   * Ask the authority for legal plays. Only one request is in flight; the reply is delivered as a
   * `hint` message and applied there, so a slow answer can never overwrite a newer selection.
   */
  async function requestHint(): Promise<void> {
    if (hintRequestInFlight) return;
    hintRequestInFlight = true;
    try {
      await request('hint', {});
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : '';
      if (message && !error.value) error.value = message;
    } finally {
      hintRequestInFlight = false;
    }
  }

  /** One button: fetch once, then cycle through the ordered suggestions. */
  function nextHint(): void {
    if (hintPlays.value.length === 0) {
      void requestHint();
      return;
    }
    if (hintPlays.value.length === 1) {
      void requestHint();
      return;
    }
    applyHintAt((hintIndex.value + 1) % hintPlays.value.length);
  }

  /* ---- local selection ---- */

  function toggleCard(id: string): void {
    const snapshot = state.value;
    if (snapshot && snapshot.role === 'player' && !snapshot.hand.some((card) => card.id === id)) return;
    const current = selected.value;
    const index = current.indexOf(id);
    selected.value = index >= 0 ? current.filter((entry) => entry !== id) : [...current, id];
    if (receivesGameAudio(snapshot)) sfx('select');
  }

  function clearSelection(): void {
    if (selected.value.length > 0) selected.value = [];
  }

  function clearError(): void {
    error.value = '';
  }

  watch(state, (snapshot) => {
    const hand = snapshot && Array.isArray(snapshot.hand) ? snapshot.hand : [];
    const handSignature = hand.map((card) => card.id).join(',');
    const phaseSignature = snapshot ? snapshot.phase : '';
    const handChanged = handSignature !== lastHandSignature;
    const phaseChanged = phaseSignature !== lastPhaseSignature;
    const turn = snapshot?.turn ?? null;
    const turnChanged = turn !== lastTurnSignature;
    const last = snapshot?.lastPlay;
    const playSignature = last ? `${last.seatId}|${last.kind}|${last.cards.map((card) => card.id).join(',')}` : '';
    const playChanged = playSignature !== lastPlaySignature;
    lastHandSignature = handSignature;
    lastPhaseSignature = phaseSignature;
    lastTurnSignature = turn;
    lastPlaySignature = playSignature;
    // A hint is tied to one exact turn and cursor; never carry it into another decision.
    if (phaseChanged || handChanged || turnChanged || playChanged) {
      hintPlays.value = [];
      hintIndex.value = 0;
    }
    if (phaseChanged || handChanged) {
      clearSelection();
      return;
    }
    if (selected.value.length > 0) {
      const live = new Set(hand.map((card) => card.id));
      const pruned = selected.value.filter((id) => live.has(id));
      if (pruned.length !== selected.value.length) selected.value = pruned;
    }
  });

  /* ---- teardown ---- */

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    heartbeat.stop();
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (phraseTimer !== null) {
      window.clearTimeout(phraseTimer);
      phraseTimer = null;
    }
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('pageshow', handleForeground);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleForeground);
    failPending('连接已关闭');
    failOpenWaiters(new TransportError('连接已关闭'));
    const ws = socket;
    socket = null;
    socketOpen = false;
    connected.value = false;
    if (ws) {
      try {
        ws.close(1000, 'closed');
      } catch {
        /* ignore */
      }
    }
  }

  /* ---- boot ---- */

  // Root with no room link is the hall: it offers Continue through savedSession instead of
  // dragging the visitor back into a room. A room/seat/view link states the intended identity.
  const intent = readIntent(new URLSearchParams(location.search));
  roomCode.value = intent.code;
  seatId.value = intent.seat;
  const initial = resolveCredential(intent, stores);
  if (initial) {
    // Resolution is read-only: a merely remembered credential must never overwrite the durable
    // slot a newer window was approved into. Writes happen when the server confirms a session.
    session = initial;
    roomCode.value = initial.code;
    seatId.value = initial.seatId;
  } else if (intent.view === 'table') {
    error.value = intent.code ? '未找到主持凭证，请重新创建房间' : '缺少房间号，请重新创建房间';
  }
  savedSession.value = readSavedSession(stores);
  syncMode();
  ensureSocket();
  if (!initial && intent.code && intent.view === 'spectator') {
    void spectateRoom(intent.code).catch(failure => { error.value = failure instanceof Error ? failure.message : '无法旁观房间'; });
  }
  void loadInviteBase();
  window.addEventListener('online', handleOnline);
  window.addEventListener('pageshow', handleForeground);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleForeground);
  if (getCurrentScope()) onScopeDispose(dispose);

  return {
    spectateRoom, setSpectatorPhrases,
    boardAiSetupRequested, configureBoardAi, retryBoardAi, createBoardPractice,
    junqiSetup, junqiMove, junqiResign, setJunqiMode, chessMove, chessResign, chessDraw, xiangqiMove, xiangqiResign, xiangqiDraw,
    stoneMove, stonePass, stoneResign, stoneScore, stoneSetup, reversiMove, reversiResign, boardUndo,
    state,
    connected,
    reconnectNow,
    busy,
    error,
    mode,
    roomCode,
    seatId,
    inviteBase,
    selected,
    hintPlays,
    hintIndex,
    requestHint,
    nextHint,
    roomInfo,
    seatRequest,
    phrase,
    savedSession,
    gameKind,
    createRoom,
    joinRoom,
    inspectRoom,
    requestSeat,
    decideSeatRequest,
    renameSelf,
    resumeLastRoom,
    leaveRoom,
    setSeats,
    addBot,
    fillBots,
    quickPractice,
    removeBot,
    setTurnTimer,
    setAutoPlay,
    dissolveRoom,
    removeOfflineSeats,
    transferHost,
    clearEmptySeats,
    ready,
    start,
    bid,
    playSelected,
    tribute,
    returnTribute,
    pass,
    again,
    sayPhrase,
    toggleCard,
    clearSelection,
    clearError,
    inviteUrl,
  };
}

/** Controller surface handed to screens; `ReturnType` keeps it in step with useGame itself. */
export type GameController = ReturnType<typeof useGame>;
