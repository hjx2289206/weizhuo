// Vibration is optional feedback: unsupported or throwing implementations must stay invisible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAPTIC_TURN, vibrate } from '../src/haptics';

test('haptics: supported vibrators receive the pattern', () => {
  const calls: (number | number[])[] = [];
  const target = {
    vibrate(pattern: number | number[]) {
      calls.push(pattern);
      return true;
    },
  };
  assert.equal(vibrate(12, target), true);
  assert.equal(vibrate(HAPTIC_TURN, target), true);
  assert.deepEqual(calls, [12, [...HAPTIC_TURN]], 'a readonly pattern is copied into a mutable array');
})

test('haptics: missing, throwing and unsupported devices are safe no-ops', () => {
  assert.equal(vibrate(12, null), false);
  assert.equal(vibrate(12, {}), false);
  assert.equal(vibrate(12, { vibrate: () => { throw new Error('denied'); } }), false);
})
