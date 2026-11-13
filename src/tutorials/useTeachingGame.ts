import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import type { GameKind } from '../../shared/protocol'
import { TUTORIAL_VERSION, type TeachingLevel, type TeachingRequest, type TeachingResponse, type TeachingState } from '../../shared/tutorialProtocol'
import { clipDuration, clipPosition } from './motion'

const key = (game: GameKind, level: TeachingLevel) => `tabletop:tutorial:${game}${game === 'go' ? `:${level}` : ''}`
export function useTeachingGame(game: GameKind, level: TeachingLevel = 'basic') {
  const data = shallowRef<TeachingState | null>(null), connected = ref(false), loading = ref(true), error = ref(''), notice = ref('')
  const elapsed = ref(0), paused = ref(false), watched = ref<string[]>([])
  const portrait = ref(innerHeight > innerWidth)
  const needsLandscape = computed(() => (game === 'doudizhu' || game === 'guandan') && portrait.value)
  const needsPortrait = computed(() => (game === 'xiangqi' || game === 'chess' || game === 'go' || game === 'gomoku') && !portrait.value)
  const needsRotation = computed(() => needsLandscape.value || needsPortrait.value)
  const media = matchMedia('(prefers-reduced-motion: reduce)'), reduced = ref(media.matches)
  let socket: WebSocket | null = null, disposed = false, sequence = 0, connection = 0, reconnect: ReturnType<typeof setTimeout> | undefined
  let pending: { id: string; timer: ReturnType<typeof setTimeout> } | null = null, wireVersion = 0, wanted: string | undefined, frameId = 0, lastTick = 0, recovering = false
  const clip = computed(() => data.value?.clip ?? null)
  const duration = computed(() => clip.value ? clipDuration(clip.value, reduced.value) : 0)
  const position = computed(() => clip.value ? clipPosition(clip.value, elapsed.value, reduced.value) : null)
  const ended = computed(() => position.value?.ended ?? false)
  const stage = computed(() => loading.value ? 'loading' : ended.value ? 'ended' : paused.value ? 'paused' : 'playing')
  function saved(): { clipId?: string; watched: string[] } {
    try {
      const value = JSON.parse(localStorage.getItem(key(game,level)) ?? '{}')
      if (value?.courseVersion && value.courseVersion !== TUTORIAL_VERSION) { notice.value = '教程已更新为动画短片，从新版首段开始'; return { watched: [] } }
      return { clipId: typeof value?.clipId === 'string' ? value.clipId : undefined, watched: Array.isArray(value?.watched) ? value.watched.filter((id: unknown): id is string => typeof id === 'string') : [] }
    } catch { return { watched: [] } }
  }
  function persist(): void {
    try { localStorage.setItem(key(game,level), JSON.stringify({ courseVersion: TUTORIAL_VERSION, clipId: data.value?.clip.id, watched: watched.value })) }
    catch { notice.value = '当前浏览器不能保存观看进度' }
  }
  function stopClock(): void { cancelAnimationFrame(frameId); frameId = 0; lastTick = 0 }
  function tick(now: number): void {
    frameId = 0
    if (disposed || paused.value || loading.value || !clip.value) return
    if (lastTick) elapsed.value = Math.min(duration.value, elapsed.value + Math.max(0, now - lastTick))
    lastTick = now
    if (ended.value) {
      if (!watched.value.includes(clip.value.id)) { watched.value = [...watched.value, clip.value.id]; persist() }
      stopClock(); return
    }
    frameId = requestAnimationFrame(tick)
  }
  function play(): void { if (needsRotation.value) { paused.value = true; return }; if (!loading.value && !ended.value) { paused.value = false; lastTick = 0; if (!frameId) frameId = requestAnimationFrame(tick) } }
  function pause(message?: string): void { stopClock(); paused.value = true; if (message && !ended.value) notice.value = message }
  function replay(): void { stopClock(); elapsed.value = 0; notice.value = ''; paused.value = false; play() }
  function toggle(): void { if (ended.value) replay(); else if (paused.value) { notice.value = ''; play() } else pause() }
  function clearPending(): void { if (pending) clearTimeout(pending.timer); pending = null }
  function send(request: Omit<TeachingRequest, 'id' | 'version'>): void {
    if (!socket || socket.readyState !== WebSocket.OPEN || pending) return
    const id = `view-${++sequence}`
    pending = { id, timer: setTimeout(() => { if (pending?.id !== id) return; error.value = '教程响应超时，正在重新连接'; socket?.close() }, 15000) }
    loading.value = true; stopClock()
    socket.send(JSON.stringify({ ...request, id, version: wireVersion }))
  }
  function selectClip(id: string): void {
    if (!data.value?.clips.some(clip => clip.id === id)) return
    wanted = id; error.value = ''; notice.value = ''; pause(); loading.value = true
    if (!pending) send({ type: 'scene', clipId: id })
  }
  function adjacent(delta: number): void {
    const clips = data.value?.clips ?? [], index = clips.findIndex(clip => clip.id === (wanted ?? data.value?.clip.id)), target = clips[index + delta]
    if (target) selectClip(target.id)
  }
  function install(response: TeachingState): void {
    data.value = response; elapsed.value = 0; loading.value = false; error.value = ''
    watched.value = watched.value.filter(id => response.clips.some(clip => clip.id === id)); persist()
    paused.value = recovering || document.hidden || needsRotation.value; recovering = false
    if (!paused.value) play()
  }
  function connect(): void {
    if (disposed) return
    const run = ++connection
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/tutorial`); socket = ws
    ws.onopen = () => {
      if (run !== connection || disposed) return
      connected.value = true; error.value = ''
      const progress = saved(); watched.value = progress.watched
      wanted = wanted ?? data.value?.clip.id ?? progress.clipId
      send({ type: 'start', game, level, courseVersion: TUTORIAL_VERSION, clipId: wanted })
    }
    ws.onmessage = event => {
      if (run !== connection || disposed) return
      let response: TeachingResponse
      try { response = JSON.parse(String(event.data)) } catch { error.value = '教程响应格式不正确'; return }
      if (!pending || response.id !== pending.id) return
      clearPending()
      if (response.type === 'tutorial-error') { error.value = response.message; loading.value = false; wanted = undefined; return }
      wireVersion = response.version
      // Coalesce fast navigation. An older selection can never replace the latest requested clip.
      if (wanted && response.clip.id !== wanted && response.clips.some(clip => clip.id === wanted)) { send({ type: 'scene', clipId: wanted }); return }
      wanted = response.clip.id; install(response)
    }
    ws.onclose = () => {
      if (run !== connection || disposed) return
      connected.value = false; clearPending(); pause(); loading.value = true; recovering = true
      error.value = '教程连接已中断，正在恢复当前片段'; reconnect = setTimeout(connect, 1200)
    }
    ws.onerror = () => ws.close()
  }
  const visibility = () => { if (document.hidden) pause('已暂停，回到页面后点击“继续播放”') }
  const resize = () => { portrait.value = innerHeight > innerWidth; if (clip.value && !ended.value) pause(needsLandscape.value ? '把手机横过来，再继续看这一段' : needsPortrait.value ? '把设备竖起来，再继续看这一段' : '画面已调整好，点击“继续播放”接着看') }
  const preference = () => { pause('动态效果偏好已更新，可重播当前片段'); reduced.value = media.matches; elapsed.value = 0 }
  window.addEventListener('resize', resize); window.addEventListener('orientationchange', resize); document.addEventListener('visibilitychange', visibility); media.addEventListener('change', preference)
  onScopeDispose(() => {
    disposed = true; connection++; stopClock(); clearTimeout(reconnect); clearPending()
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: `exit-${++sequence}`, type: 'exit' }))
    socket?.close(); window.removeEventListener('resize', resize); window.removeEventListener('orientationchange', resize); document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', preference)
  })
  connect()
  return { data, clip, connected, loading, error, notice, elapsed, duration, position, paused, ended, reduced, watched, stage, needsLandscape, needsPortrait, needsRotation, pause, toggle, replay, selectClip, adjacent,
    progress: computed(() => data.value ? `${data.value.index + 1} / ${data.value.total}` : '连接中') }
}
