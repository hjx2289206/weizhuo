<script setup lang="ts">
import BrandMark from '../components/BrandMark.vue'
import { computed, nextTick, ref } from 'vue'
import { GAME_DEFINITIONS, GAME_KINDS, supportsRoomMode, isBoardGame, isStoneGame } from '../../shared/gameCatalog'
import type { GameKind, RoomMode } from '../../shared/protocol'
import type { GameController } from '../useGame'
import GameCover from '../components/GameCover.vue'
import GameCategoryCover from '../components/GameCategoryCover.vue'
import GameTutorialButton from '../components/GameTutorialButton.vue'
import GameTools from '../components/GameTools.vue'
import AppIcon from '../components/AppIcon.vue'
import DialogShell from '../components/DialogShell.vue'
import JoinForm from '../components/JoinForm.vue'
import { useGameView } from './useGameView'
import { GAME_NOTES } from '../gamePresentation'

const props = defineProps<{ game: GameController }>()
const { busy, roomCode, seatId, roomInfo, seatRequest, savedSession } = props.game
const { run } = useGameView(props.game)

/** The hall lists only implemented games and their supported entry modes. */
const CATEGORIES = [
  { key: 'board', title: '棋类', note: '一步一想，棋逢对手', games: GAME_KINDS.filter(isBoardGame) },
  { key: 'cards', title: '牌类', note: '围桌出牌，搭档接招', games: GAME_KINDS.filter(game => !isBoardGame(game)) },
] as const
type Category = typeof CATEGORIES[number]['key']
const category = ref<Category | null>(null)
const activeCategory = computed(() => CATEGORIES.find(group => group.key === category.value) ?? null)
const gamePage = ref(0), gamesPerPage = 3
const visibleGames = computed(() => activeCategory.value?.games.slice(gamePage.value*gamesPerPage,(gamePage.value+1)*gamesPerPage) ?? [])
const gamePages = computed(() => Math.ceil((activeCategory.value?.games.length ?? 0)/gamesPerPage))
const categoryHeading = ref<HTMLElement | null>(null)
const categoryPicker = ref<HTMLElement | null>(null)

async function enterCategory(key: Category): Promise<void> {
  clearNameNotice()
  category.value = key
  gamePage.value = 0
  await nextTick()
  categoryHeading.value?.focus({ preventScroll: true })
}

async function backToCategories(): Promise<void> {
  const previous = category.value
  clearNameNotice()
  category.value = null
  await nextTick()
  categoryPicker.value?.querySelector<HTMLButtonElement>(`[data-category="${previous}"]`)?.focus({ preventScroll: true })
}
const nickname = ref(savedSession.value?.name ?? '')
const nicknameInput = ref<HTMLInputElement | null>(null)
const notice = ref('')
const practiceTier = ref<'strong' | 'easy'>('easy')
const joinExpanded = ref(!!roomCode.value)

function practiceBoard(game: 'chess' | 'xiangqi'): void {
  clearNameNotice(); run(() => props.game.createBoardPractice(game, nickname.value.trim() || '我'))
}

function practice(game: GameKind): void {
  clearNameNotice()
  const name = nickname.value.trim() || '我'
  run(() => props.game.quickPractice(game, name, practiceTier.value))
}

const savedGame = computed<GameKind | null>(() => savedSession.value?.game ?? null)
const savedGameName = computed(() => (savedGame.value ? GAME_DEFINITIONS[savedGame.value].name : '牌局'))
const joinGame = computed<GameKind | null>(() => roomInfo.value?.game ?? null)

function clearNameNotice(): void {
  if (props.game.error.value === notice.value) props.game.clearError()
  notice.value = ''
}

function showNameNotice(message: string): void {
  notice.value = message
  // Keep the name error visible without changing the one-screen layout.
  props.game.error.value = message
  nicknameInput.value?.focus({ preventScroll: true })
}

