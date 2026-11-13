import test from 'node:test'
import assert from 'node:assert/strict'
import { initialXiangqiBoard, xiangqiDestinations, xiangqiPseudoDestinations, xiangqiInCheck, xiangqiHasMove, xiangqiPositionKey, xiangqiNotation, type XiangqiBoard, type XiangqiSide, type XiangqiRank } from '../shared/xiangqi'
import { XiangqiGame } from '../server/games/xiangqi'
import { Room, type Peer } from '../server/room'
import type { XiangqiSnapshot, ServerMessage } from '../shared/protocol'
import { resultFromSnapshot, readResults } from '../src/resultHistory'
import { supportsRoomMode } from '../shared/gameCatalog'
function board(entries: [number, XiangqiSide, XiangqiRank][]): XiangqiBoard {
  const b: XiangqiBoard = Array(90).fill(null)
  entries.forEach(([point,side,rank],i) => { b[point] = { id: `piece-${i}`,side,rank } })
  return b
}
function started(entries?: [number, XiangqiSide, XiangqiRank][]) { const game = new XiangqiGame(entries ? () => board(entries) : undefined); game.start(); return game }
function move(game: XiangqiGame, side: number, from: number, to: number) { const result = game.command(side,'xiangqiMove',{from,to}); assert.ok(result.ok, `${side}: ${from} → ${to}: ${result.ok ? '' : result.message}`) }
test('Xiangqi starts with standard, symmetric 32 pieces and 44 legal red moves', () => {
  const b = initialXiangqiBoard()
  assert.equal(b.filter(Boolean).length,32)
  for (const side of [0,1] as const) {
    assert.equal(b.filter(p => p?.side === side).length,16)
    assert.equal(xiangqiInCheck(b,side),false)
    assert.equal(b.reduce((count,p,from) => count + (p?.side === side ? xiangqiDestinations(b,from).length : 0),0),44)
    b.forEach((p,from) => { if(p?.side === side) assert.deepEqual(xiangqiDestinations(b,from).map(to=>89-to).sort((a,b)=>a-b),xiangqiDestinations(b,89-from).sort((a,b)=>a-b)) })
  }
  assert.equal(new Set(b.filter(Boolean).map(p=>p!.id)).size,32)
})
test('Xiangqi rook and cannon use correct blockers, screen and friendly destinations', () => {
  const b=board([[40,0,'rook'],[13,1,'soldier'],[42,0,'soldier']])
  assert.ok(xiangqiPseudoDestinations(b,40).includes(13));assert.ok(!xiangqiPseudoDestinations(b,40).includes(4));assert.ok(!xiangqiPseudoDestinations(b,40).includes(42));assert.ok(!xiangqiPseudoDestinations(b,40).includes(43));assert.ok(!xiangqiPseudoDestinations(b,40).includes(30))
  b[40]!.rank='cannon'
  assert.ok(!xiangqiPseudoDestinations(b,40).includes(13));b[4]={id:'king',side:1,rank:'general'}
  assert.ok(xiangqiPseudoDestinations(b,40).includes(4));assert.ok(xiangqiPseudoDestinations(b,40).includes(22));b[22]={id:'block',side:0,rank:'soldier'}
  assert.ok(!xiangqiPseudoDestinations(b,40).includes(4))
})
test('Xiangqi horse legs, elephant eyes and river are enforced', () => {
  const b=board([[40,0,'horse']]);assert.equal(xiangqiPseudoDestinations(b,40).length,8)
  b[31]={id:'leg',side:1,rank:'soldier'}
  assert.ok(!xiangqiPseudoDestinations(b,40).includes(21));assert.ok(!xiangqiPseudoDestinations(b,40).includes(23));assert.ok(xiangqiPseudoDestinations(b,40).includes(29))
  b[31]=null;b[39]={id:'horizontal-leg',side:0,rank:'soldier'};assert.ok(!xiangqiPseudoDestinations(b,40).includes(29));assert.ok(!xiangqiPseudoDestinations(b,40).includes(47));assert.ok(xiangqiPseudoDestinations(b,40).includes(21))
  const e=board([[65,0,'elephant'],[55,1,'soldier']]);assert.ok(!xiangqiPseudoDestinations(e,65).includes(45));assert.ok(xiangqiPseudoDestinations(e,65).includes(49))
  e[65]=null;e[55]=null;e[47]={id:'elephant',side:0,rank:'elephant'};assert.ok(!xiangqiPseudoDestinations(e,47).includes(27));assert.ok(xiangqiPseudoDestinations(e,47).includes(63))
})
test('Xiangqi generals/advisors stay in palace, soldiers cross river but never retreat', () => {
  const b=board([[85,0,'general'],[84,0,'advisor']]);assert.deepEqual(xiangqiPseudoDestinations(b,85),[76,86]);assert.deepEqual(xiangqiPseudoDestinations(b,84),[76])
  const s=board([[45,0,'soldier'],[44,1,'soldier']]);assert.deepEqual(xiangqiPseudoDestinations(s,45),[36]);assert.deepEqual(xiangqiPseudoDestinations(s,44),[53]);s[45]=null;s[36]={id:'red',side:0,rank:'soldier'};s[44]=null;s[53]={id:'black',side:1,rank:'soldier'}
  assert.deepEqual(xiangqiPseudoDestinations(s,36),[27,37]);assert.deepEqual(xiangqiPseudoDestinations(s,53),[52,62])
})
test('Xiangqi rejects exposed kings, moving while in check, own captures and non-turn moves without mutation', () => {
  const game=started([[85,0,'general'],[4,1,'general'],[49,0,'rook']]);const before=game.view()
  assert.equal(game.command(0,'xiangqiMove',{from:49,to:48}).ok,false)
  assert.equal(game.command(1,'xiangqiMove',{from:4,to:3}).ok,false)
  for(const to of [-1,90,1.2,NaN,'40']) assert.equal(game.command(0,'xiangqiMove',{from:49,to}).ok,false)
  assert.equal(game.command(0,'play',{cards:[]}).ok,false);assert.deepEqual(game.view(),before)
  const b=board([[85,0,'general'],[4,1,'general']]);assert.equal(xiangqiInCheck(b,0),true);assert.equal(xiangqiInCheck(b,1),true)
  assert.ok(!xiangqiDestinations(b,85).includes(76));assert.ok(xiangqiDestinations(b,85).includes(84))
  b[76]={id:'shield',side:0,rank:'rook'};b[81]={id:'attacker',side:1,rank:'rook'}
  assert.equal(xiangqiInCheck(b,0),true);assert.ok(!xiangqiDestinations(b,76).includes(67));assert.ok(xiangqiDestinations(b,85).includes(81)===false)
})
test('Xiangqi final legal move produces checkmate or stalemate loss, not draw', () => {
  const mate=started([[85,0,'general'],[4,1,'general'],[49,0,'soldier'],[12,0,'rook'],[14,0,'rook'],[21,0,'rook']]);move(mate,0,21,22)
  assert.equal(mate.phase,'finished');assert.equal(mate.view().xiangqi.winner,0);assert.match(mate.view().xiangqi.reason,/将死/);assert.equal(xiangqiHasMove(mate.view().xiangqi.board,1),false)
  const stuck=started([[85,0,'general'],[4,1,'general'],[49,0,'soldier'],[12,0,'rook'],[14,0,'rook'],[54,0,'soldier']]);move(stuck,0,54,45)
  assert.equal(stuck.phase,'finished');assert.equal(stuck.view().xiangqi.winner,0);assert.equal(stuck.view().xiangqi.draw,false);assert.match(stuck.view().xiangqi.reason,/困毙/)
})
test('Xiangqi repetition detects one-sided perpetual checking and ordinary repetition independently', () => {
  const regular=started();for(let i=0;i<2;i++){move(regular,0,82,63);move(regular,1,1,18);move(regular,0,63,82);move(regular,1,18,1)}
  assert.equal(regular.view().xiangqi.draw,true);assert.match(regular.view().xiangqi.reason,/三次重复/)
  const checking=started([[85,0,'general'],[4,1,'general'],[49,0,'soldier'],[12,0,'rook']])
  for(let i=0;i<2;i++) { for(const [side,from,to] of [[0,12,13],[1,4,5],[0,13,14],[1,5,4],[0,14,13],[1,4,3],[0,13,12],[1,3,4]]) { if (checking.phase === 'finished') break; move(checking,side!,from!,to!) } }
  assert.equal(checking.view().xiangqi.winner,1);assert.match(checking.view().xiangqi.reason,/红方长将/)
})
test('Xiangqi draw agreement, decline, duplicate offers, resignation, no-capture limit and rematch', () => {
  const game=started();assert.ok(game.command(0,'xiangqiDraw',{action:'offer'}).ok);assert.equal(game.command(0,'xiangqiDraw',{action:'accept'}).ok,false);assert.ok(game.command(1,'xiangqiDraw',{action:'decline'}).ok);assert.equal(game.command(0,'xiangqiDraw',{action:'offer'}).ok,false)
  move(game,0,54,45);assert.ok(game.command(0,'xiangqiDraw',{action:'offer'}).ok);assert.ok(game.command(1,'xiangqiDraw',{action:'accept'}).ok);assert.equal(game.view().xiangqi.draw,true)
  const id=game.view().xiangqi.roundId;assert.ok(game.restart().ok);assert.equal(game.phase,'lobby');assert.notEqual(game.view().xiangqi.roundId,id);assert.equal(game.view().xiangqi.board.filter(Boolean).length,32);game.start();assert.ok(game.command(1,'xiangqiResign',{}).ok);assert.equal(game.view().xiangqi.winner,0);assert.equal(game.command(0,'xiangqiMove',{from:54,to:45}).ok,false)
  const quiet=started();Reflect.set(quiet,'quietPlies',119);move(quiet,0,82,63);assert.equal(quiet.view().xiangqi.draw,true)
  const capture=started([[85,0,'general'],[4,1,'general'],[49,0,'soldier'],[54,0,'rook'],[45,1,'soldier']]);Reflect.set(capture,'quietPlies',119);move(capture,0,54,45);assert.equal(capture.view().xiangqi.quietPlies,0);assert.equal(capture.phase,'playing')
})
test('Xiangqi snapshots and fixed fixtures cannot mutate engine; keys ignore equal piece identities', () => {
  const original=initialXiangqiBoard(), game=new XiangqiGame(()=>original);original[54]=null;assert.ok(game.view().xiangqi.board[54]);game.start();move(game,0,54,45)
  const copy=game.view();copy.xiangqi.board[45]!.rank='rook';copy.xiangqi.moves[0]!.to=89;assert.equal(game.view().xiangqi.board[45]?.rank,'soldier');assert.equal(game.view().xiangqi.moves[0]?.to,45)
  const a=initialXiangqiBoard(),b=structuredClone(a);[b[81],b[89]]=[b[89]!,b[81]!];assert.equal(xiangqiPositionKey(a,0),xiangqiPositionKey(b,0));assert.notEqual(xiangqiPositionKey(a,0),xiangqiPositionKey(b,1))
  assert.equal(xiangqiNotation(a[70]!,70,67),'炮二平五');assert.equal(xiangqiNotation(a[1]!,1,20),'马2进3')
})
type FakePeer = Peer & { sent: ServerMessage[]; kicked: number }
function peer(id:string):FakePeer{return {id,role:'table',seatId:null,token:null,room:null,requestRoom:null,sent:[],kicked:0,send(m){this.sent.push(m)},supersede(){this.kicked++}}}
function state(p:FakePeer):XiangqiSnapshot{const m=p.sent.filter(m=>m.type==='state').at(-1);assert.ok(m?.type==='state'&&m.state.game==='xiangqi');return m.state}
function roomFixture(){const room=new Room('XQ01','phone','xiangqi'),red=peer('red'),black=peer('black');room.bindCreator(red,'create','红方');room.bindJoin(black,1,'黑方','join');room.command(red,'ready',{ready:true},'r');room.command(black,'ready',{ready:true},'b');room.command(red,'start',{},'start');return {room,red,black}}
test('Xiangqi room has two human phone seats, no bots, timers, card commands or private hands',()=>{
  assert.equal(supportsRoomMode('xiangqi','tablet'),true)
  const {room,red,black}=roomFixture();try{assert.equal(state(red).seats.length,2);assert.equal(state(red).phase,'playing');assert.equal(state(red).hand.length,0);assert.equal(state(black).hand.length,0);assert.equal(state(red).turnRemainingMs,null);assert.deepEqual(state(red).xiangqi.board,state(black).xiangqi.board)
    for(const type of ['addBot','setAutoPlay','play','bid','junqiMove'] as const){room.command(red,type,{from:54,to:45,cards:[],score:3,enabled:true,seat:1},`bad-${type}`);assert.equal(state(red).xiangqi.moves.length,0);assert.ok(red.sent.some(m=>m.type==='error'&&m.id===`bad-${type}`))}
  }finally{room.dispose()}
})
test('Xiangqi room deduplicates, rejects stale seats, pauses on disconnect and restores exact round',()=>{
  const {room,red,black}=roomFixture();try{
    room.command(red,'xiangqiMove',{from:54,to:45},'move1');room.command(red,'xiangqiMove',{from:56,to:47},'move1');assert.equal(state(red).xiangqi.moves.length,1)
    room.detach(black);room.command(red,'xiangqiMove',{from:56,to:47},'offline');assert.equal(state(red).xiangqi.moves.length,1)
    const resumed=peer('black2');room.bindResume(resumed,black.token!,'resume');assert.equal(state(resumed).xiangqi.moves.length,1);room.command(black,'xiangqiResign',{},'stale');assert.equal(state(resumed).phase,'playing')
    room.command(resumed,'xiangqiMove',{from:27,to:36},'move2');assert.equal(state(resumed).xiangqi.moves.length,2)
    room.command(resumed,'xiangqiResign',{},'resign');const result=resultFromSnapshot(state(red));assert.equal(result?.game,'xiangqi');assert.match(result!.title,/红方/);assert.equal(result!.plays.length,2);assert.deepEqual(readResults({ getItem: () => JSON.stringify([result]) }),[result])
    room.command(red,'again',{},'again');assert.equal(state(red).phase,'lobby');assert.equal(state(red).xiangqi.moves.length,0)
  }finally{room.dispose()}
})

