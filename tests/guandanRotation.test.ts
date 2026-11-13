// Rotation fuzz for the authoritative Guandan engine: drives full deals to `finished` with
// random-but-legal play and asserts the invariants that keep a table progressing — the turn
// never lands on an empty seat, every adjacent pass clears eventually, and the 对家接风 handoff
// after a 头游 refill works. Guards the exact stall the head游 path could create.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card, GuandanGameFields, Suit } from '../shared/protocol';
import {
  canBeatGuandan,
  enumerateGuandanPlays,
  guandanReturnEligible,
  guandanTributeEligible,
  type GuandanOption,
} from '../shared/guandan';
import { GuandanGame } from '../server/games/guandan';
import { createPlayStamper } from '../server/games/playLog';

function card(rank: number, suit: Suit = 'spade'): Card {
  return { id: `${suit}-${rank}-${rank}${suit}`, rank, suit };
}

/** The engine's own public view, narrowed to the Guandan variant. */
function guandanView(game: GuandanGame, seat: number | null): GuandanGameFields {
  const view = game.view(seat);
  if (view.game !== 'guandan') throw new Error('expected a guandan view');
  return view;
}

function turnOf(game: GuandanGame): number {
  const turn = guandanView(game, null).turn;
  if (turn === null) throw new Error('no seat is on turn');
  return turn;
}

/** Replace a seat's hand; returns the same cards so tests can reference them. */
function setHand(game: GuandanGame, seat: number, cards: Card[]): Card[] {
  game.hands[seat].splice(0, game.hands[seat].length, ...cards);
  return cards;
}

function playTurn(game: GuandanGame, cards: Card[], claim?: string): void {
  const payload: Record<string, unknown> = { cards: cards.map((entry) => entry.id) };
  if (claim !== undefined) payload.claim = claim;
  const result = game.command(turnOf(game), 'play', payload);
  assert.equal(result.ok, true, result.ok ? '' : result.message);
}

function passTurn(game: GuandanGame): void {
  const result = game.command(turnOf(game), 'pass', {});
  assert.equal(result.ok, true, result.ok ? '' : result.message);
}

function newGame(): GuandanGame {
  return new GuandanGame(createPlayStamper('FUZZ'));
}

function viewOf(game: GuandanGame, seat: number | null): GuandanGameFields {
  const view = game.view(seat);
  if (view.game !== 'guandan') throw new Error('expected a guandan view');
  return view;
}

/** Deterministic xorshift-ish PRNG so a fuzz failure reads the same on every run. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    state = (mixed ^ (mixed >>> 14)) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function apply(command: { ok: boolean; message?: string }, what: string): void {
  assert.ok(command.ok, `${what} 被拒：${command.message ?? ''}`);
}

function mustCommand(game: GuandanGame, seat: number, type: 'play' | 'pass' | 'tribute' | 'returnTribute', payload: Record<string, unknown>): void {
  apply(game.command(seat, type, payload), `${type}@${seat}`);
}

function playRandomLegal(view: GuandanGameFields, game: GuandanGame, turn: number, rng: () => number): void {
  const hand = game.hands[turn] ?? [];
  const level = view.guandan.playedLevel;
  // enumerateGuandanPlays classifies one selection, not every subset of a hand.
  const selections = hand.map((card) => [card]);
  const ranks = new Map<number, Card[]>();
  for (const card of hand) ranks.set(card.rank, [...(ranks.get(card.rank) ?? []), card]);
  for (const cards of ranks.values()) {
    for (let size = 2; size <= cards.length; size++) selections.push(cards.slice(0, size));
  }
  const options = selections.flatMap((cards) => enumerateGuandanPlays(cards, level));
  assert.ok(options.length > 0, '持有手牌却没有任何合法牌型');
  const cursor = view.lastPlay?.claim ?? null;
  let choice: GuandanOption | null = null;
  if (cursor === null) {
    choice = options[Math.floor(rng() * options.length)]!;
  } else {
    const beaters = options.filter((option) => canBeatGuandan(option.declaration, cursor, level));
    if (beaters.length > 0 && rng() < 0.8) choice = beaters[Math.floor(rng() * beaters.length)]!;
  }
  if (choice !== null) {
    mustCommand(game, turn, 'play', {
      cards: choice.cards.map((card) => card.id),
      claim: choice.declaration.key,
    });
  } else {
    mustCommand(game, turn, 'pass', {});
  }
}

function driveExchange(game: GuandanGame, rng: () => number): void {
  let view = viewOf(game, null);
  while (view.phase === 'tribute') {
    const stage = view.guandan.exchange.stage;
    if (stage === 'tribute') {
      const owed = view.guandan.exchange.givers.filter((seat) => !view.guandan.exchange.submitted.includes(seat));
      assert.ok(owed.length > 0, '进贡阶段无人欠贡，说明引擎进入死等');
      for (const seat of owed) {
        const eligible = guandanTributeEligible(game.hands[seat] ?? [], view.guandan.playedLevel);
        assert.ok(eligible.length > 0, `seat ${seat} 进贡无牌可选`);
        mustCommand(game, seat, 'tribute', { cardId: eligible[Math.floor(rng() * eligible.length)]!.id });
      }
    } else if (stage === 'return') {
      for (const pair of view.guandan.exchange.pairs) {
        const eligible = guandanReturnEligible(game.hands[pair.receiver] ?? [], view.guandan.playedLevel);
        assert.ok(eligible.length > 0, `seat ${pair.receiver} 还贡无牌可选`);
        mustCommand(game, pair.receiver, 'returnTribute', { cardId: eligible[Math.floor(rng() * eligible.length)]!.id });
      }
    } else {
      break;
    }
    view = viewOf(game, null);
  }
}

/**
 * One full deal: play random-but-legal until `finished`. Documents two invariants directly:
 * ① the acting seat always still holds cards; ② the deal reaches its end inside the budget.
 */
