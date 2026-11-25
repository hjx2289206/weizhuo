<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { GAME_DEFINITIONS, isBoardGame } from '../../shared/gameCatalog'
import type { GameKind } from '../../shared/protocol'
import { RULE_TABS } from '../gamePresentation'
import { BOARD_UNDO_LIMIT } from '../../shared/boardUndo'

/**
 * User-facing rule sheet. It states the frozen choices of this version next to the source they
 * were adapted from; it never copies a rule book wholesale.
 */
const props = defineProps<{ initialGame?: GameKind | null; contextNote?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

interface RuleRow {
  term: string
  detail: string
}

const DOUDIZHU: RuleRow[] = [
  { term: '人数与牌', detail: '3 人一副牌 54 张：每人 17 张，底牌 3 张。' },
  { term: '叫地主', detail: '依次叫分 1–3，3 分直接成为地主；全部不叫则重新发牌。' },
  { term: '胜负', detail: '地主先出完获胜，或两名农民中有任意一人先出完则农民获胜。' },
  { term: '计分', detail: '零和计分：地主 ±2×底分×倍数，两名农民各取反。' },
  { term: '牌局保留', detail: '牌局只保存在服务内存，重启即清空；无人 30 分钟后回收。' },
]

const GUANDAN: RuleRow[] = [
  { term: '人数与牌', detail: '4 人两副牌 108 张，每人 27 张；1、3 号座同队，2、4 号座同队。' },
  {
    term: '级牌与升级',
    detail: '从 2 打起；头游与二游同队时升 3 级（双下），队友三游升 2 级，队友末游升 1 级。',
  },
  { term: '整场胜负', detail: '升到 A 不等于过 A：本副必须打 A，获胜队在本副前已到 A，且取得头游、搭档不是末游，才赢下整场。未过 A 不降级。' },
  {
    term: '牌型',
    detail: '单张、对子、三张、三带二、顺子（5 张）、三连对、二连三张、炸弹、同花顺、四大天王。',
  },
  {
    term: '大小',
    detail: '四大天王 > 6 张及以上炸弹 > 同花顺 > 5 张炸弹 > 4 张炸弹 > 其余七种。炸弹先比张数、再比点数；同型必须严格大于，花色不分大小。',
  },
  {
    term: '主牌与逢人配',
    detail: '大王 > 小王 > 级牌 > A > K … 3 > 2。两张红桃级牌可配任意非王牌的点数与花色；单出只能作级牌。选牌后自动取最强合法解释；跟牌必须能严格压过上一手。连张按自然点数使用级牌，可从 A 起，不可跨 K—A—2。',
  },
  {
    term: '进贡还贡',
    detail: '末游进贡手中最大的牌，但红桃级牌除外。头游自选普通 2 至 10（本副级牌除外）还贡，没有则还最小牌。双贡大牌给头游、小牌给二游，对应还贡；同点由头游下家进贡给头游并先出。双贡与双还均提交齐后同时公开。',
  },
  { term: '抗贡', detail: '单贡者自己持有两张大王，或双贡双方合计持有两张大王，则本副免进贡，由头游先出。' },
  { term: '计分', detail: '本版本不记录分数，只记录每副的升级与整场胜负。' },
  {
    term: '来源与改编',
    detail:
      '以 2022-09-08 全国试行规则为基础的数字改编（非官方认证版本）。本版本冻结：三带二必须不同点数（不拆五张同点）；自然五张同花顺按同花顺计算；逢人配自动选择最强合法点数与花色；“逢人配当王”等商业变体不采用。',
  },
  { term: '牌局保留', detail: '牌局只保存在服务内存，重启即清空；无人 30 分钟后回收。' },
]

const JUNQI: RuleRow[] = [
  { term: '对局模式', detail: '在军棋房间内选择双人暗棋或四国四暗。每方 25 枚，秘密布阵、全员确认后红方先行；各用私人屏幕，自己的阵地始终在下方。' },
  { term: '四国组队', detail: '红绿同队、蓝紫同队，对坐为搭档；只显示自己的棋子身份，队友也保持暗棋。按红、蓝、绿、紫轮流行棋，不可攻击或越过队友。' },
  { term: '布阵', detail: '军旗在大本营，地雷只在后两排，炸弹不在第一排，行营开局不放子。点选己方两枚棋子可交换合法位置。' },
  { term: '行棋', detail: '公路走一格，铁路直行不限格，四国外围印制弯道可沿轨通过；普通棋子不可在铁路路口换向，工兵可以。均不可越子。行营中的棋子受保护，军旗、地雷及大本营内棋子不能移动。' },
  { term: '交战', detail: '司令＞军长＞师长＞旅长＞团长＞营长＞连长＞排长＞工兵；同级同归于尽。工兵排雷，其他军衔撞雷败。炸弹与任何敌子同归于尽。' },
  { term: '胜负', detail: '司令阵亡亮军旗。双人夺旗或让对方无棋可走获胜；四国夺旗、无棋可走或认输时仅该军出局，清除其余棋子并跳过回合，搭档继续战斗，敌队全军出局获胜。连续 70 步无交战和棋，结束后剩余棋子公开。' },
  { term: '版本约定', detail: '基本布阵、行棋与碰子参考 2025 年安徽省大学生计算机博弈大赛军棋规程；四国采用四暗组队、出局清子，红方先行，连续 70 步无交战和棋。' },
]
const XIANGQI: RuleRow[] = [
  { term: '开局', detail: '两人各执 16 枚棋子，红方先走，之后轮流走一步。棋子放在交叉点上，点自己的棋，再点绿色落点。' },
  { term: '车、马', detail: '车横竖直走，不能越子。马走“日”字：先直走一格，再斜走一格；直走那一格有棋子挡着，就是“蹩马腿”，这边不能跳。' },
  { term: '相、仕、将帅', detail: '相（象）斜走两格，不能过河，中间有子挡着就是“塞象眼”。仕（士）斜走一格，将（帅）横竖走一格，都不能走出九宫。将帅不能在同一路上直接照面。' },
  { term: '炮、兵卒', detail: '炮不吃子时像车一样走；吃子时，炮和目标之间必须正好隔一枚棋子。兵（卒）每次向前一格，过河后也能横走一格，始终不能后退。' },
  { term: '将军与胜负', detail: '对方下一步能吃到将帅，就是“将军”，必须马上解围。自己不能走出让将帅被吃的棋。被将死，或虽然没被将军却一步合法棋都走不了（困毙），都算输。' },
  { term: '认输与和棋', detail: '可以认输，也可以提议和棋，由对方同意。有人掉线时先暂停，等重连后接着下；结束后房主可再开一局。' },
  { term: '重复局面约定', detail: '本房间采用休闲约定：同一局面、同一方行棋第三次出现时，若只有一方连续将军，判该方负；其他情况和棋。连续 120 手（双方各走算两手）未吃子也和棋。未采用比赛中的完整长捉裁定。' },
]
const CHESS: RuleRow[] = [
  { term: '开局与操作', detail: '两人各执 16 枚棋子，棋子放在 8×8 方格里。白方先走，双方轮流一步。平板同屏双方棋子各朝自己；手机联机自己的阵地在下方。点棋子，再点绿色落点。' },
  { term: '王与后', detail: '王横、竖、斜走一格，不能走入对方攻击范围，两王不能相邻。后可以横、竖、斜走任意格，不能越过其他棋子。' },
  { term: '车、象、马', detail: '车横竖直走；象沿斜线走，二者不能越子。马走日字，可以跳过其他棋子，没有蹩马腿。任何棋都不能吃己方棋子。' },
  { term: '兵与升变', detail: '兵向前一格，初始位置可前进两格，路径必须为空；斜前一格吃子，不能后退。兵走到对方底线，必须选择升变为后、车、象或马，不能变王。' },
  { term: '王车易位', detail: '王和相应车都未动过、二者间无子，王未被将军，且王经过和到达的格都未受攻击时，可以易位：点王，再点横移两格的落点，车自动移到王旁。长、短易位均支持。' },
  { term: '吃过路兵', detail: '对方兵刚从起始格前进两格，停在己方兵旁边时，紧接着的一步可把它当作只前进了一格来斜吃。错过这一手就失效，且仍须保证己王安全。' },
  { term: '将军与终局', detail: '王被攻击时必须马上解围；将军且无合法走法是将死，对方获胜。没有被将军却无合法走法是逼和；子力不足以将死也和棋。一方认输则对方获胜。' },
  { term: '本房间和棋约定', detail: '双方可同意和棋。本房间在同一局面（含行棋方、易位权及有效过路兵权）三次出现时自动和棋；连续 50 回合（100 手）无吃子且无兵移动也自动和棋，不另行申请。采用休闲对弈约定，无比赛棋钟。' },
  { term: '重连与记录', detail: '掉线暂停行棋，重连恢复同一局面。结束后房主可再开一局，公开棋谱与战绩保存在本浏览器。对局只保存在服务内存，重启后清空。' },
]
const UNDO: RuleRow = { term: '悔棋', detail: `联机由对方同意后退回请求者上一手之前，答复前可撤回。平板同屏确认后撤销上一手。真人对局每方每局最多成功悔棋 ${BOARD_UNDO_LIMIT} 次。` }
const COMPUTER: RuleRow = { term: '五档人机对弈', detail: '首页或准备页可选入门、简单、普通、困难、挑战。手机默认玩家先手，平板可选先后手。等电脑走完后可悔棋，退回到你上一手之前，次数不限。行棋异常可重试，和棋由棋规判定。' }
XIANGQI.push(UNDO, COMPUTER)
CHESS.push(UNDO, COMPUTER)
const GO: RuleRow[] = [
  { term: '棋盘与操作', detail: '房主在准备页选 9、13、19 路。黑先白后，轮流在空交叉点落一子；先预选，再点“确认落子”。棋子落下后固定在交叉点上。' },
  { term: '气与提子', detail: '上下左右的空点是气，斜角不算。同色横竖相邻连成整块，共享不重复的气。落子先提掉无气的对方棋，再检查己方；禁止不提子而让自己整块无气。' },
  { term: '劫与重复', detail: '本房间禁止落成此前出现过的整张盘面，包含立即提劫与更长循环；停一手不清空历史。需先在别处改变局面。' },
  { term: '停一手与死子', detail: '双方连续停一手后，进入死子确认；点击棋子标记或取消整块死子。任何改动撤销双方确认，双方同意当前结果后才结算。死活有争议可恢复原盘面继续下棋，不自动判定死棋。' },
  { term: '数子与贴点', detail: '采用面积计分：盘上己子 + 己方围住的空。邻接双方的空区为中立。白方加 7.5 贴点（所有棋盘大小相同），提子数不再另加。不采用日式数目法，不设让子或竞赛棋钟。' },
  { term: '教程与对局', detail: '基础和进阶分别选择、分别保存进度；进阶附网上高级课程，可按需观看。平板两人轮流操作，联机双方准备后房主开局；掉线暂停、重连恢复。结束后可查棋谱和战绩。' },
  { term: UNDO.term, detail: `${UNDO.detail} 停一手计入棋谱，确认死子期间暂停悔棋。` },
]
const GOMOKU: RuleRow[] = [
  { term: '棋盘与操作', detail: '15×15 交叉点，黑先白后，双方轮流一子。点空交叉点预选，再确认落子；未确认时可以换点。已有棋子的点不能再下。' },
  { term: '选择规则', detail: '房主在准备页选择无禁手（默认）或黑方禁手，改规则后需重新准备。无禁手时双方五连或长连即胜。两种规则都保留黑先白后、轮流落子，不设交换开局。' },
  { term: '黑方禁手', detail: '黑方恰好五连即胜，且优先于同手形成的禁手形状。其他情况下，三三、四四和六连以上的长连禁止落子；同一条线上的两组四也算四四。三须能在合法点延伸成两端可成五的直四。白方不受限制，五连或长连均获胜。' },
  { term: '小叉提示', detail: '黑方回合默认用小叉提示禁手点。黑方尝试落在禁手点时，系统拒绝这手，仍轮到黑方。' },
  { term: '结束与联机', detail: '满盘仍无人连五，判和；可以认输，不能停一手。平板双人同屏直接开始；联机双方准备后房主开局，掉线暂停并可重连。结束后房主可再开一局。' },
  UNDO,
  COMPUTER,
]
const REVERSI: RuleRow[] = [
  { term: '开局与落点', detail: '棋子放在 8×8 棋盘的格子内。中央四格交叉摆黑白各两子，黑方先行。小圆点是合法落点，选格后点“确认落子”。' },
  { term: '夹住翻子', detail: '在横、竖或斜线上，以新子和已有同色棋子夹住一串对手棋子。所有被夹住的棋子一起翻面，一手可以翻多个方向。' },
  { term: '停一手与终局', detail: '一方没有可落的格子时自动停一手，由另一方继续。双方都无合法落点或棋盘下满，数盘面棋子，多者胜，相同为和。也可认输。' },
  { term: '角位', detail: '落定的角子不会翻面。占住一角后，沿它连成的同色边子也能稳定下来。' },
  UNDO,
  { term: '自动停一手与悔棋', detail: '停一手计入棋谱。撤销自动停一手时一并撤销触发它的落子，恢复可继续落子的局面。' },
  COMPUTER,
]
const RULE_ROWS: Record<GameKind, RuleRow[]> = {
  doudizhu: DOUDIZHU,
  guandan: GUANDAN,
  xiangqi: XIANGQI,
  chess: CHESS,
  go: GO,
  gomoku: GOMOKU,
  reversi: REVERSI,
  junqi: JUNQI,
}
const tab = ref<GameKind>(props.initialGame ?? 'doudizhu')
const nameOf = (game: GameKind): string => GAME_DEFINITIONS[game].name

const page = ref(0), pageSize = ref(3)
const pages = computed(() => Math.ceil(RULE_ROWS[tab.value].length / pageSize.value))
const visibleRows = computed(() => RULE_ROWS[tab.value].slice(page.value * pageSize.value, (page.value + 1) * pageSize.value))
function measure(): void { pageSize.value = innerHeight <= 550 || innerWidth < 600 && innerHeight < 700 ? 1 : innerWidth < 600 ? 2 : 3; page.value = Math.min(page.value, pages.value - 1) }
watch(tab, () => { page.value = 0 })
const dialog = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    emit('close')
    return
  }
  if (event.key !== 'Tab' || !dialog.value) return
  const controls = dialog.value.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (!first || !last) return
  const active = document.activeElement
  if (!dialog.value.contains(active) || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault()
    event.stopPropagation()
    ;(event.shiftKey ? last : first).focus({ preventScroll: true })
  }
}

