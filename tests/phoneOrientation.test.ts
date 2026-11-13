import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, ref } from 'vue';
import { usePhoneScreen } from '../src/usePhoneScreen';

async function environment(run: (env: { locks: string[]; unlocks: () => number; fullscreen: (value: boolean) => void; deferFullscreen: () => () => void }) => Promise<void>) {
  const previous = new Map(['window', 'document', 'screen'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const locks: string[] = [];
  let unlocks = 0, fullscreen = true, resolveFullscreen: (() => void) | null = null;
  const events = { addEventListener() {}, removeEventListener() {} };
  const doc = {
    ...events,
    get fullscreenElement() { return fullscreen ? {} : null },
    documentElement: { requestFullscreen: () => new Promise<void>(resolve => { resolveFullscreen = () => { fullscreen = true; resolve() } }) },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { ...events, innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: false, ...events }) } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'screen', { configurable: true, value: { orientation: { lock: async (direction: string) => { locks.push(direction) }, unlock: () => { unlocks++ } } } });
  try { await run({ locks, unlocks: () => unlocks, fullscreen: value => { fullscreen = value }, deferFullscreen: () => () => resolveFullscreen?.() }) }
  finally { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } }
}

test('Junqi entry releases the hall landscape lock and subsequent fullscreen requests portrait', async () => {
  await environment(async env => {
    const preferred = ref<'landscape' | 'portrait'>('landscape');
    const scope = effectScope(); const api = scope.run(() => usePhoneScreen(preferred))!;
    try {
      api.enter(); await Promise.resolve(); assert.deepEqual(env.locks, ['landscape']);
      preferred.value = 'portrait'; await Promise.resolve();
      assert.equal(env.unlocks(), 1); assert.deepEqual(env.locks, ['landscape', 'portrait']);
      assert.match(api.note.value, /竖屏/); assert.ok(!api.note.value.includes('横屏'));
      api.enter(); await Promise.resolve(); assert.equal(env.locks.at(-1), 'portrait');
    } finally { scope.stop() }
  });
});

test('A delayed fullscreen grant uses the new game orientation rather than the old hall preference', async () => {
  await environment(async env => {
    env.fullscreen(false);
    const preferred = ref<'landscape' | 'portrait'>('landscape');
    const scope = effectScope(); const api = scope.run(() => usePhoneScreen(preferred))!;
    try {
      api.enter(); const grant = env.deferFullscreen();
      preferred.value = 'portrait'; grant();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      assert.deepEqual(env.locks, ['portrait']);
      assert.equal(env.unlocks(), 1);
      preferred.value = 'landscape'; await Promise.resolve();
      assert.equal(env.locks.at(-1), 'landscape'); // returning to the card games keeps their contract
    } finally { scope.stop() }
  });
});

test('Portrait chess can use the browser fallback and returning to the landscape hall revokes it', async () => {
  await environment(async env => {
    const preferred=ref<'landscape'|'portrait'>('portrait'), scope=effectScope(), api=scope.run(()=>usePhoneScreen(preferred))!;
    try {
      api.dismiss();assert.equal(api.dismissed.value,true);api.refresh();assert.equal(api.dismissed.value,true);
      preferred.value='landscape';assert.equal(api.dismissed.value,false);
      api.dismiss();assert.equal(api.dismissed.value,false);
      preferred.value='portrait';api.enter();await Promise.resolve();assert.equal(env.locks.at(-1),'portrait');
    }finally{scope.stop()}
  });
});
