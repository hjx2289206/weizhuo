import { ChessGame } from '../games/chess'
import { chessIndex, chessSideName, CHESS_PROMOTIONS, CHESS_NAMES } from '../../shared/chess'
import type { TeachingAction, TeachingClip, TeachingFrame } from '../../shared/tutorialProtocol'
import { Author, clone, execute, snapshot, type LessonText, type TeachingCourse, type TeachingMatch } from './model'

type Step = [number, string, string, string?]
const base = '7k/7p/8/8/8/8/8/K7 w - - 0 1'
function position(pieces: Record<string, string>, turn = 'w', rights = '-', quiet = 0): string {
  const cells = Array<string | null>(64).fill(null)
  Object.entries(pieces).forEach(([square, piece]) => { cells[chessIndex(square)] = piece })
  const rows = Array.from({ length: 8 }, (_, row) => { let text = '', empty = 0; for (const p of cells.slice(row * 8, row * 8 + 8)) { if (!p) empty++; else { if (empty) text += empty; empty = 0; text += p } } return text + (empty || '') })
  return `${rows.join('/')} ${turn} ${rights} - ${quiet} 1`
}
const setup = (pieces: Record<string, string>, turn = 'w') => position({ a1: 'K', h8: 'k', h7: 'p', ...pieces }, turn)
const action = ([seat, from, to, promotion]: Step): TeachingAction => ({ type: 'chessMove', seat, payload: { from: chessIndex(from), to: chessIndex(to), ...(promotion ? { promotion } : {}) } })
function match(id: string, title: string, explanation: string, tags: string[], fen: string | undefined, moves: Step[], opening = false): TeachingMatch {
  const create = () => new ChessGame(fen), author = new Author(create)
  const lesson: LessonText = { id: `chess-${id}`, title, instruction: explanation, explanation, tags, span: opening ? 1 : moves.length }
  author.add({ type: 'start', seat: 0, payload: {} }, opening ? lesson : undefined)
  moves.forEach((move, index) => author.add(action(move), !opening && index === 0 ? lesson : undefined))
  return { id: `chess-${id}`, title, player: 0, create, steps: author.steps }
}
export function chessCourse(): TeachingCourse {
  const matches: TeachingMatch[] = [
    match('board', '先认棋盘：棋子放在方格里', '棋盘是 8×8 的黑白方格，右下角是浅色格。双方各 16 子，后站在与自己同色的格上，白方先行。', ['board', 'white-first'], undefined, [], true),
    match('turns', '白方一步，黑方一步', '白方先走，然后双方轮流一步。这里白兵先走两格，黑兵也走两格；不能连走两次。', ['turn-order'], undefined, [[0, 'e2', 'e4'], [1, 'e7', 'e5']]),
    match('rook', '车：沿横线或竖线走', '车横、竖走任意格，中间不能有棋子，也不能斜走。', ['rook'], setup({ d4: 'R' }), [[0, 'd4', 'd7']]),
    match('bishop', '象：沿斜线走', '象沿斜线走任意格，不能越子。每只象始终留在同一种颜色的格上，没有河界限制。', ['bishop'], setup({ d3: 'B' }), [[0, 'd3', 'f5']]),
    match('queen', '后：横、竖、斜都能走', '后结合车和象的走法，可沿横线、竖线或斜线走任意格，中间不能越子。', ['queen'], setup({ d3: 'Q' }), [[0, 'd3', 'f5']]),
    match('knight', '马：走日字，可以跳子', '马横两格竖一格，或竖两格横一格。国际象棋的马可以跳过棋子，没有蹩马腿。', ['knight', 'knight-jump'], setup({ d4: 'N', d5: 'P', e4: 'P' }), [[0, 'd4', 'e6']]),
    match('king', '王：向任意方向走一格', '王横、竖、斜都只能走一格。落点不能受敌子攻击；两王也不能靠在相邻格。', ['king'], base, [[0, 'a1', 'b2']]),
    match('pawn-one', '兵：向前一格，不能后退', '白兵向黑方走，黑兵向白方走。兵平时向前一格，不能横移或后退。', ['pawn-one'], setup({ e2: 'P' }), [[0, 'e2', 'e3']]),
    match('pawn-two', '兵：第一次可以前进两格', '兵还在自己的起始格时，可选走一格或两格；经过和到达的格都必须为空。', ['pawn-two'], undefined, [[0, 'e2', 'e4']]),
    match('black-pawn', '黑兵向相反方向前进', '黑兵向白方前进；在手机黑方视角里，自己的兵同样朝画面上方走。同屏时黑方棋子朝向坐在上方的玩家。', ['black-pawn'], setup({ e7: 'p' }, 'b'), [[1, 'e7', 'e5']]),
    match('capture', '吃子：占据敌子的方格', '白车沿直线走到黑马的位置，黑马移走，白车留下。除兵外，其他棋子的吃子与移动走法相同。', ['capture'], setup({ d4: 'R', d7: 'n' }), [[0, 'd4', 'd7']]),
    match('pawn-capture', '兵：斜前一格吃子', '兵直着走，斜着吃。这里白兵向斜前一格吃掉黑马，不能直着吃正前方的敌子。', ['pawn-capture'], setup({ e4: 'P', d5: 'n' }), [[0, 'e4', 'd5']]),
    match('castle-short', '短易位：王和车一起移动', '王与这只车从未移动，二者间无子，王未被将军，经过和到达的格也没受攻击时，可点王再点横移两格的落点。车自动移到王旁。', ['castle-short'], 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', [[0, 'e1', 'g1']]),
    match('castle-long', '长易位：往另一侧也可以', '长易位时王仍只横移两格，车越过王停在旁边。王和车之间的所有格必须为空；只要求王经过与到达的格不受攻击。', ['castle-long'], 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', [[0, 'e1', 'c1']]),
    match('en-passant', '吃过路兵：只限紧接着的一手', '黑兵刚前进两格，停在白兵旁边。白兵可立即斜走到它经过的空格，并移走黑兵。只有紧接着这一手可以，错过就失效。', ['en-passant'], setup({ d5: 'P', e7: 'p' }, 'b'), [[1, 'e7', 'e5'], [0, 'd5', 'e6']]),
    ...CHESS_PROMOTIONS.map(rank => match(`promotion-${rank}`, `兵到底线，升变为${CHESS_NAMES[rank]}`, `兵走到对方底线，必须选择后、车、象或马，不受已被吃棋子的数量限制。这次选择${CHESS_NAMES[rank]}，移动完成后立即换成新棋子。`, [`promotion-${rank}`, 'promotion'], setup({ a7: 'P' }), [[0, 'a7', 'a8', rank]])),
    match('check-evade', '将军后，先把王移到安全格', '白车来到 h2，攻击同一列的黑王。黑方必须马上解围；这里把王移到 g8，离开攻击线。', ['check', 'evade-king'], position({ a1: 'K', h8: 'k', a2: 'R', g7: 'p' }), [[0, 'a2', 'h2'], [1, 'h8', 'g8']]),
    match('check-block', '也可以挡住攻击线', '白车沿 e 线将军，黑象走到王和车之间，挡住直线，黑王就安全了。', ['evade-block'], position({ a1: 'K', e8: 'k', d1: 'R', d7: 'b' }), [[0, 'd1', 'e1'], [1, 'd7', 'e6']]),
    match('check-capture', '还可以吃掉将军的棋子', '白车将军后，黑象吃掉白车，解除攻击。任何解围方法都必须真的让王安全。', ['evade-capture'], position({ a1: 'K', e8: 'k', d1: 'R', d2: 'b' }), [[0, 'd1', 'e1'], [1, 'd2', 'e1']]),
    match('mate', '将死：王被将军，又无路可解', '白后移动到 g7，受到白王保护。黑王被将军，既不能吃后，也没有安全落点；黑方被将死，白方获胜。', ['checkmate'], position({ f6: 'K', h8: 'k', g6: 'Q' }), [[0, 'g6', 'g7']]),
    match('stalemate', '逼和：没被将军，却无棋可走', '黑王没有被将军，但所有落点都不安全，而且没有其他棋可走。国际象棋的逼和算和棋。', ['stalemate'], position({ f7: 'K', h8: 'k', g5: 'Q' }), [[0, 'g5', 'g6']]),
    match('material', '子力不足，也会和棋', '白王吃掉最后一枚黑兵，只剩双王，双方都不可能将死对手，系统判和棋。', ['insufficient-material'], position({ a1: 'K', h8: 'k', b2: 'p' }), [[0, 'a1', 'b2']]),
    match('repetition', '同一局面三次，本房间自动和棋', '双方的马往返，棋子位置、行棋方及相关权利相同的局面第三次出现。本房间按休闲约定自动和棋，无需申请。', ['threefold'], undefined, [[0,'g1','f3'],[1,'g8','f6'],[0,'f3','g1'],[1,'f6','g8'],[0,'g1','f3'],[1,'g8','f6'],[0,'f3','g1'],[1,'f6','g8']]),
    match('fifty', '50 回合无吃子、无兵移动，自动和棋', '每方各走一步算一个回合。连续 50 回合，也就是 100 手，既没吃子也没动兵，本房间自动和棋。此处从计数 99 的固定教学局面演示最后一手。', ['fifty-moves'], position({ a1: 'K', h8: 'k', d4: 'R' }, 'w', '-', 99), [[0,'d4','d5']]),
  ]
  for (const [id, title, explanation, actions] of [
    ['agreement', '双方同意，就可以和棋', '白方提议，黑方同意，本局不分胜负。手机只能替自己答复；平板同屏由双方一起确认。', [{ type: 'chessDraw', seat: 0, payload: { action: 'offer' } }, { type: 'chessDraw', seat: 1, payload: { action: 'accept' } }]],
    ['resign', '认输后，对方获胜', '一方确认认输，本局立即结束。平板同屏请看清白方或黑方；手机联机只能替自己认输。', [{ type: 'chessResign', seat: 1, payload: {} }]],
  ] as const) {
    const create = () => new ChessGame(), author = new Author(create); author.start()
    actions.forEach((a, i) => author.add(a, i === 0 ? { id: `chess-${id}`, title, instruction: explanation, explanation, tags: [id], span: actions.length } : undefined))
    matches.push({ id: `chess-${id}`, title, player: 0, create, steps: author.steps })
  }
  return { game: 'chess', matches }
}

/** Each frame is the actual engine result of a server-authored command. */
export function buildChessClips(course: TeachingCourse): TeachingClip[] {
  const clips: TeachingClip[] = []
  for (const match of course.matches) {
    const engine = match.create()
    for (let i = 0; i < match.steps.length; i++) {
      const step = match.steps[i]!
      if (!step.lesson) { execute(engine, step.action); continue }
      const lesson = step.lesson, initial = snapshot(engine, 0, match.id), frames: TeachingFrame[] = []
      for (let n = 0; n < (lesson.span ?? 1); n++) {
        const a = match.steps[i + n]!.action
        execute(engine, a)
        const after = snapshot(engine, 0, match.id)
        const caption = a.type === 'start' ? lesson.explanation : after.game === 'chess' && after.phase === 'finished' ? after.chess.reason : a.type === 'chessMove' ? `${chessSideName(a.seat)}走完这一步，${after.game === 'chess' && after.chess.check !== null ? '将军，必须先解围。' : '轮到另一方。'}` : lesson.explanation
        frames.push({ snapshot: after, ...(a.type === 'start' ? {} : { action: clone(a) as TeachingAction }), cards: [], caption, duration: a.type === 'chessMove' ? 2500 : 2000 })
      }
      frames.push({ snapshot: clone(frames.at(-1)!.snapshot), cards: [], caption: lesson.explanation, kind: 'result', duration: 1800 })
      const chapter = lesson.tags.some(t => ['board', 'turn-order'].includes(t)) ? '开局与轮流' : lesson.tags.some(t => t.startsWith('castle') || t.startsWith('promotion') || t === 'en-passant') ? '特殊走法' : lesson.tags.some(t => ['check', 'evade-block', 'evade-capture'].includes(t)) ? '将军与解围' : lesson.tags.some(t => ['checkmate','stalemate','insufficient-material','threefold','fifty-moves','agreement','resign'].includes(t)) ? '胜负与和棋' : '每种棋怎么走'
      clips.push({ id: lesson.id, title: lesson.title, explanation: lesson.explanation, chapter, tags: [...lesson.tags], snapshot: initial, frames })
      i += (lesson.span ?? 1) - 1
    }
  }
  for (const [id, title, explanation, fen, attempt] of [
    ['rook-blocked', '车不能跳过挡子', '车的直线上有自己的兵挡路，不能越过它。', setup({d4:'R',d5:'P'}), [0,'d4','d7']],
    ['bishop-blocked', '象不能越子', '斜线上有棋子挡路，象不能像马一样跳过去。', setup({d4:'B',e5:'P'}), [0,'d4','g7']],
    ['pawn-back', '兵不能后退', '兵即使已经离开起始格，也一直不能后退。', setup({e4:'P'}), [0,'e4','e3']],
    ['pawn-straight-capture', '兵不能直着吃子', '兵前进的格上有敌子时不能向前走，吃子必须斜前一格。', setup({e4:'P',e5:'n'}), [0,'e4','e5']],
    ['pawn-empty-diagonal', '兵不能斜走到普通空格', '斜前方没有可吃的棋，也不是有效的吃过路兵，兵不能这样走。', setup({e4:'P'}), [0,'e4','d5']],
    ['king-danger', '王不能走进攻击范围', 'b2 受到黑车攻击，白王不能走到这里。', position({a1:'K',h8:'k',b8:'r'}), [0,'a1','b2']],
    ['king-adjacent', '两王不能相邻', '王也控制相邻格，所以白王不能靠近黑王。', position({a1:'K',c3:'k',h7:'p'}), [0,'a1','b2']],
    ['ignore-check', '被将军时必须先解围', '黑车正在攻击白王，不能先移动其他棋子来让过将军。', position({a1:'K',h8:'k',a8:'r',d4:'N'}), [0,'d4','e6']],
    ['castle-through-check', '易位不能经过受攻击的格', '黑车控制 f1。即使王现在安全，也不能经过 f1 易位到 g1。', position({e1:'K',h1:'R',a8:'k',f8:'r'},'w','K'), [0,'e1','g1']],
    ['wrong-turn', '黑方不能抢先走', '标准开局轮到白方，黑兵必须等白方走完。', undefined, [1,'e7','e5']],
  ] as [string,string,string,string|undefined,Step][]) {
    const engine = new ChessGame(fen); engine.start()
    const before = snapshot(engine, 0, `chess-${id}`), a = action(attempt), result = engine.command(a.seat, 'chessMove', a.payload)
    if (result.ok || JSON.stringify(before) !== JSON.stringify(snapshot(engine,0,`chess-${id}`))) throw new Error(`国际象棋教程拒绝场景无效: ${id}`)
    clips.push({ id: `chess-${id}`, title, explanation, chapter: '不能这样走', tags: [id], snapshot: before, frames: [
      { snapshot: clone(before), action: a, rejected: result.message, cards: [], caption: explanation, duration: 3300 },
      { snapshot: clone(before), cards: [], caption: '这一步没有走成，棋子留在原位。', kind: 'result', duration: 1500 },
    ] })
  }
  const order = ['开局与轮流','每种棋怎么走','不能这样走','特殊走法','将军与解围','胜负与和棋']
  return clips.sort((a,b) => order.indexOf(a.chapter)-order.indexOf(b.chapter))
}
