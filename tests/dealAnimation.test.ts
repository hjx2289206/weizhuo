import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref } from 'vue';
import { dealCardDelay, dealDuration, dealTravelDuration, DEAL_FLIGHT_MS, DEAL_REVEAL_MS, DEAL_STEP_MS, DEAL_WARMUP_MS } from '../shared/dealAnimation';
import { useDealAnimation } from '../src/useDealAnimation';
import { Room, type Peer } from '../server/room';
import type { Snapshot } from '../shared/protocol';

function peer(id: string): Peer {
  return { id, role:'table', seatId:null, token:null, room:null, requestRoom:null, send() {}, supersede() {} };
}

test('deal clock visits all seats in order, including eight-seat tables and existing games', () => {
  for (const [seats, count, total] of [[3,17,51], [4,27,108], [8,7,56]]) {
    const slots = Array.from({ length:count }, (_, i) => Array.from({ length:seats }, (_, s) => dealCardDelay(i,s,seats))).flat();
    assert.equal(slots.length,total);
    assert.equal(slots[0],DEAL_WARMUP_MS);
    slots.slice(1).forEach((time,i) => assert.equal(time-slots[i],DEAL_STEP_MS));
    assert.equal(slots.at(-1)!+DEAL_FLIGHT_MS,dealTravelDuration(seats,count));
    assert.equal(dealDuration(seats,count)-dealTravelDuration(seats,count),DEAL_REVEAL_MS);
  }
});

test('shared public deal clock preserves private hands and increments on an all-pass redeal', () => {
  const room = new Room('DEAL','tablet','doudizhu');
  const host = peer('table'); room.bindHost(host,'create');
  room.command(host,'seats',{positions:[{x:.5,y:.9,angle:0},{x:.1,y:.5,angle:90},{x:.9,y:.5,angle:-90}]},'seats');
  const players = [0,1,2].map(i => { const p=peer(`p${i}`);room.bindJoin(p,i,`玩家${i}`,`join${i}`);room.command(p,'ready',{ready:true},`ready${i}`);return p; });
  try {
    room.command(host,'start',{},'start');
    const table=room.snapshotFor(host), hand=room.snapshotFor(players[0]);
    assert.equal(table.hand.length,0);assert.equal(hand.hand.length,17);
    assert.equal(table.game,'doudizhu');if(table.game==='doudizhu') assert.deepEqual(table.bottom,[]);
    assert.deepEqual(Object.keys(table.dealAnimation!).sort(),['cardsPerSeat','elapsedMs','id','seatCount']);
    assert.equal(table.dealAnimation!.id,hand.dealAnimation!.id);
    players.forEach((p,i) => room.command(p,'bid',{value:0},`bid${i}`));
    assert.equal(room.snapshotFor(host).dealAnimation!.id,table.dealAnimation!.id+1);
  } finally { room.dispose(); }
});

test('client resumes only remaining deal time; duplicate snapshots and old deals never restart it', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const room = new Room('TIME','phone','doudizhu'); const p=peer('p'); room.bindCreator(p,'create','我');
  const initial={...room.snapshotFor(p),phase:'bidding',dealAnimation:{id:1,elapsedMs:1000,seatCount:3,cardsPerSeat:17}} as Snapshot;
  const state=ref<Snapshot|null>(initial);const scope=effectScope();
  try {
    const deal=scope.run(()=>useDealAnimation(state))!;
    assert.equal(deal.value?.elapsedMs,1000);
    t.mock.timers.tick(dealDuration(3,17)-1000-1);
    state.value={...initial,version:2};await nextTick();
    assert.ok(deal.value);
    t.mock.timers.tick(1);assert.equal(deal.value,null);
    state.value={...initial,version:3};await nextTick();assert.equal(deal.value,null);
    state.value={...initial,dealAnimation:{...initial.dealAnimation!,id:2,elapsedMs:10000}};await nextTick();assert.equal(deal.value,null);
  } finally { scope.stop();room.dispose(); }
});
