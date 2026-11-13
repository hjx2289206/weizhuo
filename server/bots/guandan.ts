// Guandan runtime slice: DanLM inference for Guandan robots and 托管.
//
// The policy is a thin, boring bridge modeled on douzero.ts. Candidate reasoning happens
// inside the isolated Python worker (server/bots/guandan_worker.py), loaded from the
// pinned official DanLM checkout: the worker rebuilds the official GuanDanRound from the
// deal facts our server already owns, replays every accepted play, and ranks the official
// legal actions with the model's own Q values. This module only:
//   * maps our raw card encoding to the worker's and back,
//   * validates each returned candidate and automatically uses its strongest legal interpretation,
//   * maps the winning claim onto physical card ids of the acting player's hand.
// No heuristic replaces a missing runtime: missing files, a broken interpreter or a
// replay divergence initializeGuandan marks unavailable with the honest reason instead
// of installing a weaker bot.

import { aiPython, aiModelDir } from './runtime';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card, GuandanDeclaration, LastPlay } from '../../shared/protocol';
import { enumerateGuandanPlays, strongestGuandanOption } from '../../shared/guandan';

export type GuandanAgentKey = 'danlm_v1' | 'danzero_v1t';

/** Everything the runtime needs: deal facts plus public rows, never other seats' hands. */
export interface GuandanTurnInput {
  agent: GuandanAgentKey;
  /** The deal's played level, our raw encoding (15 === 2 … 14 === A). */
  level: number;
  teamLevels: readonly [number, number];
  /** Leading seat of the deal in play. */
  firstPlayer: number;
  /** The four hands captured right when the playing phase opened (post tribute). */
  dealHands: readonly (readonly Card[])[];
  /** This deal's accepted plays, oldest first, from the room's authoritative history. */
  rows: readonly { seat: number; cards: readonly Card[]; claim: GuandanDeclaration; leading?: boolean }[];
  /** Resolved exchange pairs of the deal (may be empty; feeds the agents' representation). */
  tribute: readonly { giver: number; receiver: number; tribute: Card; returned: Card | null }[];
  /** The acting seat; must be the current turn and hold the largest hand count check. */
  selfSeat: number;
  hand: readonly Card[];
  /** Current trick cursor from our engine; null while this seat would lead. */
  cursor: LastPlay | null;
}

