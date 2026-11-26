import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import type { AnalysisScore } from '../../shared/boardAnalysis'

export interface UciSessionOptions {
  binary: string
  options: Record<string, string | number | boolean>
  requiredOptions: string[]
  signal?: AbortSignal
  timeoutMs?: number
}
interface UciPosition { position: string; go: string }
export interface UciSearch extends UciSessionOptions, UciPosition {}
export interface UciResult { move: string; output: string; options: Map<string, string>; score?: AnalysisScore }
export type UciSessionSearch = (position: UciPosition) => Promise<UciResult>
export type RunUciSession = <T>(request: UciSessionOptions, work: (search: UciSessionSearch) => Promise<T>) => Promise<T>

function scoreLine(line: string): { depth: number; score: AnalysisScore; bounded: boolean } | null {
  if (!line.startsWith('info ')) return null
  const score = /\bscore (cp|mate) (-?\d+)(?: (lowerbound|upperbound))?(?=\s|$)/.exec(line)
  if (!score) return null
  const value = Number(score[2])
  if (!Number.isSafeInteger(value)) return null
  return { depth: Number(/\bdepth (\d+)/.exec(line)?.[1] ?? -1), score: score[1] === 'cp' ? { evalCp: value } : { mate: value }, bounded: !!score[3] }
}

/** Keep one child for a sequence of searches, with bounded handshake and per-position time. */
export const withUciSession: RunUciSession = (request, work) => runSession(request, work, false)

/** Preserve the single-search deadline and invalid-bestmove contract used by board AI. */
export function searchUci(request: UciSearch): Promise<UciResult> {
  return runSession(request, async search => {
    const result = await search(request)
    if (!result.move || result.move === '(none)' || result.move === '0000') throw new Error('引擎没有返回可执行的走法')
    return result
  }, true)
}

function runSession<T>(request: UciSessionOptions, work: (search: UciSessionSearch) => Promise<T>, singleDeadline: boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) { reject(new Error('思考已取消')); return }
    const child = spawn(request.binary, [], { cwd: dirname(request.binary), stdio: ['pipe', 'pipe', 'pipe'] })
    let phase: 'uci' | 'ready' | 'idle' = 'uci'
    let buffer = '', output = '', bytes = 0, done = false
    let timer: NodeJS.Timeout | undefined
    let current: { resolve: (result: UciResult) => void; reject: (error: Error) => void;
      last: ReturnType<typeof scoreLine>; exact: Map<number, AnalysisScore> } | null = null
    const options = new Map<string, string>()
    const abort = () => finish(new Error('思考已取消'))

    function armTimeout() {
      clearTimeout(timer)
      timer = setTimeout(() => finish(new Error('棋类引擎响应超时')), request.timeoutMs ?? 10_000)
    }
    function finish(error?: Error, value?: T) {
      if (done) return
      done = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
      if (error) current?.reject(error)
      current = null
      const settle = () => { if (error) reject(error); else resolve(value!) }
      child.stdin.end('quit\n')
      child.kill('SIGTERM')
      if (singleDeadline || child.exitCode !== null || child.signalCode !== null) settle()
      else child.once('close', settle)
      const killer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 500)
      killer.unref()
      child.once('close', () => clearTimeout(killer))
    }
    function send(line: string) {
      if (!done && child.stdin.writable) child.stdin.write(`${line}\n`)
    }
    const search: UciSessionSearch = ({ position, go }) => new Promise((resolveSearch, rejectSearch) => {
      if (done || phase !== 'idle' || current) { rejectSearch(new Error('棋类引擎会话当前无法搜索')); return }
      current = { resolve: resolveSearch, reject: rejectSearch, last: null, exact: new Map() }
      if (!singleDeadline) armTimeout()
      send(position)
      send(go)
    })
    function line(text: string) {
      if (done || (singleDeadline && phase === 'idle' && !current)) return
      output = `${output}${text}\n`.slice(-12000)
      if (/\bERROR\b|network.*not loaded|failed to load/i.test(text)) { finish(new Error(`棋类引擎加载失败：${text.slice(0, 200)}`)); return }
      const option = /^option name (.+?) type (.+)$/.exec(text)
      if (option) options.set(option[1]!.toLowerCase(), option[2]!)
      if (text === 'uciok' && phase === 'uci') {
        for (const name of request.requiredOptions) if (!options.has(name.toLowerCase())) { finish(new Error(`引擎不支持必要参数 ${name}`)); return }
        for (const [name, value] of Object.entries(request.options)) {
          if (!options.has(name.toLowerCase())) { finish(new Error(`引擎不支持参数 ${name}`)); return }
          if (name === 'UCI_Variant' && !options.get(name.toLowerCase())!.includes(`var ${value}`)) { finish(new Error('引擎未包含中国象棋棋规')); return }
          send(`setoption name ${name} value ${value}`)
        }
        phase = 'ready'
        send('ucinewgame')
        send('isready')
      } else if (text === 'readyok' && phase === 'ready') {
        phase = 'idle'
        if (!singleDeadline) clearTimeout(timer)
        void work(search).then(value => finish(undefined, value), error => finish(error))
      } else if (current && text.startsWith('bestmove ')) {
        const { last, exact, resolve: resolveSearch } = current
        current = null
        if (!singleDeadline) clearTimeout(timer)
        const score = last ? exact.get(last.depth) ?? last.score : undefined
        resolveSearch({ move: text.split(/\s+/)[1] ?? '', output, options, ...(score ? { score } : {}) })
      } else if (current && !singleDeadline) {
        const entry = scoreLine(text)
        if (entry) {
          current.last = entry
          if (!entry.bounded) current.exact.set(entry.depth, entry.score)
        }
      }
    }
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 2 * 1024 * 1024) { finish(new Error('引擎输出超过限制')); return }
      buffer += String(chunk)
      if (buffer.length > 65536 && !buffer.includes('\n')) { finish(new Error('引擎输出格式错误')); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end).trim()); buffer = buffer.slice(end + 1) }
    })
    child.stderr.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-12000) })
    child.stdin.on('error', error => finish(new Error(`无法向棋类引擎发送指令：${error.message}`)))
    child.on('error', error => finish(new Error(`无法启动棋类引擎：${error.message}`)))
    child.on('exit', () => { if (!done) finish(new Error(`棋类引擎提前退出：${output.slice(-300)}`)) })
    request.signal?.addEventListener('abort', abort, { once: true })
    armTimeout()
    if (request.signal?.aborted) abort(); else send('uci')
  })
}
