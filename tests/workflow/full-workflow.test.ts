import path from 'path';
import {
  setupClient, getText,
  assert, assertIncludes, assertNotEmpty,
  mockLlmResolveUrl, mockLlmPickSection, parseNeedsUrlResponse, extractSectionIds,
  driveMockLlmLoop,
} from '../helpers.js';
import { invalidateFrameworkCache, readCache } from '../../src/disk-cache.js';

/**
 * Full end-to-end workflow test with a mock LLM.
 *
 * Simulates the conversation loop from the README "How It Works":
 *   1. User says "analyze my monorepo"
 *   2. LLM calls analyze-project → gets detected frameworks
 *   3. For each framework, LLM calls get-doc-index
 *      - Path A: server resolves from cache/llms.txt/GitHub → returns sections
 *      - Path B: server says "I need a URL" → LLM reasons about the URL
 *   4. (Path B) LLM calls resolve-doc-url with the chosen URL
 *   5. LLM picks a section from the index → calls get-doc-section → reads content
 *   6. Cache: subsequent calls are instant; new sessions read from disk
 *
 * The mock LLM is a function that maps (framework, version, description) → URL.
 * It proves the server gives the LLM enough context to make the decision.
 */
export async function testFullWorkflow() {
  const client = await setupClient();
  const projectPath = path.resolve(import.meta.dirname!, '../..');

  interface WorkflowFramework {
    key: string;
    version: string;
    custom?: { description: string; github?: string };
  }

  const frameworks: WorkflowFramework[] = [
    // Path A: built-in, has rich GitHub README
    { key: 'react', version: '18.2.0' },
    // Path A: built-in, has llms.txt
    { key: 'next', version: '14.0.0' },
    // Path B: built-in, NO GitHub repo → must ask LLM
    { key: 'postgresql', version: '16.0.0' },
    // Path B: custom unknown framework → must register, then ask LLM
    // Description hints at Spring Security so mock LLM can derive the URL
    { key: 'internal-auth-lib', version: '2.0.0',
      custom: { description: 'Internal OAuth2 authentication library based on Spring Security' } },
    // Path B: another custom — description hints at Reactor
    { key: 'company-event-bus', version: '1.5.0',
      custom: { description: 'Internal async event bus built on Reactor' } },
  ];

  let pathACount = 0;
  let pathBCount = 0;

  console.log('\n── Full Workflow: Mock LLM ↔ MCP Server ─────────────');
  console.log('   LLM ↔ Server conversation loop with mock LLM\n');

  // ─── Step 1: LLM calls analyze-project ────────────────────────────────
  console.log('  Step 1: LLM → analyze-project');
  const analysis = getText(await client.callTool({
    name: 'analyze-project', arguments: { projectPath },
  }));
  assertIncludes('S1: detects modules', analysis, 'Detected Modules');
  assertIncludes('S1: next steps: resolve-doc-url', analysis, 'resolve-doc-url');
  assertIncludes('S1: next steps: get-doc-index', analysis, 'get-doc-index');

  // ─── Steps 2–5: LLM iterates through frameworks ──────────────────────
  for (const fw of frameworks) {
    console.log(`\n  ─── ${fw.key} v${fw.version} ───`);

    if (fw.custom) {
      console.log(`  LLM → add-framework("${fw.key}", "${fw.custom.description}")`);
      const r = getText(await client.callTool({ name: 'add-framework', arguments: {
        key: fw.key, description: fw.custom.description,
        ...(fw.custom.github ? { github: fw.custom.github } : {}),
      }}));
      assertIncludes(`${fw.key}: registered`, r, 'Framework Registered');
    }

    invalidateFrameworkCache(fw.key);

    // Step 2: LLM calls get-doc-index
    console.log(`  LLM → get-doc-index("${fw.key}", "${fw.version}")`);
    const indexResult = getText(await client.callTool({
      name: 'get-doc-index', arguments: { framework: fw.key, version: fw.version },
    }));
    assertNotEmpty(`S2 ${fw.key}: non-trivial response`, indexResult);

    const needsUrl = indexResult.includes('resolve-doc-url');
    const hasSections = indexResult.includes('Documentation Sections');
    assert(`S2 ${fw.key}: needs URL or has sections`, needsUrl || hasSections, 'neither');

    if (needsUrl) {
      pathBCount++;

      // ── Path B: server asked LLM for a URL ────────────────────────
      // Verify the prompt gives the LLM enough context
      assertIncludes(`S2 ${fw.key}: prompt has framework name`, indexResult, fw.key);
      assertIncludes(`S2 ${fw.key}: prompt says "Please call"`, indexResult, 'Please call');
      assertIncludes(`S2 ${fw.key}: prompt mentions resolve-doc-url`, indexResult, 'resolve-doc-url');

      const parsed = parseNeedsUrlResponse(indexResult);
      assert(`S2 ${fw.key}: response is parseable`, parsed !== null, 'could not parse');
      if (!parsed) continue;

      assert(`S2 ${fw.key}: correct framework in prompt`, parsed.framework === fw.key,
        `expected "${fw.key}", got "${parsed.framework}"`);
      assert(`S2 ${fw.key}: description provided`, parsed.description.length > 5,
        `too short: "${parsed.description}"`);

      // Step 3: mock LLM reasons about the URL
      console.log(`  Server → "I need a URL for ${parsed.framework}${parsed.version ? ` v${parsed.version}` : ''}: ${parsed.description}"`);
      const llmUrl = mockLlmResolveUrl(parsed.framework, parsed.version, parsed.description);
      assert(`S3 ${fw.key}: mock LLM resolved a URL`, llmUrl !== null,
        `mock LLM has no knowledge of "${fw.key}"`);
      if (!llmUrl) continue;

      console.log(`  LLM → resolve-doc-url("${fw.key}", "${llmUrl}")`);
      const resolved = getText(await client.callTool({
        name: 'resolve-doc-url',
        arguments: { framework: fw.key, url: llmUrl, version: fw.version },
      }));
      assertIncludes(`S3 ${fw.key}: server confirms indexed`, resolved, 'Documentation indexed');
      assertIncludes(`S3 ${fw.key}: server echoes URL`, resolved, llmUrl);

      const countMatch = resolved.match(/Sections found:\s*(\d+)/);
      const count = countMatch ? parseInt(countMatch[1]) : 0;
      assert(`S3 ${fw.key}: >0 sections parsed`, count > 0, `got ${count}`);

    } else {
      pathACount++;
      console.log(`  Server → resolved automatically (cache/README/llms.txt)`);
    }

    // Step 4: LLM reads index and picks a section
    const finalIndex = getText(await client.callTool({
      name: 'get-doc-index', arguments: { framework: fw.key, version: fw.version },
    }));
    assertIncludes(`S4 ${fw.key}: final index has sections`, finalIndex, 'Documentation Sections');

    const sectionId = mockLlmPickSection(finalIndex);
    assert(`S4 ${fw.key}: LLM picked a section`, sectionId !== null, 'no sections');

    if (sectionId) {
      console.log(`  LLM → get-doc-section("${fw.key}", "${sectionId}")`);
      const content = getText(await client.callTool({
        name: 'get-doc-section',
        arguments: { framework: fw.key, sectionId, version: fw.version },
      }));
      assertNotEmpty(`S4 ${fw.key}: section content`, content);
      assert(`S4 ${fw.key}: content >100 chars`, content.length > 100, `only ${content.length}`);
    }

    // Step 5: cache verification
    console.log(`  Step 5: cache check...`);
    const t0 = Date.now();
    getText(await client.callTool({
      name: 'get-doc-index', arguments: { framework: fw.key, version: fw.version },
    }));
    const ms = Date.now() - t0;
    assert(`S5 ${fw.key}: cached <200ms`, ms < 200, `took ${ms}ms`);

    const disk = readCache(fw.key, fw.version, '_full');
    assert(`S5 ${fw.key}: disk cache populated`, disk !== null && disk.length > 100,
      `disk: ${disk?.length ?? 0}`);
  }

  // Verify both paths were exercised
  assert('Path A exercised (auto-resolve)', pathACount >= 1, `${pathACount}`);
  assert('Path B exercised (LLM-supplied URL)', pathBCount >= 1, `${pathBCount}`);
  console.log(`\n  Path A: ${pathACount}, Path B: ${pathBCount}`);

  // ─── Step 6: new session — everything from disk cache ─────────────────
  console.log('\n  Step 6: new MCP session — disk cache only...');
  await client.close();
  const client2 = await setupClient();

  for (const fw of frameworks) {
    if (fw.custom) {
      await client2.callTool({ name: 'add-framework', arguments: {
        key: fw.key, description: fw.custom.description,
        ...(fw.custom.github ? { github: fw.custom.github } : {}),
      }});
    }

    const t0 = Date.now();
    const idx = getText(await client2.callTool({
      name: 'get-doc-index', arguments: { framework: fw.key, version: fw.version },
    }));
    const ms = Date.now() - t0;
    assertIncludes(`S6 ${fw.key}: cache hit`, idx, 'Documentation Sections');
    assert(`S6 ${fw.key}: <200ms`, ms < 200, `took ${ms}ms`);
  }

  // Clean up
  for (const fw of frameworks) {
    if (fw.custom) {
      await client2.callTool({ name: 'remove-framework', arguments: { key: fw.key } });
    }
    invalidateFrameworkCache(fw.key);
  }

  await client2.close();
}
