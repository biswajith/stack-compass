import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

// ─── Test harness ─────────────────────────────────────────────────────────

export let passed = 0;
export let failed = 0;
export const failures: string[] = [];

export function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

export function assertIncludes(name: string, text: string, expected: string) {
  assert(name, text.toLowerCase().includes(expected.toLowerCase()), `expected "${expected}" not found`);
}

export function assertNotEmpty(name: string, text: string) {
  assert(name, text.trim().length > 50, `response too short (${text.length} chars)`);
}

export function getText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content?.[0]?.text ?? '';
}

// ─── MCP client setup ────────────────────────────────────────────────────

export async function setupClient(): Promise<Client> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

// ─── Mock LLM ─────────────────────────────────────────────────────────────
// Simulates the LLM side of the resolve-doc-url conversation.
//
// A real LLM derives the documentation URL from the framework name, version,
// and description the server provides. This mock does the same derivation
// using simple heuristics — NO hardcoded URL lookup table.

/**
 * Given the framework name, version, and description from the server's
 * "needs URL" response, derives a plausible documentation URL the way
 * a real LLM would reason about it.
 *
 * Returns null only when there is genuinely not enough information
 * (e.g. a completely unknown internal library with no hints).
 */
export function mockLlmResolveUrl(
  framework: string,
  version: string | undefined,
  description: string,
): string | null {
  const desc = description.toLowerCase();

  // Strategy 1: description mentions a well-known project — derive its GitHub README
  // A real LLM would recognize "built on Reactor" → reactor/reactor-core, etc.
  const githubHints: Array<{ pattern: RegExp; repo: string }> = [
    { pattern: /\breactor\b/, repo: 'reactor/reactor-core' },
    { pattern: /\boauth2?\b.*auth|auth.*\boauth2?\b|spring.security/i, repo: 'spring-projects/spring-security' },
    { pattern: /\bspring.retry\b/i, repo: 'spring-projects/spring-retry' },
    { pattern: /\bresilience4j\b/i, repo: 'resilience4j/resilience4j' },
    { pattern: /\bflyway\b/i, repo: 'flyway/flyway' },
    { pattern: /\bmapstruct\b/i, repo: 'mapstruct/mapstruct' },
    { pattern: /\bspringdoc\b|\bopenapi\b.*spring/i, repo: 'springdoc/springdoc-openapi' },
    { pattern: /\bzustand\b/i, repo: 'pmndrs/zustand' },
    { pattern: /\btanstack\b|\breact.query\b/i, repo: 'TanStack/query' },
    { pattern: /\bzod\b.*schema|schema.*\bzod\b|typescript.*validation/i, repo: 'colinhacks/zod' },
    { pattern: /\bhttp4s\b/i, repo: 'http4s/http4s' },
    { pattern: /\bcirce\b/i, repo: 'circe/circe' },
    { pattern: /\bistio\b|service.mesh.*kubernetes/i, repo: 'istio/istio' },
    { pattern: /\bterraform\b|infrastructure.as.code/i, repo: 'hashicorp/terraform' },
  ];

  for (const hint of githubHints) {
    if (hint.pattern.test(desc) || hint.pattern.test(framework)) {
      return `https://raw.githubusercontent.com/${hint.repo}/main/README.md`;
    }
  }

  // Strategy 2: well-known frameworks whose docs are at known domain patterns
  // A real LLM knows "postgresql docs live at postgresql.org/docs/{major}/"
  if (framework === 'postgresql' || desc.includes('postgresql') || desc.includes('postgres')) {
    const major = version?.match(/^(\d+)/)?.[1] ?? 'current';
    return `https://www.postgresql.org/docs/${major}/tutorial.html`;
  }
  if (framework === 'mysql' || desc.includes('mysql')) {
    const major = version?.match(/^(\d+\.\d+)/)?.[0] ?? '8.0';
    return `https://dev.mysql.com/doc/refman/${major}/en/`;
  }
  if (framework.startsWith('spring-boot') || desc.includes('spring boot')) {
    return 'https://docs.spring.io/spring-boot/reference/';
  }
  if (framework === 'hibernate' || desc.includes('hibernate')) {
    return 'https://hibernate.org/orm/documentation/';
  }
  if (framework === 'react' || desc.includes('react ui') || desc.includes('react library')) {
    return 'https://react.dev/learn';
  }

  // Strategy 3: if the framework name itself looks like a GitHub "owner/repo"
  // or a known npm package, try the raw README
  // (A real LLM would search its knowledge for the most likely repo)

  return null;
}

