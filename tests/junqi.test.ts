import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsRoomMode } from '../shared/gameCatalog';
import { JunqiGame } from '../server/games/junqi';
import { Room, type Peer } from '../server/room';
import { resultFromSnapshot, readResults } from '../src/resultHistory';
import { JUNQI_COUNTS, JUNQI_EDGES, canDeployJunqi, isJunqiCamp, isJunqiHQ, junqiCombat, junqiDestinations, junqiRailEdge, junqiRoadEdge, type JunqiBoard, type JunqiRank, type JunqiSide } from '../shared/junqi';
import type { JunqiSnapshot, ServerMessage } from '../shared/protocol';

function piece(side: JunqiSide, rank: JunqiRank, id = `${side}-${rank}`) { return { id, side, rank }; }
function empty(): JunqiBoard { return Array(60).fill(null); }
function started() {
  const game = new JunqiGame(); game.start();
  assert.ok(game.command(0, 'junqiSetup', { action: 'confirm' }).ok);
  assert.ok(game.command(1, 'junqiSetup', { action: 'confirm' }).ok);
  return game;
}
/** Trusted fixtures replace server internals; the production API never accepts a board. */
function fixture(game: JunqiGame, entries: [number, JunqiSide, JunqiRank][]) {
  const board = empty();
  entries.forEach(([p, side, rank], i) => { board[p] = piece(side, rank, `opaque${i}`); });
  Reflect.set(game, 'board', board);
}

test('Junqi generates exact armies and legal deployments over repeated random layouts', () => {
  for (let n = 0; n < 80; n++) {
    const game = new JunqiGame(); game.start();
    for (const side of [0, 1] as const) {
      const board = game.view(side).junqi.board;
      for (const [rank, count] of Object.entries(JUNQI_COUNTS)) assert.equal(board.filter(p => p?.side === side && p.rank === rank).length, count);
      for (let p = 0; p < 60; p++) {
        const item = board[p];
        if (item?.side === side) {
          assert.ok(canDeployJunqi(item.rank!, side, p));
          assert.match(item.id, /^[0-9a-f-]{36}$/);
        } else if (item) assert.equal(item.rank, null);
        if (isJunqiCamp(p)) assert.equal(item, null);
      }
    }
    assert.equal(game.view(null).junqi.board.filter(p => p?.rank).length, 0);
    assert.equal(new Set(game.view(null).junqi.board.filter(p => p).map(p => p!.id)).size, 50);
  }
});

test('Junqi geometry is symmetric, has camps, headquarters and exactly three bridges', () => {
  const bridges = JUNQI_EDGES.filter(([a,b]) => a < 30 && b >= 30);
  assert.deepEqual(bridges, [[25,30],[27,32],[29,34]]);
  for (const [a,b] of JUNQI_EDGES) {
    assert.ok(junqiRoadEdge(b,a));
    assert.ok(junqiRoadEdge(59-a,59-b));
    assert.equal(junqiRailEdge(a,b), junqiRailEdge(b,a));
    assert.equal(junqiRailEdge(a,b), junqiRailEdge(59-a,59-b));
  }
  assert.ok(junqiRoadEdge(6, 0)); // diagonal camp connection
  assert.ok(!junqiRoadEdge(25, 31));
  assert.ok(!junqiRoadEdge(26, 31)); // mountain, no centre-left bridge
  assert.ok(isJunqiHQ(56) && isJunqiHQ(3));
});

