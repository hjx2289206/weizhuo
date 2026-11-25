import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, ref, type Ref } from 'vue';
import type { JunqiSnapshot } from '../shared/protocol';
import type { JunqiBoard, JunqiMove, JunqiPiece, JunqiRank, JunqiSide, JunqiVariant } from '../shared/junqi';
import { BOARD_PLAYBACK_MS, useBoardPlayback } from '../src/useBoardPlayback';
import { playGo, type StoneBoard, type StoneMove } from '../shared/stones';

interface SnapshotOptions {
  board: JunqiBoard;
  moves?: JunqiMove[];
  variant?: JunqiVariant;
  phase?: 'playing' | 'finished';
  code?: string;
  roundId?: string;
  round?: number;
  selfSeat?: number | null;
  version?: number;
}

function snapshot({ board, moves = [], variant = 'two', phase = 'playing', code = 'JQ', roundId = 'round-1', round = 1, selfSeat = 0, version = 1 }: SnapshotOptions): JunqiSnapshot {
  const sides = variant === 'four' ? 4 : 2;
  return {
    code, roomMode: 'phone', seats: [], hand: [], selfSeat, role: 'player', isHost: false,
    hostSeatId: null, hostConnected: true, spectatorCount: 0, spectatorPhrases: true, turnLimitSeconds: 0, turnRemainingMs: null, turnSeatId: null,
    seatRequests: [], automation: { available: false, message: null }, message: '', version,
    game: 'junqi', phase, turn: phase === 'playing' ? 0 : null, lastPlay: null, tablePlays: [], trickStartIndex: 0,
    junqi: {
      variant, round, roundId, board, deployed: Array.from({ length: sides }, () => true), revealedFlags: Array.from({ length: sides }, () => false),
      eliminated: Array.from({ length: sides }, () => false), eliminationReasons: Array.from({ length: sides }, () => ''), winner: null, winnerTeam: null,
      draw: false, reason: '', moves, quietPlies: 0,
    },
  };
}

function piece(side: JunqiSide, rank: JunqiRank | null, id: string): JunqiPiece {
  return { side, rank, id };
}

function move(ply: number, from: number, to: number, outcome: JunqiMove['outcome'] = 'move', side: JunqiSide = 0): JunqiMove {
  return { ply, side, from, to, outcome, path: [from, to] };
}

function emptyBoard(variant: JunqiVariant = 'two'): JunqiBoard {
  return Array<JunqiPiece | null>(variant === 'four' ? 129 : 60).fill(null);
}

function observe(source: Ref<JunqiSnapshot | null>, connected: Ref<boolean>) {
  return useBoardPlayback(source, connected, {
    position: snapshot => ({ ...snapshot.junqi, layout: snapshot.junqi.variant }),
    empty: emptyBoard(),
    canAnimate: (board, move) => board[move.from]?.side === move.side,
  });
}

function frameClock() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const request = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const cancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { const id = nextId++; frames.set(id, callback); return id } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => { frames.delete(id) } });
  return {
    frames,
    tick(timestamp: number) { const due = [...frames.values()]; frames.clear(); for (const callback of due) callback(timestamp) },
    restore() {
      if (request) Object.defineProperty(globalThis, 'requestAnimationFrame', request); else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      if (cancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', cancel); else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
    },
  };
}

