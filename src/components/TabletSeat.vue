<script setup lang="ts">
import { computed } from 'vue'
import type { Phase, Seat } from '../../shared/protocol'
import AppIcon from './AppIcon.vue'
import RobotIcon from './RobotIcon.vue'

const props = defineProps<{
  seat: Seat
  phase: Phase
  active: boolean
  label: string
  finish: string
  offline: boolean
  marker?: string
  team?: number
  readonly?: boolean
}>()
defineEmits<{ invite: [] }>()
const lobby = computed(() => props.phase === 'lobby')
const canInvite = computed(() => lobby.value && !props.readonly)
const status = computed(() => {
  if (!props.seat.name) return props.readonly ? '空座' : '扫码入座'
  if (props.offline) return '连接中断'
  if (props.finish) return props.finish
  if (props.active) return props.phase === 'bidding' ? '正在叫分' : '正在出牌'
  if (lobby.value) return props.seat.ready ? '已准备' : '等待准备'
  if (props.seat.passed) return '已过牌'
  if (props.seat.autoPlay && !props.seat.isBot) return '托管中'
  return props.phase === 'tribute' ? '进贡还贡' : props.phase === 'finished' ? '本局结束' : '等待出牌'
})
</script>

<template>
  <component :is="canInvite ? 'button' : 'div'" class="tablet-seat"
    :class="{ 'is-active': active && !offline, 'is-empty': !seat.name, 'is-offline': offline, 'is-finished': Boolean(finish) }"
    :data-team="team" :data-seat-id="seat.id" :type="canInvite ? 'button' : undefined"
    :aria-label="canInvite ? `邀请 ${seat.id + 1} 号座` : `${seat.id + 1} 号座 ${seat.name}，${seat.count} 张，${status}`"
    :aria-current="active ? 'true' : undefined" @click.stop="canInvite && $emit('invite')">
    <svg class="tablet-seat-frame" viewBox="0 0 168 112" fill="none" aria-hidden="true">
      <rect x=".75" y=".75" width="166.5" height="110.5" rx="17" fill="var(--seat-fill)" stroke="var(--seat-line)" stroke-width="1.5" />
      <path d="M15 9h14M9 15v11M139 9h14M159 15v11M15 103h14M9 86v11M139 103h14M159 86v11" stroke="var(--seat-line)" stroke-opacity=".55" stroke-linecap="round" />
      <path d="M15 80h138" stroke="var(--seat-line)" stroke-opacity=".26" />
    </svg>
    <span class="tablet-seat-heading">
      <span class="tablet-seat-number">{{ String(seat.id + 1).padStart(2, '0') }} <span>号座</span></span>
      <span v-if="label" class="tablet-seat-role" :class="{ 'is-landlord': label === '地主' }">
        <AppIcon v-if="label === '地主'" name="crown" />
        {{ label }}
      </span>
    </span>
    <span class="tablet-seat-identity">
      <span class="tablet-seat-avatar" :title="marker">
        <RobotIcon v-if="seat.isBot" />
        <AppIcon v-else name="user" />
      </span>
      <span class="tablet-seat-person">
        <strong class="tablet-seat-name" :title="seat.name ?? '等待加入'">{{ seat.name ?? '等待加入' }}</strong>
        <span v-if="!lobby" class="tablet-seat-count" :aria-label="`剩余 ${seat.count} 张`">
          <b>{{ seat.count }}</b><span>张</span>
          <AppIcon name="cards" />
        </span>
        <span v-else class="tablet-seat-lobby-note">{{ seat.name ? (seat.isBot ? '机器人已就位' : '手机已连接') : canInvite ? '点击邀请好友' : '等待入座' }}</span>
      </span>
    </span>
    <span class="tablet-seat-status">
      <AppIcon v-if="active && !offline" name="play" class="tablet-seat-turn-icon" />
      <i v-else :class="{ ready: seat.ready || Boolean(finish) }"></i>
      <span>{{ status }}</span>
      <span v-if="seat.autoPlay && !seat.isBot && active" class="tablet-seat-managed">托管</span>
    </span>
    <svg v-if="active && !offline" class="tablet-seat-pointer" viewBox="0 0 32 12" aria-hidden="true"><path d="m6 10 10-8 10 8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </component>
</template>

