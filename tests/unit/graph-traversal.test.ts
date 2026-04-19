import { assert } from '../helpers.js';
import { GraphStore } from '../../src/graph/index.js';
import type { ScannedModule, ScannedFile, ExtractedSymbol } from '../../src/source-scanner/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traversal-test-'));
  return path.join(dir, 'test-graph.db');
}

function cleanup(dbPath: string) {
  const dir = path.dirname(dbPath);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeSymbol(overrides: Partial<ExtractedSymbol> & { name: string; kind: ExtractedSymbol['kind'] }): ExtractedSymbol {
  return {
    visibility: 'public',
    location: { startLine: 1, endLine: 10 },
    ...overrides,
  };
}

function makeScannedFile(overrides: Partial<ScannedFile> & { filePath: string }): ScannedFile {
  return {
    language: 'java',
    symbols: [],
    ...overrides,
  };
}

function makeModule(name: string, files: ScannedFile[]): ScannedModule {
  return {
    name,
    path: '/fake/' + name,
    language: files[0]?.language ?? 'java',
    files,
    summary: {
      totalFiles: files.length,
      totalSymbols: files.reduce((s, f) => s + f.symbols.length, 0),
      publicClasses: [],
      publicInterfaces: [],
      publicMethods: 0,
      annotations: [],
      restEndpoints: [],
      entities: [],
      events: [],
    },
  };
}

/**
 * Build a standard call chain fixture:
 *
 *   Controller.handlePost --calls--> Service.createUser --calls--> Repository.save
 *   AdminController.handleAdmin --calls--> Service.createUser
 *
 * Plus an import edge:
 *   Controller --imports--> Service
 */
async function buildCallChainFixture(store: GraphStore): Promise<void> {
  const mod = makeModule('api', [
    makeScannedFile({
      filePath: '/src/Controller.java',
      language: 'java',
      packageName: 'com.acme',
      imports: ['com.acme.Service'],
      symbols: [makeSymbol({
        name: 'Controller',
        kind: 'class',
        children: [makeSymbol({
          name: 'handlePost',
          kind: 'method',
          callSites: [{ target: 'createUser', receiver: 'service' }],
          location: { startLine: 5, endLine: 12 },
        })],
      })],
    }),
    makeScannedFile({
      filePath: '/src/AdminController.java',
      language: 'java',
      packageName: 'com.acme',
      symbols: [makeSymbol({
        name: 'AdminController',
        kind: 'class',
        children: [makeSymbol({
          name: 'handleAdmin',
          kind: 'method',
          callSites: [{ target: 'createUser', receiver: 'service' }],
          location: { startLine: 5, endLine: 12 },
        })],
      })],
    }),
    makeScannedFile({
      filePath: '/src/Service.java',
      language: 'java',
      packageName: 'com.acme',
      symbols: [makeSymbol({
        name: 'Service',
        kind: 'class',
        children: [makeSymbol({
          name: 'createUser',
          kind: 'method',
          callSites: [{ target: 'save', receiver: 'repository' }],
          location: { startLine: 5, endLine: 15 },
        })],
      })],
    }),
    makeScannedFile({
      filePath: '/src/Repository.java',
      language: 'java',
      packageName: 'com.acme',
      symbols: [makeSymbol({
        name: 'Repository',
        kind: 'class',
        children: [makeSymbol({
          name: 'save',
          kind: 'method',
          location: { startLine: 5, endLine: 10 },
        })],
      })],
    }),
  ]);

  store.ingestModule(mod);

  const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
  resolveAllEdges(store);
}

export async function testGraphTraversal() {
  console.log('\n--- Unit: Graph Traversal (Phase 3B) ---');

  await test_get_callers_depth_1();
  await test_get_callers_depth_2();
  await test_get_callers_no_callers();
  await test_get_callees_depth_1();
  await test_get_callees_depth_2();
  await test_get_callees_no_callees();
  await test_get_impact_all_edge_types();
  await test_get_impact_depth_limit();
  await test_build_context_term_extraction();
  await test_build_context_seed_search();
  await test_build_context_max_nodes_budget();
  await test_build_context_kind_boost_scoring();
}

// ── get-callers ──────────────────────────────────────────────────────────

async function test_get_callers_depth_1() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await await buildCallChainFixture(store);

    const { getCallers } = await import('../../src/graph/traversal.js');
    const result = getCallers(store, 'createUser', 1);

    assert('callers-d1: returns results', result.length > 0, `got ${result.length}`);
    const names = result.map(r => r.name);
    assert('callers-d1: handlePost calls createUser', names.includes('handlePost'), `got ${JSON.stringify(names)}`);
    assert('callers-d1: handleAdmin calls createUser', names.includes('handleAdmin'), `got ${JSON.stringify(names)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_get_callers_depth_2() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await buildCallChainFixture(store);

    const { getCallers } = await import('../../src/graph/traversal.js');
    // save → createUser → handlePost/handleAdmin
    // At depth 2 from save, we should see createUser (depth 1) AND handlePost/handleAdmin (depth 2)
    const result = getCallers(store, 'save', 2);

    const names = result.map(r => r.name);
    assert('callers-d2: includes createUser at depth 1', names.includes('createUser'), `got ${JSON.stringify(names)}`);
    assert('callers-d2: includes handlePost at depth 2', names.includes('handlePost'), `got ${JSON.stringify(names)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_get_callers_no_callers() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await buildCallChainFixture(store);

    const { getCallers } = await import('../../src/graph/traversal.js');
    const result = getCallers(store, 'handlePost', 3);

    assert('callers-none: no callers for top-level', result.length === 0, `got ${result.length}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── get-callees ──────────────────────────────────────────────────────────

async function test_get_callees_depth_1() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await buildCallChainFixture(store);

    const { getCallees } = await import('../../src/graph/traversal.js');
    const result = getCallees(store, 'handlePost', 1);

    const names = result.map(r => r.name);
    assert('callees-d1: handlePost calls createUser', names.includes('createUser'), `got ${JSON.stringify(names)}`);
    assert('callees-d1: does not include save at depth 1', !names.includes('save'), `got ${JSON.stringify(names)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_get_callees_depth_2() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await buildCallChainFixture(store);

    const { getCallees } = await import('../../src/graph/traversal.js');
    const result = getCallees(store, 'handlePost', 2);

    const names = result.map(r => r.name);
    assert('callees-d2: includes createUser', names.includes('createUser'), `got ${JSON.stringify(names)}`);
    assert('callees-d2: includes save at depth 2', names.includes('save'), `got ${JSON.stringify(names)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_get_callees_no_callees() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await buildCallChainFixture(store);

    const { getCallees } = await import('../../src/graph/traversal.js');
    const result = getCallees(store, 'save', 3);

    assert('callees-none: save has no callees', result.length === 0, `got ${result.length}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── get-impact ───────────────────────────────────────────────────────────

async function test_get_impact_all_edge_types() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await buildCallChainFixture(store);

    const { getImpact } = await import('../../src/graph/traversal.js');
    // Impact of Service: reverse traverse ALL edges (calls, imports)
    // handlePost calls createUser (child of Service)
    // handleAdmin calls createUser
    // Controller imports Service
    const result = getImpact(store, 'Service', 3);

    assert('impact: has results', result.nodes.length > 0, `got ${result.nodes.length}`);
    const names = result.nodes.map(n => n.name);
    // Controller imports Service, so it should appear
    assert('impact: Controller affected (imports)', names.includes('Controller'), `got ${JSON.stringify(names)}`);
    assert('impact: direct count > 0', result.directCount > 0, `got ${result.directCount}`);
    assert('impact: transitive count >= direct', result.transitiveCount >= result.directCount);
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_get_impact_depth_limit() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await buildCallChainFixture(store);

    const { getImpact } = await import('../../src/graph/traversal.js');
    const shallow = getImpact(store, 'save', 1);
    const deep = getImpact(store, 'save', 3);

    assert('impact-depth: deeper finds more', deep.transitiveCount >= shallow.transitiveCount,
      `shallow=${shallow.transitiveCount} deep=${deep.transitiveCount}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── build-context ────────────────────────────────────────────────────────

async function test_build_context_term_extraction() {
  const { extractTerms } = await import('../../src/graph/traversal.js');
  const terms = extractTerms('fix the login endpoint');
  assert('terms: removes stop words', !terms.includes('the'), `got ${JSON.stringify(terms)}`);
  assert('terms: keeps login', terms.includes('login'), `got ${JSON.stringify(terms)}`);
  assert('terms: keeps endpoint', terms.includes('endpoint'), `got ${JSON.stringify(terms)}`);
  assert('terms: keeps fix', terms.includes('fix'), `got ${JSON.stringify(terms)}`);
}

async function test_build_context_seed_search() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await buildCallChainFixture(store);

    const { buildContext } = await import('../../src/graph/traversal.js');
    const result = buildContext(store, 'createUser', 20);

    assert('context-seed: has results', result.length > 0, `got ${result.length}`);
    const names = result.map(r => r.name);
    assert('context-seed: includes createUser itself', names.includes('createUser'), `got ${JSON.stringify(names)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_build_context_max_nodes_budget() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await buildCallChainFixture(store);

    const { buildContext } = await import('../../src/graph/traversal.js');
    const result = buildContext(store, 'createUser', 2);

    assert('context-budget: respects maxNodes', result.length <= 2, `got ${result.length}`);
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_build_context_kind_boost_scoring() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    await buildCallChainFixture(store);

    const { buildContext } = await import('../../src/graph/traversal.js');
    const result = buildContext(store, 'Service', 20);

    assert('context-boost: has results', result.length > 0, `got ${result.length}`);
    // Each result should have a score
    for (const r of result) {
      assert(`context-boost: ${r.name} has score`, typeof r.score === 'number', `got ${typeof r.score}`);
    }
    // Results should be sorted by score descending
    for (let i = 1; i < result.length; i++) {
      assert(`context-boost: sorted desc at ${i}`, result[i - 1].score >= result[i].score,
        `${result[i - 1].name}=${result[i - 1].score} < ${result[i].name}=${result[i].score}`);
    }
    store.close();
  } finally { cleanup(dbPath); }
}
