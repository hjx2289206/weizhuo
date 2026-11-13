import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { teachingClips, teachingCourse, TeachingSession } from '../server/tutorials/session'
import { buildClips } from '../server/tutorials/clips'
import { execute, snapshot } from '../server/tutorials/model'
import { XiangqiGame } from '../server/games/xiangqi'
import { xiangqiDestinations, xiangqiInCheck, type XiangqiSide } from '../shared/xiangqi'
import { XIANGQI_FULL_BOX, xiangqiFocusBox, xiangqiMotionPath, xiangqiPoint } from '../shared/xiangqiGeometry'
import { xiangqiPathPoint, xiangqiPlaybackProgress } from '../src/tutorials/xiangqiMotion'
import { clipDuration, clipPosition, INTRO_DURATION } from '../src/tutorials/motion'
import { connectTutorialSocket } from '../server/tutorials/socket'
import { TUTORIAL_VERSION } from '../shared/tutorialProtocol'

test('Xiangqi lessons replay every legal step and preserve all physical pieces including captures',()=>{
  const course=teachingCourse('xiangqi')
  for(const match of course.matches){
    const engine=match.create() as XiangqiGame,initial=engine.view().xiangqi.board.filter(Boolean)
    assert.equal(xiangqiInCheck(engine.view().xiangqi.board,1),false,`${match.id}: opponent starts in check`)
    for(const side of [0,1]) for(const [rank,max]of Object.entries({general:1,advisor:2,elephant:2,horse:2,rook:2,cannon:2,soldier:5}))assert.ok(initial.filter(p=>p?.side===side&&p.rank===rank).length<=max,match.id)
    for(const step of match.steps){
      if(step.action.type==='xiangqiMove'){const {from,to}=step.action.payload;assert.ok(xiangqiDestinations(engine.view().xiangqi.board,Number(from)).includes(Number(to)),match.id)}
      execute(engine,step.action)
      const view=engine.view().xiangqi, all=[...view.board.filter(Boolean),...view.moves.flatMap(m=>m.captured?[m.captured]:[])]
      assert.equal(all.length,initial.length,match.id);assert.equal(new Set(all.map(p=>p!.id)).size,all.length,match.id)
    }
    const replay=match.create();for(const step of match.steps)execute(replay,step.action)
    assert.deepEqual(snapshot(replay,match.player,match.id),snapshot(engine,match.player,match.id))
  }
})
test('Xiangqi clips cover every piece, blockers, check remedies and all supported endings',()=>{
 const clips=teachingClips('xiangqi'),tags=new Set(clips.flatMap(c=>c.tags))
 for(const tag of ['board','red-first','palace','river','turn-order','rook','capture','horse','elephant','advisor','general','cannon-move','cannon-screen','soldier-before-river','soldier-cross-river','soldier-after-river','soldier-last-rank','rook-blocked','horse-leg','elephant-eye','elephant-river','advisor-palace','general-palace','cannon-no-screen','cannon-two-screens','cannon-move-blocked','soldier-side-before-river','soldier-no-retreat','friendly-capture','facing-generals','must-evade','king-safety','wrong-turn','check','evade-general','evade-block','evade-capture','checkmate','stalemate','resign','draw-agreement','threefold','perpetual-check','quiet-120'])assert.ok(tags.has(tag),tag)
 for(const [id,reason,winner]of [['xq-mate','将死',0],['xq-stalemate','困毙',0],['xq-resign','认输',0],['xq-agreement','双方同意',null],['xq-repetition','三次重复',null],['xq-perpetual','长将',1],['xq-quiet','120',null]] as const){const clip=clips.find(c=>c.id===id)!;assert.notEqual(clip.snapshot.phase,'finished');const final=clip.frames.at(-1)!.snapshot;assert.equal(final.game,'xiangqi');if(final.game==='xiangqi'){assert.equal(final.phase,'finished');assert.match(final.xiangqi.reason,new RegExp(reason));assert.equal(final.xiangqi.winner,winner)}}
 const quiet=clips.find(c=>c.id==='xq-quiet')!;assert.ok(quiet.snapshot.game==='xiangqi');assert.equal(quiet.snapshot.xiangqi.quietPlies,117);assert.equal(quiet.snapshot.xiangqi.moves.length,117)
})
test('Xiangqi attempts are actually rejected, never mutate the start, and capture frames come from the engine',()=>{
 for(const clip of teachingClips('xiangqi')){
   let before=clip.snapshot
   for(const frame of clip.frames){
     if(frame.rejected){assert.deepEqual(frame.snapshot,before);assert.equal(frame.action?.type,'xiangqiMove');if(before.game==='xiangqi'){const board=before.xiangqi.board,e=new XiangqiGame(()=>board);e.start();const a=frame.action!;assert.equal(e.command(a.seat,'xiangqiMove',a.payload).ok,false,clip.id)}}
     if(frame.action?.type==='xiangqiMove'&&!frame.rejected&&before.game==='xiangqi'&&frame.snapshot.game==='xiangqi'){
       const move=frame.snapshot.xiangqi.moves.at(-1)!;assert.equal(move.from,frame.action.payload.from);assert.equal(move.to,frame.action.payload.to);assert.deepEqual(frame.path,xiangqiMotionPath(before.xiangqi.board[move.from]!,move.from,move.to));assert.equal(before.xiangqi.board.filter(Boolean).length-frame.snapshot.xiangqi.board.filter(Boolean).length,move.captured?1:0)
     }
     before=frame.snapshot
   }
 }
})
test('Xiangqi replay, resume, pause checkpoints and independent rebuild are deterministic',()=>{
 const clips=teachingClips('xiangqi');assert.deepEqual(buildClips(teachingCourse('xiangqi')),clips)
 const session=new TeachingSession('xiangqi');let version=0
 for(const item of session.start().clips){const state=session.request({id:item.id,type:'scene',version:version++,clipId:item.id}),clip=state.clip,untouched=JSON.stringify(clip);assert.deepEqual(new TeachingSession('xiangqi',item.id).start().clip,clip);assert.deepEqual(clipPosition(clip,0).snapshot,clip.snapshot);assert.deepEqual(clipPosition(clip,clipDuration(clip)).snapshot,clip.frames.at(-1)!.snapshot);const time=INTRO_DURATION+800;assert.deepEqual(clipPosition(clip,time),clipPosition(clip,time));assert.equal(JSON.stringify(clip),untouched)}
 assert.throws(()=>session.request({id:'stale',type:'scene',version:0,clipId:clips[0]!.id}));assert.throws(()=>session.request({id:clips.at(-1)!.id,type:'scene',version:version-1,clipId:clips[0]!.id}))
})
test('Xiangqi camera includes complete routes, horse legs, elephant eyes and reversed view geometry',()=>{
 for(const clip of teachingClips('xiangqi'))for(const frame of clip.frames){if(!frame.path)continue;for(const side of [0,1] as XiangqiSide[]){const box=frame.focus?.overview?XIANGQI_FULL_BOX:xiangqiFocusBox(frame.focus?.points??frame.path,side);for(const p of frame.path){const pos=xiangqiPoint(p,side);assert.ok(pos.x>=box[0]+25&&pos.x<=box[0]+box[2]-25,clip.id);assert.ok(pos.y>=box[1]+25&&pos.y<=box[1]+box[3]-25,clip.id)}assert.deepEqual(xiangqiPathPoint(frame.path,0,side),xiangqiPoint(frame.path[0]!,side));assert.deepEqual(xiangqiPathPoint(frame.path,1,side),xiangqiPoint(frame.path.at(-1)!,side))}}
 assert.equal(xiangqiPlaybackProgress(0,true),0);assert.ok(Math.abs(xiangqiPlaybackProgress(1,true))<1e-9);assert.equal(xiangqiPlaybackProgress(1),1)
})
test('The independent tutorial websocket accepts Xiangqi, resumes and rejects actual move requests',async()=>{
 const server=new WebSocketServer({port:0});server.on('connection',connectTutorialSocket);await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const ws=new WebSocket(`ws://127.0.0.1:${address.port}`);await once(ws,'open')
 const request=async(value:unknown)=>{const reply=once(ws,'message');ws.send(JSON.stringify(value));return JSON.parse(String((await reply)[0]))}
 try{const state=await request({id:'start',type:'start',game:'xiangqi',courseVersion:TUTORIAL_VERSION,clipId:'xq-horse-leg'});assert.equal(state.clip.id,'xq-horse-leg');assert.equal(state.total,teachingClips('xiangqi').length);assert.equal((await request({id:'actual',type:'xiangqiMove',version:state.version,from:40,to:21})).type,'tutorial-error');assert.equal((await request({id:'start',type:'start',game:'xiangqi'})).type,'tutorial-error')}finally{ws.close();await once(ws,'close');await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
