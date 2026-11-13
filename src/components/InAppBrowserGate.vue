<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { ref } from 'vue'
import { detectInAppBrowser } from '../../shared/inAppBrowser'

/**
 * Hard gate for WeChat / QQ embedded webviews.
 *
 * The bootstrap only mounts this component and never imports the game, so a blocked
 * page has no game DOM and opens no `/ws` socket. There is deliberately no dismiss or
 * continue control: no Esc handler, no button that closes the gate or skips into the
 * game — the only button copies the link. No automatic external URL scheme either. The
 * copy button reports success only when the browser actually copied.
 */

const host = detectInAppBrowser(typeof navigator === 'undefined' ? '' : navigator.userAgent)
const hostLabel = host === 'qq' ? 'QQ 内置浏览器' : host === 'wechat' ? '微信内置浏览器' : '内置浏览器'
const menuLabel = host === 'qq' ? '右上角「⋯」菜单' : '右上角「···」菜单'

/** Byte-identical to the address bar: the external browser must open exactly this page. */
const currentUrl = typeof location === 'undefined' ? '' : location.href

const urlField = ref<HTMLInputElement | null>(null)
const feedback = ref('')
const copyState = ref<'idle' | 'copied' | 'manual'>('idle')

async function copyLink(): Promise<void> {
  const canUseClipboardApi =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.clipboard) &&
    typeof navigator.clipboard.writeText === 'function' &&
    typeof window !== 'undefined' &&
    window.isSecureContext
  if (canUseClipboardApi) {
    try {
      await navigator.clipboard.writeText(currentUrl)
      copyState.value = 'copied'
      feedback.value = '链接已复制，请粘贴到外部浏览器的地址栏打开。'
      return
    } catch {
      /* clipboard API refused: fall back to a selectable copy below */
    }
  }
  const field = urlField.value
  let copied = false
  if (field) {
    field.focus({ preventScroll: true })
    field.select()
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
  }
  if (copied) {
    copyState.value = 'copied'
    feedback.value = '链接已复制，请粘贴到外部浏览器的地址栏打开。'
    return
  }
  copyState.value = 'manual'
  feedback.value = '当前浏览器不允许自动复制。链接已选中，请手动复制后粘贴到外部浏览器打开。'
}
</script>

<template>
  <div class="browser-gate">
    <section class="browser-gate-panel">
      <AppIcon class="browser-gate-icon" name="share" />
      <p class="browser-gate-kicker">{{ hostLabel }}</p>
      <h1>请在外部浏览器打开</h1>
      <p class="browser-gate-lead">
        为保证全屏、横屏和手势的一致体验，微信 / QQ 内置浏览器不允许进入游戏。请使用外部浏览器。
      </p>
      <ol class="browser-gate-steps">
        <li>点{{ menuLabel }}</li>
        <li>选择「在浏览器打开」</li>
        <li>若没有该选项，复制下方链接，粘贴到 Safari、Chrome 等外部浏览器打开</li>
      </ol>
      <input
        ref="urlField"
        class="browser-gate-url"
        type="text"
        :value="currentUrl"
        readonly
        aria-label="当前页面链接"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
      />
      <button class="browser-gate-copy" type="button" @click="copyLink"><AppIcon name="copy" />复制链接</button>
      <p class="browser-gate-feedback" :class="`is-${copyState}`" role="status" aria-live="polite">
        {{ feedback }}
      </p>
      <p class="browser-gate-note">建议先用外部浏览器打开再入座；如已入座，换浏览器或手机需由房主确认接替。</p>
    </section>
  </div>
</template>
