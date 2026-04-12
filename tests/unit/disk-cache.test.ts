import { assert } from '../helpers.js';
import { readCache, writeCache, invalidateFrameworkCache } from '../../src/disk-cache.js';

export function testDiskCache() {
  console.log('\n── Unit: disk-cache ────────────────────────────────');

  const fw = '__test-cache-fw__';
  const ver = '1.0.0';

  // Write and read
  writeCache(fw, ver, 'test-section', 'Hello cached world');
  const read = readCache(fw, ver, 'test-section');
  assert('Write then read returns content', read === 'Hello cached world', `got: ${read}`);

  // Miss
  const miss = readCache(fw, ver, 'nonexistent');
  assert('Missing key returns null', miss === null, `got: ${miss}`);

  // Invalidate
  invalidateFrameworkCache(fw);
  const afterInvalidate = readCache(fw, ver, 'test-section');
  assert('After invalidate returns null', afterInvalidate === null, `got: ${afterInvalidate}`);

  // Multiple versions
  writeCache(fw, '1.0.0', 'sec', 'v1 content');
  writeCache(fw, '2.0.0', 'sec', 'v2 content');
  assert('Version isolation: v1', readCache(fw, '1.0.0', 'sec') === 'v1 content', 'wrong v1');
  assert('Version isolation: v2', readCache(fw, '2.0.0', 'sec') === 'v2 content', 'wrong v2');
  invalidateFrameworkCache(fw);

  // Multiple sections
  writeCache(fw, ver, 'section-a', 'Content A');
  writeCache(fw, ver, 'section-b', 'Content B');
  assert('Multiple sections: A', readCache(fw, ver, 'section-a') === 'Content A', 'wrong A');
  assert('Multiple sections: B', readCache(fw, ver, 'section-b') === 'Content B', 'wrong B');
  invalidateFrameworkCache(fw);
}
