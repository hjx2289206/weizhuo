import { buildChessClips } from './chess'
import { xiangqiMotionPath } from '../../shared/xiangqiGeometry'
import { xiangqiSideName } from '../../shared/xiangqi'
import { xiangqiRestrictions } from './xiangqi'
import type { GameKind, Snapshot } from '../../shared/protocol'
import { JUNQI_NAMES, isJunqiCamp, junqiCombat, junqiRoadEdge } from '../../shared/junqi'
import { junqiMovePath } from '../../shared/junqiMovePath'
import type { TeachingAction, TeachingClip, TeachingFrame } from '../../shared/tutorialProtocol'
import type { RoomGame } from '../games/types'
import { JunqiGame } from '../games/junqi'
import { DoudizhuGame } from '../games/doudizhu'
import { GuandanGame } from '../games/guandan'
import { clone, execute, snapshot, type LessonText, type ScriptStep, type TeachingCourse, type TeachingMatch } from './model'
import { fullBoard } from './junqi'
import { context, fixedDeck, select } from './decks'
import { lessonCopy } from './copy'

const kinds: Record<string, string> = { single: '单张', pair: '对子', triple: '三张', triple_single: '三带一', triple_pair: '三带二', straight: '顺子', pairs_run: '连对', triples_run: '飞机', airplane_single: '飞机带单', airplane_pair: '飞机带对', four_two_single: '四带二单', four_two_pair: '四带二对', triplePair: '三带二', bomb: '炸弹', rocket: '火箭', threePairs: '三连对', twoTriples: '二连三张', straightFlush: '同花顺', fourJokers: '四大天王' }
export const rankLabel = (rank: number) => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' })[rank] ?? String(rank)
interface Window { match: TeachingMatch; start: number; end: number; lesson: LessonText }
const view = (engine: RoomGame, match: TeachingMatch) => snapshot(engine, match.player, `tutorial:${match.id}`)
const seat = (n: number) => `${n + 1} 号位`
function chapter(game: GameKind, lesson: LessonText, action: ScriptStep['action']): string {
  if (game === 'xiangqi') return lesson.tags.some(tag => ['board', 'turn-order'].includes(tag)) ? '开局与轮流' : lesson.tags.some(tag => ['check', 'evade-block', 'evade-capture'].includes(tag)) ? '将军与解围' : lesson.tags.some(tag => ['checkmate','stalemate','resign','draw-agreement','threefold','perpetual-check','quiet-120'].includes(tag)) ? '胜负与和棋' : '每种棋怎么走'
  if (lesson.tags.includes('dark-view')) return '暗棋与路线'
  if (game === 'junqi') return lesson.tags.some(tag => ['four-dark', 'printed-curve', 'army-elimination', 'team-elimination', 'four-result'].includes(tag)) ? '四国军棋' : lesson.tags.some(tag => ['draw-70', 'no-legal-move', 'resign', 'end-result', 'flag-capture', 'no-moves-result'].includes(tag)) ? '胜负与终局' : lesson.tags.some(tag => ['rank-combat', 'smaller-loses', 'equal-ranks', 'engineer-mine', 'ordinary-mine', 'bomb-mine', 'bomb'].includes(tag)) ? '交战与特殊棋子' : '暗棋与路线'
  if (action.type === 'continue') return game === 'guandan' ? '名次、升级与过 A' : '胜负、倍数与计分'
  if (game === 'doudizhu') return action.type === 'bid' ? '身份、叫分与底牌' : action.type === 'pass' ? '轮转与不出' : '牌型与比较'
  return ['tribute', 'returnTribute'].includes(action.type) || lesson.tags.includes('resist') ? '进贡、还贡与抗贡' : lesson.tags.some(tag => tag.startsWith('wild') || tag === 'multiple-claims') ? '级牌与逢人配' : lesson.tags.includes('wind') ? '搭档、名次与接风' : '牌型与比较'
}
function frameCaption(action: ScriptStep['action'], after: Snapshot): string {
  if (after.game === 'xiangqi') {
    if (action.type === 'start') return '红黑各 16 枚棋，放在交叉点上；红方先走。'
    if (action.type === 'xiangqiResign') return `${xiangqiSideName(action.seat)}认输，对方获胜。`
    if (action.type === 'xiangqiDraw') return after.phase === 'finished' ? '另一方同意和棋，本局不分胜负。' : `${xiangqiSideName(action.seat)}提出和棋，等待对方同意。`
    const last = after.xiangqi.moves.at(-1)
    return `${xiangqiSideName(action.seat)}${last?.captured ? '吃掉目标棋子' : '走完这一步'}${after.phase === 'finished' ? `，${after.xiangqi.reason}` : after.xiangqi.check !== null ? '，将军！对方必须先解围。' : '，轮到另一方。'}`
  }
  if (action.type === 'junqiMove') {
    if (after.game !== 'junqi') return ''
    const move = after.junqi.moves.at(-1)!
    return `${['红方', '蓝方', '绿方', '紫方'][action.seat]}${move.outcome === 'move' ? '沿路线移动' : move.outcome === 'both' ? '交战：双方移除' : move.outcome === 'attacker' ? '进攻获胜，占据目标位置' : '进攻方损失，防守方留在原位'}`
  }
  if (action.type === 'junqiResign') return `${['红方', '蓝方', '绿方', '紫方'][action.seat]}认输${after.game === 'junqi' && after.junqi.variant === 'four' ? '，清除该军棋子并跳过回合' : '，本局结束'}`
  if (action.type === 'bid') return `${seat(action.seat)}${Number(action.payload.value) ? `叫 ${action.payload.value} 分` : '不叫'}${after.phase === 'playing' ? '，地主确定，收取三张底牌' : ''}`
  if (action.type === 'pass') return after.lastPlay ? `${seat(action.seat)}不出，轮到下一家` : '本轮其余玩家不出，重新获得领出权'
  if (action.type === 'tribute' || action.type === 'returnTribute') return `${seat(action.seat)}提交${action.type === 'tribute' ? '贡牌' : '还贡'}${after.game === 'guandan' && after.guandan.exchange.stage === (action.type === 'tribute' ? 'tribute' : 'return') ? '，等待其他人，暂不公开' : '，全部提交后同时公开'} `
  if (action.type === 'start') return after.game === 'guandan' && after.guandan.exchange.stage === 'resisted' ? '持有两个大王，系统判定抗贡，免去交换' : '按规则发牌，进入新的一副'
  if (action.type === 'play') return `${seat(action.seat)}打出${after.lastPlay?.claim?.label ?? kinds[after.lastPlay?.kind ?? ''] ?? after.lastPlay?.kind ?? '这一手'}${after.phase === 'finished' ? '，触发本副结算' : ''}`
  return after.message
}
function engineFrame(engine: RoomGame, match: TeachingMatch, step: ScriptStep): TeachingFrame {
  const action = step.action
  const previous = engine.view(match.player)
  const ids = Array.isArray(action.payload.cards) ? action.payload.cards as string[] : typeof action.payload.cardId === 'string' ? [action.payload.cardId] : []
  let cards = engine.handOf(action.seat).filter(card => ids.includes(card.id)).map(card => ({ ...card }))
  const board = engine instanceof JunqiGame && action.type === 'junqiMove' ? fullBoard(engine) : null
  const from = Number(action.payload.from), to = Number(action.payload.to)
  const path = board ? junqiMovePath(board, from, to, (engine as JunqiGame).view(0).junqi.variant) : previous.game === 'xiangqi' && action.type === 'xiangqiMove' ? xiangqiMotionPath(previous.xiangqi.board[from]!, from, to) : undefined
  const attacker = board?.[from]?.rank, defender = board?.[to]?.rank
  const combat = attacker && defender ? { attacker, defender, outcome: junqiCombat(attacker, defender) } : undefined
  execute(engine, action)
  const after = view(engine, match)
  const redeal = action.type === 'bid' && previous.game === 'doudizhu' && after.game === 'doudizhu' && previous.bid === 0 && action.seat === 2 && after.phase === 'bidding' && after.turn === 0
  if (action.type === 'start' && after.game === 'guandan' && after.guandan.exchange.stage === 'resisted') cards = after.guandan.exchange.givers.flatMap(giver => engine.handOf(giver).filter(card => card.rank === 17))
  return { snapshot: after, ...(action.type === 'start' || action.type === 'restart' || action.type === 'junqiSetup' ? {} : { action: clone(action) as TeachingAction }),
    ...(action.type === 'start' || redeal ? { kind: 'deal' as const } : {}), cards, ...(path ? { path } : {}), ...(combat ? { combat } : {}),
    caption: redeal ? '全部不叫，重新发牌，再从第一位开始叫分' : frameCaption(action, after), duration: action.type === 'pass' ? 1300 : action.type === 'junqiMove' || action.type === 'xiangqiMove' ? 2300 : 2000,
    focus: { points: [...path ?? [], ...(after.game === 'xiangqi' ? after.xiangqi.board.flatMap((p, i) => p?.rank === 'general' && (action.type === 'start' || p.side === after.xiangqi.check) ? [i] : []) : [])], overview: action.type === 'junqiResign' || after.game === 'xiangqi' && (action.type === 'start' || after.phase === 'finished') } }
}
function range(match: TeachingMatch, index: number): Window {
  const step = match.steps[index]!, action = step.action, lesson = step.lesson!
  if (lesson.span) return { match, start: index, end: Math.min(match.steps.length - 1, index + lesson.span - 1), lesson }
  let start = index, end = index
  if (action.type === 'continue') {
    start = index - 1
    while (start > 0 && ['continue', 'restart', 'start', 'junqiSetup'].includes(match.steps[start]!.action.type)) start--
    end = start
  } else if (action.type === 'tribute' || action.type === 'returnTribute') {
    while (start > 0 && match.steps[start - 1]!.action.type === action.type) start--
    while (end + 1 < match.steps.length && ['tribute', 'returnTribute'].includes(match.steps[end + 1]!.action.type)) end++
  } else if (lesson.tags.includes('resist')) {
    while (start > 0 && match.steps[start]!.action.type !== 'start') start--
  } else {
    const follow = action.type !== 'junqiMove' || lesson.tags.includes('four-turn-order') || lesson.tags.includes('draw-70')
    for (let c = index + 1; follow && c < Math.min(index + 5, match.steps.length); c++) {
      const next = match.steps[c]!
      if (next.lesson || next.action.seat === match.player || ['start', 'restart', 'continue', 'junqiSetup'].includes(next.action.type)) break
      if (action.type === 'bid' && next.action.type !== 'bid') break
      end = c
    }
    if (lesson.tags.includes('army-elimination')) while (start > 0 && ['junqiResign', 'junqiMove'].includes(match.steps[start - 1]!.action.type) && !match.steps[start - 1]!.lesson) start--
  }
  return { match, start, end, lesson }
}
function replayTo(match: TeachingMatch, index: number): RoomGame {
  const engine = match.create()
  for (const step of match.steps.slice(0, index)) execute(engine, step.action)
  return engine
}
function rejected(engine: RoomGame, match: TeachingMatch, id: string, title: string, explanation: string, action: TeachingAction, tags: string[], path?: number[]): TeachingClip {
  const before = view(engine, match)
  const ids = Array.isArray(action.payload.cards) ? action.payload.cards as string[] : []
  const cards = engine.handOf(action.seat).filter(card => ids.includes(card.id)).map(card => ({ ...card }))
  if (action.type === 'continue') throw new Error('不是引擎操作')
  const response = engine.command(action.seat, action.type, action.payload)
  if (response.ok) throw new Error(`${id}: 拒绝演示居然合法`)
  if (JSON.stringify(view(engine, match)) !== JSON.stringify(before)) throw new Error(`${id}: 失败操作改变局面`)
  return { id, title, chapter: before.game === 'junqi' ? '不可走的情况' : '牌型限制', tags, explanation,
    snapshot: before, frames: [{ snapshot: clone(before), action, cards, caption: explanation, duration: 3000, rejected: response.message,
      ...(path ? { path } : {}), focus: { points: path ?? [], overview: false } },
    { snapshot: clone(before), cards: [], caption: '操作未执行，局面保持不变', kind: 'result', duration: 1400 }] }
}
function restrictions(course: TeachingCourse): TeachingClip[] {
  const result: TeachingClip[] = []
  const find = (id: string) => { const match = course.matches.find(match => match.steps.some(step => step.lesson?.id === id))!; return { match, index: match.steps.findIndex(step => step.lesson?.id === id) } }
  if (course.game === 'xiangqi') return xiangqiRestrictions()
  if (course.game === 'junqi') {
    const base = find('jq-dark-rank'), engine = replayTo(base.match, base.index)
    result.push(rejected(engine, base.match, 'jq-blocked-attempt', '铁路不能越过任何棋子', '前方棋子挡住铁路，不能跳过它攻击更远的棋子。', { type: 'junqiMove', seat: 0, payload: { from: 30, to: 15 } }, ['blocked-attempt'], [30, 25, 20, 15]))
    const hq = find('jq-immobile')
    for (const [id, title, from, to] of [['jq-hq-attempt', '进入大本营后不能再动', 56, 51], ['jq-flag-attempt', '军旗不能移动', 58, 57]] as const) {
      result.push(rejected(replayTo(hq.match, hq.index), hq.match, id, title, title === '军旗不能移动' ? '军旗固定在大本营，不能主动行棋。' : '大本营中的棋子不能再走出来，但仍可能遭到攻击。', { type: 'junqiMove', seat: 0, payload: { from, to } }, ['immobile-attempt'], [from, to]))
    }
    const mineEngine = replayTo(hq.match, hq.index), mine = fullBoard(mineEngine as JunqiGame).findIndex(piece => piece?.side === 0 && piece.rank === 'mine')
    result.push(rejected(mineEngine, hq.match, 'jq-mine-attempt', '地雷不能移动', '地雷只能留在原位防守，不能主动移动或攻击。', { type: 'junqiMove', seat: 0, payload: { from: mine, to: mine - 5 } }, ['mine-immobile-attempt'], [mine, mine - 5]))
    const camp = find('jq-camp-entry'), campEngine = replayTo(camp.match, camp.index + 1), board = fullBoard(campEngine as JunqiGame)
    const attacker = board.findIndex((piece, p) => piece?.side === 1 && piece.rank !== 'mine' && piece.rank !== 'flag' && ![1, 3].includes(p) && junqiRoadEdge(p, 6))
    if (attacker < 0 || !isJunqiCamp(6)) throw new Error('缺少行营保护演示攻击方')
    result.push(rejected(campEngine, camp.match, 'jq-camp-attempt', '行营中的棋子不能被攻击', '对方进入行营后受到保护，连炸弹也不能攻击它。', { type: 'junqiMove', seat: 1, payload: { from: attacker, to: 6 } }, ['camp-protection-attempt'], [attacker, 6]))
  } else if (course.game === 'doudizhu') {
    const pair = find('ddz-pair'), pairEngine = replayTo(pair.match, pair.index)
    const card = select(pairEngine.handOf(0), [6])[0]!
    result.push(rejected(pairEngine, pair.match, 'ddz-type-attempt', '单张不能接对子', '接牌需要同牌型；一张 6 不能压住一对 5。炸弹和火箭另有优先规则。', { type: 'play', seat: 0, payload: { cards: [card.id] } }, ['same-type-attempt']))
    const straight = find('ddz-straight'), straightEngine = replayTo(straight.match, straight.index)
    result.push(rejected(straightEngine, straight.match, 'ddz-short-attempt', '四张连续牌还不是顺子', '斗地主顺子至少五张，且不能包含 2 或王。', { type: 'play', seat: 0, payload: { cards: select(straightEngine.handOf(0), [3, 4, 5, 6]).map(card => card.id) } }, ['run-limit-attempt']))
    const create = () => new DoudizhuGame(context([fixedDeck('doudizhu', [[4, 5, 6, 7, 8, 9], [3, 4, 5, 6, 7], [], []])], 1))
    const match: TeachingMatch = { id: 'ddz-length-attempt', title: '', player: 0, create, steps: [] }, engine = create()
    engine.start(); execute(engine, { type: 'bid', seat: 0, payload: { value: 0 } }); execute(engine, { type: 'bid', seat: 1, payload: { value: 3 } }); execute(engine, { type: 'play', seat: 1, payload: { cards: select(engine.handOf(1), [3, 4, 5, 6, 7]).map(card => card.id) } }); execute(engine, { type: 'pass', seat: 2, payload: {} })
    result.push(rejected(engine, match, 'ddz-length-attempt', '接顺子时长度必须相同', '六张顺子不能接五张顺子，即使最高点更大；需要同为五张再比较最高点。', { type: 'play', seat: 0, payload: { cards: select(engine.handOf(0), [4, 5, 6, 7, 8, 9]).map(card => card.id) } }, ['same-length-attempt']))
    const attachment = find('ddz-three-two'), attachEngine = replayTo(attachment.match, attachment.index)
    const singles = [...attachEngine.handOf(0)].filter(card => card.rank !== 8)
    const a = singles[0]!, b = singles.find(card => card.rank !== a.rank)!
    result.push(rejected(attachEngine, attachment.match, 'ddz-attachment-attempt', '三带二需要一个对子作附件', '三个 8 加两张不同点数的单牌，不是合法的三带二。', { type: 'play', seat: 0, payload: { cards: [...select(attachEngine.handOf(0), [8, 8, 8]), a, b].map(card => card.id) } }, ['attachment-attempt']))
  } else {
    const straight = find('gd-core-0-combo-4'), engine = replayTo(straight.match, straight.index)
    const cards = (straight.match.steps[straight.index]!.action.payload.cards as string[]).slice(0, 4)
    result.push(rejected(engine, straight.match, 'gd-length-attempt', '掼蛋顺子固定为五张', '四张连续牌不是顺子；掼蛋顺子固定五张，不能照搬斗地主的可变长度。', { type: 'play', seat: 0, payload: { cards } }, ['fixed-length-attempt']))
    const create = () => new GuandanGame(context([fixedDeck('guandan', [[13, 14, 15, 3, 4], [], [], []])], 0))
    const match: TeachingMatch = { id: 'gd-wrap-attempt', title: '', player: 0, create, steps: [] }, wrap = create(); wrap.start()
    result.push(rejected(wrap, match, 'gd-wrap-attempt', '顺子不能跨越 K—A—2', 'A 可以在 A2345 的低端，也可在 10JQKA 的高端；KA234 不能首尾相连。', { type: 'play', seat: 0, payload: { cards: select(wrap.handOf(0), [13, 14, 15, 3, 4]).map(card => card.id) } }, ['no-wrap-attempt']))
  }
  return result
}