test('Junqi playback animates only a contiguous new ply from the previous masked board', () => {
  const clock = frameClock(), scope = effectScope(), source = ref<JunqiSnapshot | null>(null), connected = ref(true);
  try {
    const firstBoard = emptyBoard();
    firstBoard[5] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: firstBoard });
    const view = scope.run(() => observe(source, connected))!;
    assert.equal(view.animating.value, false, 'an initial mid-game snapshot never replays history');
    assert.deepEqual(view.board.value, firstBoard);

    const noticeBoard = firstBoard.slice();
    source.value = snapshot({ board: noticeBoard, version: 2 });
    assert.equal(view.animating.value, false, 'a same-ply roster notification is not a move');

    const afterBoard = noticeBoard.slice();
    afterBoard[5] = null;
    afterBoard[10] = piece(0, 'company', 'red-company');
    const next = snapshot({ board: afterBoard, moves: [move(1, 5, 10)], version: 3 });
    source.value = next;
    const active = view.playback.value;
    assert.ok(active);
    assert.equal(active.move.ply, 1);
    assert.deepEqual(active.board, noticeBoard, 'uses the latest authoritative pre-move board');
    assert.deepEqual(view.board.value, noticeBoard, 'the settled board is frozen during playback');
    assert.equal(view.animating.value, true);
    assert.equal(clock.frames.size, 1);

    clock.tick(1000);
    assert.equal(view.playback.value?.progress, 0, 'the first frame anchors the clock');
    clock.tick(1000 + BOARD_PLAYBACK_MS / 2);
    assert.ok(view.playback.value && Math.abs(view.playback.value.progress - .5) < 1e-9);
    clock.tick(1000 + BOARD_PLAYBACK_MS);
    assert.equal(view.animating.value, false);
    assert.deepEqual(view.board.value, afterBoard, 'settles on the server board when the route completes');
  } finally {
    scope.stop();
    clock.restore();
  }
});

test('Junqi playback keeps both the lost attacker and hidden defender in its before-board', () => {
  const clock = frameClock(), scope = effectScope(), source = ref<JunqiSnapshot | null>(null), connected = ref(true);
  try {
    const view = scope.run(() => observe(source, connected))!;
    const beforeBoard = emptyBoard();
    beforeBoard[5] = piece(0, 'company', 'red-company');
    beforeBoard[10] = piece(1, null, 'blue-hidden');
    beforeBoard[20] = piece(1, null, 'blue-general');
    source.value = snapshot({ board: beforeBoard });

    const afterBoard = emptyBoard();
    afterBoard[20] = piece(1, 'general', 'blue-general');
    const finished = snapshot({ board: afterBoard, moves: [move(1, 5, 10, 'both')], phase: 'finished' });
    source.value = finished;
    const active = view.playback.value;
    assert.ok(active);
    assert.equal(active.board[5]?.id, 'red-company');
    assert.equal(active.board[10]?.id, 'blue-hidden');
    assert.equal(active.board[10]?.rank, null, 'hidden ranks stay hidden');
    assert.equal(active.board[20]?.rank, null, 'the finished snapshot never reveals ranks during playback');
    assert.equal(finished.junqi.board[20]?.rank, 'general');
    assert.deepEqual(view.board.value, beforeBoard);

    clock.tick(1000);
    clock.tick(1000 + BOARD_PLAYBACK_MS);
    assert.equal(view.animating.value, false);
    assert.deepEqual(view.board.value, afterBoard, 'both pieces are gone once the settled finished board applies');
    assert.equal(view.board.value[20]?.rank, 'general', 'settled play may reveal surviving ranks');
  } finally {
    scope.stop();
    clock.restore();
  }
});

test('Junqi playback uses the settled board of a missed first move for the rapid next ply', () => {
  const clock = frameClock(), scope = effectScope(), source = ref<JunqiSnapshot | null>(null), connected = ref(true);
  try {
    const view = scope.run(() => observe(source, connected))!;
    const boardOne = emptyBoard();
    boardOne[5] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: boardOne });

    const boardTwo = boardOne.slice();
    boardTwo[5] = null;
    boardTwo[10] = piece(0, 'company', 'red-company');
    const first = snapshot({ board: boardTwo, moves: [move(1, 5, 10)], version: 2 });
    source.value = first;
    assert.deepEqual(view.playback.value?.board, boardOne);
    clock.tick(1000);
    clock.tick(1200);
    assert.ok(view.playback.value!.progress > 0);

    const boardThree = boardTwo.slice();
    boardThree[10] = null;
    boardThree[15] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: boardThree, moves: [move(1, 5, 10), move(2, 10, 15)], version: 3 });
    assert.equal(view.playback.value?.move.ply, 2);
    assert.deepEqual(view.playback.value?.board, boardTwo, 'the new animation starts from the authoritative settled board');
    assert.equal(view.playback.value?.board[10]?.id, 'red-company');
    assert.equal(clock.frames.size, 1, 'the old frame was cancelled rather than queued behind the new move');
    assert.equal(view.playback.value?.progress, 0);

    clock.tick(3000);
    clock.tick(3000 + BOARD_PLAYBACK_MS);
    assert.equal(view.animating.value, false);
    assert.deepEqual(view.board.value, boardThree);
  } finally {
    scope.stop();
    clock.restore();
  }
});