function driveDeal(game: GuandanGame, rng: () => number, budget = 30_000): GuandanGameFields {
  let steps = 0;
  let view = viewOf(game, null);
  while (steps < budget) {
    steps += 1;
    if (view.phase === 'finished') return view;
    if (view.phase === 'playing') {
      const turn = view.turn;
      assert.ok(turn !== null, '出牌阶段没有轮转座位');
      assert.ok((game.hands[turn] ?? []).length > 0, `轮次落在空座位 ${turn}（头游后卡死的味道）`);
      playRandomLegal(view, game, turn, rng);
    } else if (view.phase === 'tribute') {
      driveExchange(game, rng);
    } else {
      break;
    }
    view = viewOf(game, null);
  }
  throw new Error(`对局 ${steps} 步后仍未结束：phase=${view.phase} finishing=${view.guandan.finishOrder} levels=${view.guandan.levels}`);
}

function driveMatch(rng: () => number, seed: number): void {
  const game = newGame();
  game.start();
  let budget = 0;
  while (budget < 200) {
    budget += 1;
    const view = driveDeal(game, rng);
    assert.ok(view.guandan.result !== null, 'finished 阶段必须有结果');
    if (view.guandan.matchWinner !== null) {
      assert.equal(view.guandan.matchWinner, view.guandan.result!.winnerTeam, '整场赢家必须与本副赢家一致');
      return;
    }
    const restarted = game.restart();
    apply(restarted, 'restart');
    game.start();
  }
  throw new Error('一场 200 副都没打完，说明晋级/结束判定有问题');
}

test('seed 1999: four consecutive full matches complete without stalling', () => {
  driveMatch(makeRng(1999), 0);
});

test('seed 20260101: another full match run', () => {
  driveMatch(makeRng(20_260_101), 1);
});

test('seed 42: third independent match run', () => {
  driveMatch(makeRng(42), 2);
});

test('seed 31337: fourth independent match run', () => {
  driveMatch(makeRng(31_337), 3);
});

// Fuzz-sprayed deals: wages broader random deals on one engine instance keeps the 断言 honest.
test('sprayed deals across seeds finish and never seat a ghost turn', () => {
  for (const seed of [7, 8, 9, 11, 13]) {
    driveMatch(makeRng(seed), seed);
    for (let round = 0; round < 4; round += 1) {
      const game = newGame();
      game.start();
      driveDeal(game, makeRng(seed * 100 + round));
    }
  }
});

/**
 * Forced-head游 spec: a seat empties by BEATING an open trick (the live shape from the
 * 头游滞留 report). Asserts the three invariants that keep the table progressing after
 * that moment: ① pass threshold only counts seats still holding cards, ② the trick
 * actually clears, ③ the 对家接风 handoff gives the lead to the finisher's partner —
 * whose next lead is then accepted by the engine the same way any lead is.
 */
