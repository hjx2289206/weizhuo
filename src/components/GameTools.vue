<script setup lang="ts">
import { GAME_DEFINITIONS, isBoardGame } from '../../shared/gameCatalog'
import { computed, inject, ref, watch } from 'vue'
import type { GameController } from '../useGame'
import { GAME_TOOLS } from '../gameTools'
import { exportResultImage } from '../resultHistory'
import DialogShell from './DialogShell.vue'
import GameRules from './GameRules.vue'
import GameTutorialButton from './GameTutorialButton.vue'
import AppIcon from './AppIcon.vue'
import { SITE_SCREEN } from '../siteScreen'
import { releaseDocumentFullscreen } from '../usePhoneScreen'

const props = defineProps<{ game: GameController }>()
const tools = inject(GAME_TOOLS)
const menuOpen = ref(false)
const rulesOpen = ref(false)
const historyOpen = ref(false)
const historyIndex = ref(0), movePage = ref(0), movesOpen = ref(false)
const historyRecord = computed(() => tools?.records.value[historyIndex.value] ?? null)
watch(historyIndex, () => { movePage.value = 0; movesOpen.value = false })
const notice = ref('')
watch(() => tools?.resultOpen.value, open => {
  if (open) { menuOpen.value = false; rulesOpen.value = false; historyOpen.value = false }
})
const awake = tools?.awake
const screen = inject(SITE_SCREEN)
const screenNotice = ref('')
async function toggleFullscreen(): Promise<void> {
  screenNotice.value = ''
  try { if (screen?.active.value) await releaseDocumentFullscreen(); else screen?.enter() }
  catch { screenNotice.value = '浏览器暂时无法切换全屏，可使用浏览器横屏' }
}
const awakeText = computed(() => awake?.active.value ? '常亮中' : awake?.enabled.value ? '常亮待恢复' : '常亮')
const phaseTip = computed(() => {
  const s = props.game.state.value
  if (!s) return '选择游戏查看玩法；扫码加入时先确认房间和座位。'
  if (s.game === 'reversi') return '选有小圆点的格子，再确认落子。被夹住的棋子会翻面。无合法落点时自动停一手，终局子多者胜。'
  if (s.game === 'go') return '先点空交叉点，再确认落子。双方连续停一手后确认死子，双方同意后才按数子法结算，黑贴 7.5 点；有争议可以继续下棋。'
  if (s.game === 'gomoku' && s.boardAi?.config) return '先点空交叉点，再确认落子。等电脑走完后可悔棋，退回到你上一手之前。'
  if (s.game === 'gomoku') return '15 路无禁手五子棋，黑先白后。先点空交叉点再确认；横、竖、斜先连成五子或以上获胜。'
  if (s.boardAi?.config) return '点自己的棋，再点绿色落点；电脑会自动应手。电脑思考时不能替它行棋，异常时可重试。难度在开局前设置。'
  if (s.game === 'chess') return '白方先行；点当前一方的棋，再点绿色落点。兵到底线需选择升变；将死获胜，逼和算和棋。'
  if (s.game === 'xiangqi') return s.roomMode === 'tablet' ? '红方先走，两人轮流操作；点当前一方的棋，再点绿色落点。被将军时必须先解围。' : '红方先走；点自己的棋，再点绿色落点。被将军时必须先解围，没有合法走法也判负。'
  if (s.game === 'junqi') return s.phase === 'deploying' ? '先调整己方布阵，再确认；所有玩家确认后红方先行。' : s.junqi.variant === 'four' ? '红绿同队，蓝紫同队；只看自己的棋子，出局后可继续观战。' : '点选己方棋子，再点带绿点的位置行棋；行营保护，大本营禁动。'
  if (s.phase === 'bidding') return '按顺序叫 1–3 分；叫 3 分直接成为地主，全部不叫则重新发牌。'
  if (s.phase === 'tribute') return '进贡选最大的非红桃级牌；还贡选不超过 10 的非级牌，没有则选最小牌。提交齐后同时公开。'
  if (s.game === 'guandan') return '红桃级牌可配非王牌；多种牌型解释时需自行选择。四王 > 六张及以上炸弹 > 同花顺 > 五张炸弹 > 四张炸弹。'
  return '先选牌再出牌；顺子不含 2 和王，首出不能不出。炸弹与火箭可压普通牌型。'
})
function toggleAwake(): void {
  if (!awake?.supported) return
  if (awake.enabled.value && !awake.active.value) void awake.retry()
  else awake.setEnabled(!awake.enabled.value)
}
async function save(index: number): Promise<void> {
  const record = tools?.records.value[index]
  if (!record) return
  try { await exportResultImage(record); notice.value = '图片已生成，请查看浏览器下载' }
  catch (e) { notice.value = e instanceof Error ? e.message : '无法生成图片' }
}
</script>
<template>
  <nav class="game-tools" aria-label="显示与游戏工具">
    <GameTutorialButton v-if="game.mode.value !== 'home' && game.gameKind.value" :game="game.gameKind.value" :opposed="(game.gameKind.value === 'xiangqi' || game.gameKind.value === 'chess') && game.state.value?.roomMode === 'tablet' && !game.state.value?.boardAi?.config" :live="!!game.state.value && !['lobby', 'finished'].includes(game.state.value.phase)" />
    <button type="button" class="tool-button tools-trigger" aria-label="工具" title="工具" :class="{ 'has-active-lock': awake?.active.value }" :aria-expanded="menuOpen" @click="menuOpen = true"><AppIcon name="settings" /><span v-if="awake?.active.value" class="tool-active-dot" aria-label="屏幕常亮中"></span></button>
    <DialogShell v-if="menuOpen" title="显示与对局" @close="menuOpen = false">
      <p class="tools-lead">调好屏幕，安心开局。</p>
      <div class="tools-menu-actions">
        <button type="button" class="tool-tile" :aria-pressed="awake?.enabled.value ?? false" @click="toggleAwake"><span class="tool-tile-icon"><AppIcon name="sun" /></span><span><strong>{{ awakeText }}</strong><small>{{ awake?.supported ? '让屏幕保持明亮' : '查看设备支持情况' }}</small></span><span class="tool-switch" aria-hidden="true"></span></button>
        <button type="button" class="tool-tile" :aria-pressed="screen?.active.value ?? false" @click="toggleFullscreen"><span class="tool-tile-icon"><AppIcon :name="screen?.active.value ? 'restore' : 'fullscreen'" /></span><span><strong>{{ screen?.active.value ? '退出全屏' : game.gameKind.value && isBoardGame(game.gameKind.value) ? '竖屏全屏' : '横屏全屏' }}</strong><small>{{ game.gameKind.value && isBoardGame(game.gameKind.value) ? '竖屏展示棋盘与操作' : '完整展示牌桌与手牌' }}</small></span></button>
        <button type="button" class="tool-tile" @click="menuOpen = false; rulesOpen = true"><span class="tool-tile-icon"><AppIcon name="book" /></span><span><strong>游戏规则</strong><small>查看当前阶段怎么玩</small></span><AppIcon name="right" /></button>
        <button type="button" class="tool-tile" @click="menuOpen = false; historyOpen = true"><span class="tool-tile-icon"><AppIcon name="history" /></span><span><strong>聚会战绩</strong><small>留住每一局的精彩</small></span><AppIcon name="right" /></button>
        <button v-if="game.state.value?.phase === 'finished'" type="button" class="tool-tile tool-tile-result" @click="menuOpen = false; tools && (tools.resultOpen.value = true)"><span class="tool-tile-icon"><AppIcon name="trophy" /></span><span><strong>本局结算</strong><small>得分、名次与出牌回顾</small></span><AppIcon name="right" /></button>
      </div>
      <p class="tools-support-note" role="status">{{ screenNotice || awake?.note.value }}</p>
      <p class="tools-context"><AppIcon name="book" /><span>{{ phaseTip }}</span></p>
    </DialogShell>
    <GameRules v-if="rulesOpen" :initial-game="game.gameKind.value" :context-note="phaseTip" @close="rulesOpen = false" />
    <DialogShell v-if="historyOpen" class="history-dialog" title="聚会战绩" @close="historyOpen = false">
      <p>保存本浏览器看到的最近 100 副结算；重启服务后仍可查看，清理浏览器数据后会消失。</p>
      <p v-if="tools?.storageNote.value" role="status">{{ tools.storageNote.value }}</p>
      <p v-if="!tools?.records.value.length">还没有战绩，完成一局后自动记录。</p>
      <template v-if="historyRecord">
        <article class="history-record">
          <small>{{ GAME_DEFINITIONS[historyRecord.game].name }} · {{ historyRecord.code }} · {{ new Date(historyRecord.date).toLocaleString('zh-CN') }}</small>
          <h3><AppIcon name="trophy" />{{ historyRecord.title }}</h3><p>{{ historyRecord.detail }}</p>
          <p class="history-players">{{ historyRecord.players.map(p => `${p.name}${p.delta !== undefined ? ` ${p.delta > 0 ? '+' : ''}${p.delta}` : ''}`).join(' · ') }}</p>
          <div class="review-actions"><button class="review-button" :disabled="!historyRecord.plays.length" @click="movesOpen = !movesOpen">{{ isBoardGame(historyRecord.game) ? '行棋记录' : '出牌记录' }}（{{ historyRecord.plays.length }} 手）</button><button class="review-button" @click="save(historyIndex)"><AppIcon name="download" />保存战绩</button></div>
          <div v-if="movesOpen" class="history-moves"><p v-for="(play,i) in historyRecord.plays.slice(movePage*2, movePage*2+2)" :key="i">{{ play.name }}：{{ play.cards }}</p><nav class="replay-controls"><button class="review-button" :disabled="movePage === 0" @click="movePage--">前两手</button><span>{{ movePage*2+1 }} / {{ historyRecord.plays.length }}</span><button class="review-button" :disabled="(movePage+1)*2 >= historyRecord.plays.length" @click="movePage++">后两手</button></nav></div>
        </article>
        <nav class="replay-controls"><button class="review-button" :disabled="historyIndex === 0" @click="historyIndex--">较新一局</button><span>{{ historyIndex + 1 }} / {{ tools?.records.value.length }}</span><button class="review-button" :disabled="historyIndex+1 >= (tools?.records.value.length ?? 0)" @click="historyIndex++">较早一局</button></nav>
      </template>
      <p v-if="notice" role="status">{{ notice }}</p>
    </DialogShell>
  </nav>
</template>
