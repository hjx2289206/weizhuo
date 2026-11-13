// Permanent tests for the authoritative Guandan match engine: deal/trick progression, the 2→A
// match, tribute/return exchange, 抗贡, finishing rules and exchange privacy.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card, GuandanGameFields, Suit } from '../shared/protocol';
import { GUANDAN_LEVELS } from '../shared/guandan';
import { GuandanGame } from '../server/games/guandan';
import { createPlayStamper } from '../server/games/playLog';
import type { GameResult } from '../server/games/types';

const LEVEL_TWO = GUANDAN_LEVELS[0];
const LEVEL_ACE = GUANDAN_LEVELS[GUANDAN_LEVELS.length - 1];
const BIG_JOKER = 17;
const SMALL_JOKER = 16;

let cardSeq = 0;
function card(rank: number, suit: Suit = 'spade'): Card {
  cardSeq += 1;
  return { id: `t${cardSeq}`, rank, suit };
}
function joker(rank: number): Card {
  return card(rank, 'joker');
}
/** A card that can never be in a hand: proves the ownership check without a real seat. */
function holeCard(): Card {
  return { id: 'hole-1', rank: 9, suit: 'diamond' };
}

function newGame(): GuandanGame {
  return new GuandanGame(createPlayStamper('TEST'));
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

function rejected(result: GameResult, fragment: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.message.includes(fragment), `unexpected message: ${result.message}`);
}

function totalCards(game: GuandanGame): number {
  return game.hands.reduce((sum, hand) => sum + hand.length, 0);
}

function partnerOf(seat: number): number {
  return (seat + 2) % 4;
}

/** One equal-rank card each: nobody can beat it, so the head's partner borrows the wind (双下). */
function driveDoubleDown(game: GuandanGame): { leader: number; partner: number } {
  const hands: Card[][] = [[], [], [], []];
  for (let seat = 0; seat < 4; seat += 1) hands[seat] = setHand(game, seat, [card(3)]);
  const leader = turnOf(game);
  const partner = partnerOf(leader);
  playTurn(game, hands[leader]);
  passTurn(game);
  passTurn(game);
  passTurn(game);
  playTurn(game, hands[partner]);
  return { leader, partner };
}

/** Strictly increasing singles in ring order from the leader: 1st, 2nd, 3rd out, then the 下游. */
function driveNormalEnd(game: GuandanGame): number {
  const leader = turnOf(game);
  const hands: Card[][] = [[], [], [], []];
  for (let step = 0; step < 4; step += 1) {
    const seat = (leader + step) % 4;
    hands[seat] = setHand(game, seat, [card(3 + step)]);
  }
  playTurn(game, hands[leader]);
  playTurn(game, hands[(leader + 1) % 4]);
  playTurn(game, hands[(leader + 2) % 4]);
  return leader;
}

/** Finish deal 1 quickly, then open deal 2 so its exchange can be driven. */
function openSecondDeal(game: GuandanGame): void {
  game.start();
  driveNormalEnd(game);
  game.restart();
  game.start();
}

test('first deal opens at level 2 with a random leader and no exchange', () => {
  const game = newGame();
  game.start();
  const view = guandanView(game, null);
  assert.equal(view.game, 'guandan');
  assert.equal(view.phase, 'playing');
  assert.equal(view.guandan.deal, 1);
  assert.deepEqual(view.guandan.levels, [LEVEL_TWO, LEVEL_TWO]);
  assert.equal(view.guandan.playedLevel, LEVEL_TWO);
  assert.equal(view.guandan.exchange.stage, 'none');
  assert.equal(view.guandan.matchWinner, null);
  assert.equal(view.lastPlay, null);
  assert.equal(view.trickStartIndex, 0);
  assert.ok(turnOf(game) >= 0 && turnOf(game) < 4);

  const ids = new Set<string>();
  for (let seat = 0; seat < 4; seat += 1) {
    assert.equal(game.handOf(seat).length, 27);
    for (const entry of game.handOf(seat)) ids.add(entry.id);
    assert.equal(game.requiresConnection(seat), true);
    assert.equal(game.passedAt(seat), false);
  }
  assert.equal(ids.size, 108);
  assert.equal(totalCards(game), 108);
  assert.equal(view.privateAction, null);
  assert.equal(guandanView(game, 2).privateAction, null);
  // No hand and no Doudizhu field may ride along inside the gameplay view.
  assert.equal('hand' in view, false);
  assert.equal('landlord' in view, false);
  assert.equal('scores' in view, false);
  rejected(game.restart(), '本副尚未结束');
});

test('scattered plays keep unique room-lifetime ids and bounded scatter', () => {
  const game = newGame();
  game.start();
  const hands: Card[][] = [[], [], [], []];
  for (let step = 0; step < 4; step += 1) hands[step] = [card(3 + step)];
  const leader = turnOf(game);
  setHand(game, leader, hands[0]);
  setHand(game, (leader + 1) % 4, hands[1]);
  setHand(game, (leader + 2) % 4, hands[2]);
  setHand(game, (leader + 3) % 4, hands[3]);
  playTurn(game, hands[0]);
  playTurn(game, hands[1]);
  const view = guandanView(game, null);
  assert.equal(view.tablePlays.length, 2);
  assert.equal(view.tablePlays[0].id, 'TEST:1');
  assert.equal(view.tablePlays[1].id, 'TEST:2');
  assert.equal(view.tablePlays[0].seatId, leader);
  assert.equal(view.tablePlays[0].claim?.kind, 'single');
  assert.equal(typeof view.tablePlays[0].kind, 'string');
  assert.ok(Math.abs(view.tablePlays[0].scatter.x) <= 0.045);
  assert.ok(Math.abs(view.tablePlays[0].scatter.y) <= 0.045);
  assert.ok(Math.abs(view.tablePlays[0].scatter.angle) <= 8);
});

