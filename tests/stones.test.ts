import test from 'node:test'
import assert from 'node:assert/strict'
import { StoneGame } from '../server/games/stones'
import { gomokuLine, playGo, scoreGo, stoneGroup, stonePositionKey, type StoneBoard, type StoneKind } from '../shared/stones'
import { Room, type Peer } from '../server/room'
import type { ServerMessage, StoneSnapshot } from '../shared/protocol'
import { readResults, resultFromSnapshot } from '../src/resultHistory'
const board = (black: number[], white: number[], size = 9): StoneBoard => { const b: StoneBoard = Array(size**2).fill(null); black.forEach(p => { b[p] = 0 }); white.forEach(p => { b[p] = 1 }); return b }
const agreement = (g: StoneGame) => ({action:'confirm',revision:g.view().stones.scoreRevision,roundId:g.view().stones.roundId})
const command = (game: StoneGame, seat: number, point: number) => game.command(seat,'stoneMove',{point})
function started(kind: StoneKind = 'go', b?: StoneBoard, turn: 0 | 1 = 0) { const g = new StoneGame(kind,{...(b ? { board: b } : {}),turn}); g.start(); return g }
test('Go groups share orthogonal liberties without counting duplicates or diagonals',() => {
  const b = board([40,41,50],[30])
  assert.deepEqual(stoneGroup(b,40,9).points.sort((a,b) => a-b),[40,41,50])
  assert.deepEqual(stoneGroup(b,40,9).liberties.sort((a,b) => a-b),[31,32,39,42,49,51,59])
  const diagonal = board([40,50],[]); assert.deepEqual(stoneGroup(diagonal,40,9).points,[40])
})
test('Go captures several groups at once and captures before testing suicide',() => {
  const g = started('go',board([22,30,32,38,48],[31,39]))
  assert.ok(command(g,0,40).ok); assert.deepEqual(g.view().stones.moves[0]!.captured.sort((a,b) => a-b),[31,39]); assert.equal(g.view().stones.captured[0],2)
  const result = playGo(board([11,19,29],[20,12,22,30]),21,0,9)
  assert.ok(typeof result !== 'string'); assert.deepEqual(result.captured,[20]); assert.equal(result.board[21],0)
})
test('Go wrong turns, malformed points, suicide and unrelated commands leave state unchanged',() => {
  const g = started('go',board([],[31,39,41,49])), before = g.view()
  for (const point of [-1,81,1.5,'40',null,{},NaN]) assert.equal(g.command(0,'stoneMove',{point}).ok,false)
  assert.equal(command(g,0,40).ok,false); assert.equal(command(g,1,0).ok,false); assert.equal(g.command(0,'chessMove',{from:0,to:1}).ok,false)
  assert.deepEqual(g.view(),before); const copied=g.view(); copied.stones.board[0]=1; copied.stones.confirmed[0]=true; assert.deepEqual(g.view(),before)
})
test('Go positional superko survives passing, scoring and resuming; changed positions can retake',() => {
  const initial=board([11,19,29],[20,12,22,30]), g=started('go',initial)
  assert.ok(command(g,0,21).ok); const before=g.view(); assert.equal(command(g,1,20).ok,false); assert.deepEqual(g.view(),before)
  assert.ok(g.command(1,'stonePass',{}).ok); assert.ok(g.command(0,'stonePass',{}).ok); assert.equal(g.view().stones.stage,'scoring')
  assert.ok(g.command(1,'stoneScore',{action:'resume'}).ok); assert.equal(command(g,1,20).ok,false)
  assert.ok(command(g,1,60).ok); assert.ok(command(g,0,61).ok); assert.ok(command(g,1,20).ok); assert.equal(g.view().stones.captured[1],1)
  const candidate=playGo(Array(81).fill(null),40,0,9); assert.ok(typeof candidate!=='string')
  const repeated=new StoneGame('go',{history:[stonePositionKey(candidate.board)]}); repeated.start(); assert.equal(command(repeated,0,40).ok,false)
})
test('Go consecutive passes reset after a move; scoring prevents moves until either side resumes',() => {
  const g=started(); g.command(0,'stonePass',{}); assert.ok(command(g,1,40).ok); assert.equal(g.view().stones.passes,0)
  g.command(0,'stonePass',{}); g.command(1,'stonePass',{}); assert.equal(g.view().turn,null); const before=g.view(); assert.equal(command(g,0,39).ok,false); assert.deepEqual(g.view(),before)
  g.command(1,'stoneScore',{action:'resume'}); assert.equal(g.view().turn,0); assert.ok(command(g,0,39).ok)
})
test('Go area scoring counts stones plus territory once and leaves shared regions neutral',() => {
  const black=Array.from({length:9},(_,r)=>r*9+2), white=Array.from({length:9},(_,r)=>r*9+6), b=board(black,white)
  const s=scoreGo(b,9); assert.deepEqual(s.stones,[9,9]); assert.deepEqual(s.territory,[18,18]); assert.deepEqual(s.total,[27,34.5]); assert.equal(s.ownership[40],null)
  b[0]=0; assert.deepEqual(scoreGo(b,9).total,s.total)
  b[0]=1; assert.deepEqual(scoreGo(b,9,[0]).total,s.total); assert.equal(b[0],1)
})
test('Go dead-group edits reset both agreements; only two confirmations finish the game',() => {
  const g=started('go',board([2,11,20],[50,51])); g.command(0,'stonePass',{}); g.command(1,'stonePass',{})
  assert.ok(g.command(0,'stoneScore',agreement(g)).ok); assert.equal(g.phase,'playing')
  g.command(1,'stoneScore',{action:'mark',point:50}); assert.deepEqual(g.view().stones.dead,[50,51]); assert.deepEqual(g.view().stones.confirmed,[false,false])
  g.command(1,'stoneScore',agreement(g)); assert.equal(g.phase,'playing'); g.command(0,'stoneScore',agreement(g)); assert.equal(g.phase,'finished'); assert.equal(g.view().stones.board[50],1)
  const id=g.view().stones.roundId; g.restart(); assert.equal(g.phase,'lobby'); assert.notEqual(g.view().stones.roundId,id); assert.deepEqual(g.view().stones.moves,[]); assert.equal(g.view().stones.board.filter(s=>s!==null).length,0)
})
test('Go size changes accept only declared sizes in lobby; Gomoku is always 15',() => {
  const g=new StoneGame('go'); for(const size of [9,13,19]) { assert.ok(g.setSize(size).ok); assert.equal(g.view().stones.board.length,size**2) }
  for(const size of [15,0,'19',20]) assert.equal(g.setSize(size).ok,false)
  g.start(); assert.equal(g.setSize(9).ok,false); assert.equal(new StoneGame('gomoku').setSize(9).ok,false)
})
test('Go rejects confirmations for an older dead marking, a resumed scoring phase or another round',()=>{
  const g=started('go',board([20,21],[50,51]));g.command(0,'stonePass',{});g.command(1,'stonePass',{})
  const old=agreement(g);g.command(0,'stoneScore',old);g.command(1,'stoneScore',{action:'mark',point:50})
  const before=g.view();assert.equal(g.command(1,'stoneScore',old).ok,false);assert.deepEqual(g.view(),before);assert.deepEqual(before.stones.confirmed,[false,false])
  const marked=agreement(g);g.command(1,'stoneScore',{action:'resume'});g.command(0,'stonePass',{});g.command(1,'stonePass',{})
  assert.equal(g.command(0,'stoneScore',marked).ok,false);g.command(0,'stoneScore',agreement(g));g.command(1,'stoneScore',agreement(g));g.restart();g.start();g.command(0,'stonePass',{});g.command(1,'stonePass',{})
  assert.equal(g.command(1,'stoneScore',{...agreement(g),roundId:old.roundId}).ok,false);assert.equal(g.command(1,'stoneScore',{action:'confirm'}).ok,false)
})
test('Gomoku detects all four axes, includes overlines and does not wrap around board edges',() => {
  for(const points of [[108,109,110,111,112],[52,67,82,97,112],[48,64,80,96,112],[56,70,84,98,112],[107,108,109,110,111,112]]) {
    const g=started('gomoku',board(points.slice(0,-1),[],15)); assert.ok(command(g,0,points.at(-1)!).ok); assert.equal(g.phase,'finished'); assert.equal(g.view().stones.winner,0); assert.equal(g.view().stones.winningLine.length,points.length)
  }
  assert.deepEqual(gomokuLine(board([13,14,15,16,17],[],15),15),[])
  const gap=started('gomoku',board([108,109,111,112],[],15)); assert.ok(command(gap,0,113).ok); assert.equal(gap.phase,'playing'); assert.equal(gap.command(1,'stonePass',{}).ok,false); assert.equal(gap.command(1,'stoneScore',{action:'confirm'}).ok,false)
})
test('Gomoku full board without a line draws; resignation works on either side',() => {
  const b=Array.from({length:225},(_,i)=>(Math.floor(Math.floor(i/15)/2)+i%15)%2) as StoneBoard; b[223]=null
  const g=started('gomoku',b,0); assert.ok(command(g,0,223).ok); assert.equal(g.phase,'finished'); assert.equal(g.view().stones.draw,true)
  const r=started('gomoku'); r.command(1,'stoneResign',{}); assert.equal(r.view().stones.winner,0)
})
type FakePeer=Peer & { sent: ServerMessage[]; kicked: number }
const peer=(id:string):FakePeer=>({id,role:'table',seatId:null,token:null,room:null,requestRoom:null,sent:[],kicked:0,send(m){this.sent.push(m)},supersede(){this.kicked++}})
function state(p:FakePeer):StoneSnapshot { const m=p.sent.filter(m=>m.type==='state').at(-1); assert.ok(m?.type==='state'&&(m.state.game==='go'||m.state.game==='gomoku')); return m.state }
for(const kind of ['go','gomoku'] as const) test(`${kind} phone rooms preserve authority, retry deduplication, reconnect and result history`,()=>{
  const room=new Room('ST01','phone',kind), black=peer('black'),white=peer('white')
  try {
    room.bindCreator(black,'create','黑方'); room.bindJoin(white,1,'白方','join')
    room.command(white,'stoneSetup',{size:19},'bad-size'); assert.equal(state(white).stones.size,kind==='go'?9:15)
    for(const p of [black,white]) room.command(p,'ready',{ready:true},`ready-${p.id}`)
    room.command(black,'start',{},'start'); assert.equal(state(black).phase,'playing')
    room.command(black,'stoneMove',{point:40,side:1},'move'); room.command(black,'stoneMove',{point:41},'move'); assert.equal(state(black).stones.moves.length,1); assert.equal(state(black).stones.board[40],0)
    room.detach(white); room.command(black,'stoneResign',{},'offline'); assert.equal(state(black).phase,'playing')
    const resumed=peer('fresh'); room.bindResume(resumed,white.token!,'resume'); assert.deepEqual(state(resumed).stones,state(black).stones)
    room.command(white,'stoneResign',{},'stale'); assert.equal(state(resumed).phase,'playing')
    room.command(black,'stoneResign',{side:1},'resign'); assert.equal(state(resumed).stones.winner,1)
    const record=resultFromSnapshot(state(resumed))!; assert.equal(record.game,kind); assert.deepEqual(readResults({getItem:()=>JSON.stringify([record])}),[record]); assert.ok(!JSON.stringify(record).includes(black.token!))
  } finally {room.dispose()}
})
test('Go tablet only current host can play, choose size or confirm both results; readiness resets on size change',()=>{
  const room=new Room('ST02','tablet','go'),host=peer('host'),stranger=peer('stranger')
  try {
    room.bindCreator(host,'create'); assert.deepEqual(state(host).seats.map(s=>s.name),['黑方','白方']); room.bindJoin(stranger,1,'闯入','join'); assert.equal(stranger.room,null)
    room.command(host,'stoneSetup',{size:13},'size'); assert.equal(state(host).stones.size,13); room.command(host,'start',{},'start')
    room.command(host,'stoneMove',{point:40,side:1},'black'); assert.equal(state(host).stones.board[40],0)
    room.command(host,'stonePass',{},'pass-white'); room.command(host,'stonePass',{},'pass-black'); assert.equal(state(host).stones.stage,'scoring')
    room.command(host,'stoneScore',{action:'confirm'},'no-side'); assert.deepEqual(state(host).stones.confirmed,[false,false])
    room.command(host,'stoneScore',{action:'confirm',side:0,revision:state(host).stones.scoreRevision,roundId:state(host).stones.roundId},'confirm0'); assert.equal(state(host).phase,'playing')
    room.command(host,'stoneScore',{action:'confirm',side:1,revision:state(host).stones.scoreRevision,roundId:state(host).stones.roundId},'confirm1'); assert.equal(state(host).phase,'finished')
    room.command(host,'again',{},'again'); assert.equal(state(host).stones.size,13); assert.equal(state(host).stones.moves.length,0)
  } finally {room.dispose()}
})
test('Go phone size change resets both ready flags and does not let a guest change the board',()=>{
  const room=new Room('ST03','phone','go'),host=peer('host'),guest=peer('guest')
  try {
    room.bindCreator(host,'create','主');room.bindJoin(guest,1,'客','join')
    room.command(host,'ready',{ready:true},'r0');room.command(guest,'ready',{ready:true},'r1')
    room.command(guest,'stoneSetup',{size:19},'bad');assert.equal(state(host).stones.size,9);assert.ok(state(host).seats.every(s=>s.ready))
    room.command(host,'stoneSetup',{size:13},'size');assert.equal(state(host).stones.size,13);assert.ok(state(host).seats.every(s=>!s.ready))
    room.command(host,'start',{},'early');assert.equal(state(host).phase,'lobby')
  }finally{room.dispose()}
})