function create(game: GameKind, roomMode: RoomMode): void {
  clearNameNotice()
  const name = nickname.value.trim()
  if (name.length > 8) {
    showNameNotice('昵称最多 8 个字')
    return
  }
  if (roomMode === 'phone' && !name) {
    showNameNotice(isBoardGame(game) ? '请先填写昵称，再进入联机对弈' : '请先填写昵称，再点“手机开一桌”')
    return
  }
  run(() => props.game.createRoom({ game, roomMode, ...(name ? { name } : {}) }))
}

function resume(): void {
  run(() => props.game.resumeLastRoom())
}

function join(payload: { code: string; seat: number; name: string }): void {
  run(() => props.game.joinRoom(payload.code, payload.seat, payload.name))
}

function request(payload: { code: string; seat: number; name: string }): void {
  run(() => props.game.requestSeat(payload.code, payload.seat, payload.name))
}

function inspect(code: string): void {
  run(() => props.game.inspectRoom(code))
}
function closeJoin(): void {
  joinExpanded.value = false
  // An abandoned board invitation returns to the landscape category home.
  if (!props.game.state.value && roomInfo.value && isBoardGame(roomInfo.value.game)) run(props.game.leaveRoom)
}

/** The requester holds no session while waiting: this tab must not look like it is seated. */
const waiting = computed(() => seatRequest.value?.status === 'pending')

const requestStatus = computed(() => {
  const request = seatRequest.value
  if (!request) return ''
  if (request.status === 'pending') return '等待房主同意…'
  return request.status === 'rejected' ? '房主拒绝了这次替换申请' : '申请已取消'
})

</script>

