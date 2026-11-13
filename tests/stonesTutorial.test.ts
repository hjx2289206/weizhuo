import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { teachingClips, TeachingSession } from '../server/tutorials/session'
import { buildStoneClips } from '../server/tutorials/stones'
import { clipDuration, clipPosition } from '../src/tutorials/motion'
import { connectTutorialSocket } from '../server/tutorials/socket'
test('Stone tutorials replay deterministic engine-validated examples and preserve rejected positions',()=>{
  for(const game of ['go','gomoku'] as const) {
    const clips=teachingClips(game); assert.equal(new Set(clips.map(c=>c.id)).size,clips.length); assert.deepEqual(buildStoneClips(game),clips)
    for(const clip of clips) { let before=clip.snapshot; for(const frame of clip.frames) { if(frame.rejected) assert.deepEqual(frame.snapshot,before,clip.id); before=frame.snapshot }; assert.deepEqual(clipPosition(clip,clipDuration(clip)).snapshot,clip.frames.at(-1)!.snapshot) }
  }
  for(const id of ['go-ladder','go-snapback']) { const s=teachingClips('go').find(c=>c.id===id)!.frames.at(-1)!.snapshot; assert.ok(s.game==='go'); assert.ok(s.stones.captured[0]>=3,id) }
  for(const id of ['horizontal','vertical','diagonal','anti-diagonal','freestyle','full','resign']) assert.equal(teachingClips('gomoku').find(c=>c.id===`gomoku-${id}`)!.frames.at(-1)!.snapshot.phase,'finished')
})
test('Go basic and advanced courses are separate with independent resume and no cross-course navigation',()=>{
  const basic=new TeachingSession('go','go-ladder','basic').start(),advanced=new TeachingSession('go','go-capture','advanced').start()
  assert.equal(basic.clip.id,'go-board'); assert.equal(advanced.clip.id,'go-study')
  assert.equal(basic.total,13); assert.equal(advanced.total,9); assert.ok(basic.clips.every(c=>c.level==='basic')); assert.ok(advanced.clips.every(c=>c.level==='advanced'))
  assert.ok(advanced.clip.sources?.some(s=>s.url.includes('smartedu.cn'))); assert.ok(advanced.clip.sources?.some(s=>s.url.includes('endgame-for-nerds')))
  assert.throws(()=>new TeachingSession('go').request({id:'cross',type:'scene',version:0,clipId:'go-ladder'}),/没有/)
  assert.equal(new TeachingSession('go','go-ladder','advanced').start().clip.id,'go-ladder')
})
test('Tutorial socket supports Go course selection and Gomoku and rejects gameplay and bad levels',async()=>{
  const server=new WebSocketServer({port:0});server.on('connection',connectTutorialSocket);await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');const ws=new WebSocket(`ws://127.0.0.1:${a.port}`);await once(ws,'open')
  const request=async(v:unknown)=>{const reply=once(ws,'message');ws.send(JSON.stringify(v));return JSON.parse(String((await reply)[0]))}
  try { const advanced=await request({id:'start',type:'start',game:'go',level:'advanced'}); assert.equal(advanced.level,'advanced'); assert.equal(advanced.total,9)
    assert.equal((await request({id:'act',type:'stoneMove',point:40,version:0})).type,'tutorial-error')
    assert.equal((await request({id:'bad',type:'start',game:'go',level:'unknown'})).type,'tutorial-error')
    const gomoku=await request({id:'gomoku',type:'start',game:'gomoku'}); assert.equal(gomoku.total,10)
  } finally {ws.close();await once(ws,'close');await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
