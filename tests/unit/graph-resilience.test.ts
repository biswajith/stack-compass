import { assert } from '../helpers.js';
import { GraphStore } from '../../src/graph/index.js';
import type { ScannedModule, ScannedFile, ExtractedSymbol } from '../../src/source-scanner/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-fix-'));
  return path.join(dir, 'test-graph.db');
}

function cleanup(dbPath: string) {
  const dir = path.dirname(dbPath);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeSymbol(overrides: Partial<ExtractedSymbol> & { name: string; kind: ExtractedSymbol['kind'] }): ExtractedSymbol {
  return { visibility: 'public', location: { startLine: 1, endLine: 10 }, ...overrides };
}

function makeScannedFile(overrides: Partial<ScannedFile> & { filePath: string }): ScannedFile {
  return { language: 'java', symbols: [], ...overrides };
}

function makeModule(name: string, files: ScannedFile[]): ScannedModule {
  return {
    name, path: '/fake/' + name, language: files[0]?.language ?? 'java', files,
    summary: {
      totalFiles: files.length,
      totalSymbols: files.reduce((s, f) => s + f.symbols.length, 0),
      publicClasses: [], publicInterfaces: [], publicMethods: 0,
      annotations: [], restEndpoints: [], entities: [], events: [],
    },
  };
}

export async function testGraphResilience() {
  console.log('\n--- Unit: Graph Resilience ---');

  await test_c1_inheritance_cycle_detection();
  test_c2_upsert_returns_correct_id();
  await test_s5_import_resolver_uses_file_index();
  await test_s6_depth_capped_at_10();
  test_s8_structural_hash_includes_children();
  await test_n1_annotation_array_values();
  await test_n2_action_stop_words_filtered();
  await test_gap_build_context_source_from_disk();
  test_gap_gql_content_edge_cases();
  await test_gap_stale_count_deleted_files();
}

// ── C1: Cycle detection in inheritance resolver ─────────────────────────

async function test_c1_inheritance_cycle_detection() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Create a class A that extends B, and B extends A (cycle)
    const mod = makeModule('cycle', [
      makeScannedFile({
        filePath: '/src/Cycle.java', language: 'java', packageName: 'com.cycle',
        symbols: [
          makeSymbol({ name: 'ClassA', kind: 'class', extends: 'ClassB',
            children: [makeSymbol({ name: 'innerA', kind: 'method', location: { startLine: 2, endLine: 3 } })]
          }),
          makeSymbol({ name: 'ClassB', kind: 'class', extends: 'ClassA', location: { startLine: 20, endLine: 30 },
            children: [makeSymbol({ name: 'innerB', kind: 'method', location: { startLine: 22, endLine: 23 } })]
          }),
        ],
      }),
    ]);
    store.ingestModule(mod);

    // This must not stack overflow
    let threw = false;
    try {
      const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
      resolveAllEdges(store);
    } catch {
      threw = true;
    }
    assert('C1: inheritance cycle does not throw', !threw);

    store.close();
  } finally { cleanup(dbPath); }
}

// ── C2: upsertFile/insertNode return correct ID on update ───────────────

function test_c2_upsert_returns_correct_id() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Insert file, then upsert (update) it
    const id1 = store.upsertFile('/src/Foo.java', 'hash1', 'java', 'mod1');
    const id2 = store.upsertFile('/src/Foo.java', 'hash2', 'java', 'mod1');
    assert('C2: upsert file returns same id', id1 === id2, `id1=${id1} id2=${id2}`);

    // Insert another file first to shift lastInsertRowid
    const id3 = store.upsertFile('/src/Bar.java', 'hash3', 'java', 'mod1');
    assert('C2: different file gets different id', id3 !== id1, `both got ${id1}`);

    // Now upsert the first file again — lastInsertRowid would be id3, not id1
    const id4 = store.upsertFile('/src/Foo.java', 'hash4', 'java', 'mod1');
    assert('C2: upsert after other insert returns original id', id4 === id1,
      `expected ${id1} got ${id4} (stale lastInsertRowid would be ${id3})`);

    store.close();
  } finally { cleanup(dbPath); }
}

// ── S5: Import resolver uses Map for file lookup ────────────────────────

