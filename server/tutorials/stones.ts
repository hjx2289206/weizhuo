import { StoneGame, type StoneSetup } from '../games/stones'
import { stoneCoordinate, stoneGroup, stoneSideName, type StoneBoard, type StoneKind, type StoneSide } from '../../shared/stones'
import { GO_LEARNING_SOURCES } from '../../shared/goLearning'
import type { TeachingAction, TeachingClip, TeachingFrame, TeachingLevel } from '../../shared/tutorialProtocol'
import { snapshot } from './model'
import type { GameCommandType } from '../games/types'

type Step = { action: TeachingAction; caption: string; reject?: boolean }
interface Lesson { id: string; title: string; chapter: string; explanation: string; setup?: StoneSetup; steps?: Step[]; focus?: number[]; level?: TeachingLevel }
const p = (row: number, col: number, size = 9) => row * size + col
function diagram(black: number[], white: number[], size = 9): StoneBoard {
  const board: StoneBoard = Array(size ** 2).fill(null)
  black.forEach(point => { board[point] = 0 }); white.forEach(point => { if (board[point] !== null) throw new Error('教学棋子重叠'); board[point] = 1 })
  return board
}
const move = (side: StoneSide, point: number, caption: string, reject = false): Step => ({ action: { type: 'stoneMove', seat: side, payload: { point } }, caption, ...(reject ? { reject: true } : {}) })
const pass = (side: StoneSide): Step => ({ action: { type: 'stonePass', seat: side, payload: {} }, caption: `${stoneSideName(side)}停一手；连续两次停一手后，进入死子确认。` })
const score = (side: StoneSide, action: 'mark' | 'confirm' | 'resume', caption: string, point?: number): Step => ({ action: { type: 'stoneScore', seat: side, payload: { action, ...(point === undefined ? {} : { point }) } }, caption })
const ko = () => diagram([p(1,2),p(2,1),p(3,2)],[p(2,2),p(1,3),p(2,4),p(3,3)])

