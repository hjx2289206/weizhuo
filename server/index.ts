// Socket layer for the LAN tabletop toy (Doudizhu + Guandan): HTTP (Vite dev middleware or dist) + WS at /ws.
// The `/ws` upgrade is refused for WeChat/QQ embedded webviews before any connection is
// created, using the same pure detector the front-end gate runs (shared/inAppBrowser.ts).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { RoomMode, ServerMessage } from '../shared/protocol';
import { Room, type Peer } from './room';
import { closeDouZero, initializeDouZero } from './bots/douzero';
import { closeGuandan, initializeGuandan } from './bots/guandan';
import { guandanCollector } from './collect/collector';
import { detectInAppBrowser } from '../shared/inAppBrowser';
import { getNetworkUrls } from './network';
import { boardAiPolicy } from './bots/boardAi';
import { isGameKind, supportsRoomMode } from '../shared/gameCatalog';
import { connectTutorialSocket } from './tutorials/socket';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isProduction = process.argv.includes('--production');
const PORT = Number(process.env.PORT ?? 5180);
const HOST = '0.0.0.0';
const ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_REMEMBERED_REPLIES = 64;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

interface PeerImpl extends Peer {
  ws: WebSocket;
  room: Room | null;
  /** Room holding this socket's pending seat request while it is still unbound. */
  requestRoom: Room | null;
  replies: Map<string, ServerMessage[]>;
  replyOrder: string[];
  recording: ServerMessage[] | null;
}

class Connection implements PeerImpl {
  id = randomBytes(8).toString('hex');
  role: 'table' | 'player' = 'table';
  seatId: number | null = null;
  token: string | null = null;
  room: Room | null = null;
  requestRoom: Room | null = null;
  replies = new Map<string, ServerMessage[]>();
  replyOrder: string[] = [];
  recording: ServerMessage[] | null = null;

  constructor(readonly ws: WebSocket) {}

  send(message: ServerMessage): void {
    if (this.recording) this.recording.push(message);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  supersede(): void {
    try {
      this.ws.close(4000, 'superseded');
    } catch {
      /* socket already gone */
    }
  }

  remember(requestId: string): void {
    if (!this.recording || !requestId) return;
    this.replies.set(requestId, this.recording);
    this.replyOrder.push(requestId);
    while (this.replyOrder.length > MAX_REMEMBERED_REPLIES) {
      const oldest = this.replyOrder.shift();
      if (oldest !== undefined && oldest !== requestId) this.replies.delete(oldest);
    }
  }
}

const rooms = new Map<string, Room>();

function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
}

function route(peer: Connection, type: string, payload: Record<string, unknown>, id: string): void {
  if (type === 'ping') {
    peer.send({ type: 'pong', id });
    return;
  }
  if (type === 'create') {
    if (peer.room) {
      peer.send({ type: 'error', id: id || undefined, message: '你已经在一个房间中' });
      return;
    }
    const roomMode: RoomMode = payload.roomMode === 'phone' ? 'phone' : 'tablet';
    const rawGame = payload.game;
    if (!isGameKind(rawGame)) {
      peer.send({ type: 'error', id: id || undefined, message: '未知的游戏类型' });
      return;
    }
    if (!supportsRoomMode(rawGame, roomMode)) {
      peer.send({ type: 'error', id: id || undefined, message: '军棋不支持公共平板模式，请选择联机对弈' });
      return;
    }
    const name = typeof payload.name === 'string' ? payload.name : undefined;
    const room = new Room(makeRoomCode(), roomMode, rawGame);
    room.onDissolve = () => {
      rooms.delete(room.code);
    };
    rooms.set(room.code, room);
    room.bindCreator(peer, id, name);
    return;
  }
  if (type === 'inspect') {
    const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) {
      peer.send({ type: 'error', id: id || undefined, message: '房间不存在或已过期', code: 'ROOM_NOT_FOUND' });
      return;
    }
    peer.send({ type: 'room-info', id, room: room.summary() });
    peer.send({ type: 'ack', id });
    return;
  }
  if (type === 'requestSeat') {
    // An unbound socket may ask for a seat: the room records a pending request and answers
    // with a pending SeatRequestMessage, never a session or a hand. Approval arrives later
    // as an ordinary session/state push for this same peer.
    const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) {
      peer.send({ type: 'error', id: id || undefined, message: '房间不存在或已过期', code: 'ROOM_NOT_FOUND' });
      return;
    }
    if (peer.room && peer.room !== room) {
      peer.send({ type: 'error', id: id || undefined, message: '你已经在一个房间中' });
      return;
    }
    const seatId = typeof payload.seatId === 'number' ? payload.seatId : Number.NaN;
    const name = typeof payload.name === 'string' ? payload.name : '';
    room.requestSeat(peer, seatId, name, id);
    return;
  }
  if (type === 'join' || type === 'resume') {
    const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) {
      peer.send({ type: 'error', id: id || undefined, message: '房间不存在或已过期', code: 'ROOM_NOT_FOUND' });
      return;
    }
    if (peer.room && peer.room !== room) {
      peer.send({ type: 'error', id: id || undefined, message: '你已经在一个房间中' });
      return;
    }
    if (type === 'join') {
      const seatId = typeof payload.seatId === 'number' ? payload.seatId : Number.NaN;
      const name = typeof payload.name === 'string' ? payload.name : '';
      room.bindJoin(peer, seatId, name, id);
    } else {
      room.bindResume(peer, typeof payload.token === 'string' ? payload.token : '', id);
    }
    return;
  }
  if (!peer.room) {
    peer.send({ type: 'error', id: id || undefined, message: '请先创建或加入房间' });
    return;
  }
  peer.room.command(peer, type, payload, id);
}

