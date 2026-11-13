import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** A landscape phone sees the whole desktop composition, scaled as one surface. */
export const LOBBY_WIDTH = 1040
export function lobbyScale(width: number, availableHeight = Infinity, contentHeight = 1): number {
  return Math.min(1, Math.max(0, width) / LOBBY_WIDTH, Math.max(0, availableHeight) / Math.max(1, contentHeight))
}

export function useLobbyScale(viewport: Ref<HTMLElement | null>, content: Ref<HTMLElement | null>) {
  const compact = ref(false)
  const scale = ref(1)
  const height = ref(0)
  const left = ref(0)
  let lastWidth = 0
  let availableHeight = 0
  let observer: ResizeObserver | null = null
  function measure(): void {
    const width = viewport.value?.clientWidth ?? window.innerWidth
    const editing = document.activeElement?.matches('input, textarea, select')
    if (!editing || width !== lastWidth) compact.value = window.matchMedia('(orientation: landscape) and (max-height: 600px) and (max-width: 1100px)').matches
    // Opening the keyboard must not shrink the whole lobby under the user's finger.
    if (!editing || width !== lastWidth || !availableHeight) availableHeight = window.innerHeight
    lastWidth = width
    height.value = content.value?.offsetHeight ?? 0
    scale.value = compact.value ? lobbyScale(width, availableHeight, height.value) : 1
    left.value = compact.value ? Math.max(0, (width - LOBBY_WIDTH * scale.value) / 2) : 0
  }
  onMounted(() => {
    observer = new ResizeObserver(measure)
    if (viewport.value) observer.observe(viewport.value)
    if (content.value) observer.observe(content.value)
    window.addEventListener('resize', measure)
    measure()
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    window.removeEventListener('resize', measure)
  })
  return {
    compact,
    frameStyle: computed(() => compact.value ? { height: `${height.value * scale.value}px` } : {}),
    canvasStyle: computed(() => compact.value ? {
      width: `${LOBBY_WIDTH}px`, transform: `scale(${scale.value})`, transformOrigin: 'top left', marginLeft: `${left.value}px`,
    } : {}),
  }
}
