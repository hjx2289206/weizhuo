/** Real installed CPU engines, not a substitute policy. Does not claim Elo calibration. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BOARD_AI_DIFFICULTIES } from '../shared/boardAi'
import { BOARD_AI_ROOT, NativeBoardAiPolicy, boardSearchPosition } from '../server/bots/boardAi'
import { ChessGame } from '../server/games/chess'
import { XiangqiGame } from '../server/games/xiangqi'
import { Room, type Peer } from '../server/room'
import type { Snapshot, ServerMessage } from '../shared/protocol'

const policy=new NativeBoardAiPolicy();await policy.initialize()
const results:{game:string;difficulty:string;plies:number;elapsedMs:number}[]=[]
for(const game of ['chess','xiangqi'] as const)for(const level of BOARD_AI_DIFFICULTIES){
 const status=policy.availability(game,level.id);assert.ok(status.available,status.message??'引擎不可用')
 const engine=game==='chess'?new ChessGame():new XiangqiGame();engine.start();const started=Date.now()
 for(let ply=0;ply<6;ply++){
  const view=engine.view(),move=await policy.chooseMove(boardSearchPosition(view),level.id)
  const result=engine.command(view.turn!,game==='chess'?'chessMove':'xiangqiMove',{...move});assert.ok(result.ok,result.ok?'':result.message)
 }
 results.push({game,difficulty:level.id,plies:6,elapsedMs:Date.now()-started});console.log(`${game}/${level.label}: 6 actual engine moves PASS`)
}
// Targeted special moves, with the legal search domain deliberately restricted for this test.
for(const [fen,allowed]of[['7k/P6p/8/8/8/8/8/K7 w - - 0 1','a7a8'],['7k/8/8/8/8/8/p6P/7K b - - 0 1','a2a1'],['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','e1g1']]){
 const engine=new ChessGame(fen);engine.start();const position=boardSearchPosition(engine.view());position.legalMoves=position.legalMoves.filter(m=>m.startsWith(allowed!));assert.ok(position.legalMoves.length)
 const move=await policy.chooseMove(position,'normal'),result=engine.command(engine.view().turn!,'chessMove',{...move});assert.ok(result.ok)
 assert.equal(move.kind,'uci')
 if(allowed!.startsWith('a'))assert.ok(move.promotion);else assert.ok(engine.view().chess.moves.at(-1)?.castle)
}
// Actual room authority schedules each configured difficulty and applies the real CPU reply.
for(const game of ['chess','xiangqi'] as const)for(const level of BOARD_AI_DIFFICULTIES){
 const messages:ServerMessage[]=[],room=new Room('AI00','tablet',game,undefined,undefined,policy)
 const host:Peer={id:'native-smoke',role:'table',seatId:null,token:null,room:null,requestRoom:null,send(m){messages.push(m)},supersede(){}}
 const state=()=>{const last=messages.filter(m=>m.type==='state').at(-1);assert.ok(last?.type==='state');return last.state}
 try{room.bindCreator(host,'create');room.command(host,'boardAi',{enabled:true,side:0,difficulty:level.id},'ai');room.command(host,'start',{},'start')
  for(let n=0;n<150&&state().turn!==1&&!state().boardAi?.error;n++)await new Promise(r=>setTimeout(r,100))
  assert.equal(state().boardAi?.error,null);assert.equal(state().turn,1);assert.equal(state().boardAi?.thinking,false)
 }finally{room.dispose()}
}
const manifest=JSON.parse(await readFile(join(BOARD_AI_ROOT,'manifest.json'),'utf8'))
const report={pass:true,at:new Date().toISOString(),platform:process.platform,arch:process.arch,revisions:Object.fromEntries(Object.entries(manifest.engines).map(([name,value])=>[name,(value as {revision:string}).revision])),results,specialMoves:['white-promotion','black-promotion','castling'],realRoomProfiles:10,eloCalibration:'NOT_RUN'}
await writeFile(join(BOARD_AI_ROOT,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
