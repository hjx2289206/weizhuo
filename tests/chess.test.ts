import test from 'node:test'
import assert from 'node:assert/strict'
import { ChessGame } from '../server/games/chess'
import { chessDestinations, chessIndex, chessPoint, CHESS_PROMOTIONS } from '../shared/chess'
import { Room, type Peer } from '../server/room'
import type { ChessSnapshot, ServerMessage } from '../shared/protocol'
import { resultFromSnapshot, readResults } from '../src/resultHistory'

function started(fen?: string) { const game = new ChessGame(fen); game.start(); return game }
function move(game: ChessGame, seat: number, from: string, to: string, promotion?: string) { const r = game.command(seat, 'chessMove', { from: chessIndex(from), to: chessIndex(to), ...(promotion ? { promotion } : {}) }); assert.ok(r.ok, r.ok ? '' : `${from}-${to}: ${r.message}`) }
test('Chess standard setup, legal destinations, stable piece identity and public view isolation', () => {
  const game = started(), start = game.view()
  assert.equal(start.chess.board.filter(Boolean).length,32); assert.equal(start.turn,0)
  assert.equal(start.chess.board.reduce((n,p,i)=>n+(p?.side===0?chessDestinations(start.chess.fen,i).length:0),0),20)
  const id = start.chess.board[chessIndex('e2')]!.id
  move(game,0,'e2','e4'); assert.equal(game.view().chess.board[chessIndex('e4')]!.id,id)
  const copy = game.view(); copy.chess.board[chessIndex('e4')]!.rank='q'; copy.chess.moves[0]!.to=0
  assert.equal(game.view().chess.board[chessIndex('e4')]!.rank,'p'); assert.equal(game.view().chess.moves[0]!.to,chessIndex('e4'))
  assert.equal(start.chess.moves.length,0)
  assert.deepEqual(chessPoint(0,1),chessPoint(63,0))
})
test('Chess rejects malformed, wrong-turn, friendly, blocked and unrelated commands without mutation',()=>{
  const game=started(),before=game.view()
  for(const value of [-1,64,1.5,NaN,'52',{},null]) assert.equal(game.command(0,'chessMove',{from:value,to:36}).ok,false)
  for(const [seat,from,to,promotion] of [[1,12,28,undefined],[0,60,59,undefined],[0,56,32,undefined],[0,52,36,'q'],[0,52,52,undefined]] as const)assert.equal(game.command(seat,'chessMove',{from,to,promotion}).ok,false)
  assert.equal(game.command(0,'xiangqiMove',{from:52,to:36}).ok,false);assert.equal(game.command(3,'chessResign',{}).ok,false);assert.deepEqual(game.view(),before)
})
test('Chess both castles move king and rook and preserve identities; rights do not return after moving',()=>{
  for(const [target,rookFrom,rookTo] of [['g1','h1','f1'],['c1','a1','d1']]){
    const game=started('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'),id=game.view().chess.board[chessIndex(rookFrom!)]!.id
    move(game,0,'e1',target!); const v=game.view().chess
    assert.equal(v.board[chessIndex(target!)]?.rank,'k');assert.equal(v.board[chessIndex(rookTo!)]?.id,id);assert.equal(v.board[chessIndex(rookFrom!)],null);assert.equal(v.moves.at(-1)?.castle?.piece.id,id)
  }
  const game=started('4k2r/8/8/8/8/8/8/4K2R w Kk - 0 1')
  move(game,0,'h1','g1');move(game,1,'h8','g8');move(game,0,'g1','h1');move(game,1,'g8','h8')
  const before=game.view();assert.equal(game.command(0,'chessMove',{from:60,to:62}).ok,false);assert.deepEqual(game.view(),before)
})
test('Chess castling is refused while in check, through check, onto check, or through a blocker',()=>{
  for(const fen of ['k3r3/8/8/8/8/8/8/4K2R w K - 0 1','k4r2/8/8/8/8/8/8/4K2R w K - 0 1','k5r1/8/8/8/8/8/8/4K2R w K - 0 1','k7/7p/8/8/8/8/8/4KB1R w K - 0 1']) {
    const game=started(fen), before=game.view();assert.equal(game.command(0,'chessMove',{from:60,to:62}).ok,false);assert.deepEqual(game.view(),before)
  }
})
test('Chess en passant removes the adjacent pawn, expires after one move, and cannot expose own king',()=>{
  const fen='7k/4p3/8/3P4/8/8/8/K7 b - - 0 1',game=started(fen)
  move(game,1,'e7','e5');move(game,0,'d5','e6');const v=game.view().chess
  assert.equal(v.board[chessIndex('e5')],null);assert.equal(v.board[chessIndex('e6')]?.side,0);assert.equal(v.moves.at(-1)?.capturePoint,chessIndex('e5'));assert.equal(v.moves.at(-1)?.captured?.rank,'p')
  const late=started(fen);move(late,1,'e7','e5');move(late,0,'a1','b2');move(late,1,'h8','h7');assert.equal(late.command(0,'chessMove',{from:chessIndex('d5'),to:chessIndex('e6')}).ok,false)
  const pinned=started('4r2k/8/8/3pP3/8/8/8/4K3 w - d6 0 1');const before=pinned.view();assert.equal(pinned.command(0,'chessMove',{from:chessIndex('e5'),to:chessIndex('d6')}).ok,false);assert.deepEqual(pinned.view(),before)
})
test('Chess requires explicit promotion, allows all four choices for both sides and preserves pawn identity',()=>{
  for(const rank of CHESS_PROMOTIONS)for(const side of [0,1] as const){
    const game=started(side===0?'7k/P6p/8/8/8/8/8/K7 w - - 0 1':'7k/8/8/8/8/8/p6P/7K b - - 0 1'),from=side===0?'a7':'a2',to=side===0?'a8':'a1',before=game.view()
    for(const promotion of [undefined,'k','p','Q',0]) assert.equal(game.command(side,'chessMove',{from:chessIndex(from),to:chessIndex(to),promotion}).ok,false)
    assert.deepEqual(game.view(),before);move(game,side,from,to,rank);assert.equal(game.view().chess.board[chessIndex(to)]?.rank,rank);assert.equal(game.view().chess.board[chessIndex(to)]?.id,before.chess.board[chessIndex(from)]?.id)
  }
})
test('Chess checkmate, stalemate and insufficient material are distinct real endings',()=>{
  const mate=started();move(mate,0,'f2','f3');move(mate,1,'e7','e5');move(mate,0,'g2','g4');move(mate,1,'d8','h4')
  assert.equal(mate.phase,'finished');assert.equal(mate.view().chess.winner,1);assert.match(mate.view().chess.reason,/将死/)
  const stale=started('7k/5K2/8/6Q1/8/8/8/8 w - - 0 1');move(stale,0,'g5','g6');assert.equal(stale.view().chess.draw,true);assert.equal(stale.view().chess.check,null);assert.match(stale.view().chess.reason,/逼和/)
  const bare=started('7k/8/8/8/8/8/1p6/K7 w - - 0 1');move(bare,0,'a1','b2');assert.match(bare.view().chess.reason,/子力不足/)
})
test('Chess repetition includes history, 50-move counter resets on pawns/captures, agreement and rematch work',()=>{
  const game=started();for(let i=0;i<2;i++){move(game,0,'g1','f3');move(game,1,'g8','f6');move(game,0,'f3','g1');move(game,1,'f6','g8')}
  assert.match(game.view().chess.reason,/三次重复/);const id=game.view().chess.roundId;assert.ok(game.restart().ok);assert.equal(game.view().chess.moves.length,0);assert.notEqual(game.view().chess.roundId,id);game.start();assert.ok(game.command(0,'chessDraw',{action:'offer'}).ok);assert.equal(game.command(0,'chessDraw',{action:'accept'}).ok,false);assert.ok(game.command(1,'chessDraw',{action:'decline'}).ok);assert.equal(game.command(0,'chessDraw',{action:'offer'}).ok,false);move(game,0,'e2','e4');assert.ok(game.command(0,'chessDraw',{action:'offer'}).ok);assert.ok(game.command(1,'chessDraw',{action:'accept'}).ok);assert.equal(game.view().chess.draw,true)
  const quiet=started('7k/8/8/8/3R4/8/8/K7 w - - 99 1');move(quiet,0,'d4','d5');assert.match(quiet.view().chess.reason,/50 回合/)
  for(const [fen,from,to] of [['7k/7p/8/8/8/8/4P3/K7 w - - 99 1','e2','e3'],['7k/8/8/3n4/3R4/8/8/K7 w - - 99 1','d4','d5']]){const g=started(fen);move(g,0,from!,to!);assert.equal(g.view().chess.quietPlies,0);assert.equal(g.phase,'playing')}
})

