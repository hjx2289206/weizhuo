import type { Card } from '../../shared/protocol'
import { guandanRankStrength } from '../../shared/guandan'
import { GuandanGame } from '../games/guandan'
import { Author, type LessonText, type TeachingCourse, type TeachingMatch } from './model'
import { context, fixedDeck, select, type Face } from './decks'

const text = (id: string, title: string, instruction: string, explanation: string, tags: string[]): LessonText => ({ id, title, instruction, explanation, tags })
interface Combo { faces: Face[]; kind: string; title: string; explanation: string; tags: string[]; follow?: Face[] }
interface Deal { head: number; upgrade: 1 | 2 | 3; level: number; profile?: string; combos?: Combo[] }
const strength = (card: Card, level: number) => guandanRankStrength(card.rank, level)
const low = (hand: readonly Card[], level: number) => [...hand].sort((a, b) => strength(a, level) - strength(b, level))[0]!

function leadTo(author: Author, desired: number, protectedIds = new Set<string>()): void {
  const engine = author.engine as GuandanGame
  if (engine.view(0).lastPlay) author.clear()
  const view = engine.view(0)
  if (view.turn === desired) return
  const source = view.turn!
  const card = low(engine.handOf(source), engine.playedLevel)
  author.play(source, [card])
  while (engine.view(0).turn !== desired) author.pass(engine.view(0).turn!)
  const response = [...engine.handOf(desired)].filter(c => strength(c, engine.playedLevel) > strength(card, engine.playedLevel))
    .sort((a, b) => Number(protectedIds.has(a.id)) - Number(protectedIds.has(b.id)) || strength(a, engine.playedLevel) - strength(b, engine.playedLevel))[0]
  if (!response) throw new Error('无法把教学领出权交给目标玩家')
  author.play(desired, [response]); author.clear()
}

/** Complete a deal without inventing rankings: last-card captures determine the actual order. */
function finish(author: Author, head: number, upgrade: 1 | 2 | 3, wind?: LessonText): void {
  const engine = author.engine as GuandanGame
  leadTo(author, head)
  const order = upgrade === 3 ? [head, (head + 2) % 4] : upgrade === 2 ? [head, (head + 1) % 4, (head + 2) % 4] : [head, (head + 1) % 4, (head + 3) % 4]
  for (let i = 0; i < order.length; i++) {
    const seat = order[i]!, next = order[i + 1]
    if (engine.view(0).phase === 'finished') break
    if (engine.view(0).turn !== seat || engine.view(0).lastPlay) throw new Error(`教学名次领出错误 ${seat}/${engine.view(0).turn}`)
    const intercept = next !== undefined && next !== (seat + 2) % 4
    const tails = [...engine.handOf(seat)].sort((a, b) => strength(a, engine.playedLevel) - strength(b, engine.playedLevel))
    const tail = tails.find(card => !intercept || engine.handOf(next!).some(other => strength(other, engine.playedLevel) > strength(card, engine.playedLevel)))
    if (!tail) throw new Error('无法完成教学名次交接')
    for (const card of [...engine.handOf(seat)].filter(card => card.id !== tail.id)) { author.play(seat, [card]); author.clear() }
    author.play(seat, [tail], i === 0 ? wind : undefined)
    if (engine.phase === 'finished') break
    if (intercept) {
      while (engine.view(0).turn !== next) author.pass(engine.view(0).turn!)
      const response = [...engine.handOf(next!)].filter(card => strength(card, engine.playedLevel) > strength(tail, engine.playedLevel)).sort((a, b) => strength(a, engine.playedLevel) - strength(b, engine.playedLevel))[0]!
      author.play(next!, [response]); author.clear()
    } else author.clear()
  }
  if (engine.phase !== 'finished' || engine.result?.upgrade !== upgrade) throw new Error('掼蛋教学名次未按合法流程达成')
}

