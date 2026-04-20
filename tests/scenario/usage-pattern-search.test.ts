import {
  setupClient, getText,
  assert, assertIncludes, assertNotEmpty,
  searchAllSections, driveMockLlmLoop,
} from '../helpers.js';
import { invalidateFrameworkCache } from '../../src/disk-cache.js';

/**
 * Simulates a developer searching fetched docs for specific usage patterns.
 * "I found spring-boot in pom.xml, how do I configure security?"
 */
export async function testUsagePatternSearch() {
  const client = await setupClient();

  console.log('\n── Scenario: usage pattern search ──────────────────\n');

  // ── GraphQL — query/mutation patterns ─────────────────────────────────
  {
    console.log('  [graphql] query/mutation patterns...');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'graphql' } }));
    assertIncludes('graphql: query', full, 'query');
    assertIncludes('graphql: field', full, 'field');

    const search = await searchAllSections(client, 'graphql', undefined, 'query');
    assert('graphql: "query" in sections', search.found, `${search.totalSections} sections searched`);
  }

  // ── Docker — Dockerfile commands ──────────────────────────────────────
  {
    console.log('  [docker] Dockerfile patterns...');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'docker' } }));
    assertIncludes('docker: mentions docker', full, 'docker');
    assertNotEmpty('docker: has content', full);
  }

  // ── Kubernetes — deployment ───────────────────────────────────────────
  {
    console.log('  [kubernetes] deployment patterns...');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'kubernetes' } }));
    assertIncludes('k8s: mentions kubernetes', full, 'kubernetes');
    assertNotEmpty('k8s: has content', full);
  }

  // ── React 18 — component/hooks ────────────────────────────────────────
  {
    console.log('  [react v18] component patterns...');
    await driveMockLlmLoop(client, 'react', '18.2.0');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'react', version: '18.2.0' } }));
    assertIncludes('react: component', full, 'component');
    assertNotEmpty('react: has content', full);
  }

  // ── Next.js — routing (via llms.txt) ──────────────────────────────────
  {
    console.log('  [next v14] routing via llms.txt...');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'next', version: '14.0.0' } }));
    assert('next: substantial (>5000)', full.length > 5000, `only ${full.length}`);
    assertIncludes('next: routing', full, 'rout');
    assertIncludes('next: page', full, 'page');
  }

  // ── Tailwind CSS (GitHub README fallback) ────────────────────────────
  // Tailwind removed their llms.txt endpoint in Jan 2026. The GitHub
  // README is intentionally minimal — just links to their docs site.
  {
    console.log('  [tailwindcss v4] docs via GitHub README...');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'tailwindcss', version: '4.0.0' } }));
    assert('tailwind: non-empty', full.length > 100, `only ${full.length}`);
    assertIncludes('tailwind: mentions CSS', full, 'css');
  }

  // ── Spring Retry — @Retryable pattern ─────────────────────────────────
  {
    console.log('  [spring-retry] @Retryable pattern...');
    invalidateFrameworkCache('spring-retry');
    await client.callTool({ name: 'add-framework', arguments: {
      key: 'spring-retry', description: 'Spring Retry — retry support for Spring applications',
      github: 'spring-projects/spring-retry',
    }});
    await driveMockLlmLoop(client, 'spring-retry');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'spring-retry' } }));
    assertIncludes('spring-retry: @Retryable', full, '@Retryable');
    assertIncludes('spring-retry: RetryTemplate', full, 'RetryTemplate');

    const search = await searchAllSections(client, 'spring-retry', undefined, '@Retryable');
    assert('spring-retry: @Retryable in sections', search.found, `${search.totalSections} searched`);

    await client.callTool({ name: 'remove-framework', arguments: { key: 'spring-retry' } });
    invalidateFrameworkCache('spring-retry');
  }

  // ── Resilience4j — CircuitBreaker ─────────────────────────────────────
  {
    console.log('  [resilience4j] CircuitBreaker pattern...');
    invalidateFrameworkCache('resilience4j');
    await client.callTool({ name: 'add-framework', arguments: {
      key: 'resilience4j', description: 'Resilience4j — fault tolerance library for Java',
      github: 'resilience4j/resilience4j',
    }});
    await driveMockLlmLoop(client, 'resilience4j');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'resilience4j' } }));
    assertIncludes('resilience4j: CircuitBreaker', full, 'CircuitBreaker');
    assertIncludes('resilience4j: RateLimiter', full, 'RateLimiter');
    assertIncludes('resilience4j: Bulkhead', full, 'Bulkhead');

    await client.callTool({ name: 'remove-framework', arguments: { key: 'resilience4j' } });
    invalidateFrameworkCache('resilience4j');
  }

  // ── Zustand — store creation ──────────────────────────────────────────
  {
    console.log('  [zustand] store creation pattern...');
    invalidateFrameworkCache('zustand');
    await client.callTool({ name: 'add-framework', arguments: {
      key: 'zustand', description: 'Zustand — lightweight state management for React',
      github: 'pmndrs/zustand',
    }});
    await driveMockLlmLoop(client, 'zustand');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'zustand' } }));
    assertIncludes('zustand: create', full, 'create');
    assertIncludes('zustand: store', full, 'store');

    const search = await searchAllSections(client, 'zustand', undefined, 'create');
    assert('zustand: "create" in sections', search.found, `${search.totalSections} searched`);

    await client.callTool({ name: 'remove-framework', arguments: { key: 'zustand' } });
    invalidateFrameworkCache('zustand');
  }

  // ── Scala — version-specific docs ─────────────────────────────────────
  {
    console.log('  [scala] v2 vs v3...');
    const v2 = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'scala', version: '2.13.0' } }));
    const v3 = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'scala', version: '3.3.0' } }));
    assertNotEmpty('scala v2: has docs', v2);
    assertNotEmpty('scala v3: has docs', v3);
    assert('scala: v2 != v3', v2 !== v3, 'identical');
  }

  // ── MongoDB ───────────────────────────────────────────────────────────
  {
    console.log('  [mongodb] CRUD patterns...');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'mongodb' } }));
    assertNotEmpty('mongodb: has docs', full);
    assertIncludes('mongodb: mentions mongo', full, 'mongo');
  }

  // ── Redis ─────────────────────────────────────────────────────────────
  {
    console.log('  [redis] caching patterns...');
    const full = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'redis' } }));
    assertNotEmpty('redis: has docs', full);
    assertIncludes('redis: mentions redis', full, 'redis');
  }

  // ── JUnit — v4 vs v5 ─────────────────────────────────────────────────
  {
    console.log('  [junit] v4 vs v5...');
    const v4 = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'junit', version: '4.13.0' } }));
    const v5 = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'junit', version: '5.10.0' } }));
    assertNotEmpty('junit v4: has index', v4);
    assertNotEmpty('junit v5: has index', v5);
    assert('junit: v4 != v5', v4 !== v5, 'identical');
  }

  await client.close();
}
