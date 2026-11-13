import { DoudizhuGame } from '../games/doudizhu'
import { Author, type LessonText, type TeachingCourse, type TeachingMatch } from './model'
import { context, fixedDeck, select, type Face } from './decks'

const note = (id: string, title: string, instruction: string, explanation: string, tags: string[]): LessonText => ({ id, title, instruction, explanation, tags })
function finish(author: Author, passLesson?: LessonText): void {
  for (let guard = 0; guard < 200 && author.engine.phase !== 'finished'; guard++) {
    const view = author.engine.view(0)
    const seat = view.turn!
    if (view.lastPlay && view.lastPlay.seatId !== seat) { author.pass(seat, seat === 0 ? passLesson : undefined); if (seat === 0) passLesson = undefined }
    else author.play(seat, [[...author.engine.handOf(seat)].sort((a, b) => a.rank - b.rank)[0]!])
  }
  if (author.engine.phase !== 'finished') throw new Error('斗地主教学未结束')
}

export function doudizhuCourse(): TeachingCourse {
  const matches: TeachingMatch[] = []
  const examples: { id: string; title: string; cards: Face[]; table?: Face[]; text: string; tags: string[] }[] = [
    { id: 'single', title: '单张与大小', cards: [9], table: [8], text: '单张为大王 > 小王 > 2 > A > K … > 3，花色不分大小。现在用 9 接住单张 8。', tags: ['single', 'rank-order', 'farmers', 'team-win'] },
    { id: 'pair', title: '对子', cards: [6, 6], table: [5, 5], text: '两张同点数是对子。接牌通常要同牌型、同长度，且点数严格更大。', tags: ['pair', 'same-type', 'strictly-greater'] },
    { id: 'triple', title: '三张', cards: [7, 7, 7], table: [6, 6, 6], text: '三张同点数作为一手，三张只能用更大的三张或炸弹接。', tags: ['triple'] },
    { id: 'three-one', title: '三带一', cards: [7, 7, 7, 4], table: [6, 6, 6, 3], text: '三个 7 带一张 4，比较只看主体三张，不看所带单牌。', tags: ['triple-single'] },
    { id: 'three-two', title: '三带二', cards: [8, 8, 8, 5, 5], text: '三带二的附件必须是一个对子，不能用两张不同点数代替。三带一不能接三带二。', tags: ['triple-pair', 'attachment-type'] },
    { id: 'straight', title: '顺子', cards: [3, 4, 5, 6, 7], text: '至少五张连续单牌。2 和王不能入顺子，接顺子时长度必须相同，再比较最高点。', tags: ['straight', 'run-limits', 'same-length'] },
    { id: 'pairs-run', title: '连对', cards: [3, 3, 4, 4, 5, 5], text: '至少三组连续对子，2 和王不能参加。这里练习 334455。', tags: ['pairs-run'] },
    { id: 'triples-run', title: '不带翅膀的飞机', cards: [3, 3, 3, 4, 4, 4], text: '至少两组连续三张组成飞机，主体不能有 2 和王。飞机也可以不带牌。', tags: ['triples-run', 'airplane'] },
    { id: 'plane-single', title: '飞机带单', cards: [3, 3, 3, 4, 4, 4, 7, 8], text: '每组三张带一张单牌。两组主体带两张单牌，比较主体最高点。', tags: ['airplane-single'] },
    { id: 'plane-pair', title: '飞机带对', cards: [3, 3, 3, 4, 4, 4, 7, 7, 8, 8], text: '每组三张带一个对子。两组主体带两个对子，不能用四张散牌充当两个对子。', tags: ['airplane-pair'] },
    { id: 'four-two', title: '四带二单', cards: [8, 8, 8, 8, 3, 4], text: '四张同点数带两张单牌。带附件以后属于四带二，不能按炸弹压其他牌型。', tags: ['four-two-single', 'bomb-with-attachments'] },
    { id: 'four-pairs', title: '四带二对', cards: [8, 8, 8, 8, 3, 3, 4, 4], text: '四张同点数带两个对子，共八张。与六张的四带二单是不同牌型。', tags: ['four-two-pair'] },
    { id: 'bomb', title: '炸弹突破牌型', cards: [4, 4, 4, 4], table: [13, 13], text: '四张同点数单独出是炸弹，能压普通牌型；炸弹之间比较点数，倍数翻倍。', tags: ['bomb', 'multiplier'] },
    { id: 'rocket', title: '火箭', cards: [16, 17], table: [14, 14, 14, 14], text: '小王和大王一起出是火箭，是最大牌型，倍数也翻倍。单独出一张王不是火箭。', tags: ['rocket'] },
  ]
  examples.forEach((example, index) => {
    const wishes: Face[][] = [example.cards, example.table ?? [], [], []]
    const deck = fixedDeck('doudizhu', wishes)
    const create = () => new DoudizhuGame(context([deck]))
    const author = new Author(create); author.start()
    const landlord = example.table ? 1 : 0
    author.add({ type: 'bid', seat: 0, payload: { value: landlord === 0 ? 3 : 0 } }, index === 0 ? note('ddz-bidding', '先叫地主', '点击“不叫”，本场由教学对手叫地主。', '三人先各拿 17 张，地主额外拿 3 张底牌并先出；两名农民同队，一人走完两人都赢。', ['roles', 'bidding', 'bottom']) : index === 4 ? note('ddz-bid-max', '叫 3 分立即成为地主', '点击“3 分”，拿走三张底牌并先出。', '叫 3 分立即结束叫分；其他人不能再提高分数。最终最高叫分也是本局底分。', ['bid-three', 'landlord-bottom']) : undefined)
    if (landlord === 1) author.add({ type: 'bid', seat: 1, payload: { value: 3 } })
    if (example.table) { author.play(1, select(author.engine.handOf(1), example.table)); author.pass(2) }
    const target = select(author.engine.handOf(0), example.cards)
    author.play(0, target, note(`ddz-${example.id}`, example.title, `选中高亮的 ${target.length} 张牌，然后点击“出牌”。`, example.text, example.tags))
    finish(author)
    author.add({ type: 'continue', seat: 0, payload: {} }, note(`ddz-${example.id}-result`, '对局结算', '查看结算后，点击“下一场教学”。',
      landlord === 1 ? '本场农民先走完，农民两人一起获胜。地主只出过一手，因此反春天再翻倍；地主输两份，每名农民赢一份。' : '本场地主走完，农民都没有出过牌，触发春天再翻倍。每名农民输底分 × 最终倍数，地主赢两份，三人合计为零。',
      landlord === 1 ? ['reverse-spring', 'farmers-win', 'scoring'] : ['spring', 'landlord-win', 'scoring']))
    matches.push({ id: `ddz-${example.id}`, title: `第 ${index + 1} 场 · ${example.title}`, player: 0, create, steps: author.steps })
  })
  // A real all-pass redeal, followed by an escalating auction and a complete game.
  const deck = fixedDeck('doudizhu', [[], [], [], []])
  const create = () => new DoudizhuGame(context([deck, [...deck].reverse()]))
  const author = new Author(create); author.start()
  author.add({ type: 'bid', seat: 0, payload: { value: 0 } }, note('ddz-all-pass', '全部不叫会重新发牌', '点击“不叫”，观察另外两人也不叫后的重新发牌。', '没有人叫分，就重新发一副牌，不会强制第一人当地主。', ['all-pass-redeal']))
  author.add({ type: 'bid', seat: 1, payload: { value: 0 } }); author.add({ type: 'bid', seat: 2, payload: { value: 0 } })
  author.add({ type: 'bid', seat: 0, payload: { value: 1 } }, note('ddz-bid-one', '叫分与底分', '点击“1 分”开始叫分。', '可不叫或叫 1、2、3 分；后叫者只能提高当前最高分，叫 3 分立即结束叫分。', ['bid-order', 'base-score']))
  author.add({ type: 'bid', seat: 1, payload: { value: 2 } }); author.add({ type: 'bid', seat: 2, payload: { value: 0 } })
  // Auction in this engine revisits an eligible bidder while a higher bid remains possible.
  if (author.engine.phase === 'bidding') author.add({ type: 'bid', seat: 0, payload: { value: 3 } }, note('ddz-bid-three', '加叫必须更高', '点击“3 分”成为地主。', '前面已经叫到 2 分，不能再叫 1 或 2 分；3 分直接成为地主。', ['bid-raise']))
  finish(author, note('ddz-practice-pass', '不出与重新领出', '现在点击“不出”，观察连续两家不出后重新领出。', '接不住或想让牌时可以不出；首出和重新领出必须出一手合法牌。连续两家不出后，上一次出牌者可以换牌型重新领出。', ['pass', 'trick-clear', 'no-pass-on-lead']))
  author.add({ type: 'continue', seat: 0, payload: {} }, note('ddz-final', '完成一整局', '点击“完成教学”。', '每场都从真实发牌和叫分开始，直到牌局结束。领出不能不出；接牌可以主动让牌，连续两家不出后由上一手出牌者重新领出。', ['pass', 'trick-clear', 'no-pass-on-lead']))
  matches.unshift({ id: 'ddz-auction', title: '开场 · 叫分与重新发牌', player: 0, create, steps: author.steps })
  return { game: 'doudizhu', matches }
}
