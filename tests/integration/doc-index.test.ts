import { setupClient, getText, assertIncludes, assertNotEmpty, assert } from '../helpers.js';
import { invalidateFrameworkCache, readCache } from '../../src/disk-cache.js';

export async function testDocIndex() {
  console.log('\n── Integration: get-doc-index ──────────────────────');
  const client = await setupClient();

  // Framework with GitHub README (graphql)
  {
    invalidateFrameworkCache('graphql');
    console.log('  Fetching graphql docs (GitHub README)...');
    const gql = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'graphql' } }));
    assertNotEmpty('GraphQL: non-trivial response', gql);
    const hasSections = gql.includes('Documentation Sections');
    const needsUrl = gql.includes('resolve-doc-url');
    assert('GraphQL: has sections or asks for URL', hasSections || needsUrl, 'neither');
  }

  // Framework with llms.txt (next.js)
  {
    invalidateFrameworkCache('next');
    console.log('  Fetching next.js docs (llms.txt)...');
    const next = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'next', version: '14.0.0' } }));
    assertIncludes('Next.js: has sections', next, 'Documentation Sections');
    assertNotEmpty('Next.js: substantial', next);
  }

  // Unknown framework returns null-like message
  {
    console.log('  Testing unknown framework...');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'totally-unknown-lib' } }));
    assertIncludes('Unknown: suggests add-framework', r, 'add-framework');
  }

  // Disk cache is populated after fetch
  {
    const cached = readCache('next', '14.0.0', '_full');
    assert('Next.js docs cached on disk', cached !== null && cached.length > 100, `cache: ${cached?.length ?? 0}`);
  }

  await client.close();
}
