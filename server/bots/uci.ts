import { spawn } from 'node:child_process'
import { dirname } from 'node:path'

export interface UciSearch {
  binary: string
  options: Record<string, string | number | boolean>
  requiredOptions: string[]
  position: string
  go: string
  signal?: AbortSignal
  timeoutMs?: number
}
export interface UciResult { move: string; output: string; options: Map<string, string> }
/** One process per search isolates options/hash/history between rooms. No shell is involved. */
export function searchUci(request: UciSearch): Promise<UciResult> {
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) { reject(new Error('思考已取消')); return }
    const child = spawn(request.binary, [], { cwd: dirname(request.binary), stdio: ['pipe','pipe','pipe'] })
    let phase: 'uci' | 'ready' | 'search' = 'uci', buffer = '', output = '', bytes = 0, done = false
    const options = new Map<string, string>()
    const timer = setTimeout(() => finish(new Error('棋类引擎响应超时')), request.timeoutMs ?? 10000)
    const abort = () => finish(new Error('思考已取消'))
    function finish(error?: Error, move?: string) {
      if (done) return
      done = true; clearTimeout(timer); request.signal?.removeEventListener('abort', abort)
      child.stdin.end('quit\n'); child.kill('SIGTERM')
      const killer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 500); killer.unref()
      if (error) reject(error); else resolve({ move: move!, output, options })
    }
    const send = (line: string) => { if (!done && child.stdin.writable) child.stdin.write(`${line}\n`) }
    function line(text: string) {
      if (done) return
      output = `${output}${text}\n`.slice(-12000)
      if (/\bERROR\b|network.*not loaded|failed to load/i.test(text)) { finish(new Error(`棋类引擎加载失败：${text.slice(0,200)}`)); return }
      const option = /^option name (.+?) type (.+)$/.exec(text)
      if (option) options.set(option[1]!.toLowerCase(), option[2]!)
      if (text === 'uciok' && phase === 'uci') {
        for (const name of request.requiredOptions) if (!options.has(name.toLowerCase())) { finish(new Error(`引擎不支持必要参数 ${name}`)); return }
        for (const [name, value] of Object.entries(request.options)) {
          if (!options.has(name.toLowerCase())) { finish(new Error(`引擎不支持参数 ${name}`)); return }
          if (name === 'UCI_Variant' && !options.get(name.toLowerCase())!.includes(`var ${value}`)) { finish(new Error('引擎未包含中国象棋棋规')); return }
          send(`setoption name ${name} value ${value}`)
        }
        send('ucinewgame'); send('isready'); phase = 'ready'
      } else if (text === 'readyok' && phase === 'ready') {
        phase = 'search'; send(request.position); send(request.go)
      } else if (text.startsWith('bestmove ') && phase === 'search') {
        const move = text.split(/\s+/)[1]
        if (!move || move === '(none)' || move === '0000') finish(new Error('引擎没有返回可执行的走法'))
        else finish(undefined, move)
      }
    }
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 2 * 1024 * 1024) { finish(new Error('引擎输出超过限制')); return }
      buffer += String(chunk)
      if (buffer.length > 65536 && !buffer.includes('\n')) { finish(new Error('引擎输出格式错误')); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0,end).trim()); buffer = buffer.slice(end+1) }
    })
    child.stderr.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-12000) })
    child.stdin.on('error', error => finish(new Error(`无法向棋类引擎发送指令：${error.message}`)))
    child.on('error', error => finish(new Error(`无法启动棋类引擎：${error.message}`)))
    child.on('exit', () => { if (!done) finish(new Error(`棋类引擎提前退出：${output.slice(-300)}`)) })
    request.signal?.addEventListener('abort', abort, { once: true })
    // Close the race between the initial signal check and adding its listener.
    if (request.signal?.aborted) abort(); else send('uci')
  })
}
