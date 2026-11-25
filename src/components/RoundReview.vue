<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import type { Snapshot } from '../../shared/protocol'
import { exportResultImage, resultFromSnapshot, resultSeatLabel } from '../resultHistory'
import { GAME_DEFINITIONS, isBoardGame } from '../../shared/gameCatalog'
import { GAME_TOOLS } from '../gameTools'
import AppIcon from './AppIcon.vue'
import PlayingCard from './PlayingCard.vue'
const props = defineProps<{ snapshot: Snapshot | null }>()
const tools = inject(GAME_TOOLS)
const result = computed(() => {
  const candidate = props.snapshot ? resultFromSnapshot(props.snapshot) : null
  return candidate ? tools?.records.value.find(r => r.key === candidate.key) ?? candidate : null
})
const cursor = ref(0)
const open = ref(false)
const boardPage = ref(0)
const boardPlays = computed(() => result.value?.plays.slice(boardPage.value * 2, boardPage.value * 2 + 2) ?? [])
const notice = ref('')
const saving = ref(false)
watch(() => result.value?.key, () => { cursor.value = Math.max(0, (result.value?.plays.length ?? 1) - 1); open.value = false; boardPage.value = 0; notice.value = '' }, { immediate: true })
const play = computed(() => result.value?.plays[cursor.value])
const replayCards = computed(() => props.snapshot?.tablePlays[cursor.value]?.cards ?? [])
const ownScore = computed(() => result.value?.players.find(p => p.seat === props.snapshot?.selfSeat)?.delta)
const matchEnded = computed(() => props.snapshot?.game === 'guandan' && props.snapshot.guandan.matchWinner !== null)
const metric = computed(() => {
  const s = props.snapshot
  if (s?.game === 'guandan') return { value: `+${s.guandan.result?.upgrade ?? 0}`, label: '胜方升级' }
  if (ownScore.value !== undefined) return { value: `${ownScore.value > 0 ? '+' : ''}${ownScore.value}`, label: '我的本局得分' }
  return { value: s?.game === 'doudizhu' ? String(s.bid * s.multiplier) : '—', label: '本局计分基数' }
})
function role(seat: number): string {
  const s = props.snapshot
  return s?.game === 'doudizhu' ? seat === s.landlord ? '地主' : '农民' : seat % 2 === 0 ? '1、3 号座' : '2、4 号座'
}
function place(seat: number): string {
  const s = props.snapshot
  if (s?.game !== 'guandan') return ''
  const order = s.guandan.result?.order ?? []
  const index = order.indexOf(seat)
  return index < 0 ? '双下' : ['头游', '二游', '三游', '末游'][index] ?? '—'
}
async function save(): Promise<void> {
  if (!result.value || saving.value) return
  saving.value = true
  try { await exportResultImage(result.value); notice.value = '战绩图片已生成，请查看浏览器下载' }
  catch (e) { notice.value = e instanceof Error ? e.message : '无法生成战绩图片' }
  finally { saving.value = false }
}
</script>
<template>
  <section v-if="result && !isBoardGame(result.game)" class="round-review">
    <div class="result-hero">
      <div class="result-seal" aria-hidden="true"><AppIcon name="trophy" /></div>
      <div class="result-heading"><p class="result-eyebrow">{{ matchEnded ? '整场结束' : result.game === 'guandan' ? '本副结束' : '本局结束' }}<span>房间 {{ result.code }}</span></p><h3>{{ result.title.split(' · ')[0] }}</h3><p class="result-caption">{{ result.game === 'doudizhu' ? '好牌有来回，下局再见分晓。' : matchEnded ? '过 A 获胜，这一场配合得漂亮。' : '这一副落定，下一副继续搭档。' }}</p></div>
      <div class="result-metric" :class="{ 'is-negative': (ownScore ?? 0) < 0 }"><strong>{{ metric.value }}</strong><span>{{ metric.label }}</span></div>
    </div>
    <div class="result-scoreboard" role="table" aria-label="本局成绩">
      <div class="result-score-row result-score-labels" role="row"><span role="columnheader">玩家</span><span role="columnheader">{{ result.game === 'doudizhu' ? '本局' : '名次' }}</span><span role="columnheader">{{ result.game === 'doudizhu' ? '累计' : '搭档' }}</span></div>
      <div v-for="player in result.players" :key="player.seat" class="result-score-row" :class="{ 'is-me': player.seat === snapshot?.selfSeat }" role="row">
        <span class="result-player" role="cell"><span class="result-avatar" aria-hidden="true">{{ player.name.slice(0, 1) }}</span><span><strong>{{ player.name }}<small v-if="player.seat === snapshot?.selfSeat">我</small></strong><small>{{ player.seat + 1 }} 号座 · {{ result.game === 'doudizhu' ? role(player.seat) : '搭档局' }}</small></span></span>
        <strong class="result-round-score" :class="{ 'is-positive': (player.delta ?? 0) > 0 }" role="cell">{{ result.game === 'doudizhu' ? `${(player.delta ?? 0) > 0 ? '+' : ''}${player.delta}` : place(player.seat) }}</strong>
        <span class="result-total" role="cell">{{ result.game === 'doudizhu' ? player.total : role(player.seat) }}</span>
      </div>
    </div>
    <p class="result-explanation"><AppIcon :name="result.game === 'doudizhu' ? 'counter' : 'users'" /><span>{{ result.detail }}</span></p>
    <div class="review-actions">
      <button class="review-button" type="button" :aria-expanded="open" @click="open = !open"><AppIcon name="history" />{{ open ? '收起回顾' : '出牌回顾' }}</button>
      <button class="review-button" type="button" :disabled="saving" @click="save"><AppIcon name="download" />{{ saving ? '正在生成…' : '保存战绩' }}</button>
    </div>
    <div v-if="open && play" class="public-replay" aria-live="polite">
      <div class="replay-heading"><span>{{ play.name }}</span><small>第 {{ cursor + 1 }} / {{ result.plays.length }} 手</small></div>
      <div class="replay-cards" aria-label="本手公开出牌"><PlayingCard v-for="card in replayCards" :key="card.id" :card="card" /></div>
      <div class="replay-controls"><button class="review-button" type="button" :disabled="cursor === 0" @click="cursor--"><AppIcon name="left" />上一手</button><small>仅展示已公开的有效出牌</small><button class="review-button" type="button" :disabled="cursor === result.plays.length - 1" @click="cursor++">下一手<AppIcon name="right" /></button></div>
    </div>
    <p v-if="notice" class="result-notice" role="status">{{ notice }}</p>
  </section>
  <section v-else-if="result" class="round-review">
    <div class="result-hero"><div class="result-seal" aria-hidden="true"><AppIcon name="trophy" /></div><div class="result-heading"><p class="result-eyebrow">{{ GAME_DEFINITIONS[result.game].name }} · 房间 {{ result.code }}</p><h3>{{ result.title }}</h3><p class="result-caption">{{ result.detail }}</p></div></div>
    <p class="result-explanation">{{ result.players.map(p => `${resultSeatLabel(result!.game, p.seat)}：${p.name}`).join(' · ') }}</p>
    <div class="review-actions"><button class="review-button" :disabled="!result.plays.length" :aria-expanded="open" @click="open = !open"><AppIcon name="history" />行棋回顾</button><button class="review-button" :disabled="saving" @click="save"><AppIcon name="download" />保存战绩</button></div>
    <div v-if="open"><ol class="junqi-result-moves"><li v-for="(move, i) in boardPlays" :key="i">{{ move.name }}：{{ move.cards }}</li></ol><nav class="replay-controls"><button class="review-button" :disabled="boardPage === 0" @click="boardPage--">上一页</button><span>{{ boardPage + 1 }} / {{ Math.max(1, Math.ceil(result.plays.length / 2)) }}</span><button class="review-button" :disabled="(boardPage + 1) * 2 >= result.plays.length" @click="boardPage++">下一页</button></nav></div><p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>