test('Junqi movement respects blockers, engineer turns, camps, HQ and immobile pieces', () => {
  const board = empty(); board[5] = piece(0, 'engineer');
  assert.ok(junqiDestinations(board, 5).includes(29)); // railway turn at front row
  board[5] = piece(0, 'division');
  assert.ok(!junqiDestinations(board, 5).includes(29));
  assert.ok(junqiDestinations(board, 5).includes(50));
  board[15] = piece(1, 'company');
  assert.ok(junqiDestinations(board, 5).includes(15));
  assert.ok(!junqiDestinations(board, 5).includes(20));
  board[15] = piece(0, 'company');
  assert.ok(!junqiDestinations(board, 5).includes(15));
  board[6] = piece(1, 'engineer');
  assert.ok(!junqiDestinations(board, 5).includes(6));
  board[6] = null;
  assert.ok(junqiDestinations(board, 5).includes(6));
  board[56] = piece(0, 'commander'); assert.deepEqual(junqiDestinations(board,56), []);
  board[25] = piece(0, 'mine'); assert.deepEqual(junqiDestinations(board,25), []);
  board[25] = piece(0, 'flag'); assert.deepEqual(junqiDestinations(board,25), []);
  board[25] = { id: 'hidden', side: 0, rank: null }; assert.deepEqual(junqiDestinations(board,25), []);
});

test('Junqi records the full railway route and refuses to cross an occupied station', () => {
  const game = started();
  fixture(game, [[5,0,'division'],[45,1,'company'],[58,0,'flag'],[1,1,'flag']]);
  assert.ok(game.command(0,'junqiMove',{from:5,to:45}).ok);
  const move = game.view(0).junqi.moves.at(-1)!;
  assert.equal(move.outcome,'attacker');
  assert.deepEqual(move.path,[5,10,15,20,25,30,35,40,45]);
  for (let i=1;i<move.path.length;i++) assert.ok(junqiRailEdge(move.path[i-1]!,move.path[i]!));
  assert.ok(move.path.slice(1,-1).every(point => game.view(0).junqi.board[point] === null));
  const blocked = started();
  fixture(blocked, [[5,0,'division'],[25,1,'company'],[45,1,'general'],[58,0,'flag'],[1,1,'flag']]);
  assert.equal(blocked.command(0,'junqiMove',{from:5,to:45}).ok,false);
  assert.equal(blocked.view(0).junqi.moves.length,0);
  assert.ok(blocked.command(0,'junqiMove',{from:5,to:25}).ok);
  const capture = blocked.view(0).junqi.moves.at(-1)!;
  assert.deepEqual(capture.path,[5,10,15,20,25]);
  assert.equal(capture.outcome,'attacker');
});

test('Junqi records a route for every attack outcome', () => {
  for (const [attacker, defender, outcome] of [['division','company','attacker'],['company','division','defender'],['regiment','regiment','both']] as const) {
    const game = started();
    fixture(game, [[5,0,attacker],[9,1,defender],[58,0,'flag'],[1,1,'flag']]);
    assert.ok(game.command(0,'junqiMove',{from:5,to:9}).ok);
    const move = game.view(null).junqi.moves[0]!;
    assert.equal(move.outcome,outcome);
    assert.deepEqual(move.path,[5,6,7,8,9]);
    const board = game.view(null).junqi.board;
    assert.equal(board[5],null);
    if (outcome === 'both') assert.equal(board[9],null);
    else assert.equal(board[9]?.side,outcome === 'attacker' ? 0 : 1);
  }
});

test('Junqi masked opponents still receive the same authoritative route', () => {
  const game = started();
  fixture(game, [[25,0,'commander'],[5,1,'engineer'],[1,1,'flag'],[58,0,'flag']]);
  assert.equal(game.view(0).junqi.board[5]?.side,1);
  assert.equal(game.view(0).junqi.board[5]?.rank,null);
  assert.equal(game.view(1).junqi.board[5]?.rank,'engineer');
  assert.ok(game.command(0,'junqiMove',{from:25,to:30}).ok);
  assert.ok(game.command(1,'junqiMove',{from:5,to:14}).ok);
  const observer = game.view(null).junqi.moves;
  assert.deepEqual(observer.map(move => move.path),[[25,30],[5,6,7,8,9,14]]);
  for (const seat of [0,1] as const) assert.deepEqual(game.view(seat).junqi.moves.map(move => move.path),observer.map(move => move.path));
  assert.equal(game.view(0).junqi.board[14]?.rank,null);
  assert.equal(game.view(1).junqi.board[14]?.rank,'engineer');
  assert.ok(!JSON.stringify(observer).includes('engineer'));
  assert.ok(!JSON.stringify(observer).includes('commander'));
});

