import test from 'node:test'
import assert from 'node:assert/strict'
import { useScreenAwake, type AwakeEnvironment, type ScreenLock } from '../src/useScreenAwake'

class Lock implements ScreenLock {
  released = false
  listeners: (() => void)[] = []
  addEventListener(_type: 'release', listener: () => void) { this.listeners.push(listener) }
  async release() { this.released = true; this.listeners.forEach(fn => fn()) }
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }
function environment() {
  let visible = true
  let onVisibility = () => {}
  const locks: Lock[] = []
  const env: AwakeEnvironment = {
    secure: true, supported: true, visible: () => visible,
    request: async () => { const lock = new Lock(); locks.push(lock); return lock },
    subscribe: fn => { onVisibility = fn; return () => { onVisibility = () => {} } },
  }
  return { env, locks, visibility(value: boolean) { visible = value; onVisibility() } }
}

test('screen awake refuses HTTP and unsupported browsers without pretending to hold a lock', async () => {
  for (const secure of [false, true]) {
    const { env, locks } = environment()
    env.secure = secure; env.supported = false
    const awake = useScreenAwake(env)
    awake.setEnabled(true); await settle()
    assert.equal(awake.active.value, false)
    assert.equal(locks.length, 0)
    assert.match(awake.note.value, secure ? /不支持/ : /HTTPS/)
    awake.dispose()
  }
})

test('screen awake releases on background, reacquires on return and releases on disposal', async () => {
  const e = environment(); const awake = useScreenAwake(e.env)
  awake.setEnabled(true); await settle()
  assert.equal(awake.active.value, true)
  e.visibility(false); await settle()
  assert.equal(e.locks[0]!.released, true)
  assert.equal(awake.active.value, false)
  e.visibility(true); await settle()
  assert.equal(e.locks.length, 2)
  assert.equal(awake.active.value, true)
  awake.dispose(); await settle()
  assert.equal(e.locks[1]!.released, true)
})

test('a late granted wake lock is released after disabling or closing the page', async () => {
  const e = environment(); let grant!: (lock: Lock) => void
  e.env.request = () => new Promise(resolve => { grant = resolve })
  const awake = useScreenAwake(e.env)
  awake.setEnabled(true); await settle()
  awake.setEnabled(false)
  const late = new Lock(); grant(late); await settle()
  assert.equal(late.released, true)
  assert.equal(awake.active.value, false)
  awake.dispose()
})

test('system revocation stays truthful, retry and rejected requests do not loop', async () => {
  const e = environment(); const awake = useScreenAwake(e.env)
  awake.setEnabled(true); await settle()
  await e.locks[0]!.release()
  assert.equal(awake.active.value, false)
  assert.match(awake.note.value, /暂停/)
  await awake.retry()
  assert.equal(awake.active.value, true)
  awake.setEnabled(false); await settle()
  let calls = 0
  e.env.request = async () => { calls++; throw Error('low battery') }
  awake.setEnabled(true); await settle()
  assert.equal(calls, 1)
  assert.equal(awake.active.value, false)
  assert.match(awake.note.value, /未允许/)
  awake.dispose()
})
