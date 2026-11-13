import { JUNQI_COUNTS, JUNQI_NAMES, canDeployJunqi, junqiDestinations, type JunqiBoard, type JunqiRank, type JunqiSide, type JunqiVariant } from '../../shared/junqi'
import { JunqiGame } from '../games/junqi'
import { Author, type LessonText, type TeachingCourse, type TeachingMatch } from './model'
import noMoves from './junqiNoMoves.json'

type Placement = readonly [number, JunqiSide, JunqiRank]
const info = (id: string, title: string, instruction: string, explanation: string, tags: string[]): LessonText => ({ id, title, instruction, explanation, tags })

export function armyBoard(variant: JunqiVariant, required: readonly Placement[]): JunqiBoard {
  const board: JunqiBoard = Array(variant === 'four' ? 129 : 60).fill(null)
  for (const [point, side, rank] of required) {
    if (board[point] || !canDeployJunqi(rank, side, point, variant)) throw new Error(`教学初始棋子非法 ${point}/${rank}`)
    board[point] = { id: `army-${side}-${point}`, side, rank }
  }
  for (let side = 0; side < (variant === 'four' ? 4 : 2); side++) {
    for (const rank of ['flag', 'mine', 'bomb', 'commander', 'general', 'division', 'brigade', 'regiment', 'battalion', 'company', 'platoon', 'engineer'] as JunqiRank[]) {
      const used = board.filter(piece => piece?.side === side && piece.rank === rank).length
      if (used > JUNQI_COUNTS[rank]) throw new Error(`教学棋子过多 ${side}/${rank}`)
      for (let n = used; n < JUNQI_COUNTS[rank]; n++) {
        const point = board.findIndex((piece, p) => !piece && canDeployJunqi(rank, side as JunqiSide, p, variant))
        if (point < 0) throw new Error(`无法完成固定阵形 ${side}/${rank}`)
        board[point] = { id: `army-${side}-${point}`, side: side as JunqiSide, rank }
      }
    }
  }
  return board
}

export function fullBoard(engine: JunqiGame): JunqiBoard {
  const views = Array.from({ length: engine.seatCount }, (_, seat) => engine.view(seat).junqi.board)
  return views[0]!.map((piece, p) => piece ? { ...piece, rank: views[piece.side]![p]!.rank } : null)
}

function match(id: string, title: string, overrides: Record<number, JunqiRank>, build: (author: Author, move: (from: number, to: number, lesson?: LessonText) => void) => void): TeachingMatch {
  const positions: Record<number, [JunqiSide, JunqiRank]> = {
    30: [0, 'commander'], 35: [0, 'engineer'], 36: [0, 'bomb'], 58: [0, 'flag'], 56: [0, 'company'], 40: [0, 'company'], 52: [0, 'platoon'],
    1: [1, 'flag'], 25: [1, 'company'], 20: [1, 'battalion'], 15: [1, 'platoon'], 10: [1, 'engineer'], 5: [1, 'engineer'], 24: [1, 'platoon'],
  }
  for (const [point, rank] of Object.entries(overrides)) positions[Number(point)] = [Number(point) < 30 ? 1 : 0, rank]
  const initial = armyBoard('two', Object.entries(positions).map(([point, [side, rank]]) => [Number(point), side, rank]))
  const create = () => new JunqiGame('two', () => initial)
  const author = new Author(create); author.start()
  for (let seat = 0; seat < 2; seat++) author.add({ type: 'junqiSetup', seat, payload: { action: 'confirm' } })
  let dance = false
  const move = (from: number, to: number, lesson?: LessonText) => {
    author.add({ type: 'junqiMove', seat: 0, payload: { from, to } }, lesson)
    if (author.engine.phase === 'playing') {
      author.add({ type: 'junqiMove', seat: 1, payload: { from: dance ? 18 : 24, to: dance ? 24 : 18 } })
      dance = !dance
    }
  }
  build(author, move)
  if (author.engine.phase !== 'finished') author.add({ type: 'junqiResign', seat: 0, payload: {} }, info(`${id}-resign`, '认输也会结束本局', '点击“认输”，观察双方棋子公开和终局结果。', '双人模式一方认输就结束本局。司令阵亡本身不判负，夺旗、无棋可走或认输才结束；终局公开所有存活棋子。', ['resign', 'end-reveal']))
  author.add({ type: 'continue', seat: 0, payload: {} }, info(`${id}-result`, '本局已经结束', '查看引擎判定的结果，再进入下一场。', (author.engine as JunqiGame).view(0).junqi.reason, ['end-result']))
  return { id, title, player: 0, create, steps: author.steps }
}

