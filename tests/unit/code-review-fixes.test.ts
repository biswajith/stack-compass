import { assert } from '../helpers.js';
import { GraphStore } from '../../src/graph/index.js';
import type { ScannedModule, ScannedFile, ExtractedSymbol } from '../../src/source-scanner/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-fix-test-'));
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

export async function testGraphSafety() {
  console.log('\n--- Unit: Graph Safety & Robustness ---');

  await test_fts5_special_chars_dont_crash();
  await test_fts5_sanitization();
  await test_like_wildcard_escape();
  await test_module_filter_on_callers();
  await test_module_filter_on_callees();
  await test_module_filter_on_impact();
  await test_rest_resolver_bulk_query();
  await test_spring_resolver_bulk_query();
  await test_qualified_name_no_double_lookup();
  await test_request_mapping_any_method();
  await test_structural_hash_includes_new_fields();
  await test_gql_type_multi_module_no_false_match();
}

// ── CR-1: FTS5 special chars don't crash ────────────────────────────────

async function test_fts5_special_chars_dont_crash() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/Foo.java',
        symbols: [makeSymbol({ name: 'FooService', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    // These contain FTS5 operators that previously would crash
    const dangerous = ['*', 'name:*', '"unmatched', 'foo AND', 'a OR', 'NOT', '()', '{}'];
    for (const q of dangerous) {
      try {
        store.searchSymbols(q);
        // Should not throw — either return results or empty
      } catch (e) {
        assert(`fts5-safe: "${q}" should not crash`, false, `threw: ${e}`);
      }
    }
    assert('fts5-safe: all dangerous queries handled', true);
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_fts5_sanitization() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/User.java',
        symbols: [makeSymbol({ name: 'UserService', kind: 'class', signature: 'public class UserService' })],
      }),
    ]);
    store.ingestModule(mod);

    // Normal query should still work after sanitization
    const results = store.searchSymbols('UserService');
    assert('fts5-sanit: normal query works', results.length === 1, `got ${results.length}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── CR-2: LIKE wildcard escape ──────────────────────────────────────────

async function test_like_wildcard_escape() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/A.java',
        symbols: [
          makeSymbol({ name: 'User_Service', kind: 'class' }),
          makeSymbol({ name: 'UserXService', kind: 'class', location: { startLine: 11, endLine: 20 } }),
        ],
      }),
    ]);
    store.ingestModule(mod);

    // Searching for suffix "_Service" should NOT match "UserXService" (the _ is a wildcard in LIKE)
    const results = store.getNodesByNameSuffix('_Service');
    const names = results.map(r => r.name);
    assert('like-escape: _ is literal, matches User_Service', names.includes('User_Service'), `got ${JSON.stringify(names)}`);
    assert('like-escape: _ does not match UserXService', !names.includes('UserXService'), `got ${JSON.stringify(names)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── CR-3: Module filter on traversal tools ──────────────────────────────

async function test_module_filter_on_callers() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Two modules with same method name
    const mod1 = makeModule('api', [
      makeScannedFile({
        filePath: '/api/Svc.java',
        symbols: [makeSymbol({
          name: 'SvcA', kind: 'class',
          children: [makeSymbol({ name: 'process', kind: 'method', location: { startLine: 2, endLine: 5 } })],
        })],
      }),
    ]);
    const mod2 = makeModule('web', [
      makeScannedFile({
        filePath: '/web/Svc.ts', language: 'typescript',
        symbols: [makeSymbol({
          name: 'SvcB', kind: 'class',
          children: [makeSymbol({ name: 'process', kind: 'method', location: { startLine: 2, endLine: 5 } })],
        })],
      }),
    ]);
    store.ingestModule(mod1);
    store.ingestModule(mod2);

    const { getCallers } = await import('../../src/graph/traversal.js');

    // Without module: should find in both
    const allNodes = store.getNodesByName('process');
    assert('mod-callers: 2 process nodes', allNodes.length === 2, `got ${allNodes.length}`);

    // With module filter: should narrow to just one
    const apiOnly = store.getNodesByName('process', { module: 'api' });
    assert('mod-callers: 1 process in api', apiOnly.length === 1, `got ${apiOnly.length}`);

    store.close();
  } finally { cleanup(dbPath); }
}

