import { computed, provide, ref, watch, type InjectionKey, type Ref } from 'vue'
import type { GameController } from './useGame'
import { useScreenAwake, type ScreenAwake } from './useScreenAwake'
import { appendResult, readResults, resultFromSnapshot, RESULT_HISTORY_KEY, type ResultRecord } from './resultHistory'

export interface GameToolsContext {
  awake: ScreenAwake
  records: Ref<ResultRecord[]>
  storageNote: Ref<string>
  resultOpen: Ref<boolean>
}
export const GAME_TOOLS: InjectionKey<GameToolsContext> = Symbol('game-tools')

export function provideGameTools(game: GameController): GameToolsContext {
  const awake = useScreenAwake()
  const records = ref<ResultRecord[]>([])
  const storageNote = ref('')
  const resultOpen = ref(false)
  let shownResult = ''
  try { records.value = readResults(window.localStorage) } catch { storageNote.value = '当前浏览器不允许保存战绩，记录仅保留在本页面' }
  const finished = computed(() => game.state.value?.phase === 'finished' && game.state.value.role !== 'spectator' ? game.state.value : null)
  watch(finished, snapshot => {
    if (!snapshot) { resultOpen.value = false; return }
    const record = resultFromSnapshot(snapshot)
    if (!record) return
    if (record.key !== shownResult) { shownResult = record.key; resultOpen.value = true }
    if (records.value.some(r => r.key === record.key)) return
    records.value = appendResult(records.value, record)
    try { window.localStorage.setItem(RESULT_HISTORY_KEY, JSON.stringify(records.value)) }
    catch { storageNote.value = '战绩未能写入浏览器，记录仅保留在本页面' }
  })
  const tools = { awake, records, storageNote, resultOpen }
  provide(GAME_TOOLS, tools)
  return tools
}