export function buildClips(course: TeachingCourse): TeachingClip[] {
  if (course.game === 'chess') return buildChessClips(course)
  const seen = new Set<string>(), clips: TeachingClip[] = []
  for (const match of course.matches) {
    const windows = match.steps.flatMap((step, index) => {
      if (!step.lesson || step.lesson.tags.every(tag => seen.has(tag))) return []
      step.lesson.tags.forEach(tag => seen.add(tag)); return [range(match, index)]
    })
    const engine = match.create(), active = new Map<Window, TeachingClip>()
    for (let i = 0; i < match.steps.length; i++) {
      for (const window of windows.filter(window => window.start === i)) {
        const wording = lessonCopy(window.lesson)
        const clip: TeachingClip = { id: window.lesson.id, title: wording.title, chapter: chapter(course.game, window.lesson, match.steps.find(step => step.lesson === window.lesson)!.action), tags: [...window.lesson.tags], explanation: wording.explanation, snapshot: view(engine, match), frames: [] }
        active.set(window, clip); clips.push(clip)
      }
      const frame = active.size ? engineFrame(engine, match, match.steps[i]!) : (execute(engine, match.steps[i]!.action), null)
      for (const [window, clip] of active) {
        if (frame) clip.frames.push(frame)
        if (window.end === i) {
          const end = clip.frames.at(-1)!.snapshot
          const initialFlags = clip.snapshot.game === 'junqi' ? clip.snapshot.junqi.revealedFlags : []
          clip.frames.push({ snapshot: clone(end), cards: [], kind: 'result', caption: clip.explanation.length > 95 ? clip.title : clip.explanation, duration: 1600,
            focus: { points: [], overview: end.game === 'xiangqi' && end.phase === 'finished' || end.game === 'junqi' && (end.phase === 'finished' || window.lesson.tags.includes('army-elimination') || end.junqi.revealedFlags.some((flag, side) => flag && !initialFlags[side])) } })
          active.delete(window)
        }
      }
    }
  }
  clips.push(...restrictions(course))
  const orders = course.game === 'xiangqi' ? ['开局与轮流','每种棋怎么走','不能这样走','将军与解围','胜负与和棋'] : course.game === 'junqi' ? ['暗棋与路线', '交战与特殊棋子', '不可走的情况', '胜负与终局', '四国军棋'] : course.game === 'doudizhu' ? ['身份、叫分与底牌', '牌型与比较', '牌型限制', '轮转与不出', '胜负、倍数与计分'] : ['牌型与比较', '级牌与逢人配', '牌型限制', '搭档、名次与接风', '进贡、还贡与抗贡', '名次、升级与过 A']
  const opening = ['ddz-bidding', 'ddz-bid-one', 'ddz-bid-max', 'ddz-all-pass']
  return clips.sort((a, b) => orders.indexOf(a.chapter) - orders.indexOf(b.chapter) || (a.chapter === '身份、叫分与底牌' ? opening.indexOf(a.id) - opening.indexOf(b.id) : 0))
}