async function test_module_filter_on_callees() {
  // Same structure as callers — verifying module param is accepted
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/api/Ctl.java',
        symbols: [makeSymbol({ name: 'Controller', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    const { getCallees } = await import('../../src/graph/traversal.js');
    // Should accept module parameter without error
    const result = getCallees(store, 'Controller', 2, 'api');
    assert('mod-callees: accepts module param', Array.isArray(result));
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_module_filter_on_impact() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/api/Svc.java',
        symbols: [makeSymbol({ name: 'MyService', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    const { getImpact } = await import('../../src/graph/traversal.js');
    // Should accept module parameter without error
    const result = getImpact(store, 'MyService', 3, 'api');
    assert('mod-impact: accepts module param', result !== undefined);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── CR-4: REST resolver bulk query ──────────────────────────────────────

async function test_rest_resolver_bulk_query() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Verify getAllRestEndpoints exists and works
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/Ctl.java',
        symbols: [makeSymbol({
          name: 'UserCtl', kind: 'class',
          annotations: ['@RestController'],
          children: [makeSymbol({
            name: 'getUser', kind: 'method',
            annotations: ['@GetMapping("/users")'],
            location: { startLine: 3, endLine: 8 },
          })],
        })],
      }),
    ]);
    store.ingestModule(mod);

    const allEps = store.getAllRestEndpoints();
    assert('bulk-rest: getAllRestEndpoints returns data', allEps.length >= 1, `got ${allEps.length}`);
    assert('bulk-rest: has node_id', typeof allEps[0].node_id === 'number');
    assert('bulk-rest: has method', typeof allEps[0].method === 'string');
    assert('bulk-rest: has path', typeof allEps[0].path === 'string');
    store.close();
  } finally { cleanup(dbPath); }
}

// ── CR-5: Spring resolver bulk query ────────────────────────────────────

async function test_spring_resolver_bulk_query() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/SvcImpl.java',
        symbols: [makeSymbol({
          name: 'SvcImpl', kind: 'class',
          annotations: ['@Service'],
          implements: ['ISvc'],
        })],
      }),
    ]);
    store.ingestModule(mod);

    // Verify bulk method exists
    const allClasses = store.getClassesWithImplements();
    assert('bulk-spring: getClassesWithImplements returns data', allClasses.length >= 1, `got ${allClasses.length}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── CR-6: buildQualifiedName no double-lookup ───────────────────────────

async function test_qualified_name_no_double_lookup() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const mod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/utils.ts', language: 'typescript',
        symbols: [makeSymbol({ name: 'formatDate', kind: 'function' })],
      }),
    ]);
    store.ingestModule(mod);

    // TS symbol without parent should have qualified = "filepath#name"
    const nodes = store.getNodesByName('formatDate');
    assert('qual-name: formatDate found', nodes.length === 1);
    assert('qual-name: has qualified name', nodes[0].qualified !== null && nodes[0].qualified!.includes('formatDate'),
      `got "${nodes[0].qualified}"`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── CR-7: @RequestMapping ANY matches ───────────────────────────────────

async function test_request_mapping_any_method() {
  const { normalizePath } = await import('../../src/graph/resolvers/rest-resolver.js');

  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/Ctl.java',
        symbols: [makeSymbol({
          name: 'Ctl', kind: 'class',
          children: [makeSymbol({
            name: 'handle', kind: 'method',
            annotations: ['@RequestMapping("/data")'],
            location: { startLine: 3, endLine: 8 },
          })],
        })],
      }),
    ]);
    store.ingestModule(mod);

    const tsMod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/api.ts', language: 'typescript',
        symbols: [makeSymbol({
          name: 'fetchData', kind: 'api-call',
          apiPath: '/data', apiMethod: 'GET',
        })],
      }),
    ]);
    store.ingestModule(tsMod);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    const apiCall = store.getNodesByName('fetchData');
    const edges = store.getEdgesFrom(apiCall[0].id);
    const restEdge = edges.find(e => e.kind === 'rest_match');
    assert('any-method: GET matches @RequestMapping (ANY)', restEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── CR-8: Structural hash includes new fields ───────────────────────────

async function test_structural_hash_includes_new_fields() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Use synthetic (non-disk) files so structural hash is used
    const mod1 = makeModule('api', [
      makeScannedFile({
        filePath: '/nonexistent/Svc.java',
        symbols: [makeSymbol({ name: 'Svc', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod1);

    // Same file but with different callSites — hash should differ
    const mod2 = makeModule('api', [
      makeScannedFile({
        filePath: '/nonexistent/Svc.java',
        symbols: [makeSymbol({
          name: 'Svc', kind: 'class',
          callSites: [{ target: 'foo' }],
        })],
      }),
    ]);
    store.ingestModule(mod2);

    // If hash includes callSites, the re-ingest should succeed (new data)
    // Check that FTS still returns the node (not corrupted by re-ingest)
    const results = store.searchSymbols('Svc');
    assert('struct-hash: Svc still in FTS', results.length === 1, `got ${results.length}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── CR-9: GQL type multi-module no false match ──────────────────────────

async function test_gql_type_multi_module_no_false_match() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const schemaMod = makeModule('schema', [
      makeScannedFile({
        filePath: '/schema/schema.graphql', language: 'graphql',
        symbols: [makeSymbol({ name: 'User', kind: 'graphql-type' })],
      }),
    ]);
    store.ingestModule(schemaMod);

    // Module A: User class WITH @Entity
    const modA = makeModule('api', [
      makeScannedFile({
        filePath: '/api/User.java',
        symbols: [makeSymbol({ name: 'User', kind: 'class', annotations: ['@Entity'] })],
      }),
    ]);
    store.ingestModule(modA);

    // Module B: User class WITHOUT @Entity
    const modB = makeModule('shared', [
      makeScannedFile({
        filePath: '/shared/User.java',
        symbols: [makeSymbol({ name: 'User', kind: 'class', location: { startLine: 1, endLine: 10 } })],
      }),
    ]);
    store.ingestModule(modB);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    const gqlUser = store.getNodesByName('User', { kind: 'graphql-type' });
    const edges = store.getEdgesFrom(gqlUser[0].id);
    const typeEdges = edges.filter(e => e.kind === 'type_match');
    assert('multi-mod: exactly 1 type_match edge', typeEdges.length === 1, `got ${typeEdges.length}`);

    if (typeEdges.length === 1) {
      const target = store.getNodeById(typeEdges[0].target_id);
      assert('multi-mod: target is api User', target?.module === 'api', `got module "${target?.module}"`);
    }
    store.close();
  } finally { cleanup(dbPath); }
}
