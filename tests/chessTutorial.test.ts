import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Chess } from 'chess.js'
import { WebSocket, WebSocketServer } from 'ws'
import { teachingClips, teachingCourse, TeachingSession } from '../server/tutorials/session'
import { buildClips } from '../server/tutorials/clips'
import { execute, snapshot } from '../server/tutorials/model'
import { clipDuration, clipPosition } from '../src/tutorials/motion'
import { connectTutorialSocket } from '../server/tutorials/socket'
import { TUTORIAL_VERSION } from '../shared/tutorialProtocol'
test('All Chess tutorial scripts replay legally with safe opponent and deterministic snapshots',()=>{
  for(const match of teachingCourse('chess').matches){
    const engine=match.create(),view=engine.view(0);assert.equal(view.game,'chess');if(view.game==='chess'){const c=new Chess(view.chess.fen);assert.equal(c.isAttacked(c.findPiece({type:'k',color:c.turn()==='w'?'b':'w'})[0]!,c.turn()),false,match.id)}
    for(const step of match.steps)execute(engine,step.action)
    const replay=match.create();for(const step of match.steps)execute(replay,step.action)
    assert.deepEqual(snapshot(engine,0,match.id),snapshot(replay,0,match.id),match.id)
  }
})
test('Chess tutorials cover rules and actual terminal outcomes; rejected examples never mutate',()=>{
 const clips=teachingClips('chess'),tags=new Set(clips.flatMap(c=>c.tags))
 for(const t of ['board','turn-order','rook','bishop','queen','knight','king','pawn-one','pawn-two','pawn-capture','castle-short','castle-long','en-passant','promotion-q','promotion-r','promotion-b','promotion-n','check','evade-block','evade-capture','checkmate','stalemate','insufficient-material','threefold','fifty-moves','agreement','resign','king-danger','castle-through-check','wrong-turn'])assert.ok(tags.has(t),t)
 for(const id of ['mate','stalemate','material','repetition','fifty','agreement','resign']) {const clip=clips.find(c=>c.id===`chess-${id}`)!;assert.notEqual(clip.snapshot.phase,'finished');assert.equal(clip.frames.at(-1)!.snapshot.phase,'finished',id)}
 for(const clip of clips){let before=clip.snapshot;for(const frame of clip.frames){if(frame.rejected)assert.deepEqual(frame.snapshot,before,clip.id);before=frame.snapshot}assert.deepEqual(clipPosition(clip,0).snapshot,clip.snapshot);assert.deepEqual(clipPosition(clip,clipDuration(clip)).snapshot,clip.frames.at(-1)!.snapshot)}
 assert.equal(new Set(clips.map(c=>c.id)).size,clips.length);assert.deepEqual(buildClips(teachingCourse('chess')),clips)
 const s=new TeachingSession('chess');let version=0;for(const clip of clips){assert.deepEqual(s.request({id:clip.id,type:'scene',version:version++,clipId:clip.id}).clip,new TeachingSession('chess',clip.id).start().clip)}
})
test('Chess tutorial socket resumes independently and rejects actual game commands and stale requests',async()=>{
 const server=new WebSocketServer({port:0});server.on('connection',connectTutorialSocket);await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');const ws=new WebSocket(`ws://127.0.0.1:${a.port}`);await once(ws,'open')
 const request=async(v:unknown)=>{const reply=once(ws,'message');ws.send(JSON.stringify(v));return JSON.parse(String((await reply)[0]))}
 try{const s=await request({id:'start',type:'start',game:'chess',courseVersion:TUTORIAL_VERSION,clipId:'chess-en-passant'});assert.equal(s.clip.id,'chess-en-passant');assert.equal(s.total,teachingClips('chess').length)
  for(const type of ['chessMove','create','act'])assert.equal((await request({id:type,type,version:s.version,from:52,to:36})).type,'tutorial-error')
  assert.equal((await request({id:'stale',type:'scene',version:99,clipId:'chess-board'})).type,'tutorial-error')
 }finally{ws.close();await once(ws,'close');await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