test('Junqi combat covers ranks and symmetric bomb encounters including flag/mines', () => {
  assert.equal(junqiCombat('commander', 'general'), 'attacker');
  assert.equal(junqiCombat('platoon', 'general'), 'defender');
  assert.equal(junqiCombat('regiment', 'regiment'), 'both');
  assert.equal(junqiCombat('engineer', 'mine'), 'attacker');
  assert.equal(junqiCombat('commander', 'mine'), 'defender');
  for (const rank of Object.keys(JUNQI_COUNTS) as JunqiRank[]) {
    assert.equal(junqiCombat('bomb', rank), 'both');
    assert.equal(junqiCombat(rank, 'bomb'), 'both');
  }
});

test('Junqi deployment is private, validates swaps and freezes a confirmed army', () => {
  const game = new JunqiGame(); game.start();
  assert.equal(game.command(0,'junqiMove',{from:30,to:25}).ok, false);
  const own = game.view(0).junqi.board;
  const flag = own.findIndex(p => p?.rank === 'flag');
  const front = own.findIndex((p,i) => p?.side === 0 && i >= 30 && i < 35);
  assert.equal(game.command(0,'junqiSetup',{action:'swap',from:flag,to:front}).ok,false);
  assert.equal(game.command(0,'junqiSetup',{action:'swap',from:flag,to:5}).ok,false);
  assert.equal(game.command(0,'junqiSetup',{action:'swap',from:NaN,to:3}).ok,false);
  assert.equal(game.command(0,'junqiSetup',{action:'shuffle'}).ok,true);
  assert.equal(game.command(0,'junqiSetup',{action:'confirm'}).ok,true);
  assert.equal(game.command(0,'junqiSetup',{action:'shuffle'}).ok,false);
  assert.equal(game.phase,'deploying');
  assert.equal(game.command(1,'junqiSetup',{action:'confirm'}).ok,true);
  assert.equal(game.phase,'playing'); assert.equal(game.view(0).turn,0);
});

test('Junqi only accepts owner and turn, with no mutation after an illegal move', () => {
  const game = started();
  const before = game.view(0);
  assert.equal(game.command(1,'junqiMove',{from:5,to:10}).ok,false);
  assert.equal(game.command(0,'junqiMove',{from:-1,to:10}).ok,false);
  assert.equal(game.command(0,'junqiMove',{from:30,to:2}).ok,false);
  assert.equal(game.command(0,'play',{cards:[]}).ok,false);
  assert.deepEqual(game.view(0),before);
});

test('Junqi commander death reveals only that flag and leaves surviving ranks secret', () => {
  const game = started();
  fixture(game, [[25,0,'commander'],[30,1,'bomb'],[1,1,'flag'],[58,0,'flag'],[9,1,'engineer'],[35,0,'company']]);
  assert.ok(game.command(0,'junqiMove',{from:25,to:30}).ok);
  const observer = game.view(null).junqi;
  assert.equal(observer.board[58]?.rank,'flag'); assert.equal(observer.board[1]?.rank,null);
  assert.equal(observer.board[9]?.rank,null); assert.deepEqual(observer.revealedFlags,[true,false]);
  assert.equal(observer.moves[0]?.outcome,'both');
  assert.ok(!JSON.stringify(observer.moves).includes('commander'));
});

