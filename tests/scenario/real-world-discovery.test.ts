import {
  setupClient, getText,
  assert, assertIncludes, assertNotEmpty, extractSectionIds,
  driveMockLlmLoop,
} from '../helpers.js';
import { invalidateFrameworkCache, readCache } from '../../src/disk-cache.js';

interface FrameworkScenario {
  key: string;
  description: string;
  /** If set, the mock LLM "knows" the GitHub repo — passed to add-framework */
  github?: string;
  contentMustInclude: string[];
  sectionSearch?: { contentMustInclude: string[] };
}

/**
 * Simulates the analyzer discovering various frameworks in pom.xml,
 * package.json, and build.sbt. Each framework goes through the proper flow:
 *
 * - If the mock LLM "knows" a GitHub repo → passes it via add-framework,
 *   and the server resolves docs automatically (Path A).
 * - If not → the server says "I need a URL", mock LLM derives one from
 *   the description (Path B via driveMockLlmLoop).
 */
export async function testRealWorldDiscovery() {
  const client = await setupClient();

  const scenarios: FrameworkScenario[] = [
    {
      key: 'spring-retry',
      description: 'Spring Retry — retry support for Spring applications',
      github: 'spring-projects/spring-retry',
      contentMustInclude: ['retry', 'spring'],
      sectionSearch: { contentMustInclude: ['retry'] },
    },
    {
      key: 'resilience4j',
      description: 'Resilience4j — fault tolerance library for Java',
      github: 'resilience4j/resilience4j',
      contentMustInclude: ['resilience4j'],
      sectionSearch: { contentMustInclude: ['circuit'] },
    },
    {
      key: 'flyway',
      description: 'Flyway — database migration tool',
      github: 'flyway/flyway',
      contentMustInclude: ['flyway'],
      sectionSearch: { contentMustInclude: ['migration'] },
    },
    {
      key: 'mapstruct',
      description: 'MapStruct — Java bean mapper code generator',
      github: 'mapstruct/mapstruct',
      contentMustInclude: ['mapstruct'],
    },
    {
      key: 'springdoc-openapi',
      description: 'Springdoc OpenAPI — OpenAPI 3 documentation for Spring Boot',
      github: 'springdoc/springdoc-openapi',
      contentMustInclude: ['openapi'],
    },
    {
      key: 'zustand',
      description: 'Zustand — lightweight state management for React',
      github: 'pmndrs/zustand',
      contentMustInclude: ['zustand'],
      sectionSearch: { contentMustInclude: ['store'] },
    },
    {
      key: 'tanstack-query',
      description: 'TanStack Query — async state management and data fetching',
      github: 'TanStack/query',
      contentMustInclude: ['query'],
    },
    {
      key: 'zod-lib',
      description: 'Zod — TypeScript-first schema validation',
      github: 'colinhacks/zod',
      contentMustInclude: ['zod'],
    },
    {
      key: 'http4s',
      description: 'http4s — typeful, functional HTTP for Scala',
      github: 'http4s/http4s',
      contentMustInclude: ['http4s'],
    },
    {
      key: 'circe',
      description: 'Circe — JSON library for Scala',
      github: 'circe/circe',
      contentMustInclude: ['circe'],
    },
    {
      key: 'istio',
      description: 'Istio — service mesh for Kubernetes',
      github: 'istio/istio',
      contentMustInclude: ['istio'],
    },
    {
      key: 'terraform',
      description: 'Terraform — infrastructure as code tool',
      github: 'hashicorp/terraform',
      contentMustInclude: ['terraform'],
    },

    // ── Path B: NO github → mock LLM must derive URL from description ──
    {
      key: 'custom-retry-lib',
      description: 'Internal library wrapping Spring Retry for company-wide retry policies',
      contentMustInclude: ['retry'],
    },
    {
      key: 'custom-mesh-proxy',
      description: 'Custom Istio sidecar proxy configuration library',
      contentMustInclude: ['istio'],
    },
    {
      key: 'event-reactor',
      description: 'Async event processing built on Reactor',
      contentMustInclude: ['reactor'],
    },
  ];

  console.log('\n── Scenario: real-world framework discovery ────────');
  console.log(`   Testing ${scenarios.length} frameworks end-to-end\n`);

  for (const s of scenarios) {
    console.log(`  [${s.key}] Registering...`);
    invalidateFrameworkCache(s.key);

    const addArgs: Record<string, unknown> = {
      key: s.key,
      description: s.description,
    };
    if (s.github) addArgs.github = s.github;

    const addResult = getText(await client.callTool({ name: 'add-framework', arguments: addArgs }));
    assertIncludes(`${s.key}: registered`, addResult, 'Framework Registered');

    console.log(`  [${s.key}] Fetching docs (mock LLM loop)...`);
    const { indexText, resolvedViaLlm, llmUrl } = await driveMockLlmLoop(client, s.key);

    if (resolvedViaLlm) {
      console.log(`  [${s.key}] Mock LLM derived URL: ${llmUrl}`);
    } else {
      console.log(`  [${s.key}] Server resolved automatically (GitHub/llms.txt)`);
    }

    const hasSections = indexText.includes('Documentation Sections');
    const needsUrl = indexText.includes('resolve-doc-url');
    assert(`${s.key}: has sections or needs URL`, hasSections || needsUrl, 'neither');

    if (hasSections) {
      const sectionIds = extractSectionIds(indexText);
      const minSections = s.github ? 2 : 1;
      assert(`${s.key}: has >=${minSections} sections`, sectionIds.length >= minSections,
        `only ${sectionIds.length}: ${sectionIds.join(', ')}`);

      const fullDoc = getText(await client.callTool({
        name: 'fetch-external-docs', arguments: { framework: s.key },
      }));
      for (const expected of s.contentMustInclude) {
        assertIncludes(`${s.key}: contains "${expected}"`, fullDoc, expected);
      }
      const minChars = s.github ? 500 : 100;
      assert(`${s.key}: >${minChars} chars`, fullDoc.length > minChars, `only ${fullDoc.length}`);

      if (s.sectionSearch && sectionIds.length > 0) {
        const targetId = sectionIds[0];
        console.log(`  [${s.key}] Reading section: ${targetId}`);
        const sec = getText(await client.callTool({
          name: 'get-doc-section', arguments: { framework: s.key, sectionId: targetId },
        }));
        assertNotEmpty(`${s.key}: section content`, sec);
      }

      const disk = readCache(s.key, 'latest', '_full');
      assert(`${s.key}: disk cache`, disk !== null && disk.length > 100, `${disk?.length ?? 0}`);

      const t0 = Date.now();
      getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: s.key } }));
      assert(`${s.key}: cached <500ms`, Date.now() - t0 < 500, `${Date.now() - t0}ms`);
    }

    await client.callTool({ name: 'remove-framework', arguments: { key: s.key } });
    invalidateFrameworkCache(s.key);
  }

  await client.close();
}
