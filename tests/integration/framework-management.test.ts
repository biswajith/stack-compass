import { setupClient, getText, assertIncludes, assert } from '../helpers.js';
import { invalidateFrameworkCache } from '../../src/disk-cache.js';

export async function testFrameworkManagement() {
  console.log('\n── Integration: add/remove framework ───────────────');
  const client = await setupClient();

  // Add a custom framework
  const add = getText(await client.callTool({ name: 'add-framework', arguments: {
    key: 'test-lib',
    description: 'A test library for integration testing',
    github: 'testing/test-lib',
    minMajor: 1,
  }}));
  assertIncludes('Shows registered', add, 'Framework Registered');
  assertIncludes('Shows description', add, 'test library');
  assertIncludes('Mentions resolve-doc-url', add, 'resolve-doc-url');

  // get-doc-index for custom framework (no docs exist → needs URL or uses github)
  const idx = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'test-lib' } }));
  const needsUrl = idx.includes('resolve-doc-url');
  const hasSections = idx.includes('Documentation Sections');
  assert('Custom framework: needs URL or has sections', needsUrl || hasSections, 'neither');

  // Remove the custom framework
  const rm = getText(await client.callTool({ name: 'remove-framework', arguments: { key: 'test-lib' } }));
  assertIncludes('Shows removed', rm, 'Removed');
  invalidateFrameworkCache('test-lib');

  // Remove non-existent
  const rm2 = getText(await client.callTool({ name: 'remove-framework', arguments: { key: 'nope' } }));
  assertIncludes('Shows not found', rm2, 'No custom framework');

  // Add framework with llms.txt
  await client.callTool({ name: 'add-framework', arguments: {
    key: 'test-llms',
    description: 'Framework with llms.txt',
    llmsTxt: 'https://nextjs.org/llms.txt',
  }});
  const llmsIdx = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'test-llms' } }));
  assertIncludes('llms.txt framework has sections', llmsIdx, 'Documentation Sections');
  await client.callTool({ name: 'remove-framework', arguments: { key: 'test-llms' } });
  invalidateFrameworkCache('test-llms');

  // Add multiple version ranges
  await client.callTool({ name: 'add-framework', arguments: {
    key: 'test-versioned', description: 'Version 1 docs', minMajor: 1, maxMajor: 2,
  }});
  await client.callTool({ name: 'add-framework', arguments: {
    key: 'test-versioned', description: 'Version 2 docs', minMajor: 2,
  }});
  const allFw = getText(await client.callTool({ name: 'list-all-supported-frameworks', arguments: {} }));
  assertIncludes('Versioned framework listed', allFw, 'test-versioned');
  await client.callTool({ name: 'remove-framework', arguments: { key: 'test-versioned' } });
  invalidateFrameworkCache('test-versioned');

  // ── Remove purges ALL versioned in-memory state ──────────────────────
  // This reproduces the bug where remove-framework deleted "fw" from memCache
  // but supplyDocUrl stored entries under "fw:version", leaving stale data.
  console.log('  Remove purges versioned state...');

  // Step 1: add framework and supply a URL to populate versioned caches
  await client.callTool({ name: 'add-framework', arguments: {
    key: 'purge-test', description: 'Test purge behavior',
  }});
  const resolved = getText(await client.callTool({ name: 'resolve-doc-url', arguments: {
    framework: 'purge-test',
    url: 'https://graphql.org/learn/queries/',
    version: '1.0.0',
  }}));
  assertIncludes('purge: initial resolve worked', resolved, 'Documentation indexed');

  // Verify docs are served from in-memory cache
  const beforeRemove = getText(await client.callTool({ name: 'get-doc-index', arguments: {
    framework: 'purge-test', version: '1.0.0',
  }}));
  assert('purge: docs available before remove', beforeRemove.includes('Documentation Sections'), 'expected sections');

  // Step 2: remove the framework
  const purgeRm = getText(await client.callTool({ name: 'remove-framework', arguments: { key: 'purge-test' } }));
  assertIncludes('purge: remove succeeded', purgeRm, 'Removed');

  // Step 3: re-add with same key but NO github/llmsTxt — should need a fresh URL
  await client.callTool({ name: 'add-framework', arguments: {
    key: 'purge-test', description: 'Re-added after removal',
  }});
  const afterReAdd = getText(await client.callTool({ name: 'get-doc-index', arguments: {
    framework: 'purge-test', version: '1.0.0',
  }}));
  assert(
    'purge: after remove+re-add, stale docs are gone — needs fresh URL',
    afterReAdd.includes('resolve-doc-url'),
    `expected "resolve-doc-url" prompt but got sections: ${afterReAdd.substring(0, 200)}`,
  );

  // Cleanup
  await client.callTool({ name: 'remove-framework', arguments: { key: 'purge-test' } });

  await client.close();
}