test('Junqi playback ignores same-ply notifications mid-route and settles on the latest copy', () => {
  const clock = frameClock(), scope = effectScope(), source = ref<JunqiSnapshot | null>(null), connected = ref(true);
  try {
    const view = scope.run(() => observe(source, connected))!;
    const beforeBoard = emptyBoard();
    beforeBoard[5] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: beforeBoard });
    const afterBoard = beforeBoard.slice();
    afterBoard[5] = null;
    afterBoard[10] = piece(0, 'company', 'red-company');
    const moved = snapshot({ board: afterBoard, moves: [move(1, 5, 10)], version: 2 });
    source.value = moved;
    clock.tick(1000);
    clock.tick(1000 + BOARD_PLAYBACK_MS / 2);
    const current = view.playback.value;
    assert.ok(current);
    assert.ok(Math.abs(current.progress - .5) < 1e-9);

    const latestBoard = afterBoard.slice();
    source.value = snapshot({ board: latestBoard, moves: moved.junqi.moves, version: 3 });
    assert.equal(view.playback.value?.progress, current.progress, 'a same-ply notification does not restart the movement');
    assert.equal(clock.frames.size, 1, 'no animation restart was scheduled');

    clock.tick(1000 + BOARD_PLAYBACK_MS);
    assert.equal(view.animating.value, false);
    assert.deepEqual(view.board.value, latestBoard, 'the newest same-ply snapshot is the settled board');
  } finally {
    scope.stop();
    clock.restore();
  }
});

test('Junqi playback discards stale context while offline and needs a fresh baseline after reconnect', () => {
  const clock = frameClock(), scope = effectScope(), source = ref<JunqiSnapshot | null>(null), connected = ref(true);
  try {
    const view = scope.run(() => observe(source, connected))!;
    const firstBoard = emptyBoard();
    firstBoard[5] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: firstBoard });

    const secondBoard = firstBoard.slice();
    secondBoard[5] = null;
    secondBoard[10] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: secondBoard, moves: [move(1, 5, 10)], version: 2 });
    assert.ok(view.playback.value);
    connected.value = false;
    assert.equal(view.animating.value, false, 'disconnecting cancels the live animation');
    assert.equal(clock.frames.size, 0);

    const missedBoard = secondBoard.slice();
    missedBoard[10] = null;
    missedBoard[15] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: missedBoard, moves: [move(1, 5, 10), move(2, 10, 15)], version: 3 });
    assert.equal(view.animating.value, false, 'offline snapshots never replay');

    connected.value = true;
    assert.equal(view.animating.value, false);
    const freshBoard = missedBoard.slice();
    freshBoard[15] = null;
    freshBoard[20] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: freshBoard, moves: [move(1, 5, 10), move(2, 10, 15), move(3, 15, 20)], version: 4 });
    assert.equal(view.animating.value, false, 'the first snapshot after reconnect only establishes the baseline');

    const liveBoard = freshBoard.slice();
    liveBoard[20] = null;
    liveBoard[25] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: liveBoard, moves: [move(1, 5, 10), move(2, 10, 15), move(3, 15, 20), move(4, 20, 25)], version: 5 });
    assert.equal(view.playback.value?.move.ply, 4);
    assert.deepEqual(view.playback.value?.board, freshBoard, 'only the fresh post-reconnect baseline is used');
  } finally {
    scope.stop();
    clock.restore();
  }
});

