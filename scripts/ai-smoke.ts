// Opt-in real worker -> Node validation -> authoritative game integration.
// No fake policy or timer shortcuts. Two deals per game, including same-room exchange.
import assert from 'node:assert/strict';
import { initializeDouZero, closeDouZero, douZeroPolicy } from '../server/bots/douzero';
import { initializeGuandan, closeGuandan, guandanPolicy } from '../server/bots/guandan';
import { GuandanGame } from '../server/games/guandan';
import { DoudizhuGame } from '../server/games/doudizhu';
import { createPlayStamper } from '../server/games/playLog';

const keepAlive = setInterval(() => {}, 1000);
try {
  await Promise.all([initializeDouZero(), initializeGuandan()]);
  assert.equal(douZeroPolicy.availability().available, true, douZeroPolicy.availability().message ?? '');
  assert.equal(guandanPolicy.availability().available, true, guandanPolicy.availability().message ?? '');
  const guandan = new GuandanGame(createPlayStamper('CPU-G'));
  for (let deal = 0; deal < 2; deal++) {
    guandan.start();
    console.log(JSON.stringify({ game: 'guandan', deal, phase: guandan.phase, exchange: guandan.exchange.stage }));
    let decisions = 0;
    let exchangeActions = 0;
    while (guandan.phase !== 'finished') {
      assert.ok(decisions + exchangeActions < 600, 'Guandan must finish');
      if (guandan.phase === 'tribute') {
        for (let seat = 0; seat < 4; seat++) {
          const action = guandan.view(seat).privateAction;
          if (!action || action.committed !== null) continue;
          assert.ok(action.eligibleIds.length);
          assert.deepEqual(guandan.command(seat, action.kind === 'tribute' ? 'tribute' : 'returnTribute',
            { cardId: action.eligibleIds[0] }), { ok: true });
          exchangeActions++;
        }
        continue;
      }
      const view = guandan.view(null);
      const seat = view.turn!;
      const seed = guandan.dealSeed!;
      const cards = await guandanPolicy.chooseTurn({
        agent: seat % 2 ? 'danzero_v1t' : 'danlm_v1', level: seed.playedLevel,
        teamLevels: seed.teamLevels, firstPlayer: seed.leader, dealHands: seed.hands,
        rows: guandan.replayRows().slice(seed.playStart), tribute: guandan.exchange.pairs,
        selfSeat: seat, hand: guandan.handOf(seat), cursor: view.lastPlay,
      });
      assert.deepEqual(guandan.command(seat, cards.length ? 'play' : 'pass', { cards }), { ok: true });
      decisions++;
      if (decisions % 25 === 0) console.log(JSON.stringify({ game: 'guandan', deal, decisions }));
    }
    console.log(JSON.stringify({ game: 'guandan', deal, decisions, exchangeActions, result: guandan.result }));
    if (deal === 0) assert.deepEqual(guandan.restart(), { ok: true });
  }
  const ddz = new DoudizhuGame(createPlayStamper('CPU-D'));
  for (let deal = 0; deal < 2; deal++) {
    ddz.start();
    const bidSeat = ddz.view(null).turn!;
    assert.deepEqual(ddz.command(bidSeat, 'bid', { value: 3 }), { ok: true });
    let decisions = 0;
    while (ddz.phase !== 'finished') {
      assert.ok(decisions < 600, 'DouZero must finish');
      const view = ddz.view(null);
      const seat = view.turn!;
      const cards = await douZeroPolicy.chooseMove({
        selfSeat: seat, turn: seat, landlord: view.landlord!, hand: ddz.handOf(seat),
        bottom: view.bottom, counts: ddz.hands.map(hand => hand.length) as [number, number, number],
        tablePlays: view.tablePlays, lastPlay: view.lastPlay,
      }, undefined, deal ? 'easy' : 'strong');
      assert.deepEqual(ddz.command(seat, cards.length ? 'play' : 'pass', { cards }), { ok: true });
      decisions++;
    }
    console.log(JSON.stringify({ game: 'doudizhu', deal, decisions, winner: ddz.view(null).winner }));
    if (deal === 0) assert.deepEqual(ddz.restart(), { ok: true });
  }
} finally {
  await Promise.all([closeDouZero(), closeGuandan()]);
  clearInterval(keepAlive);
}
