<script setup lang="ts">
import { computed } from 'vue'
import type { Card } from '../../shared/protocol'
import type { GamePlayController } from '../playController'
import { bottomCardText } from '../screens/cardText'
import type { GuandanView } from '../screens/useGuandanView'

/**
 * Tribute / return panel, shown only while the deal is actually waiting for an exchange. It offers
 * this seat's own eligible cards as real buttons and its own committed card, and keeps every other
 * seat's face hidden until the server reveals the pairs. Outside a waiting tribute or return it
 * renders nothing: 抗贡 and 交换完成 are public stages, not a panel left sitting over live play.
 */
const props = defineProps<{ game: GamePlayController; view: GuandanView; compact?: boolean }>()
const { selected, busy, clearSelection, toggleCard, tribute, returnTribute } = props.game

const privateAction = computed(() => props.view.privateAction.value)
const kind = computed(() => privateAction.value?.kind ?? null)
const eligibleIds = computed<readonly string[]>(() => privateAction.value?.eligibleIds ?? [])
const committed = computed<Card | null>(() => privateAction.value?.committed ?? null)
const exchange = computed(() => props.view.exchange.value)
const stage = computed(() => exchange.value?.stage ?? 'none')
const pairs = computed(() => exchange.value?.pairs ?? [])
const submitted = computed(() => exchange.value?.submitted ?? [])
const giverCount = computed(() => exchange.value?.givers.length ?? 0)
const expectedCommitters = computed(() => (stage.value === 'return' ? pairs.value.length : giverCount.value))

/** Interactive only while the server is waiting for submissions; both stages need a hand click. */
const active = computed(
  () => props.view.phase.value === 'tribute' && (stage.value === 'tribute' || stage.value === 'return'),
)

const chosenId = computed<string | null>(() => {
  if (selected.value.length !== 1) return null
  const [only] = selected.value
  return eligibleIds.value.indexOf(only) >= 0 ? only : null
})

const title = computed(() => (kind.value === 'return' ? '还贡' : kind.value === 'tribute' ? '进贡' : '进贡还贡'))

const hint = computed(() => {
  if (props.view.managed.value && kind.value && !committed.value) return '简单 AI 正在代为选牌，取消托管即可恢复手动操作。'
  if (kind.value == null) {
    if (stage.value === 'tribute') return '等待进贡方选牌，双方都提交后才会公开。'
    if (stage.value === 'return') return '等待还贡方选牌，双方都提交后才会公开。'
    return props.view.exchangeStageText.value
  }
  if (committed.value) return '已提交，等待对手提交后同时公开。'
  if (eligibleIds.value.length === 0) return '本副没有可交换的牌。'
  if (kind.value === 'tribute') return '点一张最大的牌进贡：几张大牌并列时由你自己权衡，不会替你选。'
  return '接收的牌可以还回去；点一张符合条件的牌。'
})

const canSubmit = computed(
  () => !busy.value && !props.view.managed.value && !props.view.dealing.value && kind.value !== null && committed.value === null && chosenId.value !== null,
)

/** One human choice: move the single selection onto exactly this own eligible physical card. */
function pick(card: Card): void {
  if (busy.value || props.view.managed.value || props.view.dealing.value || !active.value || chosenId.value === card.id) return
  clearSelection()
  toggleCard(card.id)
}

/** Full printed face (rank + suit, jokers by name) so tied suits stay distinguishable. */
function face(card: Card): { text: string; red: boolean } {
  return bottomCardText(card)
}

function submit(): void {
  const id = chosenId.value
  if (!canSubmit.value || id == null || kind.value == null) return
  props.view.run(() => (kind.value === 'return' ? returnTribute(id) : tribute(id)))
}

function eligibleFaces(): Card[] {
  const ids = eligibleIds.value
  return props.view.myHand.value.filter((card) => ids.indexOf(card.id) >= 0)
}

function pickFromSelect(event: Event): void {
  const card = eligibleFaces().find((entry) => entry.id === (event.target as HTMLSelectElement).value)
  if (card) pick(card)
}

function nameOf(seat: number): string {
  return props.view.seatLabel(seat)
}
</script>