test('a team taking the first two places ends the deal at once and upgrades three', () => {
  const game = newGame();
  game.start();
  const { leader, partner } = driveDoubleDown(game);
  const view = guandanView(game, null);
  const result = view.guandan.result;
  assert.equal(view.phase, 'finished');
  assert.equal(view.turn, null);
  assert.equal(view.guandan.matchWinner, null);
  assert.equal(view.guandan.exchange.stage, 'none');
  assert.ok(result !== null);
  assert.equal(result.doubleDown, true);
  assert.deepEqual(result.order, [leader, partner]);
  assert.equal(result.winnerTeam, leader % 2);
  assert.equal(result.upgrade, 3);
  assert.deepEqual(result.levelsBefore, [LEVEL_TWO, LEVEL_TWO]);
  assert.equal(result.levelsAfter[leader % 2], GUANDAN_LEVELS[3]);
  assert.equal(result.levelsAfter[(leader + 1) % 2], LEVEL_TWO);
  assert.equal(view.guandan.finishOrder.length, 2);
  for (let seat = 0; seat < 4; seat += 1) assert.equal(game.requiresConnection(seat), false);
});

test('a normal finish orders all four seats and upgrades two when the partner is third', () => {
  const game = newGame();
  game.start();
  const leader = driveNormalEnd(game);
  const view = guandanView(game, null);
  const result = view.guandan.result;
  assert.ok(result !== null);
  assert.equal(result.doubleDown, false);
  assert.deepEqual(result.order, [leader, (leader + 1) % 4, (leader + 2) % 4, (leader + 3) % 4]);
  assert.equal(result.upgrade, 2);
  assert.equal(result.levelsAfter[leader % 2], GUANDAN_LEVELS[2]);
  assert.equal(view.phase, 'finished');
});

test('upgrade one when the head\'s own partner is the last seat', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  const hands: Card[][] = [[], [], [], []];
  hands[leader] = setHand(game, leader, [card(3)]);
  hands[(leader + 1) % 4] = setHand(game, (leader + 1) % 4, [card(4)]);
  hands[(leader + 2) % 4] = setHand(game, (leader + 2) % 4, [card(3, 'heart')]);
  hands[(leader + 3) % 4] = setHand(game, (leader + 3) % 4, [card(5)]);
  playTurn(game, hands[leader]);
  playTurn(game, hands[(leader + 1) % 4]);
  passTurn(game);
  playTurn(game, hands[(leader + 3) % 4]);
  const result = guandanView(game, null).guandan.result;
  assert.ok(result !== null);
  assert.deepEqual(result.order, [leader, (leader + 1) % 4, (leader + 3) % 4, (leader + 2) % 4]);
  assert.equal(result.upgrade, 1);
});

test('reaching A is not passing A: an overshooting upgrade stops at A', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  game.levels[leader % 2] = 13;
  game.playedLevel = 13;
  driveDoubleDown(game);
  const view = guandanView(game, null);
  const result = view.guandan.result;
  assert.ok(result !== null);
  assert.equal(result.upgrade, 3);
  assert.equal(result.levelsBefore[leader % 2], 13);
  assert.equal(result.levelsAfter[leader % 2], LEVEL_ACE);
  assert.equal(view.guandan.matchWinner, null);
  assert.equal(view.guandan.levels[leader % 2], LEVEL_ACE);
});

test('a deal played at A with the partner second passes A and wins the match', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  game.levels[leader % 2] = LEVEL_ACE;
  game.playedLevel = LEVEL_ACE;
  driveDoubleDown(game);
  const view = guandanView(game, null);
  assert.equal(view.guandan.matchWinner, leader % 2);
  assert.equal(view.phase, 'finished');
  assert.match(game.statusText(null, (seat) => `P${seat}`), /过 A 获胜/);
});

test('a deal played at A with the partner last stays at A and never demotes', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  game.levels[0] = LEVEL_ACE;
  game.levels[1] = LEVEL_ACE;
  game.playedLevel = LEVEL_ACE;
  const hands: Card[][] = [[], [], [], []];
  hands[leader] = setHand(game, leader, [card(3)]);
  hands[(leader + 1) % 4] = setHand(game, (leader + 1) % 4, [card(4)]);
  hands[(leader + 2) % 4] = setHand(game, (leader + 2) % 4, [card(3, 'heart')]);
  hands[(leader + 3) % 4] = setHand(game, (leader + 3) % 4, [card(5)]);
  playTurn(game, hands[leader]);
  playTurn(game, hands[(leader + 1) % 4]);
  passTurn(game);
  playTurn(game, hands[(leader + 3) % 4]);
  const view = guandanView(game, null);
  assert.equal(view.guandan.result?.upgrade, 1);
  assert.equal(view.guandan.matchWinner, null);
  assert.deepEqual(view.guandan.levels, [LEVEL_ACE, LEVEL_ACE]);
});

test('with both teams already at A either qualifying winner may pass A', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  game.levels[0] = LEVEL_ACE;
  game.levels[1] = LEVEL_ACE;
  game.playedLevel = LEVEL_ACE;
  driveDoubleDown(game);
  const view = guandanView(game, null);
  assert.equal(view.guandan.matchWinner, leader % 2);
  assert.deepEqual(view.guandan.levels, [LEVEL_ACE, LEVEL_ACE]);
});

test('next deal keeps both levels and plays at the previous winner\'s level', () => {
  const game = newGame();
  game.start();
  const leader = driveNormalEnd(game);
  const winnerTeam = leader % 2;
  const advanced = GUANDAN_LEVELS[2];
  assert.deepEqual(game.restart(), { ok: true });
  const lobby = guandanView(game, null);
  assert.equal(lobby.phase, 'lobby');
  assert.equal(lobby.turn, null);
  assert.deepEqual(lobby.guandan.levels, winnerTeam === 0 ? [advanced, LEVEL_TWO] : [LEVEL_TWO, advanced]);
  assert.ok(lobby.guandan.result !== null);
  assert.equal(totalCards(game), 0);

  game.start();
  const second = guandanView(game, null);
  assert.equal(second.guandan.deal, 2);
  assert.equal(second.guandan.playedLevel, advanced);
  assert.notEqual(second.guandan.exchange.stage, 'none');
  assert.equal(totalCards(game), 108);
});

