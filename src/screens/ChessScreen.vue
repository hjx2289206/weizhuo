<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GameController } from '../useGame'
import { chessCoordinate, chessDestinations, chessName, chessSideName, CHESS_PROMOTIONS, CHESS_NAMES, type ChessBoard as Board, type ChessPromotion, type ChessSide } from '../../shared/chess'
import ChessBoard from '../components/ChessBoard.vue'
import ChessToken from '../components/ChessToken.vue'
import BoardAiControl from '../components/BoardAiControl.vue'
import { boardAiLabel } from '../../shared/boardAi'
import BrandMark from '../components/BrandMark.vue'
import GameTools from '../components/GameTools.vue'
import HostTools from '../components/HostTools.vue'
import SeatRequestPanel from '../components/SeatRequestPanel.vue'
import DialogShell from '../components/DialogShell.vue'
import AppIcon from '../components/AppIcon.vue'
import { useBoardPlayback } from '../useBoardPlayback'
const props = defineProps<{ game: GameController }>()
const emit = defineEmits<{ animating: [value: boolean] }>()
const s = computed(() => props.game.state.value?.game === 'chess' ? props.game.state.value : null)
const shared = computed(() => s.value?.roomMode === 'tablet')
const computer = computed(() => s.value?.boardAi?.config ?? null)
const humanSide = computed(() => computer.value ? (computer.value.side === 0 ? 1 : 0) : null)
const side = computed(() => shared.value && computer.value ? humanSide.value : s.value?.selfSeat ?? null)
const actingSide = computed(() => shared.value ? computer.value ? humanSide.value : s.value?.turn ?? null : side.value)
const { board, playback, animating } = useBoardPlayback(s, props.game.connected, {
  position: snapshot => {
    const tablet = snapshot.roomMode === 'tablet', ai = snapshot.boardAi?.config ?? null
    const viewer = tablet && ai ? (ai.side === 0 ? 1 : 0) : snapshot.selfSeat
    return { roundId: snapshot.chess.roundId, layout: `${viewer ?? 'none'}:${tablet && !ai ? 'opposed' : 'down'}`, board: snapshot.chess.board, moves: snapshot.chess.moves }
  },
  empty: [] as Board,
  canAnimate: (before, move) => before[move.from]?.id === move.piece.id && before[move.from]?.side === move.side && before[move.from]?.rank === move.piece.rank,
})
watch(animating, value => emit('animating', value), { immediate: true, flush: 'sync' })
const promotion = ref<{ from: number; to: number } | null>(null)
const resignSide = ref<ChessSide>(0), drawOpen = ref(false)
const selected = ref<number | null>(null), localBusy = ref(false), inviteOpen = ref(false), resignOpen = ref(false), requestsOpen = ref(false), historyOpen = ref(false), copied = ref(''), historyPage = ref(0)
const paused = computed(() => s.value?.phase === 'playing' && s.value.seats.some(seat => !seat.isBot && !seat.connected))
const locked = computed(() => localBusy.value || props.game.busy.value || !props.game.connected.value || paused.value || animating.value)
const editable = computed(() => !locked.value && s.value?.phase === 'playing' && s.value.turn === actingSide.value && actingSide.value !== null && (!shared.value || s.value.isHost))
const targets = computed(() => editable.value && selected.value !== null && s.value ? chessDestinations(s.value.chess.fen, selected.value) : [])
const me = computed(() => s.value?.seats.find(seat => seat.id === side.value))
const canStart = computed(() => s.value?.seats.every(seat => seat.name && seat.connected && seat.ready))
const last = computed(() => s.value?.chess.moves.at(-1) ?? null)
const lastSummary = computed(() => {
  const move = last.value
  if (!move) return '对局尚未开始'
  const tags = [move.captured ? `吃${chessName(move.captured)}` : '', move.castle ? '易位' : '', move.promotion ? `升变${CHESS_NAMES[move.promotion]}` : '', move.check ? '将军' : ''].filter(Boolean)
  return `第 ${move.ply} 手 · ${chessSideName(move.side)} ${chessCoordinate(move.from)}→${chessCoordinate(move.to)}${tags.length ? ` · ${tags.join(' · ')}` : ''}`
})
const moves = computed(() => (s.value?.chess.moves ?? []).slice(historyPage.value * 6, historyPage.value * 6 + 6))
watch(() => [s.value?.version, editable.value], () => { selected.value = null; promotion.value = null })
watch(() => s.value?.chess.roundId, () => { historyPage.value = 0; historyOpen.value = false; resignOpen.value = false })
async function run(action: () => Promise<void> | void): Promise<void> { if (localBusy.value) return; localBusy.value = true; try { await action() } catch (error) { props.game.error.value = error instanceof Error ? error.message : '操作失败' } finally { localBusy.value = false } }
function select(point: number): void {
  if (!editable.value || !s.value) return
  if (selected.value === point) { selected.value = null; return }
  if (selected.value !== null && targets.value.includes(point)) { const from = selected.value; selected.value = null; if (s.value.chess.board[from]?.rank === 'p' && (point < 8 || point >= 56)) promotion.value = { from, to: point }; else void run(() => props.game.chessMove(from, point)) }
  else if (s.value.chess.board[point]?.side === actingSide.value) selected.value = point
}
function promote(rank: ChessPromotion): void { const move = promotion.value; if (!move || !editable.value) return; promotion.value = null; void run(() => props.game.chessMove(move.from, move.to, rank)) }
async function copy(seat: number): Promise<void> { try { await navigator.clipboard.writeText(props.game.inviteUrl(seat)); copied.value = `已复制${chessSideName(seat)}链接` } catch { copied.value = '可以长按下方链接复制' } }
</script>
<template>
  <section v-if="s" class="chess-screen" :data-phase="s.phase" :data-shared="shared" :data-opposed="shared && !computer">
    <header class="chess-header"><div class="brand"><BrandMark /><strong>国际象棋</strong><span>房间 {{ s.code }}</span></div><div><GameTools :game="game" /><button class="tool-button" type="button" :disabled="game.busy.value" @click="run(game.leaveRoom)"><AppIcon name="home" /><span>大厅</span></button></div></header>
    <div class="chess-layout">
        <div class="chess-intro"><p class="eyebrow">黑白方寸 · 落子有声</p><h1>{{ s.phase === 'lobby' ? computer ? '准备好，和电脑下一局。' : shared ? '两人同屏，直接开局。' : '邀一位朋友，手谈一局。' : s.phase === 'finished' ? s.chess.draw ? '和棋，下局再见。' : `${chessSideName(s.chess.winner!)}获胜。` : s.boardAi?.error ? '电脑行棋已暂停。' : s.boardAi?.thinking ? '电脑正在思考。' : paused ? '等朋友回来，再继续。' : s.chess.check !== null ? '将军！先保护王。' : editable ? shared ? `轮到${chessSideName(s.turn!)}。` : '轮到你了。' : `等待${chessSideName(s.turn!)}行棋。` }}</h1><p role="status">{{ s.phase === 'lobby' ? computer ? `电脑难度：${boardAiLabel(computer.difficulty)}。准备好后点击开始对弈。` : shared ? '两人坐在平板两侧，不用手机，也不用摆棋。' : '双方准备后由房主开局，不用自己摆棋。' : s.boardAi?.error ? `${s.boardAi.error}，可点下方按钮重试。` : s.boardAi?.thinking ? '请稍候，电脑走完后轮到你。' : paused ? '有人掉线，对局已暂停，重连后继续。' : s.phase === 'finished' ? s.chess.reason : selected !== null ? `已选${chessName(s.chess.board[selected]!)}，绿色圆点是可以走的位置。` : shared && !computer ? '轮到哪一方，就点那一方的棋，再点绿色落点。' : '点一下自己的棋，再点绿色落点。' }}</p></div>
      <div class="chess-board-column"><div class="chess-board-meta"><span>{{ computer ? `人机对弈 · 你执${chessSideName(humanSide!)}` : shared ? '双人同屏 · 双方棋子各朝自己' : side === null ? '公开棋盘' : `你执${chessSideName(side)}` }}</span><span>{{ s.phase === 'lobby' ? '标准开局 · 白方先走' : s.phase === 'finished' ? '本局结束' : `第 ${s.chess.moves.length + 1} 步` }}</span></div><div class="chess-board-frame"><ChessBoard :board="board" :side="side" :selected="selected" :targets="targets" :disabled="!editable" :last="last" :opposed="shared && !computer" :checked="s.chess.check" :live="playback" @select="select" /></div></div>
      <aside class="chess-panel">

        <div class="chess-roster"><article v-for="seat in s.seats" :key="seat.id" :class="{ active: s.phase === 'playing' && s.turn === seat.id, 'is-white': seat.id === 0 }"><svg class="chess-seat-icon" viewBox="-30 -30 60 60" aria-hidden="true"><ChessToken :piece="{ id: `seat-${seat.id}`, side: seat.id as ChessSide, rank: 'k' }" :facing-away="shared && !computer && seat.id === 1" /></svg><div><strong>{{ seat.name ?? '等待朋友' }}<small v-if="side === seat.id">我</small><small v-if="s.hostSeatId === seat.id">房主</small></strong><span>{{ seat.isBot ? s.boardAi?.thinking ? '正在思考' : '自动行棋' : shared ? computer ? '玩家' : '平板同屏' : seat.name ? seat.connected ? s.phase === 'lobby' ? seat.ready ? '已准备' : '未准备' : '在线' : '等待重连' : `${chessSideName(seat.id)} · 空位` }}</span></div></article></div>
        <div v-if="s.phase === 'lobby'" class="chess-actions"><button v-if="!shared && side !== null" class="button" :class="me?.ready ? 'secondary' : 'primary'" :disabled="locked" @click="run(game.ready)">{{ me?.ready ? '取消准备' : '我准备好了' }}</button><button v-if="s.isHost" class="button primary" :disabled="locked || !canStart" @click="run(game.start)">开始对弈</button></div>
        <div v-else-if="s.phase === 'playing' && computer" class="chess-actions"><button class="button secondary" :disabled="locked" @click="resignSide = humanSide!; resignOpen = true">认输</button></div>
        <div v-else-if="s.phase === 'playing' && shared" class="chess-actions"><button class="button secondary" :disabled="locked" @click="drawOpen = true">双方和棋</button><button class="button secondary" :disabled="locked" @click="resignSide = 0; resignOpen = true">白方认输</button><button class="button secondary" :disabled="locked" @click="resignSide = 1; resignOpen = true">黑方认输</button></div>
        <div v-else-if="s.phase === 'playing' && side !== null" class="chess-actions"><template v-if="s.chess.drawOffer !== null && s.chess.drawOffer !== side"><span class="chess-offer">对方想和棋，是否同意？</span><button class="button secondary" :disabled="locked" @click="run(() => game.chessDraw('decline'))">继续下棋</button><button class="button primary" :disabled="locked" @click="run(() => game.chessDraw('accept'))">同意和棋</button></template><template v-else><button class="button secondary" :disabled="locked || s.chess.drawOffer !== null" @click="run(() => game.chessDraw('offer'))">{{ s.chess.drawOffer === side ? '等待对方同意' : '提议和棋' }}</button><button class="button secondary" :disabled="locked" @click="resignSide = side as ChessSide; resignOpen = true">认输</button></template></div>
        <div v-else-if="s.phase === 'finished'" class="chess-actions"><button v-if="s.isHost" class="button primary" :disabled="locked" @click="run(game.again)">再来一局</button><span v-else class="muted">等房主再开一局</span></div>
        <div class="chess-last" role="status"><span>{{ animating ? '正在行棋' : '上一手' }}</span><strong>{{ lastSummary }}</strong></div>
        <div class="chess-utilities"><button v-if="!shared && !computer" class="tool-button" type="button" @click="inviteOpen = true"><AppIcon name="users" />邀请朋友</button><button class="tool-button" type="button" :disabled="!s.chess.moves.length" @click="historyPage = Math.floor((s!.chess.moves.length - 1) / 6); historyOpen = true"><AppIcon name="history" />棋谱</button><BoardAiControl :game="game" /><HostTools v-if="s.isHost" :phase="s.phase" :room-mode="s.roomMode" :seats="s.seats" :self-seat="side" :busy="locked" @remove-offline="run(game.removeOfflineSeats)" @transfer="seat => run(() => game.transferHost(seat))" @dissolve="run(game.dissolveRoom)" /></div>
        <button v-if="s.isHost && s.seatRequests.length" class="tool-button" @click="requestsOpen = true">处理入座申请（{{ s.seatRequests.length }}）</button><p class="chess-short-rule">白方先行，王不能走进攻击范围。<br />兵到底线可升变，特殊走法见教程。</p>
      </aside>
    </div>
    <DialogShell v-if="promotion" title="兵升变：选择新棋子" class="chess-dialog" @close="promotion = null"><p>兵到达对方底线，必须变成后、车、象或马。</p><div class="chess-promotion"><button v-for="rank in CHESS_PROMOTIONS" :key="rank" class="button secondary" :disabled="locked" @click="promote(rank)"><svg viewBox="-30 -30 60 60" aria-hidden="true"><ChessToken :piece="{ id: `promotion-${rank}`, side: actingSide as ChessSide, rank }" /></svg>{{ CHESS_NAMES[rank] }}</button></div></DialogShell>
    <DialogShell v-if="inviteOpen" title="邀请朋友下象棋" class="chess-dialog" @close="inviteOpen = false"><p>朋友连接同一局域网，打开对应一方的链接即可入座。</p><div v-for="seat in s.seats" :key="seat.id" class="chess-invite-row"><button class="button secondary" @click="copy(seat.id)">复制{{ chessSideName(seat.id) }}链接</button><a :href="game.inviteUrl(seat.id)">{{ game.inviteUrl(seat.id) }}</a></div><p role="status">{{ copied }}</p></DialogShell>
    <DialogShell v-if="resignOpen" :title="shared ? `确认${chessSideName(resignSide)}认输？` : '确认认输？'" class="chess-dialog" @close="resignOpen = false"><p>认输后对方获胜，本局结束。</p><div class="chess-actions"><button class="button secondary" @click="resignOpen = false">继续下棋</button><button class="button primary" :disabled="locked" @click="resignOpen = false; run(() => game.chessResign(shared ? resignSide : undefined))">确认认输</button></div></DialogShell>
    <DialogShell v-if="drawOpen" title="双方同意和棋？" class="chess-dialog" @close="drawOpen = false"><p>确认后结束本局，双方不分胜负。</p><div class="chess-actions"><button class="button secondary" @click="drawOpen = false">继续下棋</button><button class="button primary" :disabled="locked" @click="drawOpen = false; run(() => game.chessDraw('agree'))">确认和棋</button></div></DialogShell>
    <DialogShell v-if="historyOpen" title="本局棋谱" class="chess-dialog" @close="historyOpen = false"><ol class="chess-history"><li v-for="move in moves" :key="move.ply"><span>{{ move.ply }}. {{ chessSideName(move.side) }}</span><strong>{{ move.notation }}</strong><small>{{ move.check ? '将军' : move.captured ? '吃子' : '' }}</small></li></ol><div class="chess-history-pager"><button class="review-button" :disabled="historyPage === 0" @click="historyPage--">上一页</button><span>{{ historyPage + 1 }} / {{ Math.max(1, Math.ceil(s.chess.moves.length / 6)) }}</span><button class="review-button" :disabled="(historyPage+1)*6 >= s.chess.moves.length" @click="historyPage++">下一页</button></div></DialogShell>
    <DialogShell v-if="requestsOpen && s.isHost && s.seatRequests.length" title="入座申请" @close="requestsOpen = false"><SeatRequestPanel :requests="s.seatRequests" :busy="locked" @decide="(id, approve) => run(() => game.decideSeatRequest(id, approve))" /></DialogShell>
  </section>
