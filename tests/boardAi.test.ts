import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Room, type Peer } from '../server/room'
import { ChessGame } from '../server/games/chess'
import { XiangqiGame } from '../server/games/xiangqi'
import { BOARD_AI_DIFFICULTIES, type BoardAiDifficulty } from '../shared/boardAi'
import { boardAiProfile, fairyXiangqiMove, boardSearchPosition, boardEngine, xiangqiFen, xiangqiUciIndex, xiangqiUciSquare, NativeBoardAiPolicy, type BoardAiMove, type BoardAiPolicy, type BoardSearchPosition } from '../server/bots/boardAi'
import { initialXiangqiBoard } from '../shared/xiangqi'
import type { Snapshot, ServerMessage } from '../shared/protocol'
import { searchUci } from '../server/bots/uci'
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(predicate:()=>boolean){for(let i=0;i<150;i++){if(predicate())return;await delay(20)}throw new Error('condition timed out')}
type FakePeer=Peer&{sent:ServerMessage[]}
const peer=(id:string):FakePeer=>({id,role:'table',seatId:null,token:null,room:null,requestRoom:null,sent:[],send(m){this.sent.push(m)},supersede(){}})
const state=(p:FakePeer)=>{const m=p.sent.filter(m=>m.type==='state').at(-1);assert.ok(m?.type==='state');return m.state}
const moves=(s:Snapshot)=>s.game==='chess'?s.chess.moves:s.game==='xiangqi'?s.xiangqi.moves:[]
function policy(){
 let unavailable=false
 const requests:{position:BoardSearchPosition;difficulty:BoardAiDifficulty;signal?:AbortSignal;resolve:(m:BoardAiMove)=>void;reject:(e:Error)=>void}[]=[]
 const bridge:BoardAiPolicy={availability:()=>({available:!unavailable,message:unavailable?'测试引擎不可用':null}),chooseMove:(position,difficulty,signal)=>new Promise((resolve,reject)=>requests.push({position,difficulty,signal,resolve,reject}))}
 return {bridge,requests,setUnavailable(){unavailable=true}}
}
test('Five relative profiles route to the intended CPU engines with increasing resource budgets',()=>{
 for(const game of ['chess','xiangqi'] as const){let nodes=0,time=0,skill=-30;for(const l of BOARD_AI_DIFFICULTIES){const p=boardAiProfile(game,l.id);assert.ok(p.nodes>nodes);assert.ok(p.movetime>time);assert.ok(p.skill>skill);nodes=p.nodes;time=p.movetime;skill=p.skill;assert.equal(boardEngine(game,l.id),game==='chess'?'stockfish':l.id==='challenge'?'pikafish':'fairy')}}
})
test('Engine positions retain full chess history, promotion, castling rights and Xiangqi coordinates',()=>{
 const chess=new ChessGame();chess.start();assert.ok(chess.command(0,'chessMove',{from:52,to:36}).ok);assert.ok(chess.command(1,'chessMove',{from:12,to:28}).ok)
 const c=boardSearchPosition(chess.view());assert.match(c.position,/ w KQkq - 0 1 moves e2e4 e7e5$/);assert.ok(c.legalMoves.includes('g1f3'))
 const xq=new XiangqiGame();xq.start();assert.ok(xq.command(0,'xiangqiMove',{from:54,to:45}).ok);assert.ok(xq.command(1,'xiangqiMove',{from:27,to:36}).ok)
 const x=boardSearchPosition(xq.view());assert.match(x.position,/moves a3a4 a6a5$/);assert.ok(x.legalMoves.includes('b0c2'));assert.equal(xiangqiFen(initialXiangqiBoard()),'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1')
 for(let p=0;p<90;p++)assert.equal(xiangqiUciIndex(xiangqiUciSquare(p)),p)
 for(const move of ['a0a9','b0c2','i9i0'])assert.equal(fairyXiangqiMove(fairyXiangqiMove(move,1),-1),move)
 assert.equal(fairyXiangqiMove('a9a0',1),'a10a1')
 const fixed=new ChessGame('7k/P6p/8/8/8/8/8/K7 w - - 0 1');fixed.start();assert.equal(boardSearchPosition(fixed.view()).legalMoves.filter(m=>m.startsWith('a7a8')).length,4)
})
test('Board AI configuration is host/lobby only, validates levels and never replaces a human',()=>{
 const p=policy(),room=new Room('BA01','phone','chess',undefined,undefined,p.bridge),host=peer('h'),guest=peer('g')
 try{room.bindCreator(host,'create','玩家');room.bindJoin(guest,1,'朋友','join');room.command(host,'boardAi',{enabled:true,side:1,difficulty:'normal'},'occupied');assert.equal(state(host).boardAi?.config,null)
  room.command(guest,'boardAi',{enabled:true,side:0,difficulty:'normal'},'not-host');assert.ok(guest.sent.some(m=>m.type==='error'&&m.id==='not-host'))
  room.command(host,'boardAi',{enabled:true,side:1,difficulty:'unknown'},'level');assert.equal(state(host).boardAi?.config,null)
  room.command(host,'ready',{ready:true},'r');room.command(guest,'ready',{ready:true},'g');room.command(host,'start',{},'start');room.command(host,'boardAi',{enabled:false},'mid-round');assert.ok(host.sent.some(m=>m.type==='error'&&m.id==='mid-round'))
 }finally{room.dispose()}
})
for(const game of ['chess','xiangqi'] as const)test(`${game}: shared tablet fences human input, cancels on disconnect, drops stale result, resumes and rematches`,async()=>{
 const p=policy(),room=new Room('BA02','tablet',game,undefined,undefined,p.bridge),host=peer('h')
 try{room.bindCreator(host,'create');room.command(host,'boardAi',{enabled:true,side:0,difficulty:'hard'},'ai');assert.equal(state(host).seats[0]?.isBot,true);room.command(host,'start',{},'start');await until(()=>p.requests.length===1);assert.equal(state(host).boardAi?.thinking,true)
  const payload=game==='chess'?{from:52,to:36}:{from:54,to:45};room.command(host,game==='chess'?'chessMove':'xiangqiMove',payload,'human-for-ai');assert.equal(moves(state(host)).length,0)
  room.command(host,game==='chess'?'chessResign':'xiangqiResign',{side:0},'resign-ai');assert.equal(state(host).phase,'playing')
  room.detach(host);assert.equal(p.requests[0]!.signal?.aborted,true);p.requests[0]!.resolve(payload);await delay(30);assert.equal(moves(room.engine.view(0) as Snapshot).length,0)
  const fresh=peer('fresh');room.bindResume(fresh,room.hostToken,'resume');await until(()=>p.requests.length===2);p.requests[1]!.resolve(payload);await until(()=>moves(state(fresh)).length===1);assert.equal(state(fresh).boardAi?.thinking,false)
  room.command(fresh,game==='chess'?'chessResign':'xiangqiResign',{side:1},'resign');assert.equal(state(fresh).phase,'finished');room.command(fresh,'again',{},'again');assert.equal(state(fresh).boardAi?.config?.difficulty,'hard');room.command(fresh,'boardAi',{enabled:false},'off');assert.equal(state(fresh).boardAi?.config,null);assert.ok(state(fresh).seats.every(s=>!s.isBot))
 }finally{room.dispose()}
})
test('Phone AI is ready without a socket, cannot be impersonated or taken over, and rejection is retryable',async()=>{
 const p=policy(),room=new Room('BA03','phone','chess',undefined,undefined,p.bridge),host=peer('h'),stranger=peer('s')
 try{room.bindCreator(host,'create','玩家');room.command(host,'boardAi',{enabled:true,side:1,difficulty:'easy'},'ai');assert.equal(state(host).seats[1]?.ready,true);assert.equal(state(host).seats[1]?.connected,true);room.requestSeat(stranger,1,'接替','takeover');assert.equal(stranger.requestRoom,null)
  room.command(host,'ready',{ready:true},'ready');room.command(host,'start',{},'start');room.command(host,'chessMove',{from:52,to:36},'white');await until(()=>p.requests.length===1);room.command(host,'chessMove',{from:12,to:28},'impersonate');assert.equal(moves(state(host)).length,1)
  p.requests[0]!.resolve({from:0,to:0});await until(()=>!!state(host).boardAi?.error);assert.equal(moves(state(host)).length,1);assert.equal(state(host).boardAi?.thinking,false)
  room.command(host,'boardAiRetry',{},'retry');await until(()=>p.requests.length===2);p.requests[1]!.resolve({from:12,to:28});await until(()=>moves(state(host)).length===2);assert.equal(state(host).boardAi?.error,null)
  room.command(host,'chessDraw',{action:'offer'},'draw');assert.ok(host.sent.some(m=>m.type==='error'&&m.id==='draw'))
 }finally{room.dispose()}
})
test('Finishing, restarting, and disposing a board room prevent an old computation from changing the next round',async()=>{
 const p=policy(),room=new Room('BA04','tablet','chess',undefined,undefined,p.bridge),host=peer('h')
 try{room.bindCreator(host,'create');room.command(host,'boardAi',{enabled:true,side:0,difficulty:'challenge'},'ai');room.command(host,'start',{},'start');await until(()=>p.requests.length===1);room.command(host,'chessResign',{side:1},'resign');assert.equal(p.requests[0]!.signal?.aborted,true);room.command(host,'again',{},'again');p.requests[0]!.resolve({from:52,to:36});await delay(40);assert.equal(state(host).phase,'lobby');assert.equal(moves(state(host)).length,0)
  room.command(host,'start',{},'start2');await until(()=>p.requests.length===2);room.dispose();assert.equal(p.requests[1]!.signal?.aborted,true);p.requests[1]!.resolve({from:52,to:36});await delay(30);assert.equal(moves(room.engine.view(0) as Snapshot).length,0)
 }finally{room.dispose()}
})
test('Unavailable engines fail closed without silently adding or downgrading a computer',()=>{
 const p=policy();p.setUnavailable();const room=new Room('BA05','tablet','xiangqi',undefined,undefined,p.bridge),host=peer('h')
 try{room.bindCreator(host,'create');room.command(host,'boardAi',{enabled:true,side:1,difficulty:'challenge'},'ai');assert.equal(state(host).boardAi?.config,null);assert.ok(state(host).boardAi?.levels.every(l=>!l.available));assert.ok(host.sent.some(m=>m.type==='error'&&m.id==='ai'))}finally{room.dispose()}
})
test('Native policy rejects missing or corrupt engine manifests before exposing availability',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'board-ai-test-'))
 try{const policy=new NativeBoardAiPolicy(directory);await policy.initialize();assert.equal(policy.availability('chess','normal').available,false);await writeFile(join(directory,'engine'),'broken');await writeFile(join(directory,'manifest.json'),JSON.stringify({version:1,platform:process.platform,arch:process.arch,engines:{stockfish:{binary:{path:'engine',sha256:'wrong'}}}}));await policy.initialize();assert.match(policy.availability('chess','normal').message!,/校验失败/)}finally{await rm(directory,{recursive:true,force:true})}
})
test('UCI rejects missing capabilities, malformed bestmove, startup exit, timeout and abort; never applies an early bestmove',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'uci-test-')),binary=join(directory,'engine')
 const script=async(body:string)=>{await writeFile(binary,`#!${process.execPath}\n${body}`);await chmod(binary,0o755)}
 const request={binary,options:{},requiredOptions:['Skill Level'],position:'position startpos',go:'go nodes 1',timeoutMs:3000}
 try{
  await script(`process.stdin.resume();process.stdin.on('data',s=>{if(String(s).includes('uci'))process.stdout.write('bestmove e2e4\\nuciok\\n')})`);await assert.rejects(searchUci(request),/不支持必要参数/)
  await script(`process.exit(1)`);await assert.rejects(searchUci(request),/提前退出/)
  await script(`process.stdin.resume()`);await assert.rejects(searchUci({...request,timeoutMs:100}),/超时/)
  const controller=new AbortController(),pending=searchUci({...request,signal:controller.signal,timeoutMs:2000});controller.abort();await assert.rejects(pending,/取消/)
  await script(`process.stdin.on('data',s=>{const t=String(s);if(t.includes('uci\\n'))process.stdout.write('option name Skill Level type spin default 20 min 0 max 20\\nuciok\\n');if(t.includes('isready'))process.stdout.write('readyok\\n');if(t.includes('go nodes'))process.stdout.write('bestmove (none)\\n')})`);await assert.rejects(searchUci(request),/没有返回/)
 }finally{await rm(directory,{recursive:true,force:true})}
})