test('a rematch resets both levels to 2 and drops the previous round result', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  game.levels[leader % 2] = LEVEL_ACE;
  game.playedLevel = LEVEL_ACE;
  driveDoubleDown(game);
  assert.notEqual(guandanView(game, null).guandan.matchWinner, null);
  assert.deepEqual(game.restart(), { ok: true });
  const lobby = guandanView(game, null);
  assert.equal(lobby.guandan.matchWinner, null);
  assert.equal(lobby.guandan.result, null);
  assert.equal(lobby.guandan.deal, 0);
  assert.deepEqual(lobby.guandan.levels, [LEVEL_TWO, LEVEL_TWO]);
  game.start();
  const first = guandanView(game, null);
  assert.equal(first.guandan.deal, 1);
  assert.equal(first.guandan.exchange.stage, 'none');
  assert.equal(first.guandan.playedLevel, LEVEL_TWO);
});

test('single tribute: the last seat hands its biggest non-wild card to the head and leads', () => {
  const game = newGame();
  openSecondDeal(game);
  const playLevel = guandanView(game, null).guandan.playedLevel;
  const previous = game.result;
  assert.ok(previous !== null);
  const head = previous.order[0];
  const giver = previous.order[3];
  const tributeCard = joker(BIG_JOKER);
  const headCards = [card(3), card(6), card(11), card(playLevel, 'club')];
  const bystander = card(9, 'heart');
  setHand(game, giver, [tributeCard, card(12, 'heart')]);
  setHand(game, head, headCards);
  setHand(game, (head + 1) % 4, [bystander]);
  setHand(game, (head + 2) % 4, [card(8)]);
  const escrow = totalCards(game);

  game.beginExchange();
  const view = guandanView(game, null);
  assert.equal(view.phase, 'tribute');
  assert.equal(view.guandan.exchange.stage, 'tribute');
  assert.deepEqual(view.guandan.exchange.givers, [giver]);
  assert.deepEqual(view.guandan.exchange.pairs, []);
  assert.equal(view.guandan.exchange.leader, null);
  assert.equal(guandanView(game, head).privateAction, null);
  assert.equal(guandanView(game, 5).privateAction, null);

  const own = guandanView(game, giver).privateAction;
  assert.ok(own !== null);
  assert.equal(own.kind, 'tribute');
  assert.deepEqual(own.eligibleIds, [tributeCard.id]);
  assert.equal(own.committed, null);
  rejected(game.command(head, 'tribute', { cardId: tributeCard.id }), '不需要进贡');
  rejected(game.command(giver, 'tribute', {}), '请选择进贡的牌');
  rejected(game.command(giver, 'tribute', { cardId: card(3).id }), '最大的牌');
  rejected(game.command(giver, 'tribute', { cardId: card(12, 'heart').id }), '最大的牌');

  const before = JSON.stringify(guandanView(game, null));
  rejected(game.command(giver, 'tribute', { cardId: card(3).id }), '最大的牌');
  assert.equal(JSON.stringify(guandanView(game, null)), before, 'a rejected command must not change the deal');
  assert.deepEqual(game.command(giver, 'tribute', { cardId: tributeCard.id }), { ok: true });

  const returning = guandanView(game, null);
  assert.equal(returning.guandan.exchange.stage, 'return');
  assert.deepEqual(returning.guandan.exchange.submitted, []);
  assert.equal(returning.guandan.exchange.pairs.length, 1);
  assert.equal(returning.guandan.exchange.pairs[0].giver, giver);
  assert.equal(returning.guandan.exchange.pairs[0].receiver, head);
  assert.equal(returning.guandan.exchange.pairs[0].tribute.id, tributeCard.id);
  assert.equal(returning.guandan.exchange.pairs[0].returned, null);
  assert.equal(game.handOf(giver).length, 1);
  assert.equal(game.handOf(head).length, headCards.length + 1);
  assert.equal(totalCards(game), escrow);

  const receiver = guandanView(game, head).privateAction;
  assert.ok(receiver !== null);
  assert.equal(receiver.kind, 'return');
  assert.deepEqual(receiver.eligibleIds.slice().sort(), [headCards[0].id, headCards[1].id].sort());
  assert.equal(guandanView(game, giver).privateAction, null);
  rejected(game.command(head, 'returnTribute', { cardId: headCards[2].id }), '10以下');
  rejected(game.command(head, 'returnTribute', { cardId: headCards[3].id }), '10以下');
  rejected(game.command(head, 'returnTribute', { cardId: joker(BIG_JOKER).id }), '10以下');
  rejected(game.command(giver, 'returnTribute', { cardId: card(3).id }), '不需要还贡');

  assert.deepEqual(game.command(head, 'returnTribute', { cardId: headCards[1].id }), { ok: true });
  const done = guandanView(game, null);
  assert.equal(done.phase, 'playing');
  assert.equal(done.guandan.exchange.stage, 'complete');
  assert.equal(done.guandan.exchange.leader, giver);
  assert.equal(done.turn, giver);
  assert.equal(done.lastPlay, null);
  assert.equal(done.guandan.exchange.pairs[0].returned?.id, headCards[1].id);
  assert.equal(game.handOf(giver).length, 2);
  assert.equal(game.handOf(head).length, headCards.length);
  assert.equal(totalCards(game), escrow);
  assert.ok(game.handOf(giver).some((entry) => entry.id === headCards[1].id));
  assert.equal(game.statusText(giver, (seat) => `P${seat}`), '轮到你出牌');
});

