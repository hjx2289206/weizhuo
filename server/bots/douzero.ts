// DouZero runtime slice: real official DouZero CPU inference for Doudizhu robots and 托管.
//
// The policy is a thin, boring bridge. Candidate generation (the official move generator),
// ranking (the official loaded network) and the observation encoding all happen inside the
// isolated Python worker (server/bots/douzero_worker.py). This module only:
//   * ships the acting player's own hand plus public facts to that worker,
//   * validates the returned rank candidates with our own server rules (detectPlay/canBeat),
//   * maps the winning candidate onto physical card ids of the acting player's hand.
// No heuristic, random or minimum-card substitute exists anywhere on this path: when the
// weights or the interpreter are missing, initializeDouZero marks the runtime unavailable
// with the honest reason instead of installing a weaker bot.

import { aiPython, aiModelDir } from './runtime';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card, LastPlay, TablePlay } from '../../shared/protocol';
import { canBeat, detectPlay, type PlayKind } from '../rules';

/** Everything the runtime may see: the acting player's own cards plus public table facts. */
export interface DouZeroState {
  selfSeat: number;
  turn: number;
  landlord: number;
  hand: readonly Card[];
  bottom: readonly Card[];
  counts: readonly [number, number, number];
  tablePlays: readonly TablePlay[];
  lastPlay: LastPlay | null;
}

export interface DouZeroPolicy {
  availability(): { available: boolean; message: string | null };
  /**
   * `strength` is the robot tier: 'strong' keeps the official argmax pick; 'easy' samples a
   * value-weighted choice among the top-ranked official actions (DouZero still does the
   * inference; the room never installs a different model).
   */
  chooseMove(state: DouZeroState, signal?: AbortSignal, strength?: 'strong' | 'easy'): Promise<string[]>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYTHON = aiPython;
const SOURCE = join(ROOT, '.douzero', 'douzero-src');
const WEIGHTS = aiModelDir;
const WORKER = join(ROOT, 'server', 'bots', 'douzero_worker.py');
const ROLES = ['landlord', 'landlord_down', 'landlord_up'] as const;
const READY_TIMEOUT_MS = 60_000;
/** Backstop only: room automation passes an AbortSignal with its own action timeout. */
const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 1_000;
const SETUP_HINT = '运行 scripts/douzero-setup.sh 安装 DouZero 运行时';

interface WorkerState {
  selfSeat: number;
  turn: number;
  landlord: number;
  hand: number[];
  bottom: number[];
  counts: number[];
  tablePlays: { seatId: number; ranks: number[] }[];
}

interface WorkerResponse {
  id?: number;
  ok?: boolean;
  error?: string;
  position?: string;
  legal?: number;
  candidates?: number[][];
  /** Difficulty pick: index into `candidates`, 0 = the strongest action. */
  pick?: number;
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
  return new Error(`DouZero ${reason instanceof Error ? reason.message : String(reason)}`);
}

let child: ChildProcessWithoutNullStreams | null = null;
let status: { available: boolean; message: string | null } = {
  available: false,
  message: `DouZero 运行时尚未初始化（${SETUP_HINT}）`,
};
let closing = false;
let stderrTail = '';
let nextId = 1;
let queue: Promise<unknown> = Promise.resolve();
const waiting = new Map<number, Waiter>();

function missingPiece(): string | null {
  if (!existsSync(WORKER)) return `缺少推理工作进程 ${WORKER}`;
  if (!existsSync(PYTHON)) return `缺少隔离运行时 ${PYTHON}（${SETUP_HINT}）`;
  if (!existsSync(SOURCE)) return `缺少 DouZero 官方源码 ${SOURCE}（${SETUP_HINT}）`;
  for (const role of ROLES) {
    const weight = join(WEIGHTS, `douzero-${role}.onnx`);
    if (!existsSync(weight) || statSync(weight).size === 0) {
      return `缺少 DouZero 官方权重 ${weight}（${SETUP_HINT}）`;
    }
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
 * Loads the three official role networks in an isolated venv and wires the worker.
 * Never throws: a missing or broken setup leaves the runtime unavailable with the
 * exact reason, so manual games still start with an honest status.
 */
export async function initializeDouZero(): Promise<void> {
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
      env: { ...process.env, DOUZERO_SRC: SOURCE, AI_MODEL_DIR: WEIGHTS, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    markUnavailable(`DouZero 运行时启动失败：${error instanceof Error ? error.message : String(error)}`);
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
    () => settleReady({ ok: false, error: `加载官方权重超时（${READY_TIMEOUT_MS}ms）` }),
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
    const message = `DouZero ${reason}${detail ? `：${detail}` : ''}`;
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
    const message = `DouZero 运行时不可用：${outcome.error ?? '未知原因'}${detail ? `（${detail}）` : ''}`;
    stopWorker(message);
    markUnavailable(message);
    return;
  }
  status = { available: true, message: null };
}

/** Stops the worker and releases its stdio; safe to call when nothing was started. */
export async function closeDouZero(): Promise<void> {
  const worker = child;
  closing = true;
  if (!worker) {
    settleAll(fail('运行时已关闭'));
    markUnavailable('DouZero 运行时未启动');
    return;
  }
  const exited = new Promise<void>((settle) => {
    worker.once('exit', () => settle());
  });
  stopWorker('运行时已关闭');
  await Promise.race([exited, new Promise<void>((settle) => setTimeout(settle, 2_000).unref())]);
  markUnavailable('DouZero 运行时已关闭');
}

function toWorkerState(state: DouZeroState): WorkerState {
  return {
    selfSeat: state.selfSeat,
    turn: state.turn,
    landlord: state.landlord,
    hand: state.hand.map((card) => card.rank),
    bottom: state.bottom.map((card) => card.rank),
    counts: [...state.counts],
    tablePlays: state.tablePlays.map((play) => ({
      seatId: play.seatId,
      ranks: play.cards.map((card) => card.rank),
    })),
  };
}

function send(state: WorkerState, strength: 'strong' | 'easy', signal?: AbortSignal): Promise<WorkerResponse> {
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
        reject(fail(`推理超时（${REQUEST_TIMEOUT_MS}ms）`));
      }, REQUEST_TIMEOUT_MS),
      detach: () => signal?.removeEventListener('abort', onAbort),
    };
    waiter.timer.unref();
    waiting.set(id, waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    worker.stdin.write(`${JSON.stringify({ id, state, strength })}\n`, (error) => {
      if (!error || !waiting.delete(id)) return;
      clearTimeout(waiter.timer);
      waiter.detach();
      reject(fail(`写入工作进程失败：${error.message}`));
    });
  });
}