export interface GuandanPolicy {
  availability(): { available: boolean; message: string | null };
  chooseTurn(input: GuandanTurnInput, signal?: AbortSignal): Promise<string[]>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYTHON = aiPython;
const SOURCE = join(ROOT, '.guandan', 'DanLM');
const WEIGHTS = {
  danlm_v1: join(aiModelDir, 'guandan-danlm.onnx'),
  danzero_v1t: join(aiModelDir, 'guandan-danzero.onnx'),
} satisfies Record<GuandanAgentKey, string>;
const WORKER = join(ROOT, 'server', 'bots', 'guandan_worker.py');
const READY_TIMEOUT_MS = 90_000;
/** Backstop only: room automation passes an AbortSignal with its own action timeout. */
const REQUEST_TIMEOUT_MS = 60_000;
const PRELOAD_TIMEOUT_MS = 120_000;
const STDERR_TAIL_CHARS = 1_000;
const SETUP_HINT = '运行 scripts/guandan-setup.sh 安装 DanLM 运行时';

const AGENT_KEYS: readonly GuandanAgentKey[] = ['danlm_v1', 'danzero_v1t'];

export function defaultGuandanAgent(): GuandanAgentKey {
  return process.env.GUANDAN_AGENT === 'danzero_v1t' ? 'danzero_v1t' : 'danlm_v1';
}

interface RawCard {
  r: number;
  s: string;
}

interface WorkerPlays {
  pass?: boolean;
  cards?: RawCard[];
}

interface WorkerResponse {
  id?: number;
  ok?: boolean;
  error?: string;
  agent?: string;
  plays?: WorkerPlays[];
  legal?: number;
}

interface ReadyGate {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface Waiter {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  detach: () => void;
}

function fail(reason: unknown): Error {
  return new Error(`DanLM ${reason instanceof Error ? reason.message : String(reason)}`);
}

let child: ChildProcessWithoutNullStreams | null = null;
let status: { available: boolean; message: string | null } = {
  available: false,
  message: `DanLM 运行时尚未初始化（${SETUP_HINT}）`,
};
let closing = false;
let stderrTail = '';
let nextId = 1;
let queue: Promise<unknown> = Promise.resolve();
const waiting = new Map<number, Waiter>();

function missingPiece(): string | null {
  if (!existsSync(WORKER)) return `缺少推理工作进程 ${WORKER}`;
  if (!existsSync(PYTHON)) return `缺少隔离运行时 ${PYTHON}（${SETUP_HINT}）`;
  if (!existsSync(SOURCE)) return `缺少 DanLM 官方源码 ${SOURCE}（${SETUP_HINT}）`;
  const missing = AGENT_KEYS.filter((key) => !existsSync(WEIGHTS[key]) || statSync(WEIGHTS[key]).size === 0);
  if (missing.length !== 0) {
    const label = missing.map((key) => key === 'danlm_v1' ? 'DanLM_v1 权重' : 'DanZero_v1t 权重').join(' / ');
    return `缺少已提交的 ${label}（${SETUP_HINT}）`;
  }
  return null;
}

function markUnavailable(message: string): void {
  status = { available: false, message };
}

function settleAll(error: Error): void {
  for (const waiter of waiting.values()) {
    waiter.detach();
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  waiting.clear();
}

function stopWorker(reason: string): void {
  const worker = child;
  child = null;
  if (worker) worker.kill('SIGKILL');
  settleAll(fail(reason));
}

function handleLine(line: string, gate: ReadyGate | null): void {
  let payload: WorkerResponse;
  try {
    payload = JSON.parse(line) as WorkerResponse;
  } catch {
    return; // the worker only writes JSON; anything else is noise on its stdout
  }
  if (!payload.id) {
    if (!gate) return;
    if (payload.ok === false || payload.error) gate.reject(fail(payload.error ?? '未知原因'));
    else gate.resolve();
    return;
  }
  const waiter = waiting.get(payload.id);
  if (!waiter) return; // cancelled or timed out: a stale answer is never applied
  waiting.delete(payload.id);
  waiter.detach();
  clearTimeout(waiter.timer);
  if (payload.ok === false) waiter.reject(fail(`推理失败：${payload.error ?? '未知原因'}`));
  else waiter.resolve(payload);
}

/**
 * Loads the pinned DanLM runtime in an isolated venv, then warms every downloadable
 * agent bundle so the first bot move is not a model load. Never throws: a missing or
 * broken setup leaves the runtime unavailable with the exact reason, honest for rooms.
 */
export async function initializeGuandan(): Promise<void> {
  if (child) return;
  const missing = missingPiece();
  if (missing) {
    markUnavailable(missing);
    return;
  }
  let worker: ChildProcessWithoutNullStreams;
  try {
    worker = spawn(PYTHON, [WORKER], {
      cwd: ROOT,
      env: { ...process.env, GUANDAN_SRC: SOURCE, AI_MODEL_DIR: aiModelDir, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    markUnavailable(`DanLM 运行时启动失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  child = worker;
  closing = false;
  stderrTail = '';

  let settleReady: (value: { ok: boolean; error?: string }) => void = () => {};
  const ready = new Promise<{ ok: boolean; error?: string }>((settle) => {
    settleReady = settle;
  });
  const startedTimer = setTimeout(
    () => settleReady({ ok: false, error: `加载官方运行时超时（${READY_TIMEOUT_MS}ms）` }),
    READY_TIMEOUT_MS,
  );
  startedTimer.unref();
  const gate: ReadyGate = {
    resolve: () => settleReady({ ok: true }),
    reject: (error: Error) => settleReady({ ok: false, error: error.message }),
  };

  worker.on('error', (error) => {
    settleReady({ ok: false, error: error.message });
    gone(`工作进程错误：${error.message}`);
  });
  worker.on('exit', (code, signal) => {
    settleReady({ ok: false, error: `工作进程退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）` });
    gone(`工作进程退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
  });

  function gone(reason: string): void {
    if (closing || child !== worker) return;
    const detail = stderrTail.trim().split('\n').slice(-3).join(' / ');
    const message = `DanLM ${reason}${detail ? `：${detail}` : ''}`;
    stopWorker(reason);
    markUnavailable(message);
  }

  worker.stdout.setEncoding('utf8');
  worker.stderr.setEncoding('utf8');
  let buffer = '';
  worker.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleLine(line, gate);
      index = buffer.indexOf('\n');
    }
  });
  worker.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });

  const outcome = await ready;
  clearTimeout(startedTimer);
  if (!outcome.ok || child !== worker) {
    const detail = stderrTail.trim().split('\n').slice(-3).join(' / ');
    const message = `DanLM 运行时不可用：${outcome.error ?? '未知原因'}${detail ? `（${detail}）` : ''}`;
    stopWorker(message);
    markUnavailable(message);
    return;
  }
  status = { available: true, message: null };