<template>
  <section v-if="active" class="guandan-exchange" :class="[`is-${stage}`, { 'is-compact': compact }]" :aria-label="title">
    <template v-if="compact">
      <div class="exchange-compact-info" :title="hint">
        <strong>{{ title }}</strong>
        <span role="status">{{ view.managed.value ? '简单 AI 处理中' : committed ? '已提交，等待对手' : kind ? '请选择一张牌' : hint }}</span>
      </div>
      <select v-if="kind && !committed && !view.managed.value" class="exchange-select" :aria-label="`${title}可选的牌`" :value="chosenId ?? ''" :disabled="busy" @change="pickFromSelect">
        <option disabled value="">选择{{ title }}的牌</option>
        <option v-for="card in eligibleFaces()" :key="card.id" :value="card.id">{{ face(card).text }}</option>
      </select>
      <span v-else-if="committed" class="exchange-compact-face">{{ face(committed).text }}</span>
      <button v-if="kind && !committed && !view.managed.value" class="button primary" type="button" :disabled="!canSubmit" @click="submit">{{ title }}</button>
      <span v-if="expectedCommitters" class="exchange-compact-progress">{{ submitted.length }} / {{ expectedCommitters }}</span>
    </template>
    <template v-else>
    <div class="guandan-exchange-head">
      <p class="eyebrow">Tribute</p>
      <h2 class="panel-title">{{ title }}</h2>
      <span class="guandan-exchange-stage">{{ view.exchangeStageText.value }}</span>
    </div>
    <p class="guandan-exchange-hint muted">{{ hint }}</p>

    <div v-if="kind && !committed && !view.managed.value" class="guandan-eligible" role="group" aria-label="可选的牌">
      <button
        v-for="card in eligibleFaces()"
        :key="card.id"
        class="guandan-eligible-card"
        :class="{ 'is-chosen': chosenId === card.id }"
        type="button"
        :aria-pressed="chosenId === card.id"
        :disabled="busy || view.managed.value"
        @click="pick(card)"
      >
        <span class="guandan-eligible-face" :class="{ 'is-red': face(card).red }">{{ face(card).text }}</span>
      </button>
    </div>

    <div v-if="committed" class="guandan-committed">
      <span class="guandan-committed-label muted">已提交</span>
      <span class="guandan-committed-card" :class="{ 'is-red': face(committed).red }">
        {{ face(committed).text }}
      </span>
    </div>

    <ul v-if="pairs.length" class="guandan-exchange-pairs">
      <li v-for="pair in pairs" :key="pair.giver" class="guandan-pair">
        <span class="guandan-pair-giver">{{ nameOf(pair.giver) }}</span>
        <span class="guandan-pair-tribute" :class="{ 'is-red': face(pair.tribute).red }">
          {{ face(pair.tribute).text }}
        </span>
        <span class="guandan-pair-arrow" aria-hidden="true">→</span>
        <span class="guandan-pair-receiver">{{ nameOf(pair.receiver) }}</span>
        <span v-if="pair.returned" class="guandan-pair-return" :class="{ 'is-red': face(pair.returned).red }">
          还 {{ face(pair.returned).text }}
        </span>
        <span v-else class="guandan-pair-return muted">等待还贡</span>
      </li>
    </ul>

    <p v-if="expectedCommitters > 0" class="guandan-exchange-wait muted">
      已提交 {{ submitted.length }} / {{ expectedCommitters }} 家
    </p>

    <div v-if="!view.managed.value" class="dock-actions">
      <button class="button primary" type="button" :disabled="!canSubmit" @click="submit">
        {{ kind === 'return' ? '还贡' : '进贡' }}
      </button>
    </div>
    </template>
  </section>
</template>

<style scoped>
.guandan-exchange.is-compact { position: relative; top: auto; left: auto; z-index: 6; display: flex; flex: none; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 44px; max-height: none; margin: 0; padding: 4px 12px; overflow: visible; border: 0; border-radius: 0; background: transparent; box-shadow: none; backdrop-filter: none; transform: none; }
.exchange-compact-info { display: flex; min-width: 0; align-items: center; gap: 8px; color: #758367; font-size: 10px; }
.exchange-compact-info strong { flex: none; color: #466348; font-weight: 500; }
.exchange-compact-info span { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exchange-select { width: min(30vw, 180px); min-width: 76px; height: 30px; border: 1px solid #c3cfb4; border-radius: 8px; background: transparent; color: #466348; font-size: 11px; }
.is-compact > .button { flex: none; min-width: 76px; min-height: 34px; padding: 6px 11px; background: transparent; color: #3d624e; font-size: 11px; }
.exchange-compact-progress, .exchange-compact-face { flex: none; color: #758367; font-size: 10px; white-space: nowrap; }
@media (max-width: 560px) {
  .exchange-compact-info { flex: 1; flex-direction: column; align-items: flex-start; gap: 2px; }
  .exchange-compact-info span { max-width: 110px; }
  .guandan-exchange.is-compact { gap: 7px; }
}
</style>
