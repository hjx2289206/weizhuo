import { ReversiGame, type ReversiSetup } from '../games/reversi'
import { initialReversiBoard, reversiSideName, type ReversiBoard, type ReversiSide } from '../../shared/reversi'
import type { TeachingAction, TeachingClip, TeachingFrame } from '../../shared/tutorialProtocol'
import { snapshot } from './model'

interface Step { side: ReversiSide; point: number; caption: string; rejected?: boolean }
interface Lesson { id: string; chapter: string; title: string; explanation: string; setup?: ReversiSetup; focus?: number[]; steps: Step[] }

function diagram(black: number[], white: number[]): ReversiBoard {
  const board: ReversiBoard = Array(64).fill(null)
  for (const point of black) board[point] = 0
  for (const point of white) board[point] = 1
  return board
}

function finalSquare(black: number): ReversiSetup {
  return { turn: 0, board: Array.from({ length: 64 }, (_, point) => point === 0 ? null : point >= 2 && point < black + 2 ? 0 : 1) }
}

function lessons(): Lesson[] {
  const pass: ReversiBoard = Array(64).fill(1)
  pass[0] = pass[56] = null
  pass[1] = pass[57] = 0
  const corner = initialReversiBoard()
  corner[1] = 1
  corner[2] = 0
  return [
    { id: 'opening', chapter: '开局与落子', title: '中央四子交叉摆放，黑方先行',
      explanation: '棋盘有八行八列。黑白各两枚，放在中央四格，同色位于对角。点亮的小圆点是当前一方的合法落点。',
      steps: [{ side: 0, point: 19, caption: '黑方先下 D3，夹住 D4 的白子。' }, { side: 1, point: 18, caption: '白方应在 C3，沿斜线翻回 D4。' }] },
    { id: 'legal', chapter: '开局与落子', title: '空格能夹住对手棋子才可落子',
      explanation: '落子和已有的己方棋子必须把一串连续对手棋子夹在同一直线上。途中遇到空格，或最外端没有己方棋子，那条线不能翻子。',
      steps: [{ side: 0, point: 0, caption: 'A1 是空格，但这手夹不到白子。', rejected: true },
        { side: 0, point: 26, caption: 'C4 能与 E4 的黑子夹住 D4，落子成立。' }] },
    { id: 'flip', chapter: '开局与落子', title: '夹住的整串棋子一起翻面',
      explanation: '每个棋子有黑白两面。一手夹住一列对方棋子时，所有被夹住的棋子都翻为落子方的颜色。',
      setup: { board: diagram([28, 43], [25, 26, 27, 44]), turn: 0 }, focus: [25, 26, 27],
      steps: [{ side: 0, point: 24, caption: '黑方下 A4，把 B4、C4、D4 三枚白棋翻成黑棋。' }] },
    { id: 'directions', chapter: '翻子与停一手', title: '一手可以同时翻多个方向',
      explanation: '横、竖和斜线的八个方向各自检查。只要两端形成包夹，中间的对手棋子就一起翻面。',
      setup: { board: diagram([25, 29, 11, 43, 9, 45], [26, 28, 19, 35, 18, 36]), turn: 0 },
      steps: [{ side: 0, point: 27, caption: 'D4 同时夹住六个方向的白子。' }] },
    { id: 'pass', chapter: '翻子与停一手', title: '没有合法落点，自动停一手',
      explanation: '一方没有合法落点而对方仍能下时，系统自动把该方的停一手写入棋谱，由对方继续落子。',
      setup: { board: pass, turn: 1 },
      steps: [{ side: 1, point: 0, caption: '白方下 A1 后，黑方无处可下，停一手。' },
        { side: 1, point: 56, caption: '仍轮到白方。白方在 A8 落下最后一子。' }] },
    { id: 'corner', chapter: '抓住优势', title: '能占角时，先看看四角',
      explanation: '角上的棋子位于两条边的端点，落定后不会再被夹翻。同色连续边子可以借助已有的角变得稳定。',
      setup: { board: corner, turn: 0 }, focus: [0, 1, 2],
      steps: [{ side: 0, point: 0, caption: '黑方合法占住 A1。以后这枚角子不会翻面。' }] },
    { id: 'count', chapter: '终局数子', title: '双方都走不了，比较最终子数',
      explanation: '棋盘下满，或双方都找不到合法落点，本局结束。只数盘面上当前颜色的棋子，子多者获胜。',
      setup: finalSquare(32),
      steps: [{ side: 0, point: 0, caption: '最后一手翻一子。黑 34 子，白 30 子，黑方获胜。' }] },
    { id: 'draw', chapter: '终局数子', title: '双方子数相同，判为和棋',
      explanation: '以前领先的子数可能因最后几手翻面而改变。只有终局盘面用来判胜负，双方一样多就是和棋。',
      setup: finalSquare(30),
      steps: [{ side: 0, point: 0, caption: '最后一手结束后，双方各 32 子，和棋。' }] },
  ]
}

export function buildReversiClips(): TeachingClip[] {
  return lessons().map(lesson => {
    const id = 'reversi-' + lesson.id
    const game = new ReversiGame(lesson.setup)
    game.start()
    const view = () => snapshot(game, 0, 'tutorial:' + id)
    const initial = view()
    const frames: TeachingFrame[] = lesson.steps.map(step => {
      const action: TeachingAction = { type: 'reversiMove', seat: step.side, payload: { point: step.point } }
      const result = game.command(step.side, 'reversiMove', action.payload)
      if (result.ok === Boolean(step.rejected)) throw new Error(id + (result.ok ? '：本应拒绝落子' : '：' + result.message))
      return {
        snapshot: view(), action, cards: [], caption: step.caption, duration: 2900,
        focus: { points: lesson.focus ?? [step.point], overview: false }, ...(result.ok ? {} : { rejected: result.message }),
      }
    })
    const end = game.view()
    const { counts, draw, winner } = end.reversi
    const caption = end.phase === 'finished' ? '黑 ' + counts[0] + ' 子，白 ' + counts[1] + ' 子，' + (draw ? '和棋' : reversiSideName(winner!) + '获胜') + '。'
      : frames.at(-1)!.caption
    frames.push({ snapshot: view(), cards: [], kind: 'result', caption, duration: 3600 })
    return { id, chapter: lesson.chapter, title: lesson.title, explanation: lesson.explanation, tags: [lesson.id], snapshot: initial, frames }
  })
}