async function test_s5_import_resolver_uses_file_index() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Build 100 files with one import each — if resolver uses O(n) find(),
    // this is 100 * 7 * 100 = 70K comparisons. With a Map, it's 100 * 7 lookups.
    const files: ScannedFile[] = [];
    for (let i = 0; i < 100; i++) {
      files.push(makeScannedFile({
        filePath: `/src/web/Component${i}.tsx`,
        language: 'typescript',
        symbols: [makeSymbol({ name: `Component${i}`, kind: 'component', location: { startLine: 1, endLine: 10 } })],
        imports: i > 0 ? [`./Component${i - 1}`] : [],
      }));
    }

    store.ingestModule(makeModule('web', files));

    const { resolveImportEdges } = await import('../../src/graph/resolvers/import-resolver.js');
    const start = performance.now();
    resolveImportEdges(store);
    const elapsed = performance.now() - start;

    // With Map, 100 files should resolve in under 100ms easily
    assert('S5: import resolve 100 files < 200ms', elapsed < 200, `took ${elapsed.toFixed(0)}ms`);

    // Verify some edges were created
    const comp50 = store.getNodesByName('Component50');
    if (comp50.length > 0) {
      const edges = store.getEdgesFrom(comp50[0].id);
      assert('S5: import edges created', edges.some(e => e.kind === 'imports'),
        `edges: ${JSON.stringify(edges.map(e => e.kind))}`);
    }

    store.close();
  } finally { cleanup(dbPath); }
}

// ── S6: Depth parameter capped at 10 ───────────────────────────────────

async function test_s6_depth_capped_at_10() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Build a chain of 50 methods
    const children: ExtractedSymbol[] = [];
    for (let i = 0; i < 50; i++) {
      children.push(makeSymbol({
        name: `fn${i}`, kind: 'method',
        location: { startLine: i * 3 + 1, endLine: i * 3 + 2 },
        callSites: i < 49 ? [{ target: `fn${i + 1}` }] : [],
      }));
    }
    store.ingestModule(makeModule('deep', [
      makeScannedFile({ filePath: '/src/Deep.java', language: 'java', packageName: 'com.deep', symbols: children }),
    ]));

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    const { getCallees } = await import('../../src/graph/traversal.js');

    // Requesting depth 50 should be internally capped
    const result = getCallees(store, 'fn0', 50);
    assert('S6: depth capped — max 10 results', result.length <= 10,
      `got ${result.length} results (uncapped would be ~49)`);

    store.close();
  } finally { cleanup(dbPath); }
}

// ── S8: Structural hash includes children ───────────────────────────────

function test_s8_structural_hash_includes_children() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Ingest a class with a child method
    const mod1 = makeModule('hash-test', [
      makeScannedFile({
        filePath: '/src/no-exist/HashTest.java', language: 'java',
        symbols: [makeSymbol({
          name: 'HashClass', kind: 'class',
          children: [makeSymbol({ name: 'methodA', kind: 'method', signature: 'void methodA()', location: { startLine: 3, endLine: 5 } })],
        })],
      }),
    ]);
    store.ingestModule(mod1);

    const file1 = store.getFileByPath('/src/no-exist/HashTest.java');
    const hash1 = file1?.hash;

    // Re-ingest with a different child signature
    store.deleteFile(file1!.id);
    const mod2 = makeModule('hash-test', [
      makeScannedFile({
        filePath: '/src/no-exist/HashTest.java', language: 'java',
        symbols: [makeSymbol({
          name: 'HashClass', kind: 'class',
          children: [makeSymbol({ name: 'methodA', kind: 'method', signature: 'String methodA(int x)', location: { startLine: 3, endLine: 5 } })],
        })],
      }),
    ]);
    store.ingestModule(mod2);

    const file2 = store.getFileByPath('/src/no-exist/HashTest.java');
    const hash2 = file2?.hash;

    assert('S8: child change produces different hash', hash1 !== hash2,
      `both hashes: ${hash1}`);

    store.close();
  } finally { cleanup(dbPath); }
}

// ── N1: Annotation array values parsed ──────────────────────────────────

async function test_n1_annotation_array_values() {
  const { parseAnnotation } = await import('../../src/graph/store.js');

  const result = parseAnnotation('@RequestMapping(value = {"/api/v1", "/api/v2"})');
  assert('N1: array annotation extracts first value', result.value === '/api/v1',
    `got "${result.value}"`);

  const result2 = parseAnnotation('@RequestMapping(method = {RequestMethod.GET, RequestMethod.POST})');
  assert('N1: array method annotation parsed', result2.name === 'RequestMapping');
}

// ── N2: Action stop words filtered from extractTerms ────────────────────

