<script setup lang="ts">
import { XIANGQI_FULL_BOX, xiangqiFocusBox, type XiangqiBox } from '../../shared/xiangqiGeometry'
import { xiangqiPositionKey, xiangqiSideName } from '../../shared/xiangqi'
import type { XiangqiPlayback } from '../tutorials/xiangqiMotion'
import XiangqiBoard from './XiangqiBoard.vue'
import ChessTutorialStage from './ChessTutorialStage.vue'
import StoneTutorialStage from './StoneTutorialStage.vue'
import { computed } from 'vue'
import { JUNQI_NAMES, junqiSideName } from '../../shared/junqi'
import { junqiFocusBox, junqiFullBox, type BoardBox } from '../../shared/junqiGeometry'
import { enumerateGuandanPlays } from '../../shared/guandan'
import type { TeachingClip, TeachingFrame } from '../../shared/tutorialProtocol'
import { clipPosition } from '../tutorials/motion'
import { clamp, type ChessMotion } from '../tutorials/chessMotion'
import JunqiBoard from './JunqiBoard.vue'
import JunqiFourBoard from './JunqiFourBoard.vue'
import TutorialCardSpread from './TutorialCardSpread.vue'
import PlayingCard from './PlayingCard.vue'

const props = defineProps<{ clip: TeachingClip; elapsed: number; reduced: boolean; opposed?: boolean }>()
const pos = computed(() => clipPosition(props.clip, props.elapsed, props.reduced))
const snapshot = computed(() => pos.value.snapshot)
const frame = computed(() => pos.value.frame)
const chess = computed(() => snapshot.value.game === 'junqi' ? snapshot.value : null)
const xiangqi = computed(() => snapshot.value.game === 'xiangqi' ? snapshot.value : null)
const xqMotion = computed<XiangqiPlayback | null>(() => {
  const settled = frame.value?.kind === 'result', f = settled ? props.clip.frames.filter(f=>f.action?.type==='xiangqiMove').at(-1) : frame.value
  if(f?.action?.type!=='xiangqiMove')return null
  const index=props.clip.frames.indexOf(f), before=index>0?props.clip.frames[index-1]!.snapshot:props.clip.snapshot
  if(before.game!=='xiangqi')return null
  const from=Number(f.action.payload.from),to=Number(f.action.payload.to),piece=before.xiangqi.board[from]
  return piece?{from,to,piece,path:f.path??[from,to],phase:props.reduced||settled?1:pos.value.fraction,capture:!!before.xiangqi.board[to],rejected:f.rejected}:null
})
function xqFocus(f:TeachingFrame|null,fallback:XiangqiBox):XiangqiBox { if(!f?.focus)return fallback;return f.focus.overview?XIANGQI_FULL_BOX:f.focus.points.length?xiangqiFocusBox(f.focus.points):fallback }
const xqCamera=computed(()=>{
  const first=xqFocus(props.clip.frames[0]??null,XIANGQI_FULL_BOX)
  if(!frame.value){const t=props.reduced?1:easing(pos.value.intro);return XIANGQI_FULL_BOX.map((v,i)=>v+(first[i]!-v)*t).join(' ')}
  let previous=first;for(let i=0;i<pos.value.frameIndex;i++)previous=xqFocus(props.clip.frames[i]!,previous)
  const target=xqFocus(frame.value,previous),t=props.reduced?1:easing(pos.value.fraction/.18)
  return previous.map((v,i)=>v+(target[i]!-v)*t).join(' ')
})
const xqRepeats=computed(()=>{
  if(props.clip.snapshot.game!=='xiangqi')return 0
  const states=[props.clip.snapshot,...props.clip.frames.slice(0,pos.value.frameIndex+(pos.value.fraction>=.84?1:0)).filter(f=>f.action?.type==='xiangqiMove').map(f=>f.snapshot)], counts=new Map<string,number>()
  for(const state of states)if(state.game==='xiangqi'){const last=state.xiangqi.moves.at(-1),key=xiangqiPositionKey(state.xiangqi.board,last?last.side===0?1:0:0);counts.set(key,(counts.get(key)??0)+1)}
  return Math.max(1,...counts.values())
})
const easing = (p: number) => { const t = clamp(p); return t * t * (3 - 2 * t) }
const motion = computed<ChessMotion | null>(() => {
  const settled = frame.value?.kind === 'result'
  const f = settled ? props.clip.frames.find(frame => frame.action?.type === 'junqiMove') : frame.value
  return !props.reduced && f?.action?.type === 'junqiMove' && (settled || pos.value.fraction < .84) ? { from: Number(f.action.payload.from), to: Number(f.action.payload.to), path: f.path ?? [Number(f.action.payload.from), Number(f.action.payload.to)], phase: settled ? 1 : pos.value.fraction, rejected: f.rejected, combat: f.combat } : null
})
function focus(f: TeachingFrame | null, fallback: BoardBox): BoardBox {
  const state = props.clip.snapshot
  if (state.game !== 'junqi' || !f?.focus) return fallback
  if (f.focus.overview) return junqiFullBox(state.junqi.variant)
  return f.focus.points.length ? junqiFocusBox(f.focus.points, state.junqi.variant, state.selfSeat) : fallback
}
const camera = computed(() => {
  if (!chess.value) return ''
  const full = junqiFullBox(chess.value.junqi.variant), first = focus(props.clip.frames[0] ?? null, full)
  if (!frame.value) { const t = props.reduced ? 1 : easing(pos.value.intro); return full.map((v, i) => v + (first[i]! - v) * t).join(' ') }
  let previous = first
  for (let i = 0; i < pos.value.frameIndex; i++) previous = focus(props.clip.frames[i]!, previous)
  const target = focus(frame.value, previous), t = props.reduced ? 1 : easing(pos.value.fraction / .18)
  return previous.map((v, i) => v + (target[i]! - v) * t).join(' ')
})
const fadingSides = computed(() => {
  const before = pos.value.before, after = frame.value?.snapshot
  return before.game === 'junqi' && after?.game === 'junqi' ? after.junqi.eliminated.flatMap((out, side) => out && !before.junqi.eliminated[side] ? [side] : []) : []
})
const fade = computed(() => props.reduced ? 1 : 1 - clamp((pos.value.fraction - .4) / .43))
const flags = computed(() => {
  const state = chess.value, before = props.clip.snapshot
  return state && before.game === 'junqi' ? state.junqi.revealedFlags.flatMap((shown, side) => shown && !before.junqi.revealedFlags[side] ? [side] : []) : []
})
const flagPoints = computed(() => chess.value?.junqi.board.flatMap((piece, point) => piece?.rank === 'flag' && flags.value.includes(piece.side) ? [point] : []) ?? [])
const combat = computed(() => frame.value?.combat ?? props.clip.frames.find(frame => frame.combat)?.combat)
const combatVisible = computed(() => pos.value.ended || props.clip.frames.some((frame, index) => frame.combat && (index < pos.value.frameIndex || index === pos.value.frameIndex && pos.value.fraction > .66)))
const displayIndex = computed(() => {
  const current = Math.max(0, pos.value.frameIndex)
  for (let index = current; index >= 0; index--) if (props.clip.frames[index]?.cards.length) return index
  return props.clip.frames.findIndex(frame => frame.cards.length)
})
const displayFrame = computed(() => props.clip.frames[displayIndex.value])
const currentCards = computed(() => {
  return displayFrame.value?.cards ?? []
})
const cardsBefore = computed(() => {
  const before = displayIndex.value > 0 ? props.clip.frames[displayIndex.value - 1]!.snapshot : props.clip.snapshot
  return before.lastPlay?.cards ?? []
})
const lastPlay = computed(() => frame.value?.snapshot.lastPlay)
const level = computed(() => snapshot.value.game === 'guandan' ? snapshot.value.guandan.playedLevel : undefined)
const learningFrame = computed(() => props.clip.tags.some(tag => ['wild', 'multiple-claims', 'wild-suit'].includes(tag)) ? props.clip.frames.find(frame => frame.action?.type === 'play' && frame.cards.length) : displayFrame.value)
const learningCards = computed(() => learningFrame.value?.cards ?? currentCards.value)
const claims = computed(() => snapshot.value.game === 'guandan' && learningCards.value.length ? enumerateGuandanPlays(learningCards.value, snapshot.value.guandan.playedLevel).map(option => option.declaration) : [])
const chosen = computed(() => claims.value.find(option => option.key === learningFrame.value?.action?.payload.claim) ?? claims.value.find(option => option.key === lastPlay.value?.claim?.key))
const visibleClaims = computed(() => {
  const groups = new Map<string, (typeof claims.value)[number]>()
  for (const claim of claims.value) {
    // Pair choices inside a three-with-two share one explanation. Different run ranges remain
    // distinct, and the actually demonstrated claim represents its group.
    const key = `${claim.kind}:${claim.primaryRank}:${claim.low}`
    if (!groups.has(key) || claim.key === chosen.value?.key) groups.set(key, claim)
  }
  return [...groups.values()]
})
const substitutions = computed(() => chosen.value?.substitutions ?? [])
const interpreted = computed(() => learningCards.value.map(card => { const substitute = substitutions.value.find(item => item.cardId === card.id); return substitute ? { ...card, rank: substitute.rank, suit: substitute.suit } : card }))
const isAuction = computed(() => snapshot.value.game === 'doudizhu' && (props.clip.snapshot.phase === 'bidding' || frame.value?.action?.type === 'bid'))
const isExchange = computed(() => props.clip.tags.some(tag => ['tribute', 'return-tribute', 'resist'].includes(tag)))
const exchange = computed(() => snapshot.value.game === 'guandan' ? snapshot.value.guandan.exchange : null)
const result = computed(() => snapshot.value.game === 'guandan' ? snapshot.value.guandan.result : null)
const rejected = computed(() => props.clip.frames.some(frame => frame.rejected))
const cardTransform = computed(() => {
  if (props.reduced || !frame.value || frame.value.kind === 'result' || !frame.value.cards.length) return 'none'
  const p = pos.value.fraction
  return `translateY(${frame.value.rejected ? -Math.sin(clamp(p / .75) * Math.PI) * 24 : 30 * (1 - easing((p - .16) / .6))}px) scale(${.94 + .06 * easing(p / .5)})`
})
const blank = [{ id: 'back-1', rank: 3, suit: 'spade' as const }, { id: 'back-2', rank: 4, suit: 'spade' as const }, { id: 'back-3', rank: 5, suit: 'spade' as const }]
const rankName = (value: number) => ({ 11:'J', 12:'Q', 13:'K', 14:'A', 15:'2', 16:'小王', 17:'大王' })[value] ?? String(value)
function dealPosition(index: number): string {
  const destinations = [{ x: 75, y: 28 }, { x: 280, y: 110 }, { x: 485, y: 28 }]
  const target = destinations[index % 3]!, p = props.reduced ? 1 : (pos.value.fraction * 3 + Math.floor(index / 3) / 3) % 1
  const t = easing(p)
  return `translate(${280 + (target.x - 280) * t} ${36 + (target.y - 36) * t})`
}
function role(n: number): string { const state = snapshot.value; return state.game === 'doudizhu' ? state.landlord === null ? '待叫分' : state.landlord === n ? '地主' : '农民' : n % 2 === 0 ? '红队' : '蓝队' }
</script>