function makeMatch(id: string, title: string, player: number, deals: Deal[]): TeachingMatch {
  const decks = deals.map((deal, index) => {
    const wishes: Face[][] = [[], [], [], []]
    const head = deal.head
    for (const combo of deal.combos ?? []) wishes[head]!.push(...combo.faces)
    // Guaranteed small cards let a lead transfer happen without touching the lesson combinations.
    wishes[head]!.push(4, deal.level === 15 ? 3 : 15)
    for (const combo of deal.combos ?? []) if (combo.follow) wishes[(head + 1) % 4]!.push(...combo.follow)
    const jokersUsed = wishes.flat().filter(face => (typeof face === 'number' ? face : face[0]) === 17).length
    if (deal.profile === 'equal') { wishes[0]!.push(16); wishes[2]!.push(16); wishes[1]!.push(17); wishes[3]!.push(17) }
    else if (deal.profile === 'single-resist') wishes[0]!.push(17, 17)
    else if (deal.profile === 'double-resist') { wishes[0]!.push(17); wishes[2]!.push(17) }
    else if (deal.profile === 'unequal') { wishes[0]!.push(17); wishes[2]!.push(16); wishes[1]!.push(17) }
    else {
      for (let n = jokersUsed; n < 2; n++) wishes[n === 0 ? head : deal.combos?.some(combo => combo.follow) ? (head + 1) % 4 : (head + 2) % 4]!.push(17)
    }
    if (deal.profile === 'high-return') {
      wishes[0] = [[5, 'spade'], [5, 'club'], [5, 'diamond']]
      wishes[1]!.push(17); wishes[2] = [17]
      return fixedDeck('guandan', wishes, [0])
    }
    if (deal.profile === 'return-ten') wishes[0]!.push(10)
    return fixedDeck('guandan', wishes)
  })
  const create = () => new GuandanGame(context(decks, deals[0]!.head))
  const author = new Author(create)
  for (const [di, deal] of deals.entries()) {
    if (di > 0) author.add({ type: 'restart', seat: player, payload: {} })
    author.start()
    const engine = author.engine as GuandanGame
    if (engine.playedLevel !== deal.level) throw new Error(`${id} 第${di + 1}副级牌应为${deal.level}，实际${engine.playedLevel}`)
    const protectedIds = new Set(select(engine.handOf(deal.head), (deal.combos ?? []).flatMap(combo => combo.faces)).map(card => card.id))
    let exchangeGuard = 0
    while (engine.phase === 'tribute') {
      if (++exchangeGuard > 12) throw new Error('进贡还贡未结束')
      const seat = Array.from({ length: 4 }, (_, seat) => seat).find(seat => {
        const action = engine.view(seat).privateAction
        return action && !action.committed
      })
      if (seat === undefined) throw new Error('无可执行交换动作')
      const action = engine.view(seat).privateAction!
      const eligible = engine.handOf(seat).filter(card => action.eligibleIds.includes(card.id))
      const card = action.kind === 'return' && deal.profile === 'return-ten' && seat === 0
        ? eligible.find(card => card.rank === 10)!
        : [...eligible].sort((a, b) => Number(protectedIds.has(a.id)) - Number(protectedIds.has(b.id)) || strength(a, deal.level) - strength(b, deal.level))[0]!
      if (!card) throw new Error('没有教学交换牌')
      const isPlayer = seat === player
      const tags = action.kind === 'tribute' ? ['tribute', 'wild-excluded', ...(engine.exchange.givers.length === 2 ? ['double-tribute', 'simultaneous-tribute'] : ['single-tribute']), ...(deal.profile === 'equal' ? ['equal-tribute'] : ['tribute-order'])]
        : ['return-tribute', 'simultaneous-return', 'level-excluded-return', engine.exchange.givers.length === 2 ? 'double-tribute' : 'single-tribute', ...(deal.profile === 'high-return' ? ['return-fallback'] : ['free-low-return'])]
      const info = isPlayer ? text(`${id}-${di}-${action.kind}`, action.kind === 'tribute' ? '进贡：选择最大的非红桃级牌' : deal.profile === 'high-return' ? '没有低牌时，还最小牌' : '还贡：低牌可以自行选择',
        `选中高亮的牌，点击“${action.kind === 'tribute' ? '进贡' : '还贡'}”。`,
        action.kind === 'tribute' ? `上一副名次决定这次交换。${engine.exchange.givers.length === 2 ? '双贡提交齐才同时公开，大贡给头游、小贡给二游，大贡者先出；同点由头游下家给头游并先出。' : '末游向头游进贡，完成还贡后由进贡者先出。'}红桃级牌不进贡，其他级牌照常计入。`
          : deal.profile === 'high-return' ? '手中没有普通 2 至 10，必须还当前最小牌；本副级牌高于 A，不能按数字小来判断。' : '可以从普通 2 至 10 中自选，不必还最小的；本副级牌除外。双还提交齐后同时公开。', tags) : undefined
      author.add({ type: action.kind === 'tribute' ? 'tribute' : 'returnTribute', seat, payload: { cardId: card.id } }, info)
    }
    if (engine.exchange.stage === 'resisted') {
      const lead = engine.view(0).turn!
      const card = low(engine.handOf(lead), engine.playedLevel)
      author.play(lead, [card])
      while (engine.view(0).turn !== player) author.pass(engine.view(0).turn!)
      author.pass(player, text(`${id}-${di}-resist`, '抗贡：跳过交换，头游先出', '观察免贡结果，点击“不出”让过这一手。',
        `${engine.exchange.givers.length === 2 ? '双贡双方合计' : '单贡者自己'}持有两个大王，免去进贡和还贡，由上一副头游先出。系统自动判断，不需要手工申请抗贡。`,
        [engine.exchange.givers.length === 2 ? 'double-resist' : 'single-resist', 'resist', 'pass']))
      author.clear()
    }
    leadTo(author, deal.head, protectedIds)
    for (const [ci, combo] of (deal.combos ?? []).entries()) {
      const selected = select(engine.handOf(deal.head), combo.faces)
      author.play(deal.head, selected, deal.head === player ? text(`${id}-${di}-combo-${ci}`, combo.title,
        `选中高亮的 ${selected.length} 张牌，系统自动识别最强合法牌型，点击“出牌”。`,
        combo.explanation, combo.tags) : undefined, combo.kind)
      if (combo.follow) {
        const followSeat = (deal.head + 1) % 4
        author.play(followSeat, select(engine.handOf(followSeat), combo.follow));
        while (engine.view(0).turn !== deal.head) author.pass(engine.view(0).turn!)
      } else author.clear()
    }
    // A final reply after the authored follow chain is part of the next combo, not a reset.
    if (engine.view(0).lastPlay) author.clear()
    finish(author, deal.head, deal.upgrade, id === 'gd-core' && di === 0 ? text('gd-wind', '走完最后一手，等待搭档接风', '把最后一张高亮牌打完，观察所有人不出后对家的领出权。', '搭档走完并不是立刻接风；要先等本轮其他人都不出。清轮后由仍持牌的对家接风，可以换一种合法牌型。', ['wind', 'clear-trick', 'lead-no-pass']) : undefined)
    const result = engine.result!
    const passed = engine.matchWinner !== null
    author.add({ type: 'continue', seat: player, payload: {} }, text(`${id}-${di}-result`, passed ? '真正过 A，整场结束' : '本副结束，名次决定升级',
      passed ? '查看整场结果，点击继续。' : '查看升级结果，点击“下一副教学”。',
      `本副头游是 ${result.order[0] + 1} 号位，搭档${deal.upgrade === 3 ? '二游，双下升 3 级' : deal.upgrade === 2 ? '三游，升 2 级' : '末游，只升 1 级'}。${passed ? '本副开打前本队已经到 A，本副打 A 并拿头游且搭档不是末游，成功过 A。' : deal.level === 14 ? '虽然打 A 拿到头游，但搭档末游，没有过 A，级数不降。' : '升到 A 不等于过 A；下一副按本副胜队升级后的级牌打。'}本项目记录升级与整场胜负，不计算斗地主式分数。`,
      ['rankings', `upgrade-${deal.upgrade}`, ...(deal.upgrade === 3 ? ['double-down', 'early-finish'] : []), 'next-deal-level', ...(deal.level === 14 ? [passed ? 'pass-ace' : 'fail-ace', 'ace-conditions'] : [])]))
    if (passed && di !== deals.length - 1) throw new Error(`${id} 提前过 A`)
  }
  if ((author.engine as GuandanGame).matchWinner === null) throw new Error(`${id} 未完成整场过 A`)
  return { id, title, player, create, steps: author.steps }
}

