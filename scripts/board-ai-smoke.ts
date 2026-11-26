/** Real installed CPU engines, not a substitute policy. Does not claim Elo calibration. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BOARD_AI_DIFFICULTIES } from '../shared/boardAi'
import { analysisGrade, analysisLoss, type AnalysisPosition } from '../shared/boardAnalysis'
import { createBoardAnalysisPolicy } from '../server/bots/boardAnalysis'
import { BOARD_AI_ROOT, NativeBoardAiPolicy, boardSearchPosition, decodeMove } from '../server/bots/boardAi'
import { ChessGame } from '../server/games/chess'
import { XiangqiGame } from '../server/games/xiangqi'
import { Room, type Peer } from '../server/room'
import type { ServerMessage } from '../shared/protocol'

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
const analysisFixtures = [
  { game: 'chess', blunder: 5, moves: [
    'e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5h7', 'h8h7', 'f2f4', 'h7h3', 'd2d4', 'h3f3',
    'b1a3', 'e5f4', 'e1d1', 'g7g6', 'c1f4', 'f3a3', 'b2a3', 'g8h6', 'a1c1', 'd7d6',
  ] },
  { game: 'xiangqi', blunder: 3, moves: [
    'b0c2', 'a6a5', 'a0b0', 'b7b0', 'f0e1', 'b0a0', 'h2h9', 'e6e5', 'g3g4', 'h7f7',
    'h9h6', 'g6g5', 'b2b8', 'a5a4', 'b8b4', 'a4b4', 'c3c4', 'a9a3', 'g0i2', 'b9c7',
  ] },
] as const
const analyzer = createBoardAnalysisPolicy(game => policy.analysisEngine(game))
const analysisResults = []
for (const { game, blunder, moves } of analysisFixtures) {
  const engine = game === 'chess' ? new ChessGame() : new XiangqiGame()
  engine.start()
  for (const move of moves) {
    const result = engine.command(engine.view().turn!, game === 'chess' ? 'chessMove' : 'xiangqiMove', { ...decodeMove(game, move) })
    assert.ok(result.ok, result.ok ? undefined : result.message)
  }
  assert.ok(engine.command(0, game === 'chess' ? 'chessResign' : 'xiangqiResign', {}).ok)
  const native = policy.analysisEngine(game)
  assert.ok(native.available, native.available ? undefined : native.message)
  const positions: AnalysisPosition[] = []
  const started = performance.now()
  await analyzer.analyze(engine.view(), new AbortController().signal, position => positions.push(position))
  const elapsedMs = Math.round(performance.now() - started)
  assert.equal(positions.length, moves.length + 1)
  const before = positions[blunder - 1]!
  const loss = analysisLoss(before, positions[blunder]!, before.turn)
  assert.equal(analysisGrade(loss)?.id, 'blunder', `${game} ply ${blunder} loses ${loss}`)
  analysisResults.push({ game, engine: native.key, plies: moves.length, positions: positions.length, blunder, loss, elapsedMs })
  console.log(`${game} analysis: ${positions.length} positions, blunder at ply ${blunder} (${loss}), ${elapsedMs} ms PASS`)
}
const manifest=JSON.parse(await readFile(join(BOARD_AI_ROOT,'manifest.json'),'utf8'))
const report={pass:true,at:new Date().toISOString(),platform:process.platform,arch:process.arch,revisions:Object.fromEntries(Object.entries(manifest.engines).map(([name,value])=>[name,(value as {revision:string}).revision])),results,analysisResults,specialMoves:['white-promotion','black-promotion','castling'],realRoomProfiles:10,eloCalibration:'NOT_RUN'}
await writeFile(join(BOARD_AI_ROOT,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
