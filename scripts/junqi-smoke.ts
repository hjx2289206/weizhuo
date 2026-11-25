/** Real WebSocket acceptance. Start the server, then run: npx tsx scripts/junqi-smoke.ts */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { JunqiSnapshot, ServerMessage } from '../shared/protocol';
import { JUNQI_COUNTS, junqiAllied, junqiDestinations, type JunqiSide } from '../shared/junqi';

const url = process.env.JUNQI_SMOKE_WS ?? 'ws://127.0.0.1:5180/ws';
class Client {
  ws: WebSocket;
  state: JunqiSnapshot | null = null;
  token = '';
  code = '';
  private replies = new Map<string, { resolve(): void; reject(e: Error): void }>();
  private checks = new Set<() => void>();
  constructor(checkPublicFrame?: (message: ServerMessage, raw: string) => void) {
    this.ws = new WebSocket(url);
    this.ws.on('message', raw => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      checkPublicFrame?.(m, raw.toString());
      if (m.type === 'session') { this.token = m.token; this.code = m.code; }
      if (m.type === 'state') { assert.equal(m.state.game,'junqi'); this.state = m.state as JunqiSnapshot; for(const check of this.checks) check(); }
      if (m.type === 'ack') this.replies.get(m.id)?.resolve();
      if (m.type === 'error' && m.id) this.replies.get(m.id)?.reject(new Error(m.message));
    });
  }
  async open() { await new Promise<void>((resolve,reject)=>{this.ws.once('open',resolve);this.ws.once('error',reject)}); return this; }
  send(type: string, payload: object = {}, id = randomUUID()): Promise<void> {
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.replies.delete(id);reject(new Error(`ACK timeout: ${type}`))},5000);
      this.replies.set(id,{resolve:()=>{clearTimeout(timer);this.replies.delete(id);resolve()},reject:e=>{clearTimeout(timer);this.replies.delete(id);reject(e)}});
      this.ws.send(JSON.stringify({id,type,payload}));
    });
  }
  wait(accepts: (s: JunqiSnapshot)=>boolean): Promise<JunqiSnapshot> {
    if(this.state && accepts(this.state))return Promise.resolve(this.state);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.checks.delete(check);reject(new Error('State timeout'))},5000);
      const check=()=>{if(this.state && accepts(this.state)){clearTimeout(timer);this.checks.delete(check);resolve(this.state)}};
      this.checks.add(check);check();
    });
  }
  async step(type: string,payload: object={}) { const version=this.state?.version??-1;await this.send(type,payload);return this.wait(s=>s.version>version); }
  close() { this.ws.close(); }
}

function checkSpectator(message: ServerMessage, raw: string): void {
  assert.ok(message.type !== 'hint' && message.type !== 'seat-request');
  if (message.type !== 'state') return;
  const state = message.state;
  assert.equal(state.game, 'junqi');
  assert.equal(state.role, 'spectator');
  assert.equal(state.selfSeat, null);
  assert.equal(state.isHost, false);
  assert.deepEqual(state.hand, []);
  assert.deepEqual(state.seatRequests, []);
  if (state.phase === 'finished') {
    assert.ok(state.junqi.board.every(piece => !piece || piece.rank !== null));
    return;
  }
  for (const rank of Object.keys(JUNQI_COUNTS)) {
    const allowed = rank === 'flag' ? state.junqi.board.filter(piece => piece?.rank === 'flag' && state.junqi.revealedFlags[piece.side]).length : 0;
    assert.equal(raw.split(JSON.stringify(rank)).length - 1, allowed, 'hidden rank leaked: ' + rank);
  }
}