<template>
  <main class="lobby-viewport">
    <div class="collection-home">
      <header class="collection-header">
        <div class="brand"><BrandMark /><span>桌游合集</span></div>
        <span class="lobby-header-motto">出一手好牌，下一步好棋。</span>
        <div class="lobby-header-actions"><button class="button secondary" :disabled="busy" @click="joinExpanded = true"><AppIcon name="users" />加入朋友</button><GameTools :game="game" /></div>
      </header>
      <div class="lobby-toolbar" :class="{ 'lobby-toolbar--category': activeCategory }">
        <div class="lobby-location">
          <button v-if="activeCategory" class="category-back" :disabled="busy" @click="backToCategories"><AppIcon name="left" />返回分类</button>
          <div class="lobby-intro">
            <h1 ref="categoryHeading" tabindex="-1">{{ activeCategory?.title ?? '今天，玩哪一类？' }}<small v-if="activeCategory">{{ activeCategory.games.length }} 款游戏</small></h1>
            <p>{{ activeCategory?.note ?? '选一类，邀朋友开局。' }}</p>
          </div>
        </div>
        <section v-if="activeCategory" class="collection-settings" aria-label="开局设置">
          <label class="field">昵称<input ref="nicknameInput" v-model="nickname" autocomplete="nickname" enterkeyhint="done" maxlength="8" placeholder="最多 8 个字" @keydown.enter="nicknameInput?.blur()" :aria-invalid="notice ? true : undefined" @input="clearNameNotice" /></label>
          <label v-if="category === 'cards'" class="practice-tier">练习难度<select v-model="practiceTier"><option value="easy">轻松</option><option value="strong">挑战</option></select></label>
        </section>
        <button v-if="savedSession" class="lobby-resume" :disabled="busy" @click="resume"><AppIcon name="play" /><span>继续{{ savedGameName }}<small>{{ savedSession.code }}</small></span></button>
      </div>
      <section v-if="!activeCategory" ref="categoryPicker" class="category-picker" aria-label="游戏分类">
        <button v-for="group in CATEGORIES" :key="group.key" class="category-card" :data-category="group.key" :aria-label="`进入${group.title}`" :aria-describedby="`category-note-${group.key}`" :disabled="busy" @click="enterCategory(group.key)">
          <span class="category-card-heading"><span class="category-card-title">{{ group.title }}</span><span :id="`category-note-${group.key}`" class="category-card-note">{{ group.note }}</span></span>
          <GameCategoryCover :category="group.key" />
          <span class="category-card-footer"><span>{{ group.games.length }} 款游戏</span><span class="category-card-cta">进入{{ group.title }}<AppIcon name="right" /></span></span>
        </button>
      </section>
      <section v-else class="category-game-list" :aria-label="`${activeCategory.title}游戏`">
        <div class="collection-games" :data-category="activeCategory.key" :style="{ '--game-count': visibleGames.length }">
          <article v-for="entry in visibleGames" :key="entry" class="collection-game-card" :data-game="entry">
            <div class="collection-game-cover"><GameCover :game="entry" /></div>
            <div class="game-card-copy"><div class="game-card-heading"><h2 class="panel-title">{{ GAME_DEFINITIONS[entry].name }}</h2><GameTutorialButton v-if="isStoneGame(entry)" :game="entry" /><button v-if="entry === 'chess' || entry === 'xiangqi'" class="board-practice-entry" :disabled="busy" :aria-label="`${GAME_DEFINITIONS[entry].name}人机对弈`" @click="practiceBoard(entry)">人机对弈<AppIcon name="right" /></button></div><p class="collection-game-note">{{ GAME_NOTES[entry] }}</p></div>
            <div class="collection-actions">
              <button v-if="supportsRoomMode(entry, 'tablet')" class="button primary" :disabled="busy" @click="create(entry, 'tablet')"><AppIcon name="table" />{{ isBoardGame(entry) ? '平板双人同屏' : '平板开一桌' }}</button>
              <button class="button primary" :disabled="busy" @click="create(entry, 'phone')"><AppIcon :name="isBoardGame(entry) ? 'users' : 'phone'" />{{ isBoardGame(entry) ? '联机对弈' : '手机开一桌' }}</button>
              <button v-if="!isBoardGame(entry)" class="practice-button" :disabled="busy" @click="practice(entry)"><AppIcon name="bolt" />快速练习</button>
            </div>
          </article>
        </div>
        <nav v-if="gamePages > 1" class="category-game-pager" aria-label="分类游戏分页"><button class="review-button" :disabled="gamePage === 0 || busy" @click="gamePage--"><AppIcon name="left" />上一页</button><span>{{ gamePage + 1 }} / {{ gamePages }} · 共 {{ activeCategory.games.length }} 款游戏</span><button class="review-button" :disabled="gamePage + 1 >= gamePages || busy" @click="gamePage++">下一页<AppIcon name="right" /></button></nav>
      </section>
      <footer class="home-footer"><span>{{ notice || '同一局域网，打开链接就能一起玩。' }}</span><span>对局只在本次服务中保留</span></footer>
    </div>
    <DialogShell v-if="joinExpanded && !waiting" :title="joinGame ? `加入${GAME_DEFINITIONS[joinGame].name} · ${roomInfo?.code ?? roomCode}` : '加入朋友的房间'" class="home-join-dialog" @close="closeJoin">
      <JoinForm :compact="true" :saved-session="savedSession" :initial-code="roomCode" :initial-seat="seatId ?? 0" :initial-name="nickname || savedSession?.name || ''" :roster="roomInfo?.seats ?? null" :game="joinGame" :busy="busy" @inspect="inspect" @join="join" @request="request" @resume="resume" />
    </DialogShell>
    <DialogShell v-if="seatRequest && waiting && joinExpanded" title="替换申请" class="home-join-dialog" @close="joinExpanded = false">
      <p>房间 {{ seatRequest.code }} · {{ seatRequest.seatId + 1 }} 号座 · {{ requestStatus }}</p><p>{{ seatRequest.message || '房主同意后会自动进入，请保持本页面打开。' }}</p>
    </DialogShell>
  </main>
</template>