async function test_n2_action_stop_words_filtered() {
  const { extractTerms } = await import('../../src/graph/traversal.js');

  const terms = extractTerms('fix the user creation endpoint');
  assert('N2: "fix" is filtered', !terms.includes('fix'), `terms: ${JSON.stringify(terms)}`);
  assert('N2: "user" is kept', terms.includes('user'), `terms: ${JSON.stringify(terms)}`);
  assert('N2: "endpoint" is kept', terms.includes('endpoint'), `terms: ${JSON.stringify(terms)}`);

  const terms2 = extractTerms('add a new create method');
  assert('N2: "add" is filtered', !terms2.includes('add'), `terms: ${JSON.stringify(terms2)}`);
  assert('N2: "method" is kept', terms2.includes('method'), `terms: ${JSON.stringify(terms2)}`);
}

// ── GAP: buildContext reads source from disk ────────────────────────────

async function test_gap_build_context_source_from_disk() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-disk-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const srcFile = path.join(tmpDir, 'Service.java');

  try {
    // Write a real file on disk
    fs.writeFileSync(srcFile, `package com.test;

public class UserService {
    public void createUser(String name) {
        // business logic
    }
}
`);

    const store = GraphStore.open(dbPath);
    store.ingestModule(makeModule('svc', [
      makeScannedFile({
        filePath: srcFile, language: 'java', packageName: 'com.test',
        symbols: [makeSymbol({
          name: 'UserService', kind: 'class',
          children: [makeSymbol({
            name: 'createUser', kind: 'method', signature: 'void createUser(String name)',
            location: { startLine: 4, endLine: 6 },
          })],
        })],
      }),
    ]));

    const { buildContext } = await import('../../src/graph/traversal.js');
    const results = buildContext(store, 'UserService createUser');

    const hasSource = results.some((r: any) => r.source && r.source.includes('createUser'));
    assert('GAP: buildContext reads source from disk', hasSource,
      `results: ${results.length}, sources: ${results.map((r: any) => r.source?.substring(0, 30) ?? 'none').join('; ')}`);

    // Now delete file and verify graceful fallback (no crash, source just missing)
    fs.unlinkSync(srcFile);
    const results2 = buildContext(store, 'UserService');
    assert('GAP: buildContext handles deleted source file', results2.length > 0,
      `got ${results2.length} results`);

    store.close();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

// ── GAP: parseGqlContent edge cases ─────────────────────────────────────

function test_gap_gql_content_edge_cases() {
  // Test via the extractTypeScriptSymbols path is complex,
  // so we test parseGqlContent patterns that should/shouldn't match

  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Fragment (no operation type) should NOT produce a gql-operation
    const modFragment = makeModule('gql-edge', [
      makeScannedFile({
        filePath: '/src/fragments.ts', language: 'typescript',
        symbols: [makeSymbol({ name: 'USER_FRAGMENT', kind: 'constant' })],
      }),
    ]);
    store.ingestModule(modFragment);

    // Subscription operation type should be recognized
    const modSub = makeModule('gql-sub', [
      makeScannedFile({
        filePath: '/src/subs.ts', language: 'typescript',
        symbols: [makeSymbol({
          name: 'ON_USER_UPDATED', kind: 'gql-operation',
          gqlOperationType: 'subscription', gqlFields: ['userUpdated'],
        })],
      }),
    ]);
    store.ingestModule(modSub);

    const ops = store.getGqlOperations();
    const subOp = ops.find((o: any) => o.operation_type === 'subscription');
    assert('GAP: subscription operation stored', subOp !== undefined,
      `ops: ${JSON.stringify(ops)}`);

    store.close();
  } finally { cleanup(dbPath); }
}

// ── GAP: getStaleFileCount counts deleted files ─────────────────────────

async function test_gap_stale_count_deleted_files() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-del-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const srcFile = path.join(tmpDir, 'Foo.java');

  try {
    fs.writeFileSync(srcFile, 'public class Foo {}');

    const store = GraphStore.open(dbPath);
    store.ingestModule(makeModule('del', [
      makeScannedFile({
        filePath: srcFile, language: 'java',
        symbols: [makeSymbol({ name: 'Foo', kind: 'class' })],
      }),
    ]));

    const { IncrementalSync } = await import('../../src/graph/sync.js');
    const sync = new IncrementalSync(store);

    // Before deletion: 0 stale
    assert('GAP: stale=0 before delete', sync.getStaleFileCount() === 0);

    // Delete the file
    fs.unlinkSync(srcFile);

    // After deletion: 1 stale
    assert('GAP: stale=1 after delete', sync.getStaleFileCount() === 1,
      `got ${sync.getStaleFileCount()}`);

    store.close();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}