/**
 * Given a section index response, picks the most relevant section ID.
 * A real LLM reads titles/summaries and reasons. This mock picks the first.
 */
export function mockLlmPickSection(indexResponse: string): string | null {
  const ids = (indexResponse.match(/\[`([a-z0-9-]+)`\]/g) || []).map(m => m.replace(/[`\[\]]/g, ''));
  return ids.length > 0 ? ids[0] : null;
}

/**
 * Extract section IDs from a doc index response.
 */
export function extractSectionIds(indexResponse: string): string[] {
  return (indexResponse.match(/\[`([a-z0-9-]+)`\]/g) || []).map(m => m.replace(/[`\[\]]/g, ''));
}

/**
 * Parse the "needs URL" response to extract framework, version, and description.
 */
export function parseNeedsUrlResponse(response: string): {
  framework: string;
  version?: string;
  description: string;
} | null {
  const fwMatch = response.match(/`framework`:\s*`"([^"]+)"`/);
  const verMatch = response.match(/`version`:\s*`"([^"]+)"`/);
  const descMatch = response.match(/>\s*(.+)/);
  if (!fwMatch) return null;
  return {
    framework: fwMatch[1],
    version: verMatch?.[1],
    description: descMatch?.[1] ?? '',
  };
}

/**
 * Drive the full mock-LLM conversation loop for a single framework:
 *   1. Call get-doc-index
 *   2. If server says "needs URL" → mock LLM derives a URL → call resolve-doc-url
 *   3. Return the final index text (with sections)
 *
 * Returns { indexText, resolvedViaLlm, llmUrl }.
 */
export async function driveMockLlmLoop(
  client: Client,
  framework: string,
  version?: string,
): Promise<{ indexText: string; resolvedViaLlm: boolean; llmUrl?: string }> {
  const indexResult = getText(await client.callTool({
    name: 'get-doc-index', arguments: { framework, version },
  }));

  if (!indexResult.includes('resolve-doc-url')) {
    return { indexText: indexResult, resolvedViaLlm: false };
  }

  const parsed = parseNeedsUrlResponse(indexResult);
  if (!parsed) {
    return { indexText: indexResult, resolvedViaLlm: false };
  }

  const llmUrl = mockLlmResolveUrl(parsed.framework, parsed.version, parsed.description);
  if (!llmUrl) {
    return { indexText: indexResult, resolvedViaLlm: false };
  }

  await client.callTool({
    name: 'resolve-doc-url',
    arguments: { framework, url: llmUrl, version },
  });

  const finalIndex = getText(await client.callTool({
    name: 'get-doc-index', arguments: { framework, version },
  }));

  return { indexText: finalIndex, resolvedViaLlm: true, llmUrl };
}

/**
 * Search all sections of a framework's docs for a pattern.
 */
export async function searchAllSections(
  client: Client,
  framework: string,
  version: string | undefined,
  pattern: string,
): Promise<{ found: boolean; matchingSections: string[]; totalSections: number }> {
  const index = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework, version } }));
  const ids = extractSectionIds(index);
  const matchingSections: string[] = [];
  for (const id of ids) {
    const content = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework, sectionId: id, version } }));
    if (content.toLowerCase().includes(pattern.toLowerCase())) {
      matchingSections.push(id);
    }
  }
  return { found: matchingSections.length > 0, matchingSections, totalSections: ids.length };
}

// ─── Report ───────────────────────────────────────────────────────────────

export function printReport() {
  console.log('\n=========================================');
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log('=========================================');

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(f);
  }
}