test('double tribute pairs the bigger card with the head and the head-giver leads', () => {
  const game = newGame();
  game.start();
  driveDoubleDown(game);
  game.restart();
  game.start();
  const previous = game.result;
  assert.ok(previous !== null && previous.doubleDown);
  const head = previous.order[0];
  const partner = partnerOf(head);
  const givers = [0, 1, 2, 3].filter((seat) => seat !== head && seat !== partner);
  const big = joker(BIG_JOKER);
  const small = joker(SMALL_JOKER);
  const headCard = card(3);
  const partnerCard = card(5);
  setHand(game, givers[0], [big, card(4, 'club')]);
  setHand(game, givers[1], [small, card(4, 'diamond')]);
  setHand(game, head, [headCard]);
  setHand(game, partner, [partnerCard]);
  const escrow = totalCards(game);
  game.beginExchange();

  assert.equal(guandanView(game, null).guandan.exchange.stage, 'tribute');
  const first = guandanView(game, givers[0]).privateAction;
  const second = guandanView(game, givers[1]).privateAction;
  assert.ok(first !== null && second !== null);
  assert.deepEqual(first.eligibleIds, [big.id]);
  assert.deepEqual(second.eligibleIds, [small.id]);

  assert.deepEqual(game.command(givers[0], 'tribute', { cardId: big.id }), { ok: true });
  const barrier = guandanView(game, null);
  assert.equal(barrier.guandan.exchange.stage, 'tribute', 'one commit must not reveal or pair anything');
  assert.deepEqual(barrier.guandan.exchange.pairs, []);
  assert.deepEqual(barrier.guandan.exchange.submitted, [givers[0]]);
  rejected(game.command(givers[0], 'tribute', { cardId: small.id }), '已经进贡过了');
  assert.deepEqual(guandanView(game, null).guandan.exchange.submitted, [givers[0]]);
  assert.equal(guandanView(game, givers[0]).privateAction?.committed?.id, big.id);
  assert.equal(guandanView(game, givers[1]).privateAction?.committed, null);
  assert.equal(guandanView(game, givers[1]).privateAction?.eligibleIds.includes(big.id), false);
  assert.equal(JSON.stringify(guandanView(game, givers[1])).includes(big.id), false);
  assert.equal(JSON.stringify(guandanView(game, head)).includes(big.id), false);
  assert.ok(game.handOf(givers[0]).some((entry) => entry.id === big.id), 'escrow keeps the card in hand');
  assert.equal(totalCards(game), escrow);

  assert.deepEqual(game.command(givers[1], 'tribute', { cardId: small.id }), { ok: true });
  const paired = guandanView(game, null);
  assert.equal(paired.guandan.exchange.stage, 'return');
  assert.equal(paired.guandan.exchange.pairs.length, 2);
  assert.equal(paired.guandan.exchange.pairs[0].giver, givers[0]);
  assert.equal(paired.guandan.exchange.pairs[0].receiver, head);
  assert.equal(paired.guandan.exchange.pairs[0].tribute.id, big.id);
  assert.equal(paired.guandan.exchange.pairs[1].giver, givers[1]);
  assert.equal(paired.guandan.exchange.pairs[1].receiver, partner);
  assert.equal(paired.guandan.exchange.pairs[1].tribute.id, small.id);
  assert.equal(paired.guandan.exchange.pairs[0].returned, null);
  assert.equal(game.handOf(head).length, 2);
  assert.equal(game.handOf(partner).length, 2);
  assert.equal(totalCards(game), escrow);

  const headView = guandanView(game, head).privateAction;
  const partnerView = guandanView(game, partner).privateAction;
  assert.ok(headView !== null && partnerView !== null);
  assert.deepEqual(headView.eligibleIds, [headCard.id]);
  assert.deepEqual(partnerView.eligibleIds, [partnerCard.id]);

  assert.deepEqual(game.command(head, 'returnTribute', { cardId: headCard.id }), { ok: true });
  const returned = guandanView(game, null);
  assert.equal(returned.guandan.exchange.stage, 'return');
  assert.equal(returned.guandan.exchange.pairs[0].returned, null, 'no face is revealed before both returns');
  assert.equal(returned.guandan.exchange.pairs[1].returned, null);
  // Tributed faces become public with the pairing; returned faces stay hidden until both commit.
  assert.equal(JSON.stringify(guandanView(game, partner)).includes(big.id), true);
  assert.equal(JSON.stringify(guandanView(game, partner)).includes(headCard.id), false);
  assert.equal(JSON.stringify(guandanView(game, givers[0])).includes(headCard.id), false);
  assert.equal(totalCards(game), escrow);

  assert.deepEqual(game.command(partner, 'returnTribute', { cardId: partnerCard.id }), { ok: true });
  const complete = guandanView(game, null);
  assert.equal(complete.phase, 'playing');
  assert.equal(complete.guandan.exchange.stage, 'complete');
  assert.equal(complete.guandan.exchange.leader, givers[0]);
  assert.equal(complete.turn, givers[0]);
  assert.equal(complete.guandan.exchange.pairs[0].returned?.id, headCard.id);
  assert.equal(complete.guandan.exchange.pairs[1].returned?.id, partnerCard.id);
  assert.equal(totalCards(game), escrow);
  assert.equal(game.statusText(head, (seat) => `P${seat}`), `等待 P${givers[0]} 出牌`);
});