<template>
  <div class="tutorial-animation-stage" :class="{ 'is-chess': chess || xiangqi || snapshot.game === 'chess' || snapshot.game === 'go' || snapshot.game === 'gomoku', 'is-rejected': rejected }" :data-clip-id="clip.id" :data-beat="pos.frameIndex" :data-fraction="pos.fraction.toFixed(3)">
    <ChessTutorialStage v-if="snapshot.game === 'chess'" :clip="clip" :elapsed="elapsed" :reduced="reduced" :opposed="opposed" />
    <StoneTutorialStage v-else-if="snapshot.game === 'go' || snapshot.game === 'gomoku'" :clip="clip" :elapsed="elapsed" :reduced="reduced" />
    <template v-else-if="xiangqi">
      <div class="clip-chess-context"><span>{{ opposed ? '平板同屏 · 双方棋字各朝自己' : '手机视角 · 所有棋字朝下' }}</span><span>{{ xqCamera === '0 0 500 540' ? '棋盘概览' : '关键区域放大' }}</span></div>
      <div class="clip-chess-viewport" inert><XiangqiBoard :board="xiangqi.xiangqi.board" :side="0" :selected="null" :targets="clip.tags.includes('board') ? [4,85] : []" disabled :opposed="opposed" :last="xiangqi.xiangqi.moves.at(-1)" :checked="xiangqi.xiangqi.check" :camera="xqCamera" :playback="xqMotion" /></div>
      <div class="clip-chess-facts clip-xiangqi-facts"><span v-if="rejected" class="clip-xiangqi-refused">不能这样走 · 棋子留在原位</span><span v-else-if="xiangqi.phase === 'finished'" class="clip-outcome">{{ xiangqi.xiangqi.draw ? '和棋' : `${xiangqiSideName(xiangqi.xiangqi.winner!)}获胜` }} · {{ xiangqi.xiangqi.reason }}</span><span v-else-if="xiangqi.xiangqi.drawOffer !== null">{{ xiangqiSideName(xiangqi.xiangqi.drawOffer) }}提出和棋，等待对方同意</span><span v-else-if="xiangqi.xiangqi.check !== null">{{ xiangqiSideName(xiangqi.xiangqi.check) }}正在被将军，必须先解围</span><span v-else>下一步轮到{{ xiangqiSideName(xiangqi.turn ?? 0) }}</span><span v-if="clip.tags.includes('quiet-120')">连续未吃子 {{ xiangqi.xiangqi.quietPlies }} / 120 手</span><span v-if="clip.tags.some(tag=>['threefold','perpetual-check'].includes(tag))">同一局面最多出现 {{ xqRepeats }} 次</span></div>
    </template>
    <template v-else-if="chess">
      <div class="clip-chess-context"><span>{{ chess.junqi.variant === 'four' ? '四国四暗 · 对坐同队' : '双人暗棋 · 红方视角' }}</span><span v-if="!pos.ended">{{ camera === (chess.junqi.variant === 'four' ? '0 0 872 872' : '0 0 500 760') ? '棋盘概览' : '关键区域放大' }}</span></div>
      <div class="clip-chess-viewport" inert>
        <JunqiFourBoard v-if="chess.junqi.variant === 'four'" :board="chess.junqi.board" :side="chess.selfSeat" :selected="null" :targets="flagPoints" disabled :camera="camera" :motion="motion" :fading-sides="fadingSides" :fade="fade" />
        <JunqiBoard v-else :board="chess.junqi.board" :side="chess.selfSeat" :selected="null" :targets="flagPoints" disabled :camera="camera" :motion="motion" :fading-sides="fadingSides" :fade="fade" />
      </div>
      <div class="clip-chess-facts">
        <span v-if="combat && combatVisible" class="clip-combat">{{ JUNQI_NAMES[combat.attacker] }} × {{ JUNQI_NAMES[combat.defender] }}<b>{{ combat.outcome === 'both' ? '双方移除' : combat.outcome === 'attacker' ? '进攻方胜' : '防守方胜' }}</b></span>
        <span v-if="flags.length">{{ flags.map(junqiSideName).join('、') }}军旗亮出</span>
        <span v-if="chess.phase === 'finished'" class="clip-outcome">{{ chess.message }}</span>
        <span v-else-if="chess.junqi.eliminated.some(Boolean)">{{ chess.junqi.eliminated.flatMap((out, side) => out ? [junqiSideName(side)] : []).join('、') }}已出局，跳过其回合</span>
        <span v-else-if="clip.tags.includes('draw-70')">无交战步数 {{ chess.junqi.quietPlies }} / 70</span>
      </div>
    </template>
    <template v-else>
      <div class="clip-seat-strip"><div v-for="seat in snapshot.seats" :key="seat.id" :class="{ active: (frame?.kind === 'result' ? snapshot.turn : frame?.action?.seat) === seat.id, 'red-team': snapshot.game === 'guandan' && seat.id % 2 === 0 }"><strong>{{ seat.id + 1 }} 号位</strong><span>{{ role(seat.id) }}</span><small>{{ seat.count }} 张</small></div></div>
      <div class="clip-card-context"><span v-if="snapshot.game === 'doudizhu'">底分 {{ snapshot.bid }} · 倍数 {{ snapshot.multiplier }}</span><span v-else-if="snapshot.game === 'guandan'">本副打 {{ rankName(snapshot.guandan.playedLevel) }} · 红队 {{ rankName(snapshot.guandan.levels[0]) }} / 蓝队 {{ rankName(snapshot.guandan.levels[1]) }}</span><span>{{ isAuction ? '叫分与底牌归属' : isExchange ? '交换过程' : '相关牌组放大' }}</span></div>
      <div v-if="isAuction" class="clip-auction">
        <div class="clip-bid-value" :style="{ transform: `scale(${props.reduced ? 1 : .94 + .06 * easing(pos.fraction * 2)})` }">{{ frame?.kind === 'deal' ? '重新发牌' : frame?.action?.type === 'bid' ? Number(frame.action.payload.value) ? `${frame.action.payload.value} 分` : '不叫' : snapshot.game === 'doudizhu' && snapshot.landlord !== null ? `${snapshot.landlord + 1} 号位成为地主` : '依次叫分' }}</div>
        <svg v-if="frame?.kind === 'deal'" class="clip-deal-demo" viewBox="0 0 600 190" role="img" aria-label="收回旧牌，重新分给三个人"><path d="M300 65L95 58M300 65L300 140M300 65L505 58" fill="none" stroke="#b4bf9a" stroke-dasharray="4 5" /><g v-for="index in 9" :key="index" :transform="dealPosition(index - 1)"><svg width="40" height="58"><PlayingCard back style="width:100%;height:100%" /></svg></g><g font-size="14" fill="#718064" text-anchor="middle"><text x="95" y="20">1 号位</text><text x="300" y="185">2 号位</text><text x="505" y="20">3 号位</text></g></svg>
        <div v-else class="clip-bottom"><span>{{ snapshot.game === 'doudizhu' && snapshot.landlord !== null ? `三张底牌 → ${snapshot.landlord + 1} 号位地主` : '三张底牌暂不公开' }}</span><TutorialCardSpread :cards="snapshot.game === 'doudizhu' && snapshot.bottom.length ? snapshot.bottom : blank" :back="!(snapshot.game === 'doudizhu' && snapshot.bottom.length)" :style="{ transform: !props.reduced && frame?.snapshot.phase === 'playing' && frame.action?.type === 'bid' ? `scaleX(${Math.abs(Math.cos(clamp((pos.fraction - .7) / .28) * Math.PI))})` : undefined }" /></div>
      </div>
      <div v-else-if="isExchange" class="clip-exchange">
        <div class="clip-exchange-progress"><strong>{{ exchange?.stage === 'resisted' ? '抗贡 · 免去进贡与还贡' : exchange?.stage === 'complete' ? '交换完成' : exchange?.stage === 'return' ? '还贡阶段' : '进贡阶段' }}</strong><span v-if="exchange && ['tribute','return'].includes(exchange.stage)">已提交 {{ exchange.submitted.length }} / {{ exchange.givers.length }} · 提交齐才同时公开</span><span v-else-if="exchange?.leader !== null && exchange?.leader !== undefined">{{ exchange.leader + 1 }} 号位先出</span></div>
        <div class="clip-exchange-choice" :style="{ transform: cardTransform }"><span>{{ exchange?.stage === 'resisted' ? '抗贡条件：两个大王' : frame?.action ? `${frame.action.seat + 1} 号位的${frame.action.type === 'returnTribute' ? '还贡' : '提交'}牌` : '本段交换示例' }}</span><TutorialCardSpread :cards="currentCards" :level="level" /></div>
        <div v-if="exchange?.pairs.length" class="clip-exchange-pairs"><div v-for="pair in exchange.pairs" :key="pair.giver"><span>{{ pair.giver + 1 }} 号位 → {{ pair.receiver + 1 }} 号位</span><TutorialCardSpread :cards="[pair.tribute]" /><template v-if="pair.returned"><span>还贡 ←</span><TutorialCardSpread :cards="[pair.returned]" /></template><span v-else class="clip-escrow">等待全部还贡</span></div></div>
        <div v-else-if="exchange?.submitted.length" class="clip-escrow">已提交的牌保持封存，其他人不能提前看到<TutorialCardSpread :cards="blank.slice(0, exchange.submitted.length)" back /></div>
      </div>
      <div v-else class="clip-comparison">
        <div v-if="cardsBefore.length" class="clip-card-group clip-table-cards"><span>桌面上一手 · {{ cardsBefore.length }} 张</span><TutorialCardSpread :cards="cardsBefore" :level="level" /></div>
        <div class="clip-card-group clip-action-cards" :class="{ forbidden: rejected && (pos.fraction > .4 || pos.ended) }" :style="{ transform: cardTransform }"><template v-if="currentCards.length"><span>{{ rejected ? '尝试出牌' : '本段演示的牌' }} · {{ currentCards.length }} 张</span><TutorialCardSpread :cards="currentCards" :level="level" /></template><div v-else class="clip-pass-badge">不出<span>保留手牌，让过这一手</span></div><b v-if="rejected && (pos.fraction > .4 || pos.ended)" class="clip-denied">不成立 · 局面不变</b></div>
        <div v-if="substitutions.length" class="clip-wild-mapping"><span>逢人配按以下牌面解释，实体牌保持不变</span><TutorialCardSpread :cards="interpreted" /><small>{{ substitutions.map(item => `红桃级牌 → ${{spade:'♠',heart:'♥',club:'♣',diamond:'♦'}[item.suit]}${rankName(item.rank)}`).join(' · ') }}</small></div>
        <div v-if="visibleClaims.length > 1" class="clip-claims"><span>这一组牌可以凑成</span><b v-for="claim in visibleClaims" :key="claim.key" :class="{ chosen: claim.key === chosen?.key }">{{ claim.label }}{{ ['straight', 'straightFlush', 'threePairs', 'twoTriples'].includes(claim.kind) ? `（到 ${rankName(claim.primaryRank)}）` : '' }}</b></div>
      </div>
      <div v-if="snapshot.phase === 'playing' && snapshot.turn !== null && !isAuction && !isExchange" class="clip-turn-note">{{ snapshot.turn + 1 }} 号位{{ snapshot.lastPlay ? '接牌' : '领出，可换一种合法牌型' }}</div>
      <div v-if="snapshot.phase === 'finished'" class="clip-scoreboard">
        <strong>{{ snapshot.game === 'doudizhu' ? snapshot.winner === 'landlord' ? '地主获胜' : '农民共同获胜' : snapshot.game === 'guandan' && snapshot.guandan.matchWinner !== null ? `${snapshot.guandan.matchWinner === 0 ? '红队' : '蓝队'}成功过 A` : '本副结束' }}</strong>
        <div v-if="snapshot.game === 'doudizhu'"><span v-for="(score, index) in snapshot.scores" :key="index">{{ index + 1 }} 号位 <b>{{ score > 0 ? '+' : '' }}{{ score }}</b></span></div>
        <div v-else-if="result"><span>名次 {{ result.order.map(n => `${n + 1} 号位`).join(' → ') }}</span><span>{{ result.winnerTeam === 0 ? '红队' : '蓝队' }}升 {{ result.upgrade }} 级：{{ rankName(result.levelsBefore[result.winnerTeam]) }} → {{ rankName(result.levelsAfter[result.winnerTeam]) }}</span></div>
      </div>
    </template>
  </div>
