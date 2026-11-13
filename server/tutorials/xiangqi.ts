import { XiangqiGame } from '../games/xiangqi'
import { xiangqiDestinations, xiangqiInCheck, xiangqiHasMove, xiangqiPositionKey, type XiangqiBoard, type XiangqiSide, type XiangqiRank } from '../../shared/xiangqi'
import { xiangqiMotionPath } from '../../shared/xiangqiGeometry'
import type { TeachingAction, TeachingClip } from '../../shared/tutorialProtocol'
import { Author, clone, snapshot, type LessonText, type TeachingCourse, type TeachingMatch } from './model'

type Entry = [number, XiangqiSide, XiangqiRank]
const kings: Entry[] = [[85,0,'general'],[4,1,'general'],[49,0,'soldier']]
function board(entries: readonly Entry[]): XiangqiBoard { const b: XiangqiBoard = Array(90).fill(null); entries.forEach(([p,side,rank]) => { b[p]={id:`tutorial-xq-${p}`,side,rank} }); return b }
function create(entries?: readonly Entry[]) { return () => new XiangqiGame(entries ? () => board(entries) : undefined) }
const lesson = (id: string, title: string, explanation: string, tags: string[], span?: number): LessonText => ({ id: `xq-${id}`, title, instruction: explanation, explanation, tags, ...(span ? { span } : {}) })
const action = (seat: number, from: number, to: number): TeachingAction => ({ type:'xiangqiMove', seat, payload:{from,to} })
function match(id: string, entries: readonly Entry[] | undefined, moves: [number,number,number][], text: LessonText, startLesson = false): TeachingMatch {
  const factory=create(entries), author=new Author(factory)
  author.add({type:'start',seat:0,payload:{}}, startLesson ? text : undefined)
  moves.forEach(([side,from,to],index) => author.add(action(side,from,to), !startLesson && index === 0 ? text : undefined))
  return {id:`xq-${id}`,title:text.title,player:0,create:factory,steps:author.steps}
}
export function xiangqiCourse(): TeachingCourse {
  const matches: TeachingMatch[] = [
    match('board',undefined,[],lesson('board','先认棋盘：棋子放在交叉点上','红黑各 16 枚棋。中间是河界，画斜线的方框是九宫。红方先走，棋子放在线与线的交叉点上。这里先看将帅和双方阵地。',['board','red-first','palace','river']),true),
    match('turns',undefined,[[0,54,45],[1,27,36]],lesson('turns','红方一步，黑方一步','红方先走，随后双方轮流走一步。不能连续走两步，也不能替对方走棋。',['turn-order'],2)),
    match('rook',[...kings,[54,0,'rook']],[[0,54,56]],lesson('rook','车：横着或竖着走','车沿横线或竖线走，距离不限，中途不能有棋子。不能斜着走。',['rook'])),
    match('capture',[...kings,[54,0,'rook'],[27,1,'horse']],[[0,54,27]],lesson('capture','吃子：走到对方的位置','车走到黑马所在的交叉点，黑马移走，红车留下。吃子不比较大小，只要走法合法就可以吃。',['capture'])),
    match('horse',[...kings,[40,0,'horse']],[[0,40,33]],lesson('horse','马：先直一格，再斜一格','马走“日”字，先沿横线或竖线走一格，再斜着走一格。第一格被挡住，这一侧就跳不了。',['horse'])),
    match('elephant',[[85,0,'general'],[4,1,'general'],[58,0,'soldier'],[65,0,'elephant']],[[0,65,49]],lesson('elephant','相：斜走两格，不能过河','相（象）走“田”字，斜着走两格。中间的交叉点叫象眼，那里有棋就不能走；相和象都不能过河。',['elephant'])),
    match('advisor',[...kings,[84,0,'advisor']],[[0,84,76]],lesson('advisor','仕：在九宫里斜走一格','仕（士）只在画斜线的九宫里活动，每次斜着走一格，不能走出九宫。',['advisor'])),
    match('general',kings,[[0,85,76]],lesson('general','将帅：在九宫里直走一格','将（帅）每次横着或竖着走一格，不能斜走，也不能离开九宫。任何一步都不能让自己的将帅被吃。',['general'])),
    match('cannon-move',[...kings,[64,0,'cannon']],[[0,64,66]],lesson('cannon-move','炮不吃子时，像车一样走','炮不吃子时沿横线或竖线走，中间不能有棋子。它不会在普通移动时跳过别的棋子。',['cannon-move'])),
    match('cannon-capture',[...kings,[64,0,'cannon'],[46,0,'soldier'],[28,1,'horse']],[[0,64,28]],lesson('cannon-capture','炮吃子时，必须隔一枚棋','炮与目标之间必须正好有一枚棋，叫炮架。炮架可以是任何一方的棋。这里红炮隔着红兵吃掉黑马。',['cannon-screen'])),
    match('pawn',[...kings,[54,0,'soldier']],[[0,54,45]],lesson('pawn','兵没过河，只能向前一格','红兵向黑方走，黑卒向红方走。没过河时只能向前走一格，不能横走，也不能后退。',['soldier-before-river'])),
    match('cross-river',[...kings,[45,0,'soldier']],[[0,45,36]],lesson('cross-river','兵走过河界，才算过河','这一步从河的一边走到另一边。下一次轮到红方时，这个兵就可以向前或横着走一格。',['soldier-cross-river'])),
    match('pawn-side',[...kings,[36,0,'soldier']],[[0,36,37]],lesson('pawn-side','兵过河后，也能横着走','过河后每次可以向前、向左或向右一格，仍然不能后退。吃子和不吃子的走法相同。',['soldier-after-river'])),
    match('pawn-last',[...kings,[0,0,'soldier']],[[0,0,1]],lesson('pawn-last','兵走到底线，也不能往回走','兵到了对方底线，前面已经没有交叉点，只能左右横走。它不会变成别的棋，也不能后退。',['soldier-last-rank'])),
    match('check-move',[...kings,[23,0,'rook']],[[0,23,22],[1,4,3]],lesson('check-move','被将军，可以先把将帅移开','红车下一步能吃到黑将，这叫将军。黑方必须先解围；这里把黑将横移一格，离开红车的攻击线。',['check','evade-general'],2)),
    match('check-block',[...kings,[23,0,'rook'],[10,1,'rook']],[[0,23,22],[1,10,13]],lesson('check-block','也可以挡住攻击线','红车将军后，黑车走到红车和黑将之间，挡住攻击线。挡完以后，黑将已经不能被红车直接吃到。',['evade-block'],2)),
    match('check-capture',[...kings,[23,0,'rook'],[18,1,'rook']],[[0,23,22],[1,18,22]],lesson('check-capture','还可以吃掉正在将军的棋','红车将军后，黑车吃掉红车，黑将就安全了。移将、挡住或吃掉攻击棋，都必须真的解除将军。',['evade-capture'],2)),
    match('mate',[...kings,[12,0,'rook'],[14,0,'rook'],[20,0,'horse']],[[0,12,13]],lesson('mate','将死：被将军，又无路可解','红车将军，黑将的其他落点也被红方控制；吃车、挡车和移将都不行。黑方被将死，红方获胜。',['checkmate','win'])),
    match('stalemate',[...kings,[9,0,'rook'],[14,0,'rook']],[[0,9,12]],lesson('stalemate','困毙：没被将军，但一步也走不了','黑将没有被将军，可是轮到黑方时，任何一步都会被吃。象棋里这种情况叫困毙，也算黑方输，不算和棋。',['stalemate'])),
  ]
  const resignFactory=create(), resign=new Author(resignFactory);resign.start();resign.add({type:'xiangqiResign',seat:1,payload:{}},lesson('resign','认输后，对方获胜','一方认输，本局立即结束。平板同屏要选清楚是哪一方认输；手机联机只能替自己认输。',['resign']))
  matches.push({id:'xq-resign',title:'认输',player:1,create:resignFactory,steps:resign.steps})
  const drawFactory=create(), draw=new Author(drawFactory);draw.start();draw.add({type:'xiangqiDraw',seat:0,payload:{action:'offer'}},lesson('agreement','双方都同意，就可以和棋','一方提出和棋，另一方同意后，本局不分胜负。对方不同意就继续下棋；平板同屏由两人一起确认。',['draw-agreement'],2));draw.add({type:'xiangqiDraw',seat:1,payload:{action:'accept'}})
  matches.push({id:'xq-agreement',title:'和棋',player:0,create:drawFactory,steps:draw.steps})
  const repeatFactory=create(), repeat=new Author(repeatFactory);repeat.start()
  for(let n=0;n<2;n++)for(const [i,[side,from,to]] of ([[0,82,63],[1,1,18],[0,63,82],[1,18,1]] as const).entries()) repeat.add(action(side,from,to), n===0&&i===0 ? lesson('repetition','普通重复三次，本房间判和棋','这里双方的马来回走。棋子位置相同、又轮到同一方，第三次出现这个局面时，本房间按休闲约定判和棋。',['threefold'],8) : undefined)
  matches.push({id:'xq-repetition',title:'重复局面',player:0,create:repeatFactory,steps:repeat.steps})
  const checkFactory=create([...kings,[12,0,'rook']]), checking=new Author(checkFactory);checking.start();let step=0
  while(checking.engine.phase==='playing'&&step<24)for(const [side,from,to] of [[0,12,13],[1,4,5],[0,13,14],[1,5,4],[0,14,13],[1,4,3],[0,13,12],[1,3,4]]) { if(checking.engine.phase!=='playing')break;checking.add(action(side!,from!,to!),step++===0?lesson('perpetual','不能靠一直将军拖住对方','红车来回将军，黑将反复躲开。同一局面第三次出现，而且只有红方每次都在将军，本房间判红方长将负。这里采用休闲约定，不采用比赛中的完整长捉裁定。',['perpetual-check'],100):undefined) }
  if(checking.engine.phase!=='finished')throw new Error('长将教程没有到达真实终局')
  matches.push({id:'xq-perpetual',title:'长将',player:0,create:checkFactory,steps:checking.steps})
  matches.push(quietMatch())
  return {game:'xiangqi',matches}
}
function quietMatch(): TeachingMatch {
  const factory=create([...kings,[81,0,'rook'],[82,0,'horse'],[0,1,'rook'],[1,1,'horse']]), author=new Author(factory);author.start()
  let seed=831;const seen=new Map<string,number>([[xiangqiPositionKey((author.engine as XiangqiGame).view().xiangqi.board,0),1]])
  for(let ply=0;ply<120;ply++) {
    const state=(author.engine as XiangqiGame).view(), side=state.turn as XiangqiSide, enemy=(1-side) as XiangqiSide, candidates:[number,number,string][]=[]
    state.xiangqi.board.forEach((piece,from)=>{if(piece?.side!==side||piece.rank==='soldier')return;for(const to of xiangqiDestinations(state.xiangqi.board,from)) {if(state.xiangqi.board[to])continue;const next=clone(state.xiangqi.board);next[to]=next[from]!;next[from]=null;const key=xiangqiPositionKey(next,enemy);if((seen.get(key)??0)>=2||xiangqiInCheck(next,enemy)||!xiangqiHasMove(next,enemy))continue;candidates.push([from,to,key])}})
    if(!candidates.length)throw new Error('无吃子教程缺少合法后续走法')
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;const [from,to,key]=candidates[seed%candidates.length]!
    author.add(action(side,from,to),ply===117?lesson('quiet','连续 120 手不吃子，本房间判和棋','这一段从第 118 手前开始。前面的每一步都由规则引擎走过；最后三步也没有吃子，到 120 手时判和棋。每一方走一步算一手，两人各走一次算两手。',['quiet-120'],3):undefined);seen.set(key,(seen.get(key)??0)+1)
  }
  if(author.engine.phase!=='finished'||!(author.engine as XiangqiGame).view().xiangqi.reason.includes('120'))throw new Error('无吃子教程没有到达真实和棋')
  return {id:'xq-quiet',title:'无吃子和棋',player:1,create:factory,steps:author.steps}
}
export function xiangqiRestrictions(): TeachingClip[] {
  const specs: {id:string;title:string;why:string;entries:Entry[];from:number;to:number;tags:string[];side?:number;extra?:number[]}[] = [
    {id:'rook-blocked',title:'车不能跳过挡路的棋',why:'这枚兵挡住了车的直线。车不能越过它去吃后面的黑马。',entries:[...kings,[54,0,'rook'],[45,0,'soldier'],[27,1,'horse']],from:54,to:27,tags:['rook-blocked']},
    {id:'horse-leg',title:'马腿被挡，这一侧就不能跳',why:'马先直走的那一格有棋，就是蹩马腿。不能跳过去，换一侧才可能有路。',entries:[...kings,[40,0,'horse'],[31,1,'soldier']],from:40,to:21,tags:['horse-leg'],extra:[31]},
    {id:'elephant-eye',title:'象眼被塞，不能斜跳过去',why:'相斜走两格时，中间的象眼必须空着。这里有黑卒挡住，所以相留在原位。',entries:[...kings,[65,0,'elephant'],[55,1,'soldier']],from:65,to:45,tags:['elephant-eye'],extra:[55]},
    {id:'elephant-river',title:'相和象不能过河',why:'就算象眼是空的，相也只能在自己这一边走，不能越过中间的河界。',entries:[...kings,[47,0,'elephant']],from:47,to:27,tags:['elephant-river']},
    {id:'advisor-palace',title:'仕不能走出九宫',why:'仕每次斜走一格，但只能在九宫里走。这个落点已经在九宫外，不能去。',entries:[...kings,[66,0,'advisor']],from:66,to:56,tags:['advisor-palace']},
    {id:'general-palace',title:'将帅也不能走出九宫',why:'帅想向前走一格，但已经碰到九宫边缘。不能走出这座方框。',entries:[[67,0,'general'],[4,1,'general'],[49,0,'soldier']],from:67,to:58,tags:['general-palace']},
    {id:'cannon-no-screen',title:'炮不能直接吃到眼前的棋',why:'炮和目标之间没有炮架，不能吃这枚黑马。炮吃子必须正好隔一枚棋。',entries:[...kings,[64,0,'cannon'],[28,1,'horse']],from:64,to:28,tags:['cannon-no-screen']},
    {id:'cannon-two-screens',title:'隔着两枚棋，炮也吃不到',why:'中间有两枚棋，不是一个炮架。炮只能正好隔一枚棋吃子，不能越过两枚。',entries:[...kings,[64,0,'cannon'],[55,0,'soldier'],[46,1,'soldier'],[28,1,'horse']],from:64,to:28,tags:['cannon-two-screens']},
    {id:'cannon-move-blocked',title:'炮不吃子时，不能跳过挡子',why:'这一步的落点是空的，不是在吃子。炮不能跳过中间的兵，只能走到挡子前面。',entries:[...kings,[64,0,'cannon'],[55,0,'soldier']],from:64,to:37,tags:['cannon-move-blocked']},
    {id:'pawn-side-before',title:'兵没过河，不能横着走',why:'红兵还在自己这一侧，只能向前一格。越过河界以后，才可以横走。',entries:[...kings,[45,0,'soldier']],from:45,to:46,tags:['soldier-side-before-river']},
    {id:'pawn-back',title:'兵卒一直都不能后退',why:'红兵虽然过了河，也不能向后走。黑卒同样不能后退，走到底线也只能横走。',entries:[...kings,[36,0,'soldier']],from:36,to:45,tags:['soldier-no-retreat']},
    {id:'friendly',title:'不能吃自己的棋',why:'落点上是自己的马，红车不能把它吃掉。自己的棋同样会挡路。',entries:[...kings,[54,0,'rook'],[56,0,'horse']],from:54,to:56,tags:['friendly-capture']},
    {id:'facing',title:'移开挡子后，将帅不能直接照面',why:'红马一旦移开，将和帅就在同一路上直接看见对方，中间没有任何棋。这一步不能走，红马退回原位。',entries:[[85,0,'general'],[4,1,'general'],[49,0,'horse']],from:49,to:32,tags:['facing-generals'],extra:[4,85]},
    {id:'ignore-check',title:'正在被将军，不能先走别的棋',why:'黑车正在攻击红帅。红方必须先移帅、挡住或吃掉黑车，不能随便走一匹马来让过这次将军。',entries:[...kings,[81,1,'rook'],[64,0,'horse']],from:64,to:45,tags:['must-evade'],extra:[81,85]},
    {id:'king-safety',title:'将帅不能走到会被吃的位置',why:'帅想横移一格，但那个位置仍在黑车的攻击线上。这样的走法不能解围，帅必须留在原位重新选路。',entries:[...kings,[81,1,'rook']],from:85,to:84,tags:['king-safety'],extra:[81]},
    {id:'turn',title:'红方先走，黑方不能抢先走',why:'开局先轮到红方。黑卒要等红方走完，不能抢先移动。',entries:[],from:27,to:36,tags:['wrong-turn'],side:1},
  ]
  return specs.map(spec=>{
    const engine=spec.entries.length?create(spec.entries)():new XiangqiGame();engine.start();const before=snapshot(engine,0,`tutorial:xq-${spec.id}`), attempted=action(spec.side??0,spec.from,spec.to), piece=(engine.view().xiangqi.board[spec.from])!, path=xiangqiMotionPath(piece,spec.from,spec.to), response=engine.command(attempted.seat,'xiangqiMove',attempted.payload)
    if(response.ok||JSON.stringify(snapshot(engine,0,before.code))!==JSON.stringify(before))throw new Error(`不合法教程改变局面：${spec.id}`)
    return {id:`xq-${spec.id}`,title:spec.title,explanation:spec.why,chapter:'不能这样走',tags:spec.tags,snapshot:before,frames:[{snapshot:clone(before),action:attempted,path,cards:[],caption:spec.why,rejected:response.message,duration:3400,focus:{points:[...path,...spec.extra??[]],overview:false}},{snapshot:clone(before),cards:[],caption:'这一步没有走成，棋子留在原位。',kind:'result',duration:1500}]}
  })
}
