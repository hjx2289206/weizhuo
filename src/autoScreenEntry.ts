/** Attempt once on entry, then once inside a real gesture. Explicit retries remain available. */
export function installAutoScreenEntry(env: {
  enter(): void; active(): boolean; busy(): boolean
  listen(listener: (event: Event) => void): () => void
}) {
  let stopped = false
  const retry = (event: Event): void => {
    if (stopped || env.busy()) return
    if (event.type === 'keydown' && !['Enter', ' '].includes((event as KeyboardEvent).key)) return
    if (typeof Element !== 'undefined' && event.target instanceof Element && event.target.closest('[data-skip-fullscreen]')) return
    if (!env.active()) env.enter()
    stop()
  }
  const unsubscribe = env.listen(retry)
  function stop(): void { if (stopped) return; stopped = true; unsubscribe() }
  env.enter()
  return stop
}