test('Junqi playback cancels on round changes, skipped plies and unmount without queueing history', () => {
  const clock = frameClock(), scope = effectScope(), source = ref<JunqiSnapshot | null>(null), connected = ref(true);
  try {
    const view = scope.run(() => observe(source, connected))!;
    const firstBoard = emptyBoard();
    firstBoard[5] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: firstBoard });
    const movedBoard = firstBoard.slice();
    movedBoard[5] = null;
    movedBoard[10] = piece(0, 'company', 'red-company');
    source.value = snapshot({ board: movedBoard, moves: [move(1, 5, 10)], version: 2 });
    assert.ok(view.playback.value);

    const resetBoard = emptyBoard();
    resetBoard[0] = piece(0, 'platoon', 'red-platoon');
    source.value = snapshot({ board: resetBoard, roundId: 'round-2', round: 2, version: 3 });
    assert.equal(view.animating.value, false, 'a new round drops the stale route');
    assert.deepEqual(view.board.value, resetBoard);

    const roundTwoBoard = resetBoard.slice();
    roundTwoBoard[0] = null;
    roundTwoBoard[1] = piece(0, 'platoon', 'red-platoon');
    source.value = snapshot({ board: roundTwoBoard, roundId: 'round-2', round: 2, moves: [move(1, 0, 1)], version: 4 });
    assert.equal(view.playback.value?.move.ply, 1, 'a contiguous move in the new round can animate');

    const skippedBoard = roundTwoBoard.slice();
    skippedBoard[1] = null;
    skippedBoard[2] = null;
    skippedBoard[3] = piece(0, 'platoon', 'red-platoon');
    const skipped = snapshot({ board: skippedBoard, roundId: 'round-2', round: 2, moves: [move(1, 0, 1), move(2, 1, 2), move(3, 2, 3)], version: 5 });
    source.value = skipped;
    assert.equal(view.animating.value, false, 'a multi-ply catch-up is not replayed');

    const nextBoard = skippedBoard.slice();
    nextBoard[3] = null;
    nextBoard[4] = piece(0, 'platoon', 'red-platoon');
    source.value = snapshot({ board: nextBoard, roundId: 'round-2', round: 2, moves: [move(1, 0, 1), move(2, 1, 2), move(3, 2, 3), move(4, 3, 4)], version: 6 });
    assert.equal(view.playback.value?.move.ply, 4, 'later contiguous moves animate from the adopted board');
    assert.deepEqual(view.playback.value?.board, skippedBoard);

    scope.stop();
    assert.equal(view.animating.value, false, 'unmount cancels the route');
    assert.equal(clock.frames.size, 0);
  } finally {
    scope.stop();
    clock.restore();
  }
});