type FakePeer = Peer & { sent: ServerMessage[]; kicked: number }
function peer(id:string):FakePeer{return {id,role:'table',seatId:null,token:null,room:null,requestRoom:null,sent:[],kicked:0,send(m){this.sent.push(m)},supersede(){this.kicked++}}}
function state(p:FakePeer):ChessSnapshot{const m=p.sent.filter(m=>m.type==='state').at(-1);assert.ok(m?.type==='state'&&m.state.game==='chess');return m.state}
function phoneRoom(){const room=new Room('CH01','phone','chess'),white=peer('white'),black=peer('black');room.bindCreator(white,'create','白方');room.bindJoin(black,1,'黑方','join');room.command(white,'ready',{ready:true},'r');room.command(black,'ready',{ready:true},'b');room.command(white,'start',{},'start');return {room,white,black}}
test('Chess phone room authenticates side, deduplicates, pauses, reconnects and persists public results',()=>{
  const {room,white,black}=phoneRoom()
  try{
    assert.equal(state(white).phase,'playing');assert.equal(state(white).seats.length,2);assert.deepEqual(state(white).hand,[]);assert.equal(state(white).turnRemainingMs,null)
    for(const type of ['addBot','autoPlay','play','bid','junqiMove','xiangqiMove','chessDraw'] as const){room.command(white,type,{from:52,to:36,action:'agree',enabled:true,seatId:1},`bad-${type}`);assert.equal(state(white).chess.moves.length,0);assert.ok(white.sent.some(m=>m.type==='error'&&m.id===`bad-${type}`))}
    room.command(white,'chessMove',{from:52,to:36},'move');room.command(white,'chessMove',{from:51,to:35},'move');assert.equal(state(white).chess.moves.length,1)
    room.detach(black);room.command(white,'chessMove',{from:51,to:35},'offline');assert.equal(state(white).chess.moves.length,1)
    const resumed=peer('black2');room.bindResume(resumed,black.token!,'resume');assert.deepEqual(state(resumed).chess,state(white).chess)
    room.command(black,'chessResign',{},'stale');assert.equal(state(resumed).phase,'playing');room.command(resumed,'chessMove',{from:12,to:28},'move2');room.command(white,'chessResign',{side:1},'resign')
    assert.equal(state(white).chess.winner,1);const record=resultFromSnapshot(state(white))!;assert.equal(record.game,'chess');assert.equal(record.plays.length,2);assert.deepEqual(readResults({getItem:()=>JSON.stringify([record])}),[record]);assert.ok(!JSON.stringify(record).includes(white.token!))
  }finally{room.dispose()}
})
test('Chess tablet needs no phones; only current host controls both sides, agreement and restart',()=>{
  const room=new Room('CT01','tablet','chess'),host=peer('host'),stranger=peer('stranger')
  try{
    room.bindCreator(host,'create');assert.equal(state(host).selfSeat,null);assert.equal(room.players.filter(Boolean).length,0);assert.deepEqual(state(host).seats.map(s=>s.name),['白方','黑方'])
    room.bindJoin(stranger,1,'陌生人','join');assert.equal(stranger.room,null);room.requestSeat(stranger,1,'陌生人','request');assert.ok(stranger.sent.some(m=>m.type==='error'))
    room.command(host,'start',{},'start');room.command(host,'chessMove',{from:12,to:28},'wrong');assert.equal(state(host).chess.moves.length,0)
    room.command(host,'chessMove',{from:52,to:36},'white');room.command(host,'chessMove',{from:12,to:28},'black');assert.equal(state(host).chess.moves.length,2)
    room.command(host,'xiangqiResign',{side:0},'foreign');assert.equal(state(host).phase,'playing')
    const fresh=peer('fresh');room.bindResume(fresh,room.hostToken,'resume');assert.equal(host.kicked,1);room.command(host,'chessResign',{side:0},'stale');assert.equal(state(fresh).phase,'playing')
    room.command(fresh,'chessResign',{side:1},'resign');assert.equal(state(fresh).chess.winner,0);room.command(fresh,'again',{},'again');room.command(fresh,'start',{},'start2');room.command(fresh,'chessDraw',{action:'agree'},'draw');assert.equal(state(fresh).chess.reason,'双方同意和棋')
  }finally{room.dispose()}
})
