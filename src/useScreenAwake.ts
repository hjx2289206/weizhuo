import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'

export interface ScreenLock {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}
export interface AwakeEnvironment {
  secure: boolean
  supported: boolean
  visible(): boolean
  request(): Promise<ScreenLock>
  subscribe(listener: () => void): () => void
}

function browserEnvironment(): AwakeEnvironment {
  const wake = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<ScreenLock> } }).wakeLock
  return {
    secure: window.isSecureContext,
    supported: !!wake,
    visible: () => document.visibilityState === 'visible',
    request: () => wake!.request('screen'),
    subscribe(listener) {
      document.addEventListener('visibilitychange', listener)
      window.addEventListener('pageshow', listener)
      return () => {
        document.removeEventListener('visibilitychange', listener)
        window.removeEventListener('pageshow', listener)
      }
    },
  }
}

export function useScreenAwake(env: AwakeEnvironment = browserEnvironment()) {
  const enabled = ref(false)
  const active = ref(false)
  const busy = ref(false)
  const message = ref('')
  let lock: ScreenLock | null = null
  let generation = 0
  let disposed = false
  let pending: Promise<void> | null = null

  async function release(): Promise<void> {
    const previous = lock
    lock = null
    active.value = false
    if (previous && !previous.released) {
      try { await previous.release() } catch { message.value = '系统未能释放常亮，请关闭此页面' }
    }
  }

  function acquire(): Promise<void> {
    if (pending) return pending
    if (disposed || !enabled.value || !env.visible() || (lock && !lock.released)) return Promise.resolve()
    if (!env.secure || !env.supported) return Promise.resolve()
    const attempt = generation
    busy.value = true
    message.value = ''
    pending = (async () => {
      try {
        const next = await Promise.resolve().then(() => env.request())
        if (disposed || attempt !== generation || !enabled.value || !env.visible()) {
          await next.release()
          return
        }
        lock = next
        active.value = !next.released
        next.addEventListener('release', () => {
          if (lock !== next) return
          lock = null
          active.value = false
          if (enabled.value) message.value = '系统已暂停常亮，可点击重试'
        })
      } catch {
        if (attempt === generation) message.value = '系统未允许常亮，请检查省电设置后重试'
      } finally {
        pending = null
        busy.value = false
        if (!disposed && attempt !== generation && enabled.value && env.visible()) void acquire()
      }
    })()
    return pending
  }

  function setEnabled(value: boolean): void {
    generation += 1
    enabled.value = value
    message.value = ''
    if (value) void acquire()
    else void release()
  }
  function refresh(): void {
    if (!env.visible()) {
      generation += 1
      void release()
    } else if (enabled.value) void acquire()
  }
  const unsubscribe = env.subscribe(refresh)
  function dispose(): void {
    disposed = true
    generation += 1
    unsubscribe()
    void release()
  }
  if (getCurrentScope()) onScopeDispose(dispose)
  const note = computed(() => {
    if (!env.secure) return '此地址为 HTTP，常亮需要 HTTPS；可在系统设置中延长自动锁屏时间'
    if (!env.supported) return '当前浏览器不支持屏幕常亮，可在系统设置中延长自动锁屏时间'
    if (active.value) return '屏幕常亮已开启；切到后台时自动释放，回来后重新申请'
    if (message.value) return message.value
    return enabled.value ? '等待页面回到前台后开启常亮' : '开启后在本页面保持屏幕常亮'
  })
  return { enabled, active, busy, note, supported: env.secure && env.supported, setEnabled, retry: acquire, dispose }
}
export type ScreenAwake = ReturnType<typeof useScreenAwake>