const clearColumn = (move: (from: number, to: number, lesson?: LessonText) => void) => { move(30, 25); move(25, 20); move(20, 15); move(15, 10) }

export function junqiCourse(): TeachingCourse {
  const matches: TeachingMatch[] = []
  matches.push(match('jq-capture', '第一局 · 暗棋、路线与夺旗', {}, (_author, move) => {
    move(30, 25, info('jq-dark-rank', '暗棋里的第一次交战', '点选 A6 的红方司令，再点 A7 的蓝方暗子。', '正式暗棋只显示自己的身份。司令 > 军长 > 师长 > 旅长 > 团长 > 营长 > 连长 > 排长 > 工兵。现在司令吃掉连长，进入它的位置。', ['dark-view', 'turns', 'rank-combat', 'capture']))
    move(25, 20); move(20, 15); move(15, 10); move(10, 5)
    move(5, 25, info('jq-rail-long', '铁路直行多格', '选中 A11 司令，沿左侧铁路走到 A7。', '刚才的交战已清开这条铁路。普通军衔可沿直线铁路一次走多格，但不能越过途中任何棋子。', ['rail', 'blockers', 'no-jump']))
    move(25, 5)
    move(5, 6, info('jq-camp-entry', '进入行营得到保护', '将 A11 司令移入 B11 行营。', '椭圆位置是行营，里面的棋子不能被任何敌子攻击，包括炸弹；可动棋子以后仍能走出来。行营周围斜线也可沿线走。', ['road', 'camp', 'camp-protection', 'camp-diagonals']))
    move(6, 1, info('jq-flag', '工兵以外的普通棋子也能夺旗', '从 B11 走入 B12 大本营，夺取对方军旗。', '军旗不能移动，但可以被攻击。普通可动棋子都能夺旗；双人夺旗立即获胜，大本营不提供行营式保护。', ['flag-capture', 'two-player-win', 'hq-vs-camp']))
  }))
  matches.push(match('jq-small', '第二局 · 小撞大', { 30: 'company', 25: 'general' }, (_a, move) => {
    move(30, 25, info('jq-smaller-loses', '进攻也可能损失棋子', '用 A6 连长试攻 A7 的暗子。', '目标在教学演示中揭示为军长。小棋攻击大棋，进攻方被移除，防守方仍在原位。', ['smaller-loses']))
  }))
  matches.push(match('jq-equal', '第三局 · 同级同归于尽', { 30: 'company', 25: 'company' }, (_a, move) => {
    move(30, 25, info('jq-equal-ranks', '同级交战双方移除', '用 A6 连长攻击 A7 的连长。', '相同军衔不论谁先攻击都会同归于尽，两个位置都会变空。', ['equal-ranks', 'mutual-destruction']))
  }))
  matches.push(match('jq-bomb', '第四局 · 炸弹与司令亮旗', { 30: 'engineer', 35: 'bomb', 36: 'regiment', 25: 'commander' }, (_a, move) => {
    move(30, 25)
    move(35, 30)
    move(30, 25, info('jq-bomb-commander', '炸弹与任何敌子同归于尽', '把 A6 炸弹移到 A7，与对方司令交战。', '炸弹不比较军衔，双方一起移除。司令阵亡后只公开其所属一方的军旗，其他暗子身份继续保密。', ['bomb', 'commander-reveal', 'hidden-others']))
  }))
  matches.push(match('jq-engineer', '第五局 · 工兵排雷', { 5: 'mine' }, (_a, move) => {
    clearColumn(move); move(10, 11); move(11, 12)
    move(35, 5, info('jq-defuse', '工兵可排雷并存活', '选 A5 工兵，沿已清空的铁路走到 A11 地雷处。', '工兵军衔最小，却可以排雷。途中的友军也会挡路，所以先让司令离开铁路，进入行营。', ['engineer-mine', 'friendly-blockers']))
    move(5, 6)
    move(6, 1, info('jq-engineer-flag', '工兵同样可以夺旗', '从 B11 行营走到 B12，夺取军旗。', '排雷后工兵仍可继续行棋，也可以独自完成夺旗。', ['engineer-flag']))
  }))
  matches.push(match('jq-mine', '第六局 · 普通军衔触雷', { 5: 'mine' }, (_a, move) => {
    clearColumn(move)
    move(10, 5, info('jq-hit-mine', '司令也不能排雷', '用 A10 司令攻击 A11 地雷，观察结果。', '除工兵外，普通军衔撞地雷都会败，地雷留在原位。己方司令触雷后，己方军旗会被公开，但本局尚未结束。', ['ordinary-mine', 'own-flag-reveal']))
  }))
  matches.push(match('jq-bomb-mine', '第七局 · 炸弹炸雷', { 5: 'mine', 35: 'bomb', 36: 'engineer' }, (_a, move) => {
    clearColumn(move); move(10, 11); move(11, 12); move(35, 30)
    move(30, 5, info('jq-bomb-vs-mine', '炸雷与排雷不同', '沿左侧铁路用 A6 炸弹攻击 A11 地雷。', '炸弹和地雷一起消失。只有工兵排雷才会留下工兵；炸弹与军旗交战也会双方移除并造成夺旗结果。', ['bomb-mine', 'bomb-any-piece']))
  }))
  matches.push(match('jq-turn', '第八局 · 工兵铁路换线', { 30: 'engineer', 35: 'regiment', 34: 'commander', 29: 'platoon', 28: 'company', 27: 'engineer', 26: 'company', 25: 'platoon', 15: 'regiment', 24: 'battalion' }, (_a, move) => {
    move(34, 29); move(29, 28); move(28, 27); move(27, 26); move(26, 25); move(25, 20); move(20, 15); move(15, 16)
    move(30, 29, info('jq-engineer-junction', '工兵能在铁路路口换线', '选 A6 工兵，沿铁路转弯走到 E7。', '先沿左侧铁路上行，再转入横向铁路。只有工兵可在交叉口换线，普通军衔不能这样走；工兵也不能越子。', ['engineer-turn', 'rail-junction']))
  }))
  matches.push(match('jq-hq', '第九局 · 不可移动的棋子', {}, (_a, move) => {
    move(52, 51, info('jq-immobile', '军旗、地雷和大本营', '大本营中的连长不能走。改选 C2 排长，走入 B2 行营。', '军旗、地雷不能动，任何棋子进入大本营后也不能再动。大本营仍能被攻击，不能与保护棋子的行营混淆。', ['immobile', 'hq-lock', 'flag-immobile', 'mine-immobile']))
  }))
  matches.push(match('jq-draw', '第十局 · 70 步无交战和棋', {}, (author, move) => {
    for (let n = 0; n < 35; n++) move(n % 2 ? 41 : 40, n % 2 ? 40 : 41,
      n === 0 ? info('jq-quiet-first', '安全移动也会推进回合', '把 A4 连长移入 B4 行营。', '双方接下来持续安全移动。非教学回合直接跳过，但引擎仍逐步计算无交战步数。', ['quiet-plies']) :
      n === 34 ? info('jq-quiet-last', '连续 70 步没有交战', '再移动一次，观察对方完成第 70 步后的和棋。', '发生交战会清零这段步数；连续 70 步没有交战则和棋，结束后公开全部存活棋子。', ['draw-70', 'end-reveal']) : undefined)
    if (author.engine.phase !== 'finished') throw new Error('教学和棋未产生')
  }))
  const noMoveCreate = () => new JunqiGame('two', () => noMoves.initial as JunqiBoard)
  const noMoveAuthor = new Author(noMoveCreate); noMoveAuthor.start()
  for (let seat = 0; seat < 2; seat++) noMoveAuthor.add({ type: 'junqiSetup', seat, payload: { action: 'confirm' } })
  noMoves.actions.forEach((action, index) => noMoveAuthor.add({ type: 'junqiMove', seat: index % 2, payload: action },
    index === noMoves.actions.length - 1 ? info('jq-no-moves', '无棋可走同样判负', '完成高亮的最后一步交战，观察对方无合法移动后的判负。', '本局此前所有移动与交战均已由引擎执行。对方剩余棋子都无法移动，即使军旗还在，也会判负。', ['no-legal-move', 'immobile-defeat']) : undefined))
  noMoveAuthor.add({ type: 'continue', seat: 0, payload: {} }, info('jq-no-moves-result', '对方军旗仍在，仍然获胜', '查看无棋可走的终局，再进入四国教学。', '夺旗不是唯一胜利方式；让对方无棋可走，也可以获胜。', ['no-moves-result']))
  matches.push({ id: 'jq-no-moves', title: '第十一局 · 无棋可走', player: 0, create: noMoveCreate, steps: noMoveAuthor.steps })
  matches.push(fourMatch())
  return { game: 'junqi', matches }
}