test('Xiangqi shared tablet starts without remote seats and accepts both sides only from its live host',()=>{
  const room=new Room('XT01','tablet','xiangqi'), host=peer('tablet'), stranger=peer('stranger')
  try {
    room.bindCreator(host,'create')
    assert.equal(state(host).role,'table');assert.equal(state(host).selfSeat,null);assert.ok(state(host).seats.every(seat=>seat.name&&seat.ready));assert.equal(room.players.filter(Boolean).length,0)
    room.bindJoin(stranger,1,'远程','join');assert.ok(stranger.sent.some(m=>m.type==='error'&&/同屏/.test(m.message)));assert.equal(stranger.room,null)
    room.requestSeat(stranger,1,'远程','replace');assert.ok(stranger.sent.some(m=>m.type==='error'&&/同屏/.test(m.message)))
    room.command(host,'start',{},'start');assert.equal(state(host).phase,'playing')
    room.command(host,'xiangqiMove',{from:27,to:36},'wrong');assert.equal(state(host).xiangqi.moves.length,0)
    room.command(host,'xiangqiMove',{from:54,to:45},'red');room.command(host,'xiangqiMove',{from:27,to:36},'black');assert.equal(state(host).xiangqi.moves.length,2)
    room.command(host,'xiangqiMove',{from:56,to:47},'black');assert.equal(state(host).xiangqi.moves.length,2)
    const fresh=peer('fresh');room.bindResume(fresh,room.hostToken,'resume');assert.equal(host.kicked,1);assert.equal(state(fresh).xiangqi.moves.length,2)
    room.command(host,'xiangqiResign',{side:0},'stale');assert.equal(state(fresh).phase,'playing')
    room.command(fresh,'xiangqiResign',{side:1},'resign');assert.equal(state(fresh).xiangqi.winner,0)
    const result=resultFromSnapshot(state(fresh));assert.equal(result?.players.length,2);assert.equal(result?.plays.length,2)
    room.command(fresh,'again',{},'again');room.command(fresh,'start',{},'start2');room.command(fresh,'xiangqiDraw',{action:'agree'},'draw');assert.equal(state(fresh).xiangqi.draw,true);assert.equal(state(fresh).xiangqi.reason,'双方同意和棋')
    room.command(fresh,'xiangqiDraw',{action:'agree'},'draw');assert.equal(state(fresh).xiangqi.draw,true)
  }finally{room.dispose()}
})
test('Xiangqi phone seats cannot impersonate the opposite side or use tablet-only agreement',()=>{
 const {room,red}=roomFixture();try{
  room.command(red,'xiangqiDraw',{action:'agree'},'agree');assert.equal(state(red).phase,'playing');assert.equal(state(red).xiangqi.draw,false)
  room.command(red,'xiangqiResign',{side:1},'resign');assert.equal(state(red).xiangqi.winner,1)
 }finally{room.dispose()}
})
