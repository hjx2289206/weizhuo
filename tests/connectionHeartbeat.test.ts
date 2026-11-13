import test from 'node:test'
import assert from 'node:assert/strict'
import { createHeartbeat } from '../src/connectionHeartbeat'

function transport() {
  let sequence = 0
  const tasks = new Map<number, () => void>()
  const sent: string[] = []
  let stale = 0
  const heartbeat = createHeartbeat({
    send(id) { sent.push(id); return true }, stale() { stale++ },
    setTimeout(fn) { const id = ++sequence; tasks.set(id, fn); return id },
    clearTimeout(id) { tasks.delete(id) },
  })
  return { heartbeat, sent, tasks, stale: () => stale, tick() { const next = tasks.entries().next().value!; tasks.delete(next[0]); next[1]() } }
}
test('heartbeat accepts only its own pong and terminates a stale connection once', () => {
  const t = transport(); t.heartbeat.start(); t.tick()
  assert.equal(t.sent.length, 1)
  t.heartbeat.pong('old'); t.tick()
  assert.equal(t.stale(), 1)
  assert.equal(t.tasks.size, 0)
})
test('heartbeat renews after a pong, does not overlap probes and clears timers on stop', () => {
  const t = transport(); t.heartbeat.start(); t.heartbeat.pulse(); t.heartbeat.pulse()
  assert.equal(t.sent.length, 1)
  t.heartbeat.pong(t.sent[0]!); t.tick()
  assert.equal(t.sent.length, 2)
  t.heartbeat.stop()
  assert.equal(t.tasks.size, 0)
  t.heartbeat.pong(t.sent[1]!)
  assert.equal(t.tasks.size, 0)
  assert.equal(t.stale(), 0)
})