<style scoped>
.tablet-seat { --seat-fill: #193f34; --seat-line: #8d9f776b; position:absolute;z-index:7;display:flex;flex-direction:column;width:168px;height:112px;min-width:0;margin:0;padding:12px 14px 8px;border:0;border-radius:17px;background:transparent;color:#e9e6cf;text-align:left;line-height:1.2;transform:translate(-50%,-50%) rotate(var(--seat-angle,0deg)) scale(var(--seat-scale,1));transform-origin:center;box-sizing:border-box;font-family:inherit;isolation:isolate; }
.tablet-seat-frame { position:absolute;inset:0;z-index:-1;width:100%;height:100%;overflow:visible;pointer-events:none; }
.tablet-seat-heading { display:flex;align-items:center;justify-content:space-between;height:16px;gap:5px; }
.tablet-seat-number { font-size:11px;letter-spacing:.12em;color:#c7cba9;white-space:nowrap;font-variant-numeric:tabular-nums; }
.tablet-seat-number > span { font-size:8px;letter-spacing:.02em;opacity:.7; }
.tablet-seat-role { display:inline-flex;align-items:center;gap:3px;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 7px;border:1px solid #9bac7b50;border-radius:9px;color:#cdd5ac;font-size:9px; }
.tablet-seat-role svg { width:11px;height:11px;flex:none; }
.tablet-seat-role.is-landlord { color:#f0d18a;border-color:#c6aa6a88; }
.tablet-seat[data-team="1"] .tablet-seat-role { color:#e6cb9b;border-color:#bfa77566; }
.tablet-seat-identity { display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:9px;height:51px; }
.tablet-seat-avatar { display:grid;place-items:center;width:32px;height:32px;border:1px solid #a8b58b4d;border-radius:50%;color:#c5cba4;background:#b4c68e0c; }
.tablet-seat-avatar > svg { width:24px;height:24px; }
.tablet-seat-person { display:flex;flex-direction:column;gap:2px;min-width:0; }
.tablet-seat-name { display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;letter-spacing:.02em; }
.tablet-seat-count { display:flex;align-items:baseline;gap:5px;height:30px;font-size:10px;color:#c9cfb0; }
.tablet-seat-count b { font-size:29px;font-weight:550;line-height:1;font-variant-numeric:tabular-nums;color:#f4ecd2; }
.tablet-seat-count svg { align-self:center;width:19px;height:19px;margin-left:auto;opacity:.55; }
.tablet-seat-lobby-note { font-size:9px;color:#a3b395;margin-top:5px; }
.tablet-seat-status { display:flex;align-items:center;justify-content:center;gap:6px;flex:1;min-height:22px;font-size:10px;letter-spacing:.08em;color:#a9bd9d;white-space:nowrap; }
.tablet-seat-status i { width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.6; }
.tablet-seat-status i.ready { color:#d8c281;opacity:1; }
.tablet-seat-turn-icon { width:11px;height:11px;fill:currentColor;stroke:none; }
.tablet-seat-managed { margin-left:auto;font-size:8px;letter-spacing:0;opacity:.8; }
.tablet-seat.is-active { --seat-fill:#304d36;--seat-line:#efd192;color:#ffe8b6;box-shadow:0 0 0 3px #e1c67a24,0 5px 18px #09251a66; }
.tablet-seat.is-active .tablet-seat-role { border-color:#e7c57777;color:#f6d995; }
.tablet-seat.is-active .tablet-seat-status { margin:3px -5px 0;border-radius:5px;background:#ecd18b;color:#25412e;font-size:11px;font-weight:650; }
.tablet-seat.is-active .tablet-seat-avatar { border-color:#d9c08688;color:#f0d28b; }
.tablet-seat-pointer { position:absolute;top:-14px;left:calc(50% - 16px);width:32px;height:12px;color:#f0ce80;animation:tablet-turn-point 1.6s ease-in-out infinite; }
.tablet-seat.is-empty { --seat-fill:#193f3499;--seat-line:#8d9f774d;cursor:pointer; }
.tablet-seat.is-empty:hover { --seat-line:#d9c086; }
.tablet-seat:focus-visible { outline:2px solid #efd192;outline-offset:5px; }
.tablet-seat.is-offline { --seat-line:#c9946977; }
.tablet-seat.is-offline .tablet-seat-status { color:#dfb18c; }
.tablet-seat.is-finished .tablet-seat-status { color:#e6cc89; }
@keyframes tablet-turn-point { 0%,100% { transform:translateY(0);opacity:1 } 50% { transform:translateY(-3px);opacity:.65 } }
@media (prefers-reduced-motion:reduce) { .tablet-seat-pointer { animation:none; } }
</style>
