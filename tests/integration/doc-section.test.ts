import { setupClient, getText, assertIncludes, assertNotEmpty, assert, extractSectionIds } from '../helpers.js';

export async function testDocSection() {
  console.log('\n── Integration: get-doc-section ────────────────────');
  const client = await setupClient();

  // Fetch index first to get section IDs (next.js has llms.txt, reliable)
  const idx = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'next', version: '14.0.0' } }));
  const sectionIds = extractSectionIds(idx);
  assert('Next.js has sections to test', sectionIds.length >= 1, `got ${sectionIds.length}`);

  // Fetch a valid section
  if (sectionIds.length > 0) {
    const sectionId = sectionIds[0];
    console.log(`  Fetching section: ${sectionId}`);
    const sec = getText(await client.callTool({ name: 'get-doc-section', arguments: {
      framework: 'next', sectionId, version: '14.0.0',
    }}));
    assertNotEmpty(`Section "${sectionId}" has content`, sec);
    assert(`Section >100 chars`, sec.length > 100, `only ${sec.length} chars`);
  }

  // Invalid section ID
  {
    console.log('  Testing invalid section...');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: {
      framework: 'next', sectionId: 'nonexistent-xyz', version: '14.0.0',
    }}));
    assertIncludes('Shows not found', r, 'not found');
    assertIncludes('Lists available sections', r, 'Available sections');
  }

  // Section from framework needing URL (no docs cached)
  {
    console.log('  Testing section for framework with no docs...');
    // postgresql has no github → might need URL
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: {
      framework: 'postgresql', sectionId: 'anything',
    }}));
    const needsUrl = r.includes('resolve-doc-url');
    const notFound = r.includes('not found') || r.includes('No sections');
    assert('postgresql section: needs URL or not found', needsUrl || notFound, 'unexpected response');
  }

  await client.close();
}