test('equal tribute ranks send the head\'s own next seat to the head, and that seat leads', () => {
  const game = newGame();
  game.start();
  driveDoubleDown(game);
  game.restart();
  game.start();
  const previous = game.result;
  assert.ok(previous !== null && previous.doubleDown);
  const head = previous.order[0];
  const partner = partnerOf(head);
  const givers = [0, 1, 2, 3].filter((seat) => seat !== head && seat !== partner);
  const firstCard = joker(SMALL_JOKER);
  const secondCard = joker(SMALL_JOKER);
  const headCard = card(3);
  const partnerCard = card(3, 'club');
  setHand(game, givers[0], [firstCard]);
  setHand(game, givers[1], [secondCard]);
  setHand(game, head, [headCard]);
  setHand(game, partner, [partnerCard]);
  const escrow = totalCards(game);
  game.beginExchange();
  assert.deepEqual(game.command(givers[0], 'tribute', { cardId: firstCard.id }), { ok: true });
  assert.deepEqual(game.command(givers[1], 'tribute', { cardId: secondCard.id }), { ok: true });

  const view = guandanView(game, null);
  const nextSeat = givers.includes((head + 1) % 4) ? (head + 1) % 4 : givers[0];
  assert.equal(view.guandan.exchange.pairs[0].giver, nextSeat);
  assert.equal(view.guandan.exchange.pairs[0].receiver, head);
  assert.equal(view.guandan.exchange.pairs[1].receiver, partner);
  assert.equal(totalCards(game), escrow);

  assert.deepEqual(guandanView(game, head).privateAction?.eligibleIds, [headCard.id]);
  assert.deepEqual(guandanView(game, partner).privateAction?.eligibleIds, [partnerCard.id]);
  assert.deepEqual(game.command(head, 'returnTribute', { cardId: headCard.id }), { ok: true });
  assert.deepEqual(game.command(partner, 'returnTribute', { cardId: partnerCard.id }), { ok: true });
  const complete = guandanView(game, null);
  assert.equal(complete.guandan.exchange.stage, 'complete');
  assert.equal(complete.guandan.exchange.leader, nextSeat, 'the head-giver leads the first trick');
  assert.equal(complete.turn, nextSeat);
  assert.equal(totalCards(game), escrow);
});

test('resisted single tribute skips the exchange and the head leads', () => {
  const game = newGame();
  game.start();
  driveNormalEnd(game);
  game.restart();
  game.start();
  const previous = game.result;
  assert.ok(previous !== null && !previous.doubleDown);
  const head = previous.order[0];
  const giver = previous.order[3];
  const bigs = [joker(BIG_JOKER), joker(BIG_JOKER)];
  setHand(game, giver, bigs);
  setHand(game, head, [card(3)]);
  game.beginExchange();

  const view = guandanView(game, null);
  assert.equal(view.phase, 'playing');
  assert.equal(view.guandan.exchange.stage, 'resisted');
  assert.deepEqual(view.guandan.exchange.givers, [giver]);
  assert.deepEqual(view.guandan.exchange.pairs, []);
  assert.equal(view.guandan.exchange.leader, head);
  assert.equal(view.turn, head);
  assert.equal(game.handOf(giver).length, 2);
  assert.equal(guandanView(game, giver).privateAction, null);
  assert.equal(JSON.stringify(view).includes(bigs[0].id), false, 'no private joker id leaks');
  rejected(game.command(giver, 'tribute', { cardId: bigs[0].id }), '不是进贡阶段');
  assert.match(game.statusText(head, (seat) => `P${seat}`), /抗贡/);
});

test('resisted double tribute needs both big jokers across the two givers, split allowed', () => {
  const game = newGame();
  game.start();
  driveDoubleDown(game);
  game.restart();
  game.start();
  const previous = game.result;
  assert.ok(previous !== null && previous.doubleDown);
  const head = previous.order[0];
  const partner = partnerOf(head);
  const givers = [0, 1, 2, 3].filter((seat) => seat !== head && seat !== partner);
  const first = joker(BIG_JOKER);
  const second = joker(BIG_JOKER);
  setHand(game, givers[0], [first, card(3)]);
  setHand(game, givers[1], [second, card(3)]);
  setHand(game, head, [card(4)]);
  setHand(game, partner, [card(4)]);
  const escrow = totalCards(game);
  game.beginExchange();
  const view = guandanView(game, null);
  assert.equal(view.guandan.exchange.stage, 'resisted');
  assert.equal(view.guandan.exchange.leader, head);
  assert.equal(view.turn, head);
  assert.deepEqual(view.guandan.exchange.givers.slice().sort(), givers.slice().sort());
  assert.equal(totalCards(game), escrow);
});

test('return eligibility is rank ordered: level cards and jokers are out, no low card falls back to the minimum tie', () => {
  const game = newGame();
  openSecondDeal(game);
  const level = guandanView(game, null).guandan.playedLevel;
  const previous = game.result;
  assert.ok(previous !== null);
  const head = previous.order[0];
  const giver = previous.order[3];
  const low = card(3);
  const middle = card(6);
  const jack = card(11);
  const levelCard = card(level, 'club');
  const tribute = joker(BIG_JOKER);
  setHand(game, giver, [tribute]);
  setHand(game, head, [low, middle, jack, levelCard]);
  game.beginExchange();
  assert.deepEqual(game.command(giver, 'tribute', { cardId: tribute.id }), { ok: true });
  const eligible = guandanView(game, head).privateAction?.eligibleIds ?? [];
  assert.deepEqual(eligible.slice().sort(), [low.id, middle.id].sort());
  assert.equal(eligible.includes(jack.id), false);
  assert.equal(eligible.includes(levelCard.id), false);
  assert.deepEqual(game.command(head, 'returnTribute', { cardId: middle.id }), { ok: true });

  const lonely = newGame();
  openSecondDeal(lonely);
  const lonelyLevel = guandanView(lonely, null).guandan.playedLevel;
  const lonelyPrevious = lonely.result;
  assert.ok(lonelyPrevious !== null);
  const lonelyHead = lonelyPrevious.order[0];
  const lonelyGiver = lonelyPrevious.order[3];
  const jackA = card(11);
  const jackB = card(11, 'heart');
  const lonelyTribute = joker(BIG_JOKER);
  setHand(lonely, lonelyGiver, [lonelyTribute]);
  setHand(lonely, lonelyHead, [jackA, jackB, card(12), card(13), card(14), card(lonelyLevel, 'club')]);
  lonely.beginExchange();
  assert.deepEqual(lonely.command(lonelyGiver, 'tribute', { cardId: lonelyTribute.id }), { ok: true });
  const ties = guandanView(lonely, lonelyHead).privateAction?.eligibleIds ?? [];
  assert.deepEqual(ties.slice().sort(), [jackA.id, jackB.id].sort());
  rejected(lonely.command(lonelyHead, 'returnTribute', { cardId: card(12).id }), '10以下');
  assert.deepEqual(lonely.command(lonelyHead, 'returnTribute', { cardId: jackB.id }), { ok: true });
  assert.equal(guandanView(lonely, null).guandan.exchange.stage, 'complete');
});