test('头游之后的墩清：阈值只数有牌座位，对家接风', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  const nexts = [(leader + 1) % 4, (leader + 2) % 4, (leader + 3) % 4];
  const finisher = nexts[1];
  const partnerOfFinisher = (finisher + 2) % 4;
  setHand(game, leader, [card(7), card(12), card(13)]); // 3 cards: the wind-lead must not itself finish the deal
  setHand(game, nexts[0], [card(9), card(13)]);
  setHand(game, finisher, [card(10)]);
  setHand(game, nexts[2], [card(6), card(14)]);

  // leader leads 7; nexts[0] beats 9; finisher beats 10 and empties (头游, mid-trick).
  playTurn(game, [card(7)]);
  playTurn(game, [card(9)]);
  playTurn(game, [card(10)]);

  let view = guandanView(game, null);
  assert.equal(view.guandan.finishOrder[0], finisher, '头游必须是 finisher');
  assert.equal(game.hands[finisher].length, 0);
  assert.notEqual(view.lastPlay, null, '压牌完成的头游：墩还没清');
  assert.equal(turnOf(game), nexts[2], '打完牌立即轮到下一个有牌座位');

  // Only three seats still hold cards, including the empty actor's exclusion: exactly
  // three passes clear this trick. Nobody here should be skipped, nobody should be asked twice.
  passTurn(game); // nexts[2] holds 6/14, both beatable — passes anyway
  passTurn(game); // leader's 12 could beat 10 — passes (choice, not obligation)
  passTurn(game); // nexts[0]'s 13 could beat 10 — passes; third pass clears
  view = guandanView(game, null);
  assert.equal(view.lastPlay, null, '三次过牌之后墩必须已清');
  assert.equal(turnOf(game), partnerOfFinisher, '对家接风：轮次交给头游者的对家');
  assert.ok(game.hands[partnerOfFinisher].length > 0, '接风者必须有牌可出');

  // 接风者正常领出，轮转继续落到下一个有牌座位。
  const windHand = game.hands[partnerOfFinisher];
  playTurn(game, windHand.slice(0, 1));
  view = guandanView(game, null);
  const after = turnOf(game);
  assert.ok(game.hands[after].length > 0, `接风后轮次落在空座位 ${after}`);
  assert.notEqual(view.guandan.finishOrder[0], after, '接风后的轮次不能是已完成的座位');
});

/**
 * The live-room killer variant: 头游者的最后一手是炸弹（几乎不可压），后续所有座位都必须过。
 * After the clear the wind hands the lead to the finisher's partner and play resumes.
 */
test('头游压炸弹后全场只能过：清墩与接风照常推进', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  const nexts = [(leader + 1) % 4, (leader + 2) % 4, (leader + 3) % 4];
  const finisher = nexts[1];
  setHand(game, leader, [card(3, 'heart'), card(6)]);
  setHand(game, nexts[0], [card(4), card(9)]);
  setHand(game, finisher, [card(8), card(8, 'heart'), card(8, 'club'), card(8, 'diamond')]);
  setHand(game, nexts[2], [card(11), card(17, 'joker')]); // no straight/bomb can beat a plain quad-8

  playTurn(game, [card(3, 'heart')]);
  playTurn(game, [card(4)]);
  // finisher bombs the open trick: the only legal beat left is a bigger bomb; none exists.
  playTurn(game, [card(8), card(8, 'heart'), card(8, 'club'), card(8, 'diamond')]);

  assert.equal(game.hands[finisher].length, 0);
  const view = guandanView(game, null);
  assert.equal(view.guandan.finishOrder[0], finisher);
  assert.equal(turnOf(game), nexts[2]);
  passTurn(game); // 11 无法压炸弹
  passTurn(game); // 大王也无法压（炸弹只被更大炸弹/火箭压）
  passTurn(game); // leader 也不行 → 清墩
  assert.equal(guandanView(game, null).lastPlay, null);
  // 风给头游者对家（nexts[0] + 2 = leader + 3 = nexts[2] 的对家…（finisher=l+2 → partner=l）)
  assert.equal(turnOf(game), (finisher + 2) % 4, '炸弹头游后接风仍交给对家');
  playTurn(game, game.hands[(finisher + 2) % 4].slice());
});