/** Physical cards of `hand` carrying exactly these ranks, or null when the hand lacks them. */
function matchRanks(hand: readonly Card[], ranks: readonly number[]): Card[] | null {
  const pool = hand.slice();
  const picked: Card[] = [];
  for (const rank of ranks) {
    const index = pool.findIndex((card) => card.rank === rank);
    if (index < 0) return null;
    picked.push(pool[index]!);
    pool.splice(index, 1);
  }
  return picked;
}

async function decide(state: DouZeroState, strength: 'strong' | 'easy', signal?: AbortSignal): Promise<string[]> {
  const response = await send(toWorkerState(state), strength, signal);
  const candidates = response.candidates ?? [];
  if (candidates.length === 0) throw fail('推理失败：官方走法生成器没有返回候选');
  // The easy tier starts from the value-weighted sampled candidate, then falls back to the
  // officially ranked order so a degraded pick never breaks room rules.
  const rawPick = response.pick;
  const pickIndex = typeof rawPick === 'number' && Number.isInteger(rawPick) && rawPick >= 0 && rawPick < candidates.length
    ? rawPick
    : 0;
  const order = [pickIndex, ...candidates.map((_, index) => index).filter((index) => index !== pickIndex)];
  const lastPlay = state.lastPlay;
  const cursor: PlayKind | null =
    lastPlay && lastPlay.cards.length > 0 && lastPlay.seatId !== state.selfSeat
      ? detectPlay([...lastPlay.cards])
      : null; // the acting player leads: nothing to beat
  for (const index of order) {
    const ranks = candidates[index]!;
    const cards = matchRanks(state.hand, ranks);
    if (!cards) continue;
    if (cards.length === 0) {
      if (cursor) return []; // the official choice is a pass, and a pass is legal here
      continue; // a lead may not pass; fall through to the next ranked candidate
    }
    const play = detectPlay(cards);
    if (!play || !canBeat(play, cursor)) continue;
    return cards.map((card) => card.id);
  }
  throw fail(`返回的候选动作都不符合本服规则（legal=${response.legal ?? '?'}）`);
}

export const douZeroPolicy: DouZeroPolicy = {
  availability(): { available: boolean; message: string | null } {
    return status;
  },
  chooseMove(state: DouZeroState, signal?: AbortSignal, strength: 'strong' | 'easy' = 'strong'): Promise<string[]> {
    if (!child || !status.available) {
      return Promise.reject(new Error(status.message ?? 'DouZero 运行时不可用'));
    }
    // One inference at a time: the worker is serial by construction and never queues twice.
    const result = queue.then(() => decide(state, strength, signal));
    queue = result.then(() => undefined, () => undefined);
    return result;
  },
};