test('ambiguous cards automatically use the strongest legal reading and losing responses are refused', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  for (let seat = 0; seat < 4; seat += 1) {
    setHand(game, seat, [card(3), card(4), card(5), card(6), card(LEVEL_TWO, 'heart')]);
  }
  const hand = game.handOf(leader);
  const ids = hand.map((entry) => entry.id);

  rejected(game.command(leader, 'play', { cards: ids, claim: 'not-a-key' }), '牌型与牌张不符');
  rejected(game.command(leader, 'play', { cards: [ids[0], ids[1], ids[2]] }), '牌型不合法');
  rejected(game.command(leader, 'play', { cards: [ids[0], ids[0]] }), '重复');
  rejected(game.command(leader, 'play', { cards: [holeCard().id] }), '你没有这些牌');

  assert.deepEqual(game.command(leader, 'play', { cards: ids }), { ok: true });
  const view = guandanView(game, null);
  assert.equal(view.lastPlay?.seatId, leader);
  assert.equal(view.lastPlay?.claim?.kind, 'straightFlush');
  assert.equal(view.lastPlay?.claim?.primaryRank, 7);
  assert.equal(view.tablePlays[0].claim?.low, 3);

  const follower = turnOf(game);
  const single = game.handOf(follower)[0];
  rejected(game.command(follower, 'play', { cards: [single.id] }), '管不上上家');
  assert.deepEqual(game.command(follower, 'pass', {}), { ok: true });
});

test('automatic fullhouse claim promotes the triple to the level rank and rejects a later KKK22', () => {
  const game = newGame();
  game.start();
  const first = turnOf(game);
  const next = (first + 1) % 4;
  const previous = [card(12), card(12, 'club'), card(15, 'club'), card(15, 'diamond'), card(15, 'heart')];
  const following = [card(13), card(13), card(13, 'club'), card(15, 'club'), card(15, 'diamond')];
  setHand(game, first, [...previous, card(3)]);
  setHand(game, next, [...following, card(4)]);
  assert.deepEqual(game.command(first, 'play', { cards: previous.map(c => c.id) }), { ok: true });
  assert.equal(game.view(null).lastPlay?.claim?.primaryRank, 15);
  const before = game.handOf(next).map(c => c.id);
  assert.equal(game.command(next, 'play', { cards: following.map(c => c.id) }).ok, false);
  assert.deepEqual(game.handOf(next).map(c => c.id), before);
  assert.equal(game.view(null).turn, next);
  assert.equal(game.replayRows()[0].claim.primaryRank, 15);
});

test('a leading seat cannot pass, out-of-turn commands are refused, and passes clear at the active threshold', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  const hands: Card[][] = [[], [], [], []];
  hands[leader] = setHand(game, leader, [card(3)]);
  hands[(leader + 1) % 4] = setHand(game, (leader + 1) % 4, [card(4), card(7)]);
  hands[(leader + 2) % 4] = setHand(game, (leader + 2) % 4, [card(9)]);
  hands[(leader + 3) % 4] = setHand(game, (leader + 3) % 4, [card(8)]);

  rejected(game.command(leader, 'pass', {}), '领出牌不能过');
  rejected(game.command((leader + 1) % 4, 'play', { cards: [hands[(leader + 1) % 4][0].id] }), '还没轮到你');

  playTurn(game, hands[leader]);
  assert.equal(game.passedAt(leader), false);
  playTurn(game, [hands[(leader + 1) % 4][0]]);
  const follower = (leader + 2) % 4;
  const third = (leader + 3) % 4;
  assert.deepEqual(game.command(follower, 'pass', {}), { ok: true });
  assert.equal(game.passedAt(follower), true);
  assert.equal(guandanView(game, null).lastPlay?.seatId, (leader + 1) % 4);
  rejected(game.command(follower, 'pass', {}), '还没轮到你');
  assert.deepEqual(game.command(third, 'pass', {}), { ok: true });
  const cleared = guandanView(game, null);
  assert.equal(cleared.lastPlay, null, 'two passes over the three active seats clear the trick');
  assert.equal(cleared.turn, (leader + 1) % 4);
  assert.equal(cleared.trickStartIndex, 2);
  assert.equal(game.passedAt(follower), false);
  assert.equal(game.passedAt(third), false);
  assert.equal(game.handOf(leader).length, 0);
  assert.equal(game.requiresConnection(leader), false);
  assert.equal(game.requiresConnection(follower), true);
});

test('the partner borrows the wind when the last player has already emptied its hand', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  const hands: Card[][] = [[], [], [], []];
  hands[leader] = setHand(game, leader, [card(3)]);
  hands[(leader + 1) % 4] = setHand(game, (leader + 1) % 4, [card(3, 'heart')]);
  hands[(leader + 2) % 4] = setHand(game, (leader + 2) % 4, [card(3, 'club')]);
  hands[(leader + 3) % 4] = setHand(game, (leader + 3) % 4, [card(3, 'diamond')]);
  playTurn(game, hands[leader]);
  assert.equal(game.requiresConnection(leader), false);
  passTurn(game);
  passTurn(game);
  assert.equal(guandanView(game, null).lastPlay?.seatId, leader, 'two passes are not enough for a finished actor');
  passTurn(game);
  const cleared = guandanView(game, null);
  assert.equal(cleared.lastPlay, null);
  assert.equal(cleared.turn, partnerOf(leader), 'the partner takes the next lead');
  assert.equal(cleared.trickStartIndex, 1);
  assert.equal(game.handOf(leader).length, 0);
});