test('Junqi flag capture (also by bomb), immobilisation, surrender and restart finish correctly', () => {
  for (const attacker of ['engineer','bomb'] as const) {
    const game = started(); fixture(game,[[6,0,attacker],[1,1,'flag'],[9,1,'engineer'],[58,0,'flag']]);
    assert.ok(game.command(0,'junqiMove',{from:6,to:1}).ok);
    assert.equal(game.phase,'finished'); assert.equal(game.view(null).junqi.winner,0);
    assert.ok(game.view(null).junqi.board.filter(p=>p).every(p=>p!.rank));
    const id=game.view(null).junqi.roundId;
    assert.ok(game.restart().ok); assert.equal(game.phase,'lobby');
    assert.notEqual(game.view(null).junqi.roundId,id);
    game.start(); assert.equal(game.view(0).junqi.board.filter(p=>p).length,50);
  }
  const game=started(); fixture(game,[[25,0,'engineer'],[1,1,'flag'],[58,0,'flag']]);
  assert.ok(game.command(0,'junqiMove',{from:25,to:30}).ok); assert.match(game.view(0).junqi.reason,/无棋可走/);
  const resigned=started(); assert.ok(resigned.command(1,'junqiResign',{}).ok); assert.equal(resigned.view(0).junqi.winner,0);
});

test('Junqi has a finite no-combat draw and a detached view cannot mutate its authority', () => {
  const game=started(); fixture(game,[[25,0,'engineer'],[5,1,'engineer'],[1,1,'flag'],[58,0,'flag']]);
  Reflect.set(game,'quietPlies',69);
  assert.ok(game.command(0,'junqiMove',{from:25,to:30}).ok); assert.ok(game.view(0).junqi.draw);
  const copy=game.view(0); copy.junqi.board[58]!.rank='bomb'; copy.junqi.deployed[0]=false; copy.junqi.moves[0]!.from=99; copy.junqi.moves[0]!.path.push(99);
  assert.equal(game.view(0).junqi.board[58]?.rank,'flag'); assert.equal(game.view(0).junqi.moves[0]?.from,25); assert.deepEqual(game.view(0).junqi.moves[0]?.path,[25,30]);
});

type FakePeer = Peer & { sent: ServerMessage[]; kicked: number };
function peer(id: string): FakePeer { return { id, role:'table', seatId:null, token:null, room:null, requestRoom:null, sent:[], kicked:0, send(m){this.sent.push(m)},supersede(){this.kicked++} }; }
function state(p: FakePeer): JunqiSnapshot { const msg=p.sent.filter(m=>m.type==='state').at(-1); assert.ok(msg?.type==='state' && msg.state.game==='junqi'); return msg.state; }
function roomFixture() {
  const room=new Room('JQ01','phone','junqi'), host=peer('host'), red=host, blue=peer('blue');
  room.bindCreator(host,'create','红方');
  room.bindJoin(blue,1,'蓝方','bluejoin');
  room.command(red,'ready',{ready:true},'r');room.command(blue,'ready',{ready:true},'b');room.command(host,'start',{},'start');
  return {room,host,red,blue};
}

test('Junqi room isolates both players and foreign/superseded peers', () => {
  const {room,red,blue}=roomFixture();
  try {
    assert.equal(state(red).junqi.board.filter(p=>p?.rank).length,25);
    assert.equal(state(blue).junqi.board.filter(p=>p?.rank).length,25);
    const foreign=room.snapshotFor(peer('foreign')); assert.ok(foreign.game==='junqi'); assert.equal(foreign.junqi.board.filter(p=>p?.rank).length,0);
    const fresh=peer('newred');room.bindResume(fresh,red.token!,'resume');
    assert.equal(red.kicked,1);
    const old=room.snapshotFor(red);assert.ok(old.game==='junqi');assert.equal(old.junqi.board.filter(p=>p?.rank).length,0);
    assert.equal(state(fresh).junqi.board.filter(p=>p?.rank).length,25);
  } finally {room.dispose()}
});