  // Warm both difficulty models so no first move waits for model loading.
  for (const key of AGENT_KEYS) {
    try {
      await request({ preload: true, agent: key }, PRELOAD_TIMEOUT_MS);
    } catch (error) {
      const message = `DanLM ${key} 预热失败：${error instanceof Error ? error.message : String(error)}`;
      stopWorker('预热失败');
      markUnavailable(message);
      return;
    }
  }
}

/** Stops the worker and releases its stdio; safe to call when nothing was started. */
export async function closeGuandan(): Promise<void> {
  const worker = child;
  closing = true;
  if (!worker) {
    settleAll(fail('运行时已关闭'));
    markUnavailable('DanLM 运行时未启动');
    return;
  }
  const exited = new Promise<void>((settle) => {
    worker.once('exit', () => settle());
  });
  stopWorker('运行时已关闭');
  await Promise.race([exited, new Promise<void>((settle) => setTimeout(settle, 2_000).unref())]);
  markUnavailable('DanLM 运行时已关闭');
}

function cardToRaw(card: Card): RawCard {
  return { r: card.rank, s: card.suit };
}

interface WorkerRequestShape {
  id: number;
  agent: GuandanAgentKey;
  preload?: boolean;
  level?: number;
  teamLevels?: [number, number];
  firstPlayer?: number;
  deal?: { hands: RawCard[][] };
  tribute?: { giver: number; receiver: number; tribute: RawCard; returned: RawCard | null }[];
  rows?: { seat: number; cards: RawCard[]; claim: GuandanDeclaration; leading?: boolean }[];
  selfSeat?: number;
  leading?: boolean;
}

function send(body: Omit<WorkerRequestShape, 'id'>, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResponse> {
  const worker = child;
  if (!worker) return Promise.reject(fail('运行时未启动'));
  const id = nextId;
  nextId += 1;
  return new Promise<WorkerResponse>((settle, reject) => {
    const onAbort = (): void => {
      if (!waiting.delete(id)) return;
      clearTimeout(waiter.timer);
      waiter.detach();
      reject(fail('推理已取消'));
    };
    const waiter: Waiter = {
      resolve: settle,
      reject,
      timer: setTimeout(() => {
        if (!waiting.delete(id)) return;
        waiter.detach();
        reject(fail(`推理超时（${timeoutMs}ms）`));
      }, timeoutMs),
      detach: () => signal?.removeEventListener('abort', onAbort),
    };
    waiter.timer.unref();
    waiting.set(id, waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    worker.stdin.write(`${JSON.stringify({ ...body, id })}\n`, (error) => {
      if (!error || !waiting.delete(id)) return;
      clearTimeout(waiter.timer);
      waiter.detach();
      reject(fail(`写入工作进程失败：${error.message}`));
    });
  });
}

function request(body: Omit<WorkerRequestShape, 'id'>, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResponse> {
  // One worker call at a time, bridged through the shared serial queue.
  const run = (): Promise<WorkerResponse> => send(body, timeoutMs, signal);
  const result = queue.then(run, () => run());
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Physical cards of `hand` carrying exactly these printed faces, or null. */
function matchFaces(hand: readonly Card[], faces: readonly RawCard[]): Card[] | null {
  const pool = hand.slice();
  const picked: Card[] = [];
  for (const face of faces) {
    const index = pool.findIndex((card) => card.rank === face.r && card.suit === face.s);
    if (index < 0) return null;
    picked.push(pool[index]!);
    pool.splice(index, 1);
  }
  return picked;
}

function idsOf(cards: readonly Card[]): string[] {
  return cards.map((card) => card.id);
}

async function decide(input: GuandanTurnInput, signal?: AbortSignal): Promise<string[]> {
  const response = await send(
    {
      agent: input.agent,
      level: input.level,
      teamLevels: [input.teamLevels[0], input.teamLevels[1]],
      firstPlayer: input.firstPlayer,
      deal: {
        hands: input.dealHands.map((hand) => hand.map(cardToRaw)),
      },
      tribute: input.tribute.map((pair) => ({
        giver: pair.giver,
        receiver: pair.receiver,
        tribute: cardToRaw(pair.tribute),
        returned: pair.returned ? cardToRaw(pair.returned) : null,
      })),
      rows: input.rows.map((row) => ({ seat: row.seat, cards: row.cards.map(cardToRaw), claim: row.claim, leading: row.leading })),
      selfSeat: input.selfSeat,
      leading: input.cursor === null,
    },
    REQUEST_TIMEOUT_MS,
    signal,
  );
  const candidates = response.plays ?? [];
  if (candidates.length === 0) throw fail('推理失败：模型没有返回候选动作');
  const cursor = input.cursor;
  const cursorClaim: GuandanDeclaration | null =
    cursor && cursor.cards.length > 0 && cursor.claim ? cursor.claim : null;

  for (const candidate of candidates) {
    if (candidate.pass) {
      if (cursor !== null) return []; // a pass is legal only against an open trick
      continue; // this seat leads and may not pass: fall through to the next candidate
    }
    const faces = candidate.cards ?? [];
    const cards = matchFaces(input.hand, faces);
    if (!cards) continue;
    const option = strongestGuandanOption(enumerateGuandanPlays(cards, input.level), input.level, cursorClaim);
    if (option) return idsOf(option.cards);
  }
  throw fail(`返回的候选动作都不符合本服规则（legal=${response.legal ?? '?'}）`);
}

export const guandanPolicy: GuandanPolicy = {
  availability(): { available: boolean; message: string | null } {
    return status;
  },
  chooseTurn(input: GuandanTurnInput, signal?: AbortSignal): Promise<string[]> {
    if (!child || !status.available) {
      return Promise.reject(new Error(status.message ?? 'DanLM 运行时不可用'));
    }
    // One inference at a time: the worker is serial by construction and never queues twice.
    const result = queue.then(() => decide(input, signal));
    queue = result.then(() => undefined, () => undefined);
    return result;
  },
};