test('a live deal conserves all 108 cards through tribute, return and the first trick', () => {
  const game = newGame();
  game.start();
  driveNormalEnd(game);
  game.restart();
  game.start();
  assert.equal(totalCards(game), 108);
  for (let seat = 0; seat < 4; seat += 1) assert.equal(game.handOf(seat).length, 27);

  const stage = guandanView(game, null).guandan.exchange.stage;
  const previous = game.result;
  assert.ok(previous !== null);
  const head = previous.order[0];
  const partner = partnerOf(head);
  const givers = previous.doubleDown
    ? [0, 1, 2, 3].filter((seat) => seat !== head && seat !== partner)
    : [previous.order[3]];
  let bigJokers = 0;
  for (const seat of givers) {
    for (const entry of game.handOf(seat)) if (entry.rank === BIG_JOKER) bigJokers += 1;
  }
  if (stage === 'resisted') {
    assert.ok(bigJokers >= 2, 'staying out of the exchange requires both big jokers');
    assert.equal(guandanView(game, null).phase, 'playing');
    assert.equal(guandanView(game, null).turn, head);
  } else {
    assert.equal(stage, 'tribute');
    assert.ok(bigJokers < 2);
    for (const seat of givers) {
      const action = guandanView(game, seat).privateAction;
      assert.ok(action !== null && action.eligibleIds.length >= 1);
      assert.deepEqual(game.command(seat, 'tribute', { cardId: action.eligibleIds[0] }), { ok: true });
    }
    assert.equal(totalCards(game), 108);
    for (const pair of guandanView(game, null).guandan.exchange.pairs) {
      const action = guandanView(game, pair.receiver).privateAction;
      assert.ok(action !== null && action.eligibleIds.length >= 1);
      assert.deepEqual(game.command(pair.receiver, 'returnTribute', { cardId: action.eligibleIds[0] }), { ok: true });
    }
    assert.equal(totalCards(game), 108);
    for (let seat = 0; seat < 4; seat += 1) assert.equal(game.handOf(seat).length, 27);
    const done = guandanView(game, null);
    assert.equal(done.phase, 'playing');
    assert.equal(done.guandan.exchange.stage, 'complete');
    assert.equal(done.turn, done.guandan.exchange.leader);
  }

  const leader = turnOf(game);
  const first = game.handOf(leader)[0];
  assert.deepEqual(game.command(leader, 'play', { cards: [first.id] }), { ok: true });
  assert.equal(totalCards(game), 107);
  const played = guandanView(game, null);
  assert.equal(played.tablePlays.length, 1);
  assert.equal(played.lastPlay?.claim?.kind, 'single');
  assert.equal(played.tablePlays[0].cards[0].id, first.id);
});

test('rejected and duplicate commands change nothing', () => {
  const game = newGame();
  openSecondDeal(game);
  const previous = game.result;
  assert.ok(previous !== null);
  const head = previous.order[0];
  const giver = previous.order[3];
  const big = joker(BIG_JOKER);
  const headCard = card(3);
  setHand(game, giver, [big]);
  setHand(game, head, [headCard]);
  game.beginExchange();

  const snapshot = JSON.stringify(guandanView(game, null));
  const handSnapshot = JSON.stringify(game.handOf(giver));
  rejected(game.command(head, 'tribute', { cardId: headCard.id }), '不需要进贡');
  rejected(game.command(giver, 'tribute', { cardId: 'missing' }), '最大的牌');
  rejected(game.command(giver, 'bid', { value: 1 }), '未知的操作类型');
  assert.equal(JSON.stringify(guandanView(game, null)), snapshot);
  assert.equal(JSON.stringify(game.handOf(giver)), handSnapshot);

  assert.deepEqual(game.command(giver, 'tribute', { cardId: big.id }), { ok: true });
  const afterTribute = JSON.stringify(guandanView(game, null));
  rejected(game.command(giver, 'tribute', { cardId: big.id }), '不是进贡阶段');
  assert.equal(JSON.stringify(guandanView(game, null)), afterTribute);
  assert.deepEqual(game.command(head, 'returnTribute', { cardId: headCard.id }), { ok: true });
  const afterReturn = JSON.stringify(guandanView(game, null));
  rejected(game.command(head, 'returnTribute', { cardId: headCard.id }), '不是还贡阶段');
  rejected(game.command(head, 'play', { cards: [headCard.id] }), '还没轮到你');
  assert.equal(JSON.stringify(guandanView(game, null)), afterReturn);
});

test('exchange stage text and private actions follow the acting seat', () => {
  const game = newGame();
  game.start();
  driveDoubleDown(game);
  game.restart();
  game.start();
  const previous = game.result;
  assert.ok(previous !== null && previous.doubleDown);
  const head = previous.order[0];
  const partner = partnerOf(head);
  const givers = [0, 1, 2, 3].filter((seat) => seat !== head && seat !== partner);
  const big = joker(BIG_JOKER);
  const small = joker(SMALL_JOKER);
  const headCard = card(3);
  const partnerCard = card(3, 'club');
  setHand(game, givers[0], [big]);
  setHand(game, givers[1], [small]);
  setHand(game, head, [headCard]);
  setHand(game, partner, [partnerCard]);
  game.beginExchange();
  const names = (seat: number): string => `P${seat}`;

  assert.equal(game.statusText(givers[0], names), '请选择进贡的牌');
  assert.equal(game.statusText(givers[1], names), '请选择进贡的牌');
  assert.equal(game.statusText(head, names), '等待进贡');
  assert.equal(game.statusText(null, names), '等待进贡');
  assert.deepEqual(game.command(givers[0], 'tribute', { cardId: big.id }), { ok: true });
  assert.equal(game.statusText(givers[0], names), '已进贡，等待对手');
  assert.equal(game.statusText(givers[1], names), '请选择进贡的牌');
  assert.deepEqual(game.command(givers[1], 'tribute', { cardId: small.id }), { ok: true });
  assert.equal(game.statusText(head, names), '请选择还贡的牌');
  assert.equal(game.statusText(partner, names), '请选择还贡的牌');
  assert.equal(game.statusText(givers[0], names), '等待还贡');
  assert.deepEqual(game.command(head, 'returnTribute', { cardId: headCard.id }), { ok: true });
  assert.equal(game.statusText(head, names), '已还贡，等待对手');
  assert.deepEqual(game.command(partner, 'returnTribute', { cardId: partnerCard.id }), { ok: true });
  assert.match(game.statusText(givers[0], names), /轮到你出牌/);
  assert.equal(game.statusText(head, names), `等待 ${names(givers[0])} 出牌`);
  assert.equal(game.statusText(null, names), `等待 ${names(givers[0])} 出牌`);
});

