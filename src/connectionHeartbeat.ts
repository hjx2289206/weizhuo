export interface HeartbeatTransport {
  send(id: string): boolean
  stale(): void
  setTimeout(callback: () => void, ms: number): number
  clearTimeout(id: number): void
}

/** Separate liveness from game actions: a missed heartbeat never replays a move. */
export function createHeartbeat(transport: HeartbeatTransport, interval = 15_000, timeout = 8_000) {
  let timer: number | null = null
  let waiting: string | null = null
  let sequence = 0
  let running = false
  function clear(): void {
    if (timer !== null) transport.clearTimeout(timer)
    timer = null
  }
  function stop(): void { running = false; waiting = null; clear() }
  function pulse(): void {
    if (!running || waiting !== null) return
    clear()
    const id = `heartbeat-${++sequence}`
    waiting = id
    if (!transport.send(id)) { stop(); transport.stale(); return }
    timer = transport.setTimeout(() => {
      if (waiting !== id) return
      stop()
      transport.stale()
    }, timeout)
  }
  function schedule(): void {
    clear()
    timer = transport.setTimeout(pulse, interval)
  }
  return {
    start() { stop(); running = true; schedule() },
    stop,
    pulse,
    pong(id: string) {
      if (!running || waiting !== id) return
      waiting = null
      schedule()
    },
  }
}