</template>
<style>
html:has(.chess-screen), body:has(.chess-screen) { height: 100%; overflow: hidden; overscroll-behavior: none; }
.chess-screen { height: 100dvh; width: 100%; overflow: hidden; padding: max(8px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); display: flex; flex-direction: column; gap: 8px; color: #294f3c; background: #f2efe2; }
.chess-header { display: flex; justify-content: space-between; align-items: center; min-height: 42px; gap: 15px; border-bottom: 1px solid #d2d8c1; flex: none; }.chess-header > div, .chess-header .brand { display: flex; gap: 12px; align-items: center; }.chess-header .brand > strong { font: 22px 'Songti SC',serif; font-weight: 500; }.chess-header .brand > span { font-size: 11px; color: #879477; letter-spacing: .06em; }.chess-header .brand-mark { width: 28px; height: 28px; }
.chess-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(235px, .62fr); gap: clamp(16px,3vw,45px); max-width: 1180px; width: 100%; margin: 0 auto; }
.chess-board-column { min-width: 0; min-height: 0; display: flex; flex-direction: column; }.chess-board-meta { display: flex; justify-content: space-between; font-size: 11px; padding: 3px 12px 7px; color: #7a8968; flex: none; }.chess-board-frame { flex: 1; min-height: 0; }.chess-panel { min-height: 0; display: flex; flex-direction: column; gap: clamp(10px,2vh,20px); padding: clamp(8px,2vh,24px) 0; }.chess-intro .eyebrow { font-size: 10px; color: #9a8555; margin: 0 0 10px; }.chess-intro h1 { font: clamp(22px,2.8vw,34px) 'Songti SC',serif; line-height: 1.4; margin: 0 0 10px; }.chess-intro > p:last-child { font-size: 12px; line-height: 1.7; color: #7d8b6e; margin: 0; min-height: 38px; }
.chess-roster { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }.chess-roster > article { display: flex; align-items: center; gap: 8px; padding: 12px 9px; border: 1px solid #d1d7bf; background: #f9f8ed; border-radius: 12px; min-width: 0; }.chess-roster > article.active { border-color: #a89458; background: #f8f0d9; }.chess-roster b { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid #baa478; border-radius: 50%; color: #394539; background: #f2e1ba; font: 23px 'Songti SC',serif; flex: none; }.chess-roster .is-white b { color: #a34534; }.chess-roster article > div { min-width: 0; }.chess-roster strong { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }.chess-roster small { font-size: 9px; margin-left: 4px; font-weight: normal; color: #859173; }.chess-roster article span { display: block; font-size: 10px; color: #839070; margin-top: 4px; }
.chess-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }.chess-actions .button { flex: 1; min-height: 40px; font-size: 12px; padding: 7px 10px; }.chess-offer { width: 100%; font-size: 12px; color: #977448; }.chess-last { display: flex; flex-direction: column; gap: 7px; padding: 12px 14px; border: 1px solid #d4d9c3; border-radius: 10px; font-size: 12px; }.chess-last > span { font-size: 10px; color: #919a7d; }.chess-last > strong { font-weight: 500; }.chess-utilities { display: flex; align-items: center; gap: 8px; margin-top: auto; }.chess-utilities .host-tools { margin-left: auto; }.chess-short-rule { color: #9a9e82; font-size: 11px; line-height: 1.8; margin: 0; }
.chess-dialog { overflow: hidden; }.chess-dialog > p { font-size: 12px; color: #768568; line-height: 1.8; }.chess-invite-row { display: flex; align-items: center; gap: 12px; margin: 15px 0; }.chess-invite-row .button { min-height: 36px; font-size: 12px; flex: none; }.chess-invite-row > a { min-width: 0; font-size: 11px; overflow-wrap: anywhere; color: #748662; }.chess-history { list-style: none; padding: 0; }.chess-history li { display: flex; align-items: center; justify-content: space-between; gap: 15px; padding: 8px 4px; border-bottom: 1px solid #dde2d0; font-size: 12px; }.chess-history li > span, .chess-history li small { color: #899579; font-size: 11px; }.chess-history-pager { display: flex; align-items: center; justify-content: space-between; gap: 14px; font-size: 11px; color: #859372; margin-top: 12px; }
@media (orientation: landscape) and (max-height:550px) { .chess-screen { padding: 4px max(12px, env(safe-area-inset-right)) 5px max(12px, env(safe-area-inset-left)); gap: 4px; }.chess-header { min-height: 31px; }.chess-header .brand > strong { font-size: 17px; }.chess-header .brand-mark { width: 23px; height: 23px; }.chess-layout { grid-template-columns: minmax(0,1fr) minmax(270px,.85fr); gap: 18px; }.chess-board-meta { padding: 2px 6px 3px; font-size: 9px; }.chess-panel { gap: 8px; padding: 3px 0; }.chess-intro .eyebrow { margin-bottom: 4px; font-size: 8px; }.chess-intro h1 { font-size: 21px; margin-bottom: 4px; }.chess-intro > p:last-child { font-size: 10px; min-height: 29px; }.chess-roster > article { padding: 7px; border-radius: 9px; }.chess-roster b { width: 29px; height: 29px; font-size: 21px; }.chess-roster strong { font-size: 11px; }.chess-roster article span { font-size: 9px; margin-top: 2px; }.chess-actions .button { min-height: 32px; font-size: 11px; padding: 5px 9px; }.chess-last { gap: 3px; padding: 7px 10px; font-size: 11px; }.chess-short-rule { font-size: 9px; }.chess-utilities .tool-button { min-height: 28px; padding: 5px 8px; font-size: 10px; }.chess-history li { padding: 5px; font-size: 11px; }.chess-dialog.tools-dialog { padding: 13px 18px; }.chess-dialog .tools-dialog-heading { margin-bottom: 6px; }.chess-history-pager { margin-top: 7px; }.chess-header .tool-button { min-height: 28px; padding: 4px 7px; }.chess-header .tool-button > span { font-size: 10px; } }
@media (max-height:340px) and (orientation:landscape) { .chess-intro .eyebrow, .chess-short-rule { display: none; }.chess-intro h1 { font-size: 18px; }.chess-panel { gap: 5px; }.chess-last { padding: 4px 8px; }.chess-roster > article { padding: 5px; } }
</style>
<style>
/* Both local and network chess use the portrait board composition. */
@media (orientation:portrait) {
 .chess-screen { padding: max(8px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left)); gap: 10px; }
 .chess-layout { display: flex; flex-direction: column; gap: 9px; max-width: 820px; }
 .chess-panel { display: flex; flex: none; order: 2; padding: 0; gap: 9px; }
 .chess-intro { order: 0; flex: none; }.chess-intro .eyebrow { display: none; }.chess-intro h1 { font-size: clamp(23px,3vw,30px); margin: 0 0 4px; }.chess-intro > p:last-child { font-size: 11px; min-height: 0; line-height: 1.6; }
 .chess-board-column { order: 1; flex: 1; min-height: 0; }.chess-board-meta { padding: 0 6px 5px; font-size: 10px; }
 .chess-roster { order: 2; flex: none; }.chess-roster > article { padding: 8px 12px; }.chess-roster b { width: 30px; height: 30px; font-size: 22px; }.chess-roster article span { margin-top: 2px; }.chess-roster > article:not(.active) { background: #f9f8ed; }
 .chess-actions { order: 3; flex: none; }.chess-actions .button { min-height: 38px; font-size: 12px; }
 .chess-last { order: 4; flex: none; flex-direction: row; align-items: baseline; flex-wrap: wrap; row-gap: 2px; gap: 12px; border: 0; padding: 3px 2px; font-size: 11px; }
 .chess-utilities { order: 5; flex: none; margin: 0; padding-top: 4px; border-top: 1px solid #d6dcc6; }.chess-short-rule { display: none; }
 .chess-dialog .chess-actions { margin-top: 15px; }
 .chess-header .brand > strong { font-size: 20px; }.chess-header .brand > span:not(.brand-mark) { font-size: 10px; }.chess-header .brand { gap: 8px; }.chess-header { min-height: 36px; gap: 8px; }.chess-header > div:last-child { gap: 7px; }
 .chess-screen[data-opposed="true"] .chess-roster .is-white b { transform: none; }.chess-screen[data-opposed="true"] .chess-roster article:not(.is-white) b { transform: rotate(180deg); }
}
@media (orientation:portrait) and (max-width:600px) {
 .chess-screen { padding-left: max(10px,env(safe-area-inset-left)); padding-right: max(10px,env(safe-area-inset-right)); gap: 6px; }.chess-layout, .chess-panel { gap: 7px; }
 .chess-header .brand > strong { font-size: 17px; }.chess-header .brand-mark { width: 25px; height: 25px; }.chess-header .brand > span:not(.brand-mark) { font-size: 9px; letter-spacing: 0; }.chess-header .tool-button { min-height: 30px; padding: 5px 7px; font-size: 10px; }.chess-header .tools-trigger { width: 31px; height: 31px; }
 .chess-intro h1 { font-size: 23px; }.chess-roster > article { padding: 7px 9px; }.chess-roster strong { font-size: 11px; }.chess-roster article span { font-size: 9px; }.chess-actions .button { min-height: 35px; font-size: 11px; }.chess-utilities .tool-button { min-height: 31px; font-size: 11px; }
}
@media (orientation:portrait) and (max-height:740px) {
 .chess-screen { padding-block: 5px; gap: 4px; }.chess-layout, .chess-panel { gap: 4px; }.chess-header { min-height: 32px; }.chess-intro h1 { font-size: 20px; margin-bottom: 2px; }.chess-intro > p:last-child { font-size: 10px; }.chess-board-meta { font-size: 9px; padding-bottom: 2px; }.chess-roster > article { padding: 4px 8px; }.chess-roster b { width: 26px; height: 26px; font-size: 19px; }.chess-actions .button { min-height: 32px; }.chess-last { padding: 1px 2px; font-size: 10px; }.chess-utilities { padding-top: 3px; }.chess-utilities .tool-button { min-height: 28px; }
}
</style>
<style>
@media (orientation:portrait) and (max-width:360px) { .chess-header .brand > span:not(.brand-mark) { display: none; } }
</style>

<style>
.chess-seat-icon { width: 36px; height: 36px; flex: none; }.chess-promotion { display: flex; gap: 9px; }.chess-promotion .button { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0; }.chess-promotion svg { width: 48px; height: 48px; }.chess-utilities .host-tools-menu { top: auto; bottom: calc(100% + 7px); }
</style>