test('Junqi room pauses on disconnect, resumes exact deployment, and deduplicates moves', () => {
  const {room,red,blue}=roomFixture();
  try {
    room.command(red,'junqiSetup',{action:'confirm'},'redconfirm');
    room.detach(blue);
    const before=room.engine.view(0);
    room.command(red,'junqiSetup',{action:'shuffle'},'paused');assert.deepEqual(room.engine.view(0),before);
    const fresh=peer('blueagain');room.bindResume(fresh,blue.token!,'back');
    assert.ok(state(fresh).junqi.deployed[0]); assert.ok(!state(fresh).junqi.deployed[1]);
    room.command(fresh,'junqiSetup',{action:'confirm'},'blueconfirm');
    const own=state(red);
    const from=own.junqi.board.findIndex((p, point)=>p?.side===0 && junqiDestinations(own.junqi.board,point).length>0);
    const move={from,to:junqiDestinations(own.junqi.board,from)[0]!};
    room.command(red,'junqiMove',move,'moveid');room.command(red,'junqiMove',move,'moveid');
    assert.equal(state(red).junqi.moves.length,1);
    room.command(red,'junqiResign',{},'resign');
    const record=resultFromSnapshot(state(red));assert.ok(record);assert.equal(record.game,'junqi');
    assert.ok(!JSON.stringify(record).includes(red.token!));assert.ok(!JSON.stringify(record).includes('commander'));
    assert.equal(readResults({getItem:()=>JSON.stringify([record])}).length,1);
  } finally {room.dispose()}
});

test('Junqi rejects all bot and auto-play commands in both modes without changing human play', () => {
  for (const variant of ['two', 'four'] as const) {
    const room=new Room('NOAI','phone','junqi'), players=[peer('red'),peer('blue'),peer('green'),peer('purple')];
    const host=players[0]!;
    try {
      room.bindCreator(host,'create','红');
      if (variant==='four') room.command(host,'junqiMode',{variant},'mode');
      const size=variant==='four'?4:2;
      const rejectAutomation=()=>{
        const before=state(host);
        assert.equal(before.automation.available,false);
        assert.match(before.automation.message!,/真人联机/);
        for (const [index,type,payload] of [
          [0,'addBot',{seatId:1}], [1,'removeBot',{seatId:1}],
          [2,'autoPlay',{enabled:true}], [3,'autoPlay',{enabled:false}],
        ] as const) {
          room.command(host,type,payload,`no-ai-${before.phase}-${index}`);
          const error=host.sent.at(-1); assert.ok(error?.type==='error'); assert.match(error.message,/真人联机/);
          assert.deepEqual(room.snapshotFor(host),before);
        }
        assert.ok(before.seats.every(p=>!p.isBot&&!p.autoPlay));
      };
      rejectAutomation();
      for(let seat=1;seat<size;seat++) room.bindJoin(players[seat]!,seat,`玩家${seat}`,`join-${seat}`);
      for(const p of players.slice(0,size)) room.command(p,'ready',{ready:true},`ready-${p.id}`);
      room.command(host,'start',{},'start'); assert.equal(state(host).phase,'deploying');
      rejectAutomation();
      for(const p of players.slice(0,size)) room.command(p,'junqiSetup',{action:'confirm'},`confirm-${p.id}`);
      assert.equal(state(host).phase,'playing'); rejectAutomation();
      const own=state(host).junqi;
      const from=own.board.findIndex((p,point)=>p?.side===0&&junqiDestinations(own.board,point,variant).length>0);
      room.command(host,'junqiMove',{from,to:junqiDestinations(own.board,from,variant)[0]!},'manual');
      assert.equal(state(host).junqi.moves.length,1);
      assert.equal(state(host).turn,1);
    } finally { room.dispose(); }
  }
});

test('Junqi allows private player devices and rejects a public tablet room at construction', () => {
  assert.equal(supportsRoomMode('junqi','phone'), true);
  assert.equal(supportsRoomMode('junqi','tablet'), false);
  assert.equal(supportsRoomMode('doudizhu','tablet'), true);
  assert.equal(supportsRoomMode('guandan','tablet'), true);
  assert.throws(() => new Room('JQ03','tablet','junqi'), /不支持公共平板模式/);
});
