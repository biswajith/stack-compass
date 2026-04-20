import { setupClient, getText, assert } from '../helpers.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GraphStore } from '../../src/graph/store.js';
import { resolveAllEdges } from '../../src/graph/resolvers/index.js';
import { getCallers, getCallees, getImpact, buildContext } from '../../src/graph/traversal.js';
import { IncrementalSync } from '../../src/graph/sync.js';
import type { ScannedModule, ScannedFile, ExtractedSymbol } from '../../src/source-scanner/types.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Performance integration tests that run against THIS repository at realistic scale.
 *
 * Each test scans real source code and asserts wall-clock time stays under
 * generous but meaningful thresholds. Thresholds are intentionally loose
 * (2-10x expected time) to avoid flaky CI, while still catching regressions
 * like accidental O(n²) or N+1 query patterns.
 */
export async function testGraphPerformance() {
  console.log('\n--- Integration: Graph Performance ---');

  await test_self_scan_ingestion_time();
  await test_edge_resolution_time();
  await test_fts5_search_throughput();
  await test_traversal_latency();
  await test_build_context_latency();
  await test_incremental_sync_unchanged();
  await test_graph_status_latency();
  await test_large_fixture_ingestion();
  await test_resolver_no_n_plus_one();
}

// ── Helpers ──────────────────────────────────────────────────────────────

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `perf-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath: string): void {
  try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ok */ }
  try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ok */ }
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

async function timeMsAsync(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

// ── 1. Full scan of this repo via MCP tool — end-to-end ingestion ────────

async function test_self_scan_ingestion_time() {
  const client = await setupClient();

  const elapsed = await timeMsAsync(async () => {
    await client.callTool({
      name: 'scan-internal-source',
      arguments: { projectPath: PROJECT_ROOT, modulePaths: ['src'] },
    });
  });

  // ~60 TS files should scan + ingest + resolve in under 10 seconds
  assert('perf: self-scan < 10s', elapsed < 10_000, `took ${elapsed.toFixed(0)}ms`);
  console.log(`  self-scan: ${elapsed.toFixed(0)}ms`);

  // Verify non-trivial graph was built
  const status = getText(await client.callTool({ name: 'graph-status', arguments: {} }));
  const nodeMatch = status.match(/Nodes:?\s*\**\s*(\d+)/);
  const nodeCount = nodeMatch ? parseInt(nodeMatch[1], 10) : 0;
  assert('perf: self-scan produced > 100 nodes', nodeCount > 100, `only ${nodeCount} nodes`);
  console.log(`  self-scan: ${nodeCount} nodes`);

  await client.close();
}

// ── 2. Edge resolution on a pre-populated graph ──────────────────────────

async function test_edge_resolution_time() {
  const client = await setupClient();

  await client.callTool({
    name: 'scan-internal-source',
    arguments: { projectPath: PROJECT_ROOT, modulePaths: ['src'] },
  });

  // Re-resolve edges and time it independently
  const dbDir = path.join(PROJECT_ROOT, '.stack-compass');
  const dbPath = path.join(dbDir, 'graph.db');
  if (!fs.existsSync(dbPath)) {
    console.log('  edge-resolution: skipped (no graph.db)');
    return;
  }

  const store = GraphStore.open(dbPath);
  const stats = store.getStats();

  const elapsed = timeMs(() => {
    resolveAllEdges(store);
  });

  // Edge resolution over real codebase should complete in under 2 seconds
  assert('perf: edge-resolution < 2s', elapsed < 2_000, `took ${elapsed.toFixed(0)}ms for ${stats.totalNodes} nodes`);
  console.log(`  edge-resolution: ${elapsed.toFixed(0)}ms (${stats.totalNodes} nodes, ${stats.totalEdges} edges)`);

  store.close();
  await client.close();
}

// ── 3. FTS5 search throughput — many queries in sequence ────────────────

async function test_fts5_search_throughput() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Ingest enough symbols to make FTS non-trivial
    const mod = buildLargeModule('search-bench', 200);
    store.ingestModule(mod);

    const queries = ['User', 'Service', 'Controller', 'Repository', 'Handler', 'Manager',
                     'Config', 'Factory', 'Builder', 'Adapter', 'Proxy', 'Listener'];

    const elapsed = timeMs(() => {
      for (let round = 0; round < 10; round++) {
        for (const q of queries) {
          store.searchSymbols(q);
        }
      }
    });

    const totalQueries = queries.length * 10;
    const avgMs = elapsed / totalQueries;
    // Each FTS5 query should average under 5ms
    assert('perf: FTS5 avg < 5ms', avgMs < 5, `avg ${avgMs.toFixed(2)}ms over ${totalQueries} queries`);
    console.log(`  FTS5 search: ${totalQueries} queries in ${elapsed.toFixed(0)}ms (avg ${avgMs.toFixed(2)}ms)`);

    store.close();
  } finally { cleanup(dbPath); }
}

// ── 4. Traversal latency with a deep call chain ─────────────────────────

async function test_traversal_latency() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Build a chain: fn_0 → fn_1 → ... → fn_99
    const mod = buildCallChainModule('chain-bench', 100);
    store.ingestModule(mod);
    resolveAllEdges(store);

    // get-callers depth 5
    const callersMs = timeMs(() => {
      getCallers(store, 'fn_50', 5);
    });
    assert('perf: get-callers depth-5 < 50ms', callersMs < 50, `took ${callersMs.toFixed(1)}ms`);

    // get-callees depth 5
    const calleesMs = timeMs(() => {
      getCallees(store, 'fn_50', 5);
    });
    assert('perf: get-callees depth-5 < 50ms', calleesMs < 50, `took ${calleesMs.toFixed(1)}ms`);

    // get-impact depth 10 from root
    const impactMs = timeMs(() => {
      getImpact(store, 'fn_0', 10);
    });
    assert('perf: get-impact depth-10 < 200ms', impactMs < 200, `took ${impactMs.toFixed(1)}ms`);

    console.log(`  traversal: callers=${callersMs.toFixed(1)}ms callees=${calleesMs.toFixed(1)}ms impact=${impactMs.toFixed(1)}ms`);

    store.close();
  } finally { cleanup(dbPath); }
}

// ── 5. build-context latency on real repo ───────────────────────────────

async function test_build_context_latency() {
  const client = await setupClient();

  await client.callTool({
    name: 'scan-internal-source',
    arguments: { projectPath: PROJECT_ROOT, modulePaths: ['src'] },
  });

  const dbPath = path.join(PROJECT_ROOT, '.stack-compass', 'graph.db');
  if (!fs.existsSync(dbPath)) {
    console.log('  build-context: skipped (no graph.db)');
    return;
  }

  const store = GraphStore.open(dbPath);

  const tasks = [
    'fix the source scanner',
    'add a new MCP tool for documentation',
    'refactor the graph store',
    'update the tree builder',
  ];

  let totalMs = 0;
  for (const task of tasks) {
    const ms = timeMs(() => {
      buildContext(store, task);
    });
    totalMs += ms;
  }

  const avgMs = totalMs / tasks.length;
  // build-context reads source from disk, so allow more headroom
  assert('perf: build-context avg < 500ms', avgMs < 500, `avg ${avgMs.toFixed(0)}ms`);
  console.log(`  build-context: ${tasks.length} tasks in ${totalMs.toFixed(0)}ms (avg ${avgMs.toFixed(0)}ms)`);

  store.close();
  await client.close();
}

// ── 6. Incremental sync — all unchanged should be fast ──────────────────

async function test_incremental_sync_unchanged() {
  const client = await setupClient();

  await client.callTool({
    name: 'scan-internal-source',
    arguments: { projectPath: PROJECT_ROOT, modulePaths: ['src'] },
  });

  // Second scan should be fast because nothing changed (hash skip)
  const elapsed = await timeMsAsync(async () => {
    await client.callTool({
      name: 'scan-internal-source',
      arguments: { projectPath: PROJECT_ROOT, modulePaths: ['src'] },
    });
  });

  // Re-scan with no changes should be significantly faster than cold scan
  assert('perf: re-scan unchanged < 5s', elapsed < 5_000, `took ${elapsed.toFixed(0)}ms`);
  console.log(`  re-scan unchanged: ${elapsed.toFixed(0)}ms`);

  await client.close();
}

// ── 7. graph-status tool latency ────────────────────────────────────────

async function test_graph_status_latency() {
  const client = await setupClient();

  await client.callTool({
    name: 'scan-internal-source',
    arguments: { projectPath: PROJECT_ROOT, modulePaths: ['src'] },
  });

  const elapsed = await timeMsAsync(async () => {
    await client.callTool({ name: 'graph-status', arguments: {} });
  });

  // graph-status calls getStaleFileCount which hashes every file on disk
  assert('perf: graph-status < 3s', elapsed < 3_000, `took ${elapsed.toFixed(0)}ms`);
  console.log(`  graph-status: ${elapsed.toFixed(0)}ms`);

  await client.close();
}

// ── 8. Large fixture — 500 classes across 50 files ──────────────────────

async function test_large_fixture_ingestion() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const mod = buildLargeModule('large-bench', 500);

    const ingestMs = timeMs(() => {
      store.ingestModule(mod);
    });

    const stats = store.getStats();
    assert('perf: 500-class ingest < 3s', ingestMs < 3_000,
      `took ${ingestMs.toFixed(0)}ms for ${stats.totalNodes} nodes`);

    const resolveMs = timeMs(() => {
      resolveAllEdges(store);
    });
    assert('perf: 500-class resolve < 2s', resolveMs < 2_000,
      `took ${resolveMs.toFixed(0)}ms for ${stats.totalNodes} nodes`);

    console.log(`  large-fixture: ingest=${ingestMs.toFixed(0)}ms resolve=${resolveMs.toFixed(0)}ms (${stats.totalNodes} nodes, ${stats.totalFiles} files)`);

    store.close();
  } finally { cleanup(dbPath); }
}

// ── 9. Resolver queries — verify no N+1 via query count proxy ───────────

async function test_resolver_no_n_plus_one() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Build fixture with many REST endpoints and api-calls
    const mod = buildRestHeavyModule('rest-bench', 100);
    store.ingestModule(mod);

    // Time the REST resolver specifically
    const { resolveRestEdges } = await import('../../src/graph/resolvers/rest-resolver.js');
    const elapsed = timeMs(() => {
      resolveRestEdges(store);
    });

    // With bulk queries, 100 endpoints × 100 api-calls should still be fast
    // An N+1 pattern would make this blow up proportionally
    assert('perf: REST resolver 100×100 < 500ms', elapsed < 500, `took ${elapsed.toFixed(0)}ms`);
    console.log(`  REST resolver (100×100): ${elapsed.toFixed(0)}ms`);

    store.close();
  } finally { cleanup(dbPath); }
}

// ── Fixture builders ────────────────────────────────────────────────────

function makeSummary(files: ScannedFile[]): ScannedModule['summary'] {
  return {
    totalFiles: files.length,
    totalSymbols: files.reduce((s, f) => s + f.symbols.length, 0),
    publicClasses: [], publicInterfaces: [], publicMethods: 0,
    annotations: [], restEndpoints: [], entities: [], events: [],
  };
}

function buildLargeModule(name: string, classCount: number): ScannedModule {
  const filesPerModule = Math.ceil(classCount / 10);
  const files: ScannedFile[] = [];

  for (let f = 0; f < filesPerModule; f++) {
    const symbols: ExtractedSymbol[] = [];
    const classesInFile = Math.min(10, classCount - f * 10);

    for (let c = 0; c < classesInFile; c++) {
      const idx = f * 10 + c;
      symbols.push({
        name: `Class${idx}`,
        kind: 'class',
        visibility: 'public',
        location: { startLine: c * 20 + 1, endLine: c * 20 + 19 },
        annotations: idx % 5 === 0 ? ['@Service'] : [],
        children: [
          {
            name: `method${idx}a`,
            kind: 'method',
            visibility: 'public',
            location: { startLine: c * 20 + 3, endLine: c * 20 + 8 },
            signature: `void method${idx}a()`,
            callSites: idx > 0 ? [{ target: `method${idx - 1}a`, receiver: `Class${idx - 1}` }] : [],
          },
          {
            name: `method${idx}b`,
            kind: 'method',
            visibility: 'public',
            location: { startLine: c * 20 + 10, endLine: c * 20 + 15 },
            signature: `String method${idx}b(int x)`,
          },
        ],
      });
    }

    files.push({
      filePath: `/src/${name}/File${f}.java`,
      language: 'java',
      packageName: `com.bench.${name}`,
      symbols,
      imports: [],
    });
  }

  return { name, path: `/fake/${name}`, language: 'java', files, summary: makeSummary(files) };
}

function buildCallChainModule(name: string, chainLength: number): ScannedModule {
  const symbols: ExtractedSymbol[] = [];

  for (let i = 0; i < chainLength; i++) {
    symbols.push({
      name: `fn_${i}`,
      kind: 'method',
      visibility: 'public',
      location: { startLine: i * 5 + 1, endLine: i * 5 + 4 },
      signature: `void fn_${i}()`,
      callSites: i < chainLength - 1 ? [{ target: `fn_${i + 1}` }] : [],
    });
  }

  const files: ScannedFile[] = [{
    filePath: `/src/${name}/Chain.java`,
    language: 'java',
    packageName: `com.bench.${name}`,
    symbols,
    imports: [],
  }];

  return { name, path: `/fake/${name}`, language: 'java' as const, files, summary: makeSummary(files) };
}

function buildRestHeavyModule(name: string, count: number): ScannedModule {
  const javaSymbols: ExtractedSymbol[] = [];
  const tsSymbols: ExtractedSymbol[] = [];

  for (let i = 0; i < count; i++) {
    javaSymbols.push({
      name: `Handler${i}`,
      kind: 'class',
      visibility: 'public',
      location: { startLine: i * 10 + 1, endLine: i * 10 + 9 },
      annotations: ['@RestController'],
      children: [{
        name: `handle${i}`,
        kind: 'method',
        visibility: 'public',
        location: { startLine: i * 10 + 3, endLine: i * 10 + 7 },
        annotations: [`@GetMapping("/api/resource${i}")`],
      }],
    });

    tsSymbols.push({
      name: `fetchResource${i}`,
      kind: 'api-call',
      visibility: 'public',
      location: { startLine: i + 1, endLine: i + 1 },
      apiMethod: 'GET',
      apiPath: `/api/resource${i}`,
    });
  }

  const files: ScannedFile[] = [
    {
      filePath: `/src/${name}/Controllers.java`,
      language: 'java',
      packageName: `com.bench.${name}`,
      symbols: javaSymbols,
      imports: [],
    },
    {
      filePath: `/src/${name}/api-client.ts`,
      language: 'typescript',
      symbols: tsSymbols,
      imports: [],
    },
  ];

  return { name, path: `/fake/${name}`, language: 'java', files, summary: makeSummary(files) };
}