function fourMatch(): TeachingMatch {
  const initial = armyBoard('four', [[0, 0, 'division'], [24, 0, 'platoon'], [34, 1, 'company'], [54, 1, 'platoon'], [84, 2, 'platoon'], [114, 3, 'platoon']])
  const create = () => new JunqiGame('four', () => initial)
  const a = new Author(create); a.start()
  for (let seat = 0; seat < 4; seat++) a.add({ type: 'junqiSetup', seat, payload: { action: 'confirm' } })
  a.add({ type: 'junqiMove', seat: 0, payload: { from: 24, to: 18 } }, info('jq-four-team', '四国四暗与对坐同队', '把己方后排棋子移入行营，观察四方轮转。', '你执红方，绿方是队友，蓝紫是对手。只显示自己的身份，队友也保持暗棋。顺序红、蓝、绿、紫；不能攻击或穿过队友。', ['four-dark', 'teams', 'four-turn-order', 'allied-blockers']))
  for (let seat = 1; seat < 4; seat++) a.add({ type: 'junqiMove', seat, payload: { from: seat * 30 + 24, to: seat * 30 + 18 } })
  const engine = a.engine as JunqiGame
  if (!junqiDestinations(fullBoard(engine), 0, 'four').includes(34)) throw new Error('完整四国棋盘弯道未打通')
  a.add({ type: 'junqiMove', seat: 0, payload: { from: 0, to: 34 } }, info('jq-four-curve', '普通棋子可沿印制弯道走', '选南方 A1 师长，沿外侧弯道走到西方 E1。', '顺着棋盘已印出的铁路弯道走，并不等于在交叉口换线。普通棋子可以顺弯道通过，途中仍然不能越子。', ['printed-curve', 'curve-vs-junction']))
  a.add({ type: 'junqiResign', seat: 1, payload: {} })
  a.add({ type: 'junqiResign', seat: 2, payload: {} })
  a.add({ type: 'junqiMove', seat: 3, payload: { from: 108, to: 114 } })
  a.add({ type: 'junqiMove', seat: 0, payload: { from: 34, to: 0 } }, info('jq-four-eliminate', '一军出局，搭档继续', '绿方已经出局，继续把师长沿弯道走回南方。', '蓝方、绿方认输出局后，整军棋子被移除并跳过回合。绿方出局不让红方立即判负；夺旗和无棋可走也会使该军出局。', ['army-elimination', 'clear-army', 'skip-eliminated', 'ally-continues']))
  a.add({ type: 'junqiMove', seat: 3, payload: { from: 114, to: 108 } })
  a.add({ type: 'junqiResign', seat: 0, payload: {} }, info('jq-four-team-end', '全队出局才结束', '点击“认输”，观察红绿两军出局后的全队结果。', '认输只让自己这一军出局。现在绿方已经出局，红方再出局后红绿队全部出局，仍存活的紫方所在蓝紫队获胜。', ['team-elimination', 'four-team-win', 'four-resign']))
  a.add({ type: 'continue', seat: 0, payload: {} }, info('jq-four-result', '四国对局结束', '查看整队结果，完成教学。', engine.view(0).junqi.reason, ['four-result']))
  return { id: 'jq-four', title: '第十二局 · 四国四暗', player: 0, create, steps: a.steps }
}