const mode = 'phone' as const;
for (const variant of ['two', 'four'] as const) {
  const clients: Client[]=[];
  const connect=async(check?: (message: ServerMessage, raw: string) => void)=>{const c=await new Client(check).open();clients.push(c);return c};
  let host: Client | null=null;
  try {
    host=await connect();
    await assert.rejects(host.send('create',{game:'junqi',roomMode:'tablet'}), /不支持公共平板模式/);
    await assert.rejects(host.send('create',{game:'junqi'}), /不支持公共平板模式/);
    assert.equal(host.code,''); assert.equal(host.state,null);
    await host.step('create',{game:'junqi',roomMode:mode,name:'红方验收'});
    if (variant === 'four') await host.step('junqiMode', { variant });
    const code=host.code;
    let spectator = await connect(checkSpectator);
    await spectator.step('spectate', { code });
    await assert.rejects(spectator.send('junqiSetup', { action:'confirm' }), /旁观者不能操作/);
    const red=host;
    assert.equal(host.state!.automation.available,false);
    await assert.rejects(host.send('addBot',{seatId:1}), /真人联机/);
    await assert.rejects(host.send('autoPlay',{enabled:true}), /真人联机/);
    assert.ok(host.state!.seats.every(p=>!p.isBot&&!p.autoPlay));
    const players = [red];
    for (let side = 1; side < (variant === 'four' ? 4 : 2); side++) {
      const player = await connect(); await player.step('join', { code, seatId: side, name: `玩家${side}验收` }); players.push(player);
    }
    await assert.rejects(players[1]!.send('junqiMode', { variant }), /只有房主/);
    for (const player of players) await player.step('ready', { ready: true });
    await host.step('start');
    await spectator.wait(s => s.phase === 'deploying');
    assert.ok(spectator.state!.junqi.board.every(piece => !piece || piece.rank === null));
    for (const player of players) {
      await player.wait(s => s.phase === 'deploying');
      assert.equal(player.state!.junqi.board.filter(p=>p?.rank).length,25);
      await player.step('junqiSetup',{action:'confirm'});
    }
    await red.wait(s=>s.phase==='playing');
    const viewerToken = spectator.token;
    spectator.close();
    spectator = await connect(checkSpectator);
    await spectator.step('resume', { code, token:viewerToken });
    assert.equal(spectator.state!.spectatorCount, 1);
    // Real disconnect and resume: same layout and identity, no lost piece.
    const last = players.length - 1, previous = players[last]!;
    const oldBoard=previous.state!.junqi.board, token=previous.token;
    previous.close(); const resumed=await connect(); await resumed.step('resume',{code,token}); players[last] = resumed;
    assert.deepEqual(resumed.state!.junqi.board,oldBoard);
    for(let n=0;n<8000;n++) {
      await red.wait(s=>s.phase==='finished'||s.junqi.moves.length===n);
      if(red.state!.phase==='finished')break;
      const side=red.state!.turn as JunqiSide, player=players[side]!;
      await player.wait(s=>s.junqi.moves.length===n);
      // Deterministic protocol fixture: submit the first legal move, without a playing policy.
      const view=player.state!.junqi;
      const from=view.board.findIndex((p,point)=>p?.side===side && junqiDestinations(view.board,point,variant).length>0);
      assert.ok(from>=0);
      const move={from,to:junqiDestinations(view.board,from,variant)[0]!};
      const target = player.state!.junqi.board[move.to];
      assert.ok(!target || !junqiAllied(side, target.side, variant));
      assert.ok(player.state!.junqi.board.every(p => !p || p.side === side || p.rank === null || p.rank === 'flag'));
      await player.step('junqiMove',move);
    }
    for (const player of players) await player.wait(s=>s.phase==='finished');
    await spectator.wait(s=>s.phase==='finished');
    const end=red.state!;assert.ok(end.junqi.moves.length>0);
    assert.ok(end.junqi.board.filter(p=>p).every(p=>p!.rank!==null));
    assert.deepEqual(spectator.state!.junqi.board, end.junqi.board);
    console.log(JSON.stringify({mode,variant,code,result:'PASS',moves:end.junqi.moves.length,winnerTeam:end.junqi.winnerTeam,reason:end.junqi.reason,privacy:'PASS',spectatorPrivacyAndResume:'PASS',resume:'PASS',publicTabletRejected:'PASS',aiDisabled:'PASS'}));
    await host.step('again');assert.equal(host.state!.phase,'lobby');
    assert.equal(host.state!.junqi.variant, variant);
    await host.send('dissolve');host=null;
  } finally {
    if(host?.ws.readyState===WebSocket.OPEN) await host.send('dissolve').catch(()=>{});
    for(const c of clients)c.close();
  }
}