test('the all-pass threshold follows the active seats, not a fixed count', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  const hands: Card[][] = [[], [], [], []];
  hands[leader] = setHand(game, leader, [card(3)]);
  hands[(leader + 1) % 4] = setHand(game, (leader + 1) % 4, [card(4)]);
  hands[(leader + 2) % 4] = setHand(game, (leader + 2) % 4, [card(4, 'heart')]);
  hands[(leader + 3) % 4] = setHand(game, (leader + 3) % 4, [card(4, 'club')]);
  playTurn(game, hands[leader]);
  playTurn(game, hands[(leader + 1) % 4]);
  // Two seats still hold cards and the actor has finished, so both of them must pass.
  assert.deepEqual(game.command((leader + 2) % 4, 'pass', {}), { ok: true });
  assert.equal(guandanView(game, null).lastPlay?.seatId, (leader + 1) % 4);
  assert.equal(guandanView(game, null).turn, (leader + 3) % 4);
  assert.deepEqual(game.command((leader + 3) % 4, 'pass', {}), { ok: true });
  assert.equal(guandanView(game, null).lastPlay, null);
  assert.equal(guandanView(game, null).turn, partnerOf(leader + 1));

  const twin = newGame();
  twin.start();
  const first = turnOf(twin);
  const other: Card[][] = [[], [], [], []];
  other[first] = setHand(twin, first, [card(3), card(9)]);
  other[(first + 1) % 4] = setHand(twin, (first + 1) % 4, [card(4)]);
  other[(first + 2) % 4] = setHand(twin, (first + 2) % 4, [card(5, 'heart')]);
  other[(first + 3) % 4] = setHand(twin, (first + 3) % 4, [card(4, 'club'), card(8)]);
  playTurn(twin, [other[first][0]]);
  playTurn(twin, other[(first + 1) % 4]);
  playTurn(twin, other[(first + 2) % 4]);
  playTurn(twin, [other[(first + 3) % 4][1]]);
  // Two live seats and a live actor: a single pass is enough to clear.
  assert.equal(guandanView(twin, null).turn, first);
  assert.deepEqual(twin.command(first, 'pass', {}), { ok: true });
  assert.equal(guandanView(twin, null).lastPlay, null);
  assert.equal(guandanView(twin, null).turn, (first + 3) % 4);
});

test('a head whose own partner is the 下游 still receives that tribute, and the partner leads', () => {
  const game = newGame();
  game.start();
  const leader = turnOf(game);
  const hands: Card[][] = [[], [], [], []];
  hands[leader] = setHand(game, leader, [card(3)]);
  hands[(leader + 1) % 4] = setHand(game, (leader + 1) % 4, [card(4)]);
  hands[(leader + 2) % 4] = setHand(game, (leader + 2) % 4, [card(3, 'heart')]);
  hands[(leader + 3) % 4] = setHand(game, (leader + 3) % 4, [card(5)]);
  playTurn(game, hands[leader]);
  playTurn(game, hands[(leader + 1) % 4]);
  passTurn(game);
  playTurn(game, hands[(leader + 3) % 4]);
  const result = guandanView(game, null).guandan.result;
  assert.ok(result !== null);
  assert.equal(result.upgrade, 1);
  const head = result.order[0];
  const lastSeat = result.order[3];
  assert.equal(lastSeat, partnerOf(head), 'the head and the 下游 are partners in this case');

  game.restart();
  game.start();
  const tribute = joker(BIG_JOKER);
  const own = card(6);
  setHand(game, lastSeat, [tribute, card(12)]);
  setHand(game, head, [own]);
  game.beginExchange();
  assert.deepEqual(guandanView(game, null).guandan.exchange.givers, [lastSeat]);
  assert.equal(guandanView(game, head).privateAction, null);
  assert.deepEqual(game.command(lastSeat, 'tribute', { cardId: tribute.id }), { ok: true });
  assert.deepEqual(guandanView(game, head).privateAction?.eligibleIds, [own.id]);
  assert.deepEqual(game.command(head, 'returnTribute', { cardId: own.id }), { ok: true });
  const done = guandanView(game, null);
  assert.equal(done.guandan.exchange.pairs[0].giver, lastSeat);
  assert.equal(done.guandan.exchange.pairs[0].receiver, head);
  assert.equal(done.turn, lastSeat, 'the 下游 leads even when it is the head\'s own partner');
});

test('a tied tribute maximum offers every legal suit as the player\'s own choice', () => {
  const game = newGame();
  openSecondDeal(game);
  const previous = game.result;
  assert.ok(previous !== null);
  const head = previous.order[0];
  const giver = previous.order[3];
  const aceSpade = card(14);
  const aceHeart = card(14, 'heart');
  const lowCard = card(7);
  setHand(game, giver, [aceSpade, aceHeart, lowCard]);
  setHand(game, head, [card(6)]);
  game.beginExchange();
  const own = guandanView(game, giver).privateAction;
  assert.ok(own !== null);
  assert.deepEqual(own.eligibleIds.slice().sort(), [aceHeart.id, aceSpade.id].sort());
  rejected(game.command(giver, 'tribute', { cardId: lowCard.id }), '最大的牌');
  assert.deepEqual(game.command(giver, 'tribute', { cardId: aceHeart.id }), { ok: true });
  const pair = guandanView(game, null).guandan.exchange.pairs[0];
  assert.equal(pair.tribute.id, aceHeart.id, 'the engine takes the suit the player chose');
  assert.equal(pair.tribute.suit, 'heart');
});
