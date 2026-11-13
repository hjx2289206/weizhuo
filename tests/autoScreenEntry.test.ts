import test from 'node:test'
import assert from 'node:assert/strict'
import { installAutoScreenEntry } from '../src/autoScreenEntry'

function setup() {
  let attempts = 0; let removed = 0; let active = false; let busy = false
  let listener = (_event: Event) => {}
  const stop = installAutoScreenEntry({
    enter() { attempts++ }, active: () => active, busy: () => busy,
    listen(fn) { listener = fn; return () => { removed++ } },
  })
  return { stop, attempts: () => attempts, removed: () => removed,
    send(type: string, key?: string) { const event = new Event(type); if (key) Object.defineProperty(event, 'key', { value: key }); listener(event) },
    setActive(value: boolean) { active = value }, setBusy(value: boolean) { busy = value },
  }
}
test('site entry tries fullscreen on load and retries once on a gesture without looping after native exit', () => {
  const s = setup()
  assert.equal(s.attempts(), 1)
  s.send('pointerdown'); assert.equal(s.attempts(), 2); assert.equal(s.removed(), 1)
  s.setActive(true); s.setActive(false); s.send('pointerdown')
  assert.equal(s.attempts(), 2)
  s.stop(); assert.equal(s.removed(), 1)
})
test('typing and pending requests do not consume the entry gesture; cleanup cancels further retries', () => {
  const s = setup()
  s.send('keydown', 'a'); assert.equal(s.attempts(), 1)
  s.setBusy(true); s.send('pointerdown'); assert.equal(s.removed(), 0)
  s.setBusy(false); s.send('keydown', 'Enter'); assert.equal(s.attempts(), 2)
  const closed = setup(); closed.stop(); closed.send('pointerdown'); assert.equal(closed.attempts(), 1)
})
test('an existing fullscreen session is not requested again by the first gesture', () => {
  const s = setup(); s.setActive(true); s.send('pointerdown')
  assert.equal(s.attempts(), 1); assert.equal(s.removed(), 1)
})
