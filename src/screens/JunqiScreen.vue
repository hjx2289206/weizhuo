<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GameController } from '../useGame'
import { JUNQI_NAMES, canDeployJunqi, junqiAllied, junqiCoordinate, junqiDestinations, junqiSideName, type JunqiVariant, type JunqiBoard as Board } from '../../shared/junqi'
import JunqiBoard from '../components/JunqiBoard.vue'
import JunqiFourBoard from '../components/JunqiFourBoard.vue'
import BrandMark from '../components/BrandMark.vue'
import GameTools from '../components/GameTools.vue'
import AppIcon from '../components/AppIcon.vue'
import HostTools from '../components/HostTools.vue'
import SeatRequestPanel from '../components/SeatRequestPanel.vue'
import { useBoardPlayback } from '../useBoardPlayback'

const props = defineProps<{ game: GameController }>()
const emit = defineEmits<{ animating: [value: boolean] }>()
const s = computed(() => props.game.state.value?.game === 'junqi' ? props.game.state.value : null)
const { board, playback, animating } = useBoardPlayback(s, props.game.connected, {
  position: snapshot => ({ roundId: snapshot.junqi.roundId, layout: snapshot.junqi.variant, board: snapshot.junqi.board, moves: snapshot.junqi.moves }),
  empty: [] as Board,
  canAnimate: (before, move) => before[move.from]?.side === move.side,
})
watch(animating, value => emit('animating', value), { immediate: true, flush: 'sync' })
const side = computed(() => s.value?.selfSeat ?? null)
const variant = computed(() => s.value?.junqi.variant ?? 'two')
const four = computed(() => variant.value === 'four')
const focusArmy = ref(false)
const zoom = ref(false)
const selected = ref<number | null>(null)
const rulesOpen = ref(false)
const inviteOpen = ref(false)
const resignOpen = ref(false)
const copied = ref('')
const localBusy = ref(false)
const me = computed(() => s.value?.seats.find(p => p.id === side.value))
const paused = computed(() => !!s.value && s.value.phase !== 'lobby' && s.value.phase !== 'finished' && s.value.seats.some(p => !p.connected && !s.value!.junqi.eliminated[p.id]))
const locked = computed(() => localBusy.value || props.game.busy.value || !props.game.connected.value || paused.value || animating.value)
const editable = computed(() => !!s.value && side.value !== null && !s.value.junqi.eliminated[side.value] && !locked.value && (s.value.phase === 'deploying' ? !s.value.junqi.deployed[side.value] : s.value.phase === 'playing' && s.value.turn === side.value))
const canStart = computed(() => !!s.value?.isHost && s.value.seats.length === (four.value ? 4 : 2) && s.value.seats.every(p => p.name && p.ready && p.connected))
const targets = computed(() => {
  const p = selected.value, snapshot = s.value;
  if (p === null || !snapshot || !editable.value) return [];
  if (snapshot.phase === 'playing') return junqiDestinations(board.value, p, variant.value);
  const a = board.value[p];
  return board.value.flatMap((b, to) => a?.rank && b?.rank && a.side === b.side && to !== p && canDeployJunqi(a.rank, a.side, to, variant.value) && canDeployJunqi(b.rank, b.side, p, variant.value) ? [to] : []);
})
const lastMove = computed(() => s.value?.junqi.moves.at(-1) ?? null)
const recent = computed(() => (s.value?.junqi.moves ?? []).slice(-8).reverse())
const phaseText = computed(() => ({ lobby: '等待开局', deploying: '秘密布阵', playing: '对弈中', finished: '本局结束' }[s.value?.phase ?? 'lobby']))
const outcome = { move: '行军', attacker: '进攻方胜', defender: '防守方胜', both: '同归于尽' }
const flagsText = computed(() => s.value?.junqi.revealedFlags.flatMap((shown, seat) => shown ? [junqiSideName(seat)] : []).join('、'))
const selectedPiece = computed(() => selected.value === null ? null : board.value[selected.value])
const coordinate = (p: number) => junqiCoordinate(p, variant.value)
function relation(seat: number) { return side.value === null || seat === side.value ? '' : junqiAllied(seat, side.value, variant.value) ? '队友' : '对手' }
watch(() => [s.value?.phase, s.value?.turn, s.value?.version, editable.value], () => { selected.value = null })
watch(() => [s.value?.phase, variant.value], () => { focusArmy.value = s.value?.phase === 'deploying'; zoom.value = false; resignOpen.value = false }, { immediate: true })
watch(() => playback.value?.move.ply, ply => { if (ply) { focusArmy.value = false; zoom.value = false } })
async function run(action: () => Promise<void> | void) {
  if (localBusy.value) return;
  localBusy.value = true;
  try { await action() } catch (e) { props.game.error.value = e instanceof Error ? e.message : '操作失败' } finally { localBusy.value = false }
}
function select(p: number) {
  if (!editable.value) return;
  if (selected.value === p) { selected.value = null; return }
  if (selected.value !== null && targets.value.includes(p)) {
    const from = selected.value; selected.value = null;
    void run(() => s.value?.phase === 'deploying' ? props.game.junqiSetup('swap', from, p) : props.game.junqiMove(from, p)); return;
  }
  if (board.value[p]?.side === side.value) selected.value = p;
}
async function copyInvite(seat: number) {
  try { await navigator.clipboard.writeText(props.game.inviteUrl(seat)); copied.value = `已复制 ${junqiSideName(seat)}邀请链接` }
  catch { copied.value = '请长按下方链接复制' }
}
</script>
<template>
  <section v-if="s" class="junqi-screen">
    <header class="junqi-header">
      <div class="junqi-brand"><BrandMark /><span>军棋<small>{{ four ? '四国暗棋' : '双人暗棋' }}</small></span></div>
      <div class="junqi-header-tools"><span class="junqi-room">房间 {{ s.code }}</span><span class="junqi-status-dot" :class="{ online: game.connected.value }">{{ game.connected.value ? '已连接' : '重连中' }}</span><GameTools :game="game" /><button class="tool-button" @click="game.leaveRoom()"><AppIcon name="home" />大厅</button></div>
    </header>
    <div v-if="s.phase === 'lobby'" class="junqi-mode-picker">
      <div class="junqi-mode-tabs" role="group" aria-label="军棋玩法">
        <button v-for="mode in (['two', 'four'] as JunqiVariant[])" :key="mode" :aria-pressed="variant === mode" :disabled="locked || !s.isHost" @click="run(() => game.setJunqiMode(mode))">{{ mode === 'four' ? '四国暗棋' : '双人暗棋' }}<small>{{ mode === 'four' ? '4 人 · 对坐同队' : '2 人 · 一对一' }}</small></button>
      </div>
      <p>{{ four ? '红绿同队，蓝紫同队；队友的棋子也不公开。' : '秘密布阵，双方各用私人屏幕。' }}{{ s.isHost ? ' 开局前可切换玩法。' : ' 玩法由房主选择。' }}</p>
    </div>
    <p v-else class="junqi-game-kind">{{ four ? '四国四暗 · 红绿 / 蓝紫' : '双人暗棋' }}</p>
    <div class="junqi-layout">
      <div class="junqi-board-column"><div class="junqi-board-heading"><span>{{ side === null ? '观战棋盘' : `你执${junqiSideName(side)}` }}</span><span>{{ phaseText }}<template v-if="s.phase === 'playing'"> · {{ s.turn === side ? '轮到你' : `${junqiSideName(s.turn!)}行棋` }} · 第 {{ s.junqi.moves.length + 1 }} 步</template></span></div>
        <p v-if="lastMove" class="junqi-last-move" role="status">{{ animating ? '正在行棋' : '上一手' }} · 第 {{ lastMove.ply }} 步 · {{ junqiSideName(lastMove.side) }} {{ coordinate(lastMove.from) }} → {{ coordinate(lastMove.to) }} · {{ outcome[lastMove.outcome] }}</p>
        <div class="junqi-board-frame" :class="{ 'is-four': four, 'is-army': four && focusArmy }"><JunqiFourBoard v-if="four" :board="board" :side="side" :selected="selected" :targets="targets" :disabled="!editable" :last="lastMove" :playback="playback" :focus-army="focusArmy" :zoom="zoom" @select="select" /><JunqiBoard v-else :board="board" :side="side" :selected="selected" :targets="targets" :disabled="!editable" :last="lastMove" :playback="playback" @select="select" /></div>
        <div v-if="four" class="junqi-board-controls" role="group" aria-label="棋盘视图"><button class="junqi-small-button" :aria-pressed="!focusArmy && !zoom" @click="focusArmy = false; zoom = false">全盘</button><button v-if="side !== null" class="junqi-small-button" :aria-pressed="focusArmy" @click="focusArmy = !focusArmy; zoom = false">我的阵地</button><button class="junqi-small-button" :aria-pressed="zoom" @click="focusArmy = false; zoom = !zoom">{{ zoom ? '缩回全盘' : '放大棋盘' }}</button><small>{{ zoom ? '滑动查看各方阵地' : '自己的阵地始终在下方' }}</small></div>
        <p v-if="selectedPiece?.rank" class="junqi-selection-note">已选 {{ JUNQI_NAMES[selectedPiece.rank] }} · {{ coordinate(selected!) }} · {{ targets.length }} 个可选位置</p>
      </div>
      <aside class="junqi-panel">
        <div class="junqi-intro"><p class="eyebrow">调兵遣将 · 暗中博弈</p><h1>{{ s.phase === 'deploying' ? '先布阵，再交锋。' : s.phase === 'finished' ? s.junqi.draw ? '和棋，再战一局。' : '胜负已定。' : '运筹方寸之间。' }}</h1><p class="junqi-message" role="status">{{ s.message }}</p></div>
        <div class="junqi-roster">
          <article v-for="seat in s.seats" :key="seat.id" class="junqi-seat" :class="{ 'is-turn': s.phase === 'playing' && s.turn === seat.id, 'is-out': s.junqi.eliminated[seat.id] }">
            <span class="junqi-side" :class="['red', 'blue', 'green', 'purple'][seat.id]">{{ junqiSideName(seat.id).slice(0, 1) }}</span>
            <div><strong>{{ seat.name ?? '虚位以待' }}<small v-if="seat.id === side">我</small><small v-else-if="four">{{ relation(seat.id) }}</small><small v-if="seat.id === s.hostSeatId">房主</small></strong><p>{{ s.junqi.eliminated[seat.id] ? `已出局 · ${s.junqi.eliminationReasons[seat.id]}` : seat.name ? seat.connected ? '在线' : '等待重连' : '邀请朋友入座' }}<template v-if="s.phase === 'lobby' && seat.name"> · {{ seat.ready ? '已准备' : '未准备' }}</template><template v-else-if="s.phase === 'deploying'"> · {{ s.junqi.deployed[seat.id] ? '已确认' : '布阵中' }}</template></p></div>
          </article>
        </div>
        <div v-if="s.phase === 'lobby'" class="junqi-actions">
          <button v-if="side !== null" class="button" :class="me?.ready ? 'secondary' : 'primary'" :disabled="locked" @click="run(game.ready)">{{ me?.ready ? '取消准备' : '我准备好了' }}</button>
          <button v-if="s.isHost" class="button primary" :disabled="locked || !canStart" @click="run(game.start)">开始布阵</button>
          <p class="junqi-help">{{ four ? '四位' : '两位' }}玩家入座并准备后，由房主开始。请邀请朋友分别入座。</p>
        </div>
        <div v-else-if="s.phase === 'deploying'" class="junqi-actions">
          <template v-if="side !== null && !s.junqi.deployed[side]"><button class="button secondary" :disabled="locked" @click="run(() => game.junqiSetup('shuffle'))">随机布阵</button><button class="button primary" :disabled="locked" @click="run(() => game.junqiSetup('confirm'))">确认布阵</button></template>
          <p class="junqi-help">{{ side === null ? '请在各自手机上布阵。观战棋盘不显示暗子身份。' : s.junqi.deployed[side] ? '你的阵形已锁定，等待所有玩家就绪。' : '点选己方棋子，再点带绿点的棋子交换位置。确认后本局不能再调整。' }}</p>
        </div>
        <div v-else-if="s.phase === 'finished'" class="junqi-actions"><button v-if="s.isHost" class="button primary" :disabled="locked" @click="run(game.again)">再来一局</button><p class="junqi-help">{{ s.junqi.reason }} · 全部存活棋子已揭晓</p></div>
        <div v-if="side !== null && s.phase === 'playing' && !s.junqi.eliminated[side]" class="junqi-manage"><button class="junqi-text-button" :disabled="locked" @click="resignOpen = !resignOpen">认输</button></div>
        <div v-if="resignOpen && s.phase === 'playing'" class="junqi-confirm"><p>{{ four ? '确认自己认输出局？你的棋子会被移除，队友继续作战。' : '确认认输并结束本局？' }}</p><button class="button secondary" @click="resignOpen = false">继续下棋</button><button class="button primary" :disabled="locked" @click="resignOpen = false; run(game.junqiResign)">确认认输</button></div>
        <p v-if="flagsText && s.phase !== 'finished'" class="junqi-flag-note">{{ flagsText }}司令阵亡，军旗位置已公开。</p>
        <div class="junqi-utilities"><button class="junqi-text-button" :aria-expanded="inviteOpen" @click="inviteOpen = !inviteOpen">邀请朋友</button><button class="junqi-text-button" :aria-expanded="rulesOpen" @click="rulesOpen = !rulesOpen">军棋规则</button></div>
        <div v-if="inviteOpen" class="junqi-invites"><p>同一 Wi-Fi 下打开链接，选择对应一方入座。</p><div v-for="seat in s.seats" :key="seat.id"><button class="junqi-small-button" @click="copyInvite(seat.id)">复制{{ junqiSideName(seat.id) }}链接</button><a :href="game.inviteUrl(seat.id)">{{ game.inviteUrl(seat.id) }}</a></div><p role="status">{{ copied }}</p></div>
        <div v-if="rulesOpen" class="junqi-rules"><p v-if="four">对坐同队：红绿一队，蓝紫一队。四暗模式中，只能看到自己的棋子，队友也保持暗棋。红方先行，依次红、蓝、绿、紫，跳过已出局方。不能攻击队友，也不能穿过队友棋子。</p><p>每方 25 枚。军旗必须在大本营，地雷只放后两排，炸弹不能在最前排，行营开局不放子。</p><p>公路走一格；铁路沿线行进，普通子不能在铁路交叉口换线，工兵可转弯；途中不能越子。行营中的棋子不能被攻击。军旗、地雷和进入大本营的棋子不能移动。</p><p>司令＞军长＞师长＞旅长＞团长＞营长＞连长＞排长＞工兵；同级同归于尽。工兵排雷，其他军衔撞雷败；炸弹与任何敌子同归于尽。</p><p>司令阵亡亮出军旗。{{ four ? '被夺旗、无棋可走或认输的一方出局并移除棋子，队友继续；一队全部出局，另一队获胜。' : '夺旗或使对方无棋可走获胜。' }}连续 70 步无交战和棋。结束后全部存活棋子公开。</p></div>
        <div v-if="recent.length" class="junqi-history"><h2>最近行棋 <span>共 {{ s.junqi.moves.length }} 步</span></h2><ol><li v-for="move in recent" :key="move.ply"><span>{{ move.ply }}. {{ junqiSideName(move.side).slice(0, 1) }} {{ coordinate(move.from) }} → {{ coordinate(move.to) }}</span><small>{{ outcome[move.outcome] }}</small></li></ol></div>
        <HostTools v-if="s.isHost" :phase="s.phase" :room-mode="s.roomMode" :seats="s.seats" :self-seat="s.selfSeat" :busy="locked" @remove-offline="run(game.removeOfflineSeats)" @transfer="seat => run(() => game.transferHost(seat))" @dissolve="run(game.dissolveRoom)" />
        <SeatRequestPanel v-if="s.isHost && s.seatRequests.length" :requests="s.seatRequests" :busy="locked" @decide="(id, approve) => run(() => game.decideSeatRequest(id, approve))" />
      </aside>
    </div>
  </section>
</template>