test('stone playback retains captured stones until settlement, skips passes and resets on board-size changes', () => {
  type State = { code: string; selfSeat: number | null; phase: string; roundId: string; size: number; board: StoneBoard; moves: StoneMove[] };
  const clock = frameClock(), scope = effectScope(), source = ref<State | null>(null), connected = ref(true);
  try {
    const view = scope.run(() => useBoardPlayback(source, connected, {
      position: s => ({ ...s, layout: `go:${s.size}` }),
      empty: [] as StoneBoard,
      canAnimate: (board, move) => move.point !== null && board[move.point] === null,
    }))!;
    const before: StoneBoard = Array(81).fill(null);
    before[0] = 1; before[1] = 0;
    const base: State = { code: 'GO', selfSeat: 0, phase: 'playing', roundId: 'one', size: 9, board: before, moves: [] };
    source.value = base;
    const result = playGo(before, 9, 0, 9);
    assert.notEqual(typeof result, 'string');
    if (typeof result === 'string') throw new Error(result);
    assert.deepEqual(result.captured, [0]);
    const drop: StoneMove = { ply: 1, side: 0, point: 9, captured: result.captured, notation: 'A2' };
    source.value = { ...base, board: result.board, moves: [drop] };
    assert.equal(view.animating.value, true);
    assert.equal(view.board.value[0], 1, 'captured white stone remains available to fade');
    assert.equal(view.board.value[9], null, 'the placed stone is rendered by the moving layer');
    clock.tick(1000); clock.tick(1000 + BOARD_PLAYBACK_MS);
    assert.equal(view.board.value[0], null);
    assert.equal(view.board.value[9], 0);

    const pass: StoneMove = { ply: 2, side: 1, point: null, captured: [], notation: '停一手' };
    source.value = { ...base, board: result.board, moves: [drop, pass] };
    assert.equal(view.animating.value, false, 'a pass must not replay the previous placement');
    assert.equal(clock.frames.size, 0);
    source.value = { ...base, size: 19, board: Array(361).fill(null), moves: [] };
    assert.equal(view.animating.value, false);
    assert.deepEqual(view.board.value, Array(361).fill(null), 'size reset replaces every old intersection');
  } finally { scope.stop(); clock.restore(); }
});

test('a same-ply resignation ends playback rather than holding a stale pre-move board', () => {
  const clock = frameClock(), scope = effectScope(), source = ref<JunqiSnapshot | null>(null), connected = ref(true);
  try {
    const view = scope.run(() => observe(source, connected))!;
    const before = emptyBoard(); before[5] = piece(0, 'company', 'red');
    source.value = snapshot({ board: before });
    const after = before.slice(); after[10] = after[5]!; after[5] = null;
    const moves = [move(1, 5, 10)];
    source.value = snapshot({ board: after, moves });
    assert.equal(view.animating.value, true);
    source.value = snapshot({ board: after, moves, phase: 'finished', version: 3 });
    assert.equal(view.animating.value, false);
    assert.equal(clock.frames.size, 0);
    assert.deepEqual(view.board.value, after);
  } finally { scope.stop(); clock.restore(); }
});

test('background snapshots settle silently without suppressing the next visible live move', () => {
  const clock = frameClock(), scope = effectScope(), source = ref<JunqiSnapshot | null>(null), connected = ref(true);
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const documentStub = Object.assign(new EventTarget(), { hidden: false });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  try {
    const view = scope.run(() => observe(source, connected))!;
    const first = emptyBoard(); first[5] = piece(0, 'company', 'red');
    source.value = snapshot({ board: first });
    const second = first.slice(); second[10] = second[5]!; second[5] = null;
    source.value = snapshot({ board: second, moves: [move(1, 5, 10)] });
    assert.equal(view.animating.value, true);
    documentStub.hidden = true;
    documentStub.dispatchEvent(new Event('visibilitychange'));
    assert.equal(view.animating.value, false);
    const third = second.slice(); third[15] = third[10]!; third[10] = null;
    source.value = snapshot({ board: third, moves: [move(1, 5, 10), move(2, 10, 15)] });
    assert.equal(view.animating.value, false, 'hidden moves update the board without playing');
    assert.deepEqual(view.board.value, third);
    documentStub.hidden = false;
    documentStub.dispatchEvent(new Event('visibilitychange'));
    const fourth = third.slice(); fourth[20] = fourth[15]!; fourth[15] = null;
    source.value = snapshot({ board: fourth, moves: [move(1, 5, 10), move(2, 10, 15), move(3, 15, 20)] });
    assert.equal(view.animating.value, true, 'the next live move after returning remains visible');
    assert.equal(view.playback.value?.move.ply, 3);
    assert.deepEqual(view.playback.value?.board, third);
  } finally {
    scope.stop(); clock.restore();
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