export function guandanCourse(): TeachingCourse {
  const core: Deal[] = [
    { head: 0, upgrade: 3, level: 15, combos: [
      { faces: [9], kind: 'single', title: '四人搭档与单牌', explanation: '两副牌 108 张，每人 27 张，对坐同队。大王 > 小王 > 级牌 > A … > 2，同点花色不分大小。', tags: ['teams', 'deal-108', 'single', 'level-rank'] },
      { faces: [6, 6], kind: 'pair', title: '对子', explanation: '两张同点数是对子，接牌要同型且严格更大。相同花色在两副牌中各有两张。', tags: ['pair', 'same-type'] },
      { faces: [7, 7, 7], kind: 'triple', title: '三张', explanation: '三张同点数为三张，比较看点数。级牌的三张高于 A 的三张。', tags: ['triple'] },
      { faces: [8, 8, 8, 11, 11], kind: 'triplePair', title: '三带二', explanation: '三张加另一个点数的对子。没有三带一或四带二，比较只看三张。五张同点数按炸弹解释。', tags: ['triple-pair', 'attachment-rules'] },
      { faces: [[3, 'spade'], [4, 'heart'], [5, 'club'], [6, 'diamond'], [7, 'spade']], kind: 'straight', title: '固定五张顺子', explanation: '顺子固定五张，按自然点数连续，不含王。级牌也放在原来的连续位置。', tags: ['straight', 'fixed-length', 'natural-order'] },
    ] },
    { head: 0, upgrade: 3, level: 5, combos: [
      { faces: [13], kind: 'single', title: '先观察对方用 A 接 K', explanation: '普通单牌仍按自然大小比较。接下来对手用 A 接 K，再由你用级牌接。', tags: ['ordinary-rank'], follow: [14] },
      { faces: [[5, 'spade']], kind: 'single', title: '级牌高于 A', explanation: '本副打 5，所有花色的 5 都高于 A，只有王更大；黑桃 5 能压 A，花色本身不决定大小。', tags: ['level-beats-ace'] },
      { faces: [3, 3, 4, 4, [5, 'spade'], [5, 'club']], kind: 'threePairs', title: '三连对', explanation: '三组连续对子，固定六张。可从 A 起接 AA2233，不能跨 K—A—2。', tags: ['three-pairs', 'run-limits'] },
      { faces: [6, 6, 6, 7, 7, 7], kind: 'twoTriples', title: '二连三张', explanation: '两组连续三张，固定六张，不带翅膀。与斗地主飞机不同。', tags: ['two-triples'] },
      { faces: [[5, 'heart'], 9], kind: 'pair', title: '红桃级牌是逢人配', explanation: '本副打 5，红桃 5 可替代任意非王牌点数和花色。这里配成对 9；单出仍是级牌，不能变成王。', tags: ['wild', 'wild-no-joker', 'wild-single'] },
    ] },
    { head: 0, upgrade: 3, level: 8, combos: [
      { faces: [4, 4, 4, 4], kind: 'bomb', title: '炸弹与张数', explanation: '四张及以上同点数是炸弹。先比张数，同张数再比点数，能压普通牌型。接着观察对方用五张炸弹接。', tags: ['bomb-four', 'bomb-count', 'bomb-rank'], follow: [6, 6, 6, 6, 6] },
      { faces: [[3, 'spade'], [4, 'spade'], [5, 'spade'], [6, 'spade'], [7, 'spade']], kind: 'straightFlush', title: '同花顺压五张炸弹', explanation: '同花色五张顺子高于五张炸弹，低于六张及以上炸弹。自然同花顺按同花顺计算，不能降成普通顺子。', tags: ['straight-flush', 'bomb-five', 'flush-tier'] },
      { faces: [7, 7, 7, [8, 'heart'], [8, 'heart']], kind: 'bomb', title: '同一手牌自动取最强解释', explanation: '777 加两张红桃级牌既能作三带二，也能作五张 7 炸弹。系统自动识别为更强的五张炸弹，随后观察对方同花顺压过它。', tags: ['multiple-claims', 'wild-bomb'], follow: [[8, 'club'], [9, 'club'], [10, 'club'], [11, 'club'], [12, 'club']] },
      { faces: [10, 10, 10, 10, 10, 10], kind: 'bomb', title: '六张炸弹压同花顺', explanation: '六张及以上炸弹高于同花顺。大炸弹之间仍先比张数再比点数。', tags: ['bomb-six-plus', 'all-bomb-tiers'] },
    ] },
    { head: 0, upgrade: 3, level: 11, combos: [
      { faces: [16, 16, 17, 17], kind: 'fourJokers', title: '四大天王', explanation: '两个小王加两个大王一起出，是最高牌型。两张大小王不是斗地主的火箭；同点数的两张王可以作对子。', tags: ['four-jokers', 'joker-pair'] },
      { faces: [[3, 'spade'], [4, 'spade'], [5, 'spade'], [6, 'spade'], [11, 'heart']], kind: 'straightFlush', title: '逢人配自动补成最强同花顺', explanation: '本副打 J，红桃 J 自动替代黑桃 7，与黑桃 3 至 6 组成最高的可用同花顺；不需要手工选择配牌点数或花色。', tags: ['wild-suit', 'wild-straight-flush'] },
    ] },
    { head: 0, upgrade: 3, level: 14, combos: [
      { faces: [[14, 'spade'], [15, 'heart'], [3, 'club'], [4, 'diamond'], [5, 'spade']], kind: 'straight', title: 'A2345 与过 A', explanation: 'A2345 是最小顺子，10JQKA 是最大顺子，QKA23 不合法。本副打 A，级牌仍可按自然点数参加连张。', tags: ['ace-low-run', 'no-wrap-run'] },
    ] },
  ]
  const exchanges: Deal[] = [
    { head: 1, upgrade: 3, level: 15 },
    { head: 1, upgrade: 2, level: 5, profile: 'equal' },
    { head: 1, upgrade: 2, level: 7 },
    { head: 1, upgrade: 1, level: 9, profile: 'single-resist' },
    { head: 1, upgrade: 3, level: 10 },
    { head: 1, upgrade: 3, level: 13, profile: 'double-resist' },
    { head: 1, upgrade: 1, level: 14, profile: 'unequal' },
    { head: 1, upgrade: 2, level: 14 },
  ]
  const returns: Deal[] = [
    { head: 0, upgrade: 3, level: 15 },
    { head: 0, upgrade: 2, level: 5, profile: 'high-return' },
    { head: 0, upgrade: 3, level: 7, profile: 'return-ten' },
    { head: 0, upgrade: 3, level: 10 },
    { head: 0, upgrade: 3, level: 13 },
    { head: 0, upgrade: 3, level: 14 },
  ]
  return { game: 'guandan', matches: [makeMatch('gd-core', '第一整场 · 搭档、牌型与过 A', 0, core), makeMatch('gd-exchange', '第二整场 · 单贡、双贡与抗贡', 0, exchanges), makeMatch('gd-return', '第三整场 · 还贡选择与兜底', 0, returns)] }
}