function handleMessage(peer: Connection, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    peer.send({ type: 'error', message: '消息格式错误' });
    return;
  }
  const message = parsed as { id?: unknown; type?: unknown; payload?: unknown } | null;
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    peer.send({ type: 'error', message: '消息格式错误' });
    return;
  }
  const id = typeof message.id === 'string' ? message.id : '';
  const payload = message.payload && typeof message.payload === 'object' ? (message.payload as Record<string, unknown>) : {};
  const type = message.type;

  // Only the identity-establishing commands replay a remembered reply. `requestSeat` is
  // deliberately excluded: its pending SeatRequestMessage becomes obsolete the moment the
  // host approves, so replaying it would resurrect a queue entry that no longer exists.
  const preRoom = type === 'create' || type === 'join' || type === 'resume';
  if (preRoom) {
    const cached = id ? peer.replies.get(id) : undefined;
    if (cached) {
      for (const reply of cached) peer.send(reply);
      return;
    }
    peer.recording = [];
    try {
      route(peer, type, payload, id);
    } finally {
      peer.remember(id);
      peer.recording = null;
    }
    return;
  }

  try {
    route(peer, type, payload, id);
  } catch (error) {
    console.error('[ws] command failed', error);
    peer.send({ type: 'error', id: id || undefined, message: '服务器处理失败' });
  }
}

async function serveIndexHtml(res: http.ServerResponse, vite: ViteMiddleware | null): Promise<void> {
  const file = path.join(rootDir, 'index.html');
  let html = await fs.promises.readFile(file, 'utf8');
  if (vite) html = await vite.transformIndexHtml('/', html);
  res.writeHead(200, { 'content-type': MIME['.html'] });
  res.end(html);
}

interface ViteMiddleware {
  (req: http.IncomingMessage, res: http.ServerResponse, next: (err?: unknown) => void): void;
  transformIndexHtml(url: string, html: string): Promise<string>;
  ssrFixStacktrace(error: Error): void;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const distDir = path.join(rootDir, 'dist');
  let filePath = path.join(distDir, urlPath);
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (urlPath === '/' || !path.extname(filePath)) filePath = path.join(distDir, 'index.html');
  try {
    const data = await fs.promises.readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('未找到资源，请先执行 npm run build');
  }
}

async function main(): Promise<void> {
  let vite: ViteMiddleware | null = null;
  if (!isProduction) {
    // Dynamic import: `vite` must never load in --production (it is a devDependency
    // and its dev server is irrelevant to serving dist), so the specifier is runtime-selected.
    const { createServer } = await import('vite');
    const dev = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
    vite = dev.middlewares as unknown as ViteMiddleware;
    vite.transformIndexHtml = (url, html) => dev.transformIndexHtml(url, html);
    vite.ssrFixStacktrace = (error) => dev.ssrFixStacktrace(error);
  }

  const server = http.createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] === '/api/network') {
      res.writeHead(200, { 'content-type': MIME['.json'] });
      res.end(JSON.stringify({ urls: getNetworkUrls(PORT) }));
      return;
    }
    if (vite) {
      vite(req, res, (error) => {
        if (error) {
          if (error instanceof Error && vite) vite.ssrFixStacktrace(error);
          res.writeHead(500).end('development server error');
          return;
        }
        void serveIndexHtml(res, vite);
      });
      return;
    }
    void serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  const tutorialWss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  tutorialWss.on('connection', connectTutorialSocket);
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (pathname !== '/ws' && pathname !== '/ws/tutorial') {
      socket.destroy();
      return;
    }
    // Same shared detector as the front-end gate: WeChat/QQ webviews never reach
    // `handleUpgrade`, so no Connection, session, room or hand is ever created for them.
    const header = req.headers['user-agent'];
    const userAgent = Array.isArray(header) ? header[0] ?? '' : header ?? '';
    if (detectInAppBrowser(userAgent) !== null) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const target = pathname === '/ws/tutorial' ? tutorialWss : wss;
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, 20_000);
    heartbeat.unref();
    const peer = new Connection(ws);
    ws.on('message', (data) => {
      handleMessage(peer, data.toString());
    });
    ws.on('close', () => {
      clearInterval(heartbeat);
      // One connection waits in at most one room, and that pointer is the only queue it owns:
      // cancel it there (so the host cannot later approve a dead waiter), then detach any seat.
      peer.requestRoom?.cancelSeatRequest(peer);
      peer.room?.detach(peer);
    });
    ws.on('error', () => ws.close());
  });

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      // Expiry is continuous-empty time, not room age: a long-running room that just
      // emptied keeps its full 30-minute retention window.
      if (room.isExpired(now, ROOM_TTL_MS)) {
        room.dispose();
        rooms.delete(code);
      }
    }
  }, 60_000).unref();

  await Promise.all([initializeDouZero(), initializeGuandan(), boardAiPolicy.initialize()]);
  server.listen(PORT, HOST, () => {
    const mode = isProduction ? 'production' : 'development';
    console.log(`桌游合集服务已启动（${mode}）：http://localhost:${PORT}`);
    for (const url of getNetworkUrls(PORT)) console.log(`  局域网地址：${url}`);
    if (isProduction) console.log('  生产模式：请确认已执行 npm run build');
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const room of rooms.values()) room.dispose();
    rooms.clear();
    await closeDouZero();
    await closeGuandan();
    guandanCollector.flush();
    server.close(() => process.exit(0));
    // Never hang on lingering keep-alive sockets.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