function goLessons(): Lesson[] {
  const eyes = diagram([...Array.from({ length: 5 },(_,i) => p(3,i+2)),...Array.from({ length: 5 },(_,i) => p(5,i+2)),p(4,2),p(4,4),p(4,6)],[])
  const ladder: Step[] = [move(0,21,'黑棋打吃，白棋只能先向下逃。'),move(1,29,'白棋逃出后还有两口气。')]
  for (const [black,white] of [[38,30],[31,39],[48,40],[41,49],[58,50],[51,59],[68,60],[61,69],[78,70],[71,79]] as const) {
    ladder.push(move(0,black,'黑棋交替封住前方一口气，继续打吃。'),move(1,white,'白棋沿锯齿形方向逃跑；注意前方是否有接应。'))
  }
  ladder.push(move(0,80,'到达边线后，黑棋收紧最后一口气，提掉整串白棋。'))
  return [
    { id: 'board', title: '棋盘与操作：点交叉点，再确认', chapter: '开始一盘棋', explanation: '围棋下在横线与竖线的交叉点，不下在格子里。黑方先行，之后轮流一手；落下的棋子不能移动。游戏里先点空交叉点预选，再点“确认落子”提交；再点预选点可取消，点别处可更换。坐标从左上角开始，字母是列，数字是行，字母跳过 I。', steps: [move(0,40,'黑方先把棋子下在交叉点。'),move(1,24,'白方落子后，再轮到黑方。')] },
    { id: 'sizes', title: '9、13、19 路怎么选', chapter: '开始一盘棋', explanation: '准备页由房主选择棋盘。9 路适合第一次学提子与终局；13 路便于过渡；19 路是常用标准棋盘。更换大小会取消联机玩家的准备状态。本房间三种棋盘均采用黑贴 7.5 点，开局前就能看到；不设让子。', setup: { size: 19 } },
    { id: 'liberties', title: '什么是气？斜着不算连在一起', chapter: '气、连接与提子', explanation: '一颗棋子上下左右相邻的空交叉点叫气，斜角空点不算气。同色棋子沿横竖相邻才连成一块，整块共享所有不重复的气；斜着接触仍是两块。金色标记显示这块黑棋周围的气。', setup: { board: diagram([40,41,50], [30]) }, focus: [31,32,39,42,49,51,59] },
    { id: 'capture', title: '最后一口气被堵住，就整块提掉', chapter: '气、连接与提子', explanation: '白棋只剩右边一口气，称为被打吃。黑方占住这最后一口气后，白棋立刻从棋盘移除。提子是按整块棋处理，由系统自动执行；一手可同时提掉多块。提掉的子数仅作记录，数子结算时不额外加分。', setup: { board: diagram([31,39,49],[40]) }, focus: [40,41], steps: [move(0,41,'黑棋堵住白棋最后一口气，白子被提掉。')] },
    { id: 'escape', title: '被打吃时，可以逃跑、连接或提子', chapter: '气、连接与提子', explanation: '黑棋只剩一口气时，可以向这口气伸出，让整块棋获得更多气。实战还可连接活棋或先提掉攻击你的棋。不要只看一颗棋，要重新数整块的气；有气不等于一定能逃脱后续追击。', setup: { board: diagram([40],[31,39,49]) }, steps: [move(0,41,'黑棋向右伸出，整块棋的气增加了。')] },
    { id: 'suicide', title: '禁入点：不能直接把自己下成无气', chapter: '不能这样落子', explanation: '若落子后没有提掉对方棋，自己的整块棋却没有气，这手不允许。这里黑棋被白棋上下左右围住，直接投进去会无气。规则判断顺序是先提掉对方无气棋，再检查自己；能先提子的点不一定是禁入点。', setup: { board: diagram([],[31,39,41,49]) }, focus: [40], steps: [move(0,40,'黑方直接落进无气点，系统拒绝，盘面不变。',true)] },
    { id: 'occupied', title: '有子的点不能再落，也不能连下两手', chapter: '不能这样落子', explanation: '双方轮流一手，不能抢下对方回合；已经有棋子的交叉点不能再落子。棋子不会像象棋那样移动。合法落子和停一手以服务器确认的局面为准。', steps: [move(0,40,'黑方先落一子。'),move(0,41,'黑方想连下第二手，系统拒绝。',true),move(1,40,'白方想落在已有黑子的点，系统拒绝。',true),move(1,41,'白方改下空点，轮流顺序恢复正常。')] },
    { id: 'ko', title: '劫：不能马上提回同一个盘面', chapter: '不能这样落子', explanation: '黑方提掉白子后，白方若立刻在刚被提的位置反提，会恢复此前的整张盘面，所以不能立即提回。本房间采用禁止盘面同形再现的约定，包含更长的循环；停一手不绕过这条限制。先在别处行棋，改变盘面后才可能再争劫。', setup: { board: ko() }, focus: [20,21], steps: [move(0,21,'黑方提掉白子，形成单劫。'),move(1,20,'白方立即提回会重现旧盘面，系统拒绝。',true)] },
    { id: 'passes', title: '双方停一手，进入死子确认', chapter: '终局与数子', explanation: '认为没有值得下的地方时，轮到你可点“停一手”并确认。对方还可继续落子；只有连续两手都是停一手，才进入死子确认。这时还没有判胜，也不会自动把被包围的棋当死棋。', setup: { board: diagram([20,21,29],[50,51,60]) }, steps: [pass(0),pass(1)] },
    { id: 'dead', title: '先标记死子，双方都同意才结算', chapter: '终局与数子', explanation: '死子指双方认可已经无法救活的棋。进入结算后，点击棋子会标记或取消整块死子，红叉只作标记，原盘面保留。任何标记修改都会撤销双方之前的确认；双方都确认当前标记后才按数子法结算。不要为了省事把对手所有被围的棋都标死。', setup: { board: diagram([p(1,1),p(1,2),p(1,3),p(1,4),p(4,1),p(4,2),p(4,3),p(4,4),p(2,1),p(3,1),p(2,4),p(3,4)],[p(2,2)]) }, steps: [pass(0),pass(1),score(0,'mark','双方讨论后，点击白子标记整块死棋。',20),score(0,'confirm','黑方确认当前标记。'),score(1,'confirm','白方也确认，系统才显示最终结果。')] },
    { id: 'dispute', title: '死活有争议：恢复原盘面继续下', chapter: '终局与数子', explanation: '一方不同意死子判断时，点“继续下棋”，清除死子标记和双方确认，恢复原有棋子。从两次停一手后的行棋方继续，必要时用实际落子证明死活。禁止同形再现的历史仍保留，不能借结算重置劫争。', setup: { board: diagram([20,21],[50,51]) }, steps: [pass(0),pass(1),score(0,'mark','白棋先被标记为待确认死子。',50),score(1,'resume','白方有异议，恢复原盘面继续下棋。'),move(0,30,'轮到黑方继续，刚才的白子仍在原处。')] },
    { id: 'area', title: '数子法：盘上活子 + 围住的空', chapter: '终局与数子', explanation: '本房间按面积计分：盘上留下的己方棋子 + 只与己方相邻连通的空点。双方都邻接的空区归中立，双方都不加分。白方再加 7.5 贴点，比较双方总点；提子数不重复加分。这不是日式数目法；活棋内部补一手通常不会改变自己的面积。', setup: { board: diagram(Array.from({ length: 9 },(_,r) => p(r,2)),Array.from({ length: 9 },(_,r) => p(r,6))) }, steps: [pass(0),pass(1),score(0,'confirm','黑方确认；盘上子、围空与贴点分别计算。'),score(1,'confirm','白方确认后公布结果。中间接触双方的空区不计分。')] },
    { id: 'resign', title: '认输、再开一局与保存棋谱', chapter: '终局与数子', explanation: '确定不再继续时可以认输，对方获胜。结束后房主可再开一局，黑方重新先行。棋谱与公开战绩可在工具里查看；联机掉线时暂停，重连后继续同一局。教程是独立演示，观看时原对局仍可能进行。', steps: [{ action: { type: 'stoneResign', seat: 0, payload: {} }, caption: '黑方确认认输，白方获胜。' }] },
    { id: 'study', title: '进阶学习路线：按需选择，不必连看', chapter: '进阶学习路线', level: 'advanced', explanation: '先学会完整下完一盘，再按需要学习死活、手筋、布局、中盘与官子。站内局面是独立编写的演示，可暂停、重播、按目录选段；下方外站课程由原作者提供，可自行选看中文课程和更深入的视频内容。不要只背结论，每次先想对方最强的应手。' },
    { id: 'two-eyes', title: '两眼做活：关键是两个独立真眼', chapter: '死活与手筋', level: 'advanced', explanation: '金色点是这块黑棋内部两个独立的眼。对方填其中一眼时，黑棋仍有另一口气，不能被提；填入的白子反而无气。前提是周围确实连成可靠的一块，两个空点不能只是同一只大眼，也要防假眼、分断和对杀的特殊情况。', setup: { board: eyes, turn: 1 }, focus: [39,41], steps: [move(1,39,'白棋投进第一只真眼，黑棋还有另一只眼，不能被提；白方这一手无气。',true)] },
    { id: 'connect', title: '连接与分断：先看自己的薄弱处', chapter: '死活与手筋', level: 'advanced', explanation: '两块棋之间存在断点时，攻击前先检查自己是否会被切开。这里黑方在两块之间补一手，将它们沿横线连成一块，共享气与出路。不是每个断点都要补：比较对手切断的后果、连接代价以及全局紧急程度。', setup: { board: diagram([38,40],[30,48]) }, focus: [38,39,40], steps: [move(0,39,'黑棋补在断点，两块合并，气要按整块重新计算。')] },
    { id: 'double-atari', title: '双打吃：让对方难以两边兼顾', chapter: '死活与手筋', level: 'advanced', explanation: '黑棋下在中间，同时让左右两颗白子都只剩一口气。这盘局部里白方先救左边，黑方可提右边。双打吃是否成立，要确认两边都真的只剩一气，并检查对手能否反提、反打或把两块同时连回去。', setup: { board: diagram([11,19,13,23],[20,22]) }, focus: [20,21,22], steps: [move(0,21,'一手同时打吃左右两块白棋。'),move(1,29,'白方选择向下救出左边。'),move(0,31,'黑方收紧右边最后一气，提掉白子。')] },
    { id: 'ladder', title: '征子：读到边线，还要看引征', chapter: '死活与手筋', level: 'advanced', explanation: '这段逐手演示沿锯齿形追击的征子，每次打吃后白棋只能向剩余的气逃跑，最终到达边线被提。落第一手之前要读清方向，并检查追击路线远处是否有白棋接应；若有引征或反打手段，原本能征的棋可能征不掉。不能把这张示例的结论套到所有局面。', setup: { board: diagram([11,19,28],[20]) }, steps: ladder },
    { id: 'snapback', title: '倒扑：先送一子，再反提一串', chapter: '死活与手筋', level: 'advanced', explanation: '黑棋扑进白棋气紧处，暂时送掉一子；白方提走后，自己的相连三子只剩刚刚空出的一口气。黑方回到这个点，能一次反提三子。这不是劫，因为反提后的盘面与之前不同。实战要核实白方是否有更好的应法，不能见虎口就扑。', setup: { board: diagram([p(2,2),p(1,3),p(1,4),p(2,5),p(3,5),p(4,4)],[p(2,3),p(2,4),p(3,2),p(4,3)]) }, focus: [p(3,3),p(3,4)], steps: [move(0,p(3,3),'黑方先扑一子，自己暂时只剩一口气。'),move(1,p(3,4),'白方提掉扑入的一子，却让相连白棋变成一气。'),move(0,p(3,3),'黑方在原处反提三颗白子，形成倒扑。')] },
    { id: 'ko-threat', title: '劫材：比较损失，再决定是否应劫', chapter: '布局、劫争与官子', level: 'advanced', explanation: '劫争中不能立即反提，要先在别处制造对手值得应对的威胁，称为劫材。此处用远处的两手示意盘面改变后可以再提劫，并不代表那两手在实战就是足够大的劫材。应比较劫的价值、威胁的真实损失、对手能否消劫，以及双方剩余劫材；随意下一手可能得不偿失。', setup: { board: ko() }, steps: [move(0,21,'黑方先提劫。'),move(1,60,'白方先在别处落子；实战需找有实际价值的威胁。'),move(0,61,'黑方在别处应手，示意整盘局面已经改变。'),move(1,20,'白方现在可反提；结果不是历史上的同一盘面。')] },
    { id: 'opening', title: '布局方向：角、边与全局配合', chapter: '布局、劫争与官子', level: 'advanced', explanation: '角部借助两条边，通常较容易围空；边上次之，中央更重视势力与攻防。但“金角银边”是学习方向，不是每手都抢角的命令。示例只是展示四角与边上展开的位置；实际还要照顾弱棋、定式后续与邻近棋子的配合，不应机械照抄落点。', setup: { size: 19 }, steps: [move(0,p(3,3,19),'黑方先在一个角上展开。'),move(1,p(15,15,19),'白方选择对角。'),move(0,p(3,15,19),'黑方占另一个角，观察相邻边的配合。'),move(1,p(15,3,19),'白方也在另一角落子。'),move(0,p(3,9,19),'黑方在边上展开；中央与全局配合仍须另行判断。')] },
    { id: 'endgame', title: '官子：先处理死活，再比较先后手', chapter: '布局、劫争与官子', level: 'advanced', explanation: '进入收官前先确认各块是否安全。比较一处你先下与对手先下的最终面积差，再看对手是否必须应手；能保留下一手选择权的先手官子往往值得优先考虑。不能只把眼前多围的空当作完整价值，也不要把对手可以脱先的棋当作先手。数子法下，补在已确定的自家空内通常只是空变子。下方课程可继续看官子次序与计算。', setup: { board: diagram(Array.from({ length: 9 },(_,r) => p(r,2)),Array.from({ length: 9 },(_,r) => p(r,6))) }, focus: [36,37], steps: [move(0,36,'黑方在自己已围定的空里补一手：空少一，子多一，面积通常不变。')] },
  ]
}
function gomokuLessons(): Lesson[] {
  const line = (id: string, title: string, points: number[]): Lesson => {
    const steps = points.flatMap((point,i) => [move(0,point,`黑方落下第 ${i+1} 颗连线棋子。`),...(i < points.length-1 ? [move(1,15 + i*2,'白方在别处落子，演示轮流一手。')] : [])])
    return { id, title, chapter: '四个方向的五连', explanation: '横、竖与两条斜线都能获胜。必须是同色棋子紧挨着，中间不能有空点或对方棋子。黑白轮流一手，任意一方先连成五子或更多，系统立刻判胜并标出获胜连线。', setup: { size: 15 }, steps }
  }
  const full = Array.from({ length: 225 },(_,i) => (Math.floor(Math.floor(i/15)/2)+i%15)%2 as StoneSide) as StoneBoard
  full[223] = null
  return [
    { id: 'board', title: '15 路棋盘，黑先白后，落在交叉点', chapter: '开始与操作', explanation: '五子棋下在 15×15 棋盘的交叉点。黑方先行，之后轮流一手。先点空点预选，再点“确认落子”；未确认时可点别处更换。棋子落下后固定在交叉点，可按房间规则悔棋。', steps: [move(0,112,'黑方先落在交叉点。'),move(1,113,'白方回应，然后再轮到黑方。')] },
    line('horizontal','横着连成五子',[108,109,110,111,112]),
    line('vertical','竖着连成五子',[52,67,82,97,112]),
    line('diagonal','左上到右下也能赢',[48,64,80,96,112]),
    line('anti-diagonal','右上到左下也能赢',[56,70,84,98,112]),
    { id: 'freestyle', title: '默认无禁手，六连也算获胜', chapter: '本房间规则', explanation: '本段采用默认的无禁手规则。示例中黑方补上空点，一次连成六子，同样获胜。房主可在正式对局开始前改用黑方禁手，两种规则都没有交换开局。', setup: { board: diagram([107,108,109,111,112],[],15) }, steps: [move(0,110,'黑方补上缺口，形成六连，照样获胜。')] },
    { id: 'renju-three', title: '三三：两组真活三同时成立', chapter: '黑方禁手', explanation: '黑方补中间会同时形成横、竖两组活三。每组都能在合法点延伸成两端可成五的直四。如果延伸点本身是禁手，该组就不算活三。小叉提示此处为三三，系统拒绝这手，黑方仍可在别处落子。', setup: { rule: 'renju', board: diagram([97,111,113,127],[],15) }, focus: [112], steps: [move(0,112,'两组活三都成立，系统拒绝黑方这手。',true),move(0,96,'还轮到黑方，改下合法空点。')] },
    { id: 'renju-four', title: '四四：同一条线也能形成两组四', chapter: '黑方禁手', explanation: '四是再走一手就能连成恰好五子的四颗棋。同一组直四的两个胜点仍只算一个四。本例左、右两组的棋子不同，虽在同一条横线上，黑方补中间仍是四四。', setup: { rule: 'renju', board: diagram([109,111,113,115],[],15) }, focus: [110,112,114], steps: [move(0,112,'填中间会形成两组不同的四，系统拒绝。',true)] },
    { id: 'renju-overline', title: '长连：黑方被拒绝，白方六连获胜', chapter: '黑方禁手', explanation: '黑方只有恰好五连才赢，恰好五连优先于同手形成的其他禁手形状。单独形成六连或更长时，系统拒绝落子，棋局继续。白方无禁手，五连或长连都赢。', setup: { rule: 'renju', board: diagram([107,108,109,111,112],[32,33,34,36,37],15) }, focus: [110,35], steps: [move(0,110,'黑方想补成六连，系统拒绝。',true),move(0,144,'黑方改下合法点。'),move(1,35,'白方补成六连，立即获胜。')] },
    { id: 'defend', title: '防守：对手冲四，先堵唯一胜点', chapter: '入门攻防', explanation: '白棋已有四颗紧挨的棋，左端被黑棋封住，右端是下一手成五的点。轮到黑方时，应先看到这个直接威胁。若两端都空着是活四，通常只堵一端不够；实战还要检查自己是否有更快的成五或反击。', setup: { board: diagram([108],[109,110,111,112],15) }, focus: [113], steps: [move(0,113,'黑方先堵住白方这一端的成五点。'),move(1,96,'白方无法直接连五，转到别处继续。')] },
    { id: 'occupied', title: '不能重叠落子，也不能抢回合', chapter: '本房间规则', explanation: '只有轮到自己时才能在空交叉点落子。点在已有棋子的位置不会换色，也不会吃掉它；不能通过重复点击连下两手。联机断线会暂停，重连后棋盘和执子身份恢复。', steps: [move(0,112,'黑方落子。'),move(0,113,'黑方连续落第二子，被拒绝。',true),move(1,112,'白方试图重叠落子，被拒绝。',true),move(1,113,'白方改下空点。')] },
    { id: 'full', title: '棋盘满了仍无五连，判和棋', chapter: '胜负与重开', explanation: '一旦出现五连就立即判胜；只有棋盘填满且双方都没有五连，才判和棋。五子棋不能停一手。本图是特意排成的无五连示例，用最后一手展示满盘和棋；正常对弈常会更早分出胜负。', setup: { board: full, turn: 0 }, steps: [move(0,223,'黑方填上最后空点，双方均无五连，判和。')] },
    { id: 'resign', title: '认输与再开一局', chapter: '胜负与重开', explanation: '不想继续可点“认输”，确认后对方获胜。双人平板先选择认输一方，避免替错人认输。结束后房主可再开一局，黑方重新先行；公开棋谱与战绩在本浏览器保留，服务重启不保留原房间。', steps: [{ action: { type: 'stoneResign', seat: 0, payload: {} }, caption: '黑方认输，白方获胜。' }] },
  ]
}
/** Every displayed transition is run through the real rules engine before publication. */
export function buildStoneClips(game: StoneKind): TeachingClip[] {
  return (game === 'go' ? goLessons() : gomokuLessons()).map(lesson => {
    const engine = new StoneGame(game,lesson.setup), id = `${game}-${lesson.id}`
    // Catch impossible diagrams at authoring time, including accidentally dead initial groups.
    const initial = engine.view().stones
    if (game === 'go') initial.board.forEach((side,point) => { if (side !== null && !stoneGroup(initial.board,point,initial.size).liberties.length) throw new Error(`${id}: 初始棋块无气`) })
    engine.start()
    const start = snapshot(engine,0,`tutorial:${id}`), frames: TeachingFrame[] = []
    for (const step of lesson.steps ?? []) {
      const before = snapshot(engine,0,`tutorial:${id}`)
      const payload = step.action.type === 'stoneScore' && step.action.payload.action === 'confirm' ? { ...step.action.payload, revision: engine.view().stones.scoreRevision, roundId: engine.view().stones.roundId } : step.action.payload
      const result = engine.command(step.action.seat,step.action.type as GameCommandType,payload)
      if (step.reject ? result.ok : !result.ok) throw new Error(`${id}: ${result.ok ? '本应拒绝' : result.message}`)
      const after = snapshot(engine,0,`tutorial:${id}`)
      if (!result.ok && JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${id}: 拒绝操作改变局面`)
      const point = step.action.payload.point
      frames.push({ snapshot: after, action: step.action, cards: [], caption: step.caption, duration: step.reject ? 5200 : 4200,
        ...(result.ok ? {} : { rejected: result.message }), focus: { points: lesson.focus ?? (typeof point === 'number' ? [point] : []), overview: false } })
    }
    frames.push({ snapshot: snapshot(engine,0,`tutorial:${id}`), cards: [], kind: 'result', caption: lesson.steps?.length ? `${lesson.title}。可重播，或打开完整说明。` : lesson.explanation, duration: lesson.steps?.length ? 5000 : 11000, focus: { points: lesson.focus ?? [], overview: false } })
    return { id, title: lesson.title, chapter: lesson.chapter, tags: [lesson.id], level: lesson.level ?? 'basic', explanation: lesson.explanation, snapshot: start, frames,
      ...(game === 'go' && lesson.level === 'advanced' ? { sources: GO_LEARNING_SOURCES } : {}) }
  })
}
