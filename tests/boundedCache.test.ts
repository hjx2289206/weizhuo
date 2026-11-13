import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCache } from '../src/boundedCache';

test('animation pixel cache evicts least recently used artwork and respects its memory limit', () => {
  const cache = new BoundedCache<string>(10);
  cache.set('a','first',4); cache.set('b','second',4);
  assert.equal(cache.get('a'),'first');
  cache.set('c','third',4);
  assert.equal(cache.get('b'),undefined);
  assert.equal(cache.get('a'),'first'); assert.equal(cache.get('c'),'third');
  assert.equal(cache.byteSize,8);
  cache.set('a','replacement',7);
  assert.equal(cache.get('c'),undefined); assert.equal(cache.byteSize,7);
  cache.set('too-large','no retained bitmap',11);
  assert.equal(cache.size,1); assert.equal(cache.byteSize,7);
});
