import { setupClient, getText, assertIncludes, assertNotEmpty, assert, extractSectionIds } from '../helpers.js';
import { invalidateFrameworkCache } from '../../src/disk-cache.js';

export async function testResolveDocUrl() {
  console.log('\n── Integration: resolve-doc-url ────────────────────');
  const client = await setupClient();

  // Supply a known URL for graphql
  invalidateFrameworkCache('graphql');
  console.log('  Supplying URL for graphql...');
  const resolved = getText(await client.callTool({ name: 'resolve-doc-url', arguments: {
    framework: 'graphql',
    url: 'https://graphql.org/learn/queries/',
  }}));
  assertIncludes('Shows "Documentation indexed"', resolved, 'Documentation indexed');
  assertIncludes('Shows section count', resolved, 'Sections found');
  assertIncludes('Echoes the URL', resolved, 'graphql.org');

  // After resolve, get-doc-index should return sections
  const idx = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'graphql' } }));
  assertIncludes('After resolve: has sections', idx, 'Documentation Sections');
  assertNotEmpty('After resolve: substantial', idx);

  // Section navigation works
  const sectionIds = extractSectionIds(idx);
  assert('Has at least 1 section', sectionIds.length >= 1, `got ${sectionIds.length}`);
  if (sectionIds.length > 0) {
    console.log(`  Fetching section: ${sectionIds[0]}`);
    const sec = getText(await client.callTool({ name: 'get-doc-section', arguments: {
      framework: 'graphql', sectionId: sectionIds[0],
    }}));
    assertNotEmpty(`Section "${sectionIds[0]}" has content`, sec);
  }

  // Supply URL for spring-boot with version
  invalidateFrameworkCache('spring-boot');
  console.log('  Supplying URL for spring-boot v3.2.0...');
  const sbResolved = getText(await client.callTool({ name: 'resolve-doc-url', arguments: {
    framework: 'spring-boot',
    url: 'https://docs.spring.io/spring-boot/docs/3.2.0/reference/htmlsingle/',
    version: '3.2.0',
  }}));
  assertIncludes('spring-boot: indexed', sbResolved, 'Documentation indexed');

  // Verify version-specific index
  const sbIdx = getText(await client.callTool({ name: 'get-doc-index', arguments: {
    framework: 'spring-boot', version: '3.2.0',
  }}));
  assertIncludes('spring-boot: has sections', sbIdx, 'Documentation Sections');

  // Bad URL should handle gracefully
  console.log('  Testing invalid URL...');
  const bad = getText(await client.callTool({ name: 'resolve-doc-url', arguments: {
    framework: 'graphql',
    url: 'https://this-does-not-exist.example.com/404',
  }}));
  // Should still succeed (server attempts fetch, may get 0 sections)
  assertIncludes('Bad URL: still completes', bad, 'Documentation indexed');

  await client.close();
}