onMounted(() => {
  measure(); window.addEventListener('resize', measure)
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.addEventListener('keydown', onKeydown, true)
  dialog.value?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  document.removeEventListener('keydown', onKeydown, true)
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
  <div class="rules-backdrop" @click.self="$emit('close')">
    <section ref="dialog" class="rules-dialog" role="dialog" aria-modal="true" aria-label="规则说明">
      <header class="rules-heading">
        <div>
          <p class="eyebrow">Rules</p>
          <h2 class="panel-title">规则说明</h2>
        </div>
        <button class="icon-button" type="button" aria-label="关闭规则" @click="$emit('close')"><AppIcon name="close" /></button>
      </header>

      <nav class="rules-tabs">
        <button
          v-for="kind in RULE_TABS"
          :key="kind"
          class="rules-tab"
          :class="{ 'is-active': tab === kind }"
          type="button"
          :aria-pressed="tab === kind"
          @click="tab = kind"
        >{{ nameOf(kind) }}</button>
      </nav>

      <div class="rules-body" role="region" :aria-label="`${nameOf(tab)}规则正文`" tabindex="0">
        <p v-if="page === 0 && pageSize > 1 && contextNote && (!initialGame || tab === initialGame)" class="tools-phase-tip">{{ contextNote }}</p>
        <p class="rules-lead muted">
          {{ GAME_DEFINITIONS[tab].seatCount }} 人 · {{ isBoardGame(tab) ? '棋类' : `${GAME_DEFINITIONS[tab].deckCount} 副牌` }} · {{ GAME_DEFINITIONS[tab].brief }}
        </p>
        <dl class="rules-list">
          <div v-for="row in visibleRows" :key="row.term" class="rules-row">
            <dt class="rules-term">{{ row.term }}</dt>
            <dd class="rules-detail">{{ row.detail }}</dd>
          </div>
        </dl>
      </div>
      <nav class="rules-pager" aria-label="规则翻页"><button class="review-button" :disabled="page === 0" @click="page--">上一页</button><span>{{ page + 1 }} / {{ pages }}</span><button class="review-button" :disabled="page + 1 >= pages" @click="page++">下一页</button></nav>
    </section>
  </div>
  </Teleport>
</template>