</template>

<style>
.tutorial-animation-stage { position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: auto; background: radial-gradient(ellipse at 50% 30%, #f5f4e5, #e7ecd9); border: 1px solid #cdd7bd; border-radius: 18px; color: #345540; }
.clip-seat-strip { display: flex; justify-content: center; gap: 12px; padding: 14px 18px 8px; flex: none; }.clip-seat-strip > div { display: flex; align-items: center; gap: 7px; border: 1px solid #cbd7c0; background: #f6f7ed; padding: 7px 12px; border-radius: 12px; font-size: 11px; }.clip-seat-strip > div.active { border-color: #a58e4e; background: #faf3d8; box-shadow: 0 0 0 2px #c5ae6822; }.clip-seat-strip strong { font-weight: 600; }.clip-seat-strip small { color: #7a896c; }.clip-seat-strip .red-team { color: #96554b; }
.clip-card-context, .clip-chess-context { display: flex; justify-content: space-between; gap: 12px; padding: 8px 18px; font-size: 11px; color: #748263; flex: none; }
.clip-comparison { flex: 1; min-height: 190px; padding: 10px 20px; display: flex; flex-wrap: wrap; align-content: center; justify-content: center; align-items: center; gap: 14px 30px; }.clip-card-group { width: min(44%, 430px); display: flex; flex-direction: column; gap: 10px; align-items: center; min-height: 140px; }.clip-card-group > span, .clip-bottom > span, .clip-exchange-choice > span { font-size: 12px; color: #718064; }.clip-card-group .tutorial-card-spread { height: clamp(100px, 22vh, 180px); }.clip-action-cards { position: relative; }.clip-action-cards.forbidden > svg { opacity: .55; }.clip-denied { position: absolute; top: 46%; padding: 9px 14px; background: #fff3e5ed; border: 1px solid #bc7862; border-radius: 10px; font-size: 13px; color: #984d3d; white-space: nowrap; }.clip-wild-mapping { width: min(100%, 400px); display: flex; flex-direction: column; align-items: center; gap: 7px; border: 1px solid #cbb56d; padding: 10px 16px; border-radius: 12px; background: #fff8db70; }.clip-wild-mapping > span, .clip-wild-mapping small { font-size: 11px; color: #8a7539; }.clip-wild-mapping > svg { height: 115px; }.clip-claims { display: flex; justify-content: center; flex-wrap: wrap; align-items: center; gap: 5px; width: 100%; font-size: 10px; color: #748164; }.clip-claims b { padding: 4px 7px; border: 1px solid #cbd3bb; border-radius: 8px; font-weight: normal; }.clip-claims .chosen { background: #dce8cc; border-color: #819d67; color: #355b3c; }
.clip-auction { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 25px; align-items: center; padding: 15px; }.clip-bid-value { font: 34px 'Songti SC', serif; color: #517046; }.clip-bottom { display: flex; flex-direction: column; align-items: center; gap: 12px; width: 260px; }.clip-bottom .tutorial-card-spread { height: 150px; }
.clip-exchange { flex: 1; display: flex; flex-direction: column; gap: 14px; align-items: center; padding: 12px; }.clip-exchange-progress { text-align: center; display: flex; flex-direction: column; gap: 7px; font-size: 13px; }.clip-exchange-progress span { font-size: 11px; color: #7e896b; }.clip-exchange-choice { display: flex; align-items: center; gap: 20px; min-height: 95px; }.clip-exchange-choice > svg { height: 100px; width: 110px; }.clip-exchange-pairs { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }.clip-exchange-pairs > div { display: flex; align-items: center; gap: 10px; padding: 9px 14px; background: #f8f8ec; border: 1px solid #ccd9bd; border-radius: 12px; font-size: 11px; }.clip-exchange-pairs .tutorial-card-spread { width: 45px; height: 65px; }.clip-escrow { color: #7b846b; font-size: 11px; text-align: center; }.clip-escrow .tutorial-card-spread { width: 110px; height: 90px; margin-top: 8px; }
.clip-scoreboard { flex: none; padding: 12px 16px; text-align: center; background: #f8f7e8e8; border-top: 1px solid #cbd7b9; font-size: 13px; }.clip-scoreboard > div { display: flex; justify-content: center; gap: 20px; flex-wrap: wrap; margin-top: 6px; font-size: 11px; }.clip-scoreboard b { color: #916f32; margin-left: 5px; }
.clip-chess-viewport { flex: 1; min-height: 0; padding: 0 8px; overflow: hidden; }.clip-chess-viewport > .junqi-board { width: 100%; height: 100%; }.clip-chess-viewport > .junqi-four-scroll { width: 100%; height: 100%; border: 0; border-radius: 8px; overflow: hidden; background: transparent; }.clip-chess-facts { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 16px; padding: 10px 15px; font-size: 12px; min-height: 34px; flex: none; }.clip-combat b { color: #8d6a35; padding-left: 12px; }.clip-outcome { font-weight: 600; }.tutorial-animation-stage.is-chess { overflow: hidden; }.teaching-moving-piece { pointer-events: none; }
@media (max-width: 560px) { .clip-seat-strip { gap: 5px; padding: 10px 7px 3px; }.clip-seat-strip > div { padding: 5px 7px; flex-direction: column; gap: 2px; min-width: 55px; font-size: 10px; }.clip-seat-strip small { font-size: 9px; }.clip-comparison { gap: 15px 10px; padding: 10px; }.clip-card-group { width: 46%; min-height: 110px; }.clip-card-group > span { font-size: 10px; }.clip-card-group .tutorial-card-spread { height: 130px; }.clip-comparison:has(.clip-wild-mapping) .clip-card-group { width: 80%; }.clip-wild-mapping > svg { height: 100px; }.clip-bid-value { font-size: 28px; }.clip-card-context, .clip-chess-context { padding: 8px 10px; font-size: 10px; }.clip-scoreboard { padding: 10px; }.clip-exchange-pairs > div { padding: 7px; gap: 7px; font-size: 10px; }.clip-chess-facts { font-size: 11px; padding: 7px 10px; }.clip-claims { font-size: 9px; } }
@media (orientation: landscape) and (max-height: 550px) { .clip-seat-strip { position: absolute; left: 20px; top: 0; padding: 4px 0; gap: 5px; z-index: 1; }.clip-seat-strip > div { padding: 3px 7px; font-size: 9px; gap: 4px; }.clip-card-context { justify-content: flex-end; padding: 9px 12px; font-size: 9px; }.clip-card-context > span:last-child { display: none; }.clip-comparison { padding: 0 10px 6px; gap: 5px 20px; min-height: 100px; flex-wrap: nowrap; }.clip-card-group { width: min(40%, 330px); min-height: 95px; gap: 3px; }.clip-card-group .tutorial-card-spread { height: 105px; }.clip-wild-mapping { width: 40%; padding: 5px 10px; gap: 3px; }.clip-wild-mapping > svg { height: 85px; }.clip-claims { display: none; }.clip-auction { padding: 0 12px; gap: 20px; flex-direction: row; }.clip-bottom .tutorial-card-spread { height: 100px; }.clip-bid-value { font-size: 24px; }.clip-exchange { flex-direction: row; justify-content: center; flex-wrap: wrap; padding: 4px 12px; gap: 6px 20px; }.clip-exchange-pairs { gap: 6px; }.clip-exchange-pairs > div { padding: 4px 8px; }.clip-exchange-choice > svg { height: 65px; width: 65px; }.clip-exchange-choice { min-height: 65px; gap: 8px; }.clip-exchange-pairs .tutorial-card-spread { height: 50px; width: 35px; }.clip-scoreboard { padding: 5px 12px; font-size: 11px; }.clip-scoreboard > div { margin-top: 3px; font-size: 10px; }.clip-chess-context { padding: 4px 12px; font-size: 9px; }.clip-chess-facts { padding: 4px 12px; font-size: 10px; min-height: 24px; } }
</style>
<style>
.clip-turn-note { flex: none; padding: 7px 12px 12px; text-align: center; font-size: 11px; color: #748465; }
.clip-pass-badge { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 20px; border-radius: 14px; border: 1px dashed #adb991; font: 32px 'Songti SC', serif; color: #718164; }.clip-pass-badge > span { font: 11px system-ui, sans-serif; }
@media (orientation: landscape) and (max-height: 550px) { .clip-turn-note { padding: 3px 10px 6px; font-size: 9px; }.clip-comparison:has(.clip-claims) { padding-bottom: 24px; }.clip-claims { display: flex; position: absolute; bottom: 22px; left: 10px; right: 10px; width: auto; flex-wrap: nowrap; overflow: auto; font-size: 9px; }.clip-claims b { padding: 2px 5px; white-space: nowrap; }.clip-claims > span { white-space: nowrap; }.clip-pass-badge { padding: 12px 20px; font-size: 24px; } }
</style>
<style>
.clip-deal-demo { width: min(500px, 90%); height: min(200px, 25vh); overflow: visible; }
@media (orientation: landscape) and (max-height: 550px) { .clip-deal-demo { height: 125px; width: 400px; } }
</style>

<style>
.clip-chess-viewport > .xiangqi-board { width: 100%; height: 100%; }.clip-xiangqi-facts { min-height: 42px; align-items: center; }.clip-xiangqi-refused { color: #a65a43; }
</style>
