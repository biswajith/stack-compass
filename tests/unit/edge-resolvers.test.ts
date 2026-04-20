import { assert } from '../helpers.js';
import { GraphStore } from '../../src/graph/index.js';
import type { ScannedModule, ScannedFile, ExtractedSymbol } from '../../src/source-scanner/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-test-'));
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

export async function testEdgeResolvers() {
  console.log('\n--- Unit: Edge Resolvers (Phase 2A) ---');

  // Import edges
  await test_java_import_edge();
  await test_ts_import_edge();
  await test_import_no_match();
  await test_cross_module_import();
  await test_java_wildcard_import();

  // Inheritance edges
  await test_java_extends_edge();
  await test_java_implements_edge();
  await test_ts_extends_edge();
  await test_ts_implements_edge();
  await test_ts_interface_extends();
  await test_generic_type_extends();

  // Call edges
  await test_java_call_edge();
  await test_ts_call_edge();

  // React-specific edges
  await test_jsx_renders_edge();
  await test_hook_call_edge();

  // Edge deduplication
  await test_edge_deduplication_on_re_resolve();

  // Extractor enhancements
  await test_extractor_captures_extends();
  await test_extractor_captures_implements();
  await test_ts_extractor_captures_extends();
  await test_ts_extractor_captures_implements();
  await test_ts_extractor_interface_extends();
  await test_java_extractor_generic_extends();

  // Call-site extraction
  await test_java_extractor_call_sites();
  await test_ts_extractor_call_sites();
  await test_ts_extractor_jsx_usage();
}

// ── Import edges ─────────────────────────────────────────────────────────

async function test_java_import_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/com/acme/UserController.java',
        language: 'java',
        packageName: 'com.acme',
        imports: ['com.acme.UserService'],
        symbols: [makeSymbol({ name: 'UserController', kind: 'class' })],
      }),
      makeScannedFile({
        filePath: '/src/com/acme/UserService.java',
        language: 'java',
        packageName: 'com.acme',
        symbols: [makeSymbol({ name: 'UserService', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    // Import resolver should be called after ingestion
    const { resolveImportEdges } = await import('../../src/graph/resolvers/import-resolver.js');
    resolveImportEdges(store);

    // UserController imports UserService → should have an imports edge
    const controllerNodes = store.getNodesByName('UserController');
    assert('java-import: controller found', controllerNodes.length === 1);
    const edges = store.getEdgesFrom(controllerNodes[0].id);
    assert('java-import: has edge', edges.length >= 1, `got ${edges.length}`);
    const importEdge = edges.find(e => e.kind === 'imports');
    assert('java-import: edge kind is imports', importEdge !== undefined);
    if (importEdge) {
      const target = store.getNodeById(importEdge.target_id);
      assert('java-import: target is UserService', target?.name === 'UserService', `got "${target?.name}"`);
    }

    store.close();
  } finally { cleanup(dbPath); }
}

async function test_ts_import_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/components/App.tsx',
        language: 'typescript',
        imports: ['./UserList'],
        symbols: [makeSymbol({ name: 'App', kind: 'component' })],
      }),
      makeScannedFile({
        filePath: '/src/components/UserList.tsx',
        language: 'typescript',
        symbols: [makeSymbol({ name: 'UserList', kind: 'component' })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveImportEdges } = await import('../../src/graph/resolvers/import-resolver.js');
    resolveImportEdges(store);

    const appNodes = store.getNodesByName('App');
    const edges = store.getEdgesFrom(appNodes[0].id);
    const importEdge = edges.find(e => e.kind === 'imports');
    assert('ts-import: has imports edge', importEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    if (importEdge) {
      const target = store.getNodeById(importEdge.target_id);
      assert('ts-import: target is UserList', target?.name === 'UserList', `got "${target?.name}"`);
    }

    store.close();
  } finally { cleanup(dbPath); }
}

async function test_import_no_match() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/Foo.java',
        language: 'java',
        packageName: 'com.acme',
        imports: ['org.external.SomeLibrary'],
        symbols: [makeSymbol({ name: 'Foo', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveImportEdges } = await import('../../src/graph/resolvers/import-resolver.js');
    resolveImportEdges(store);

    // External imports should not create edges
    const fooNodes = store.getNodesByName('Foo');
    const edges = store.getEdgesFrom(fooNodes[0].id);
    assert('no-match: no edges for external import', edges.length === 0, `got ${edges.length}`);

    store.close();
  } finally { cleanup(dbPath); }
}

async function test_cross_module_import() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const mod1 = makeModule('shared', [
      makeScannedFile({
        filePath: '/src/com/acme/shared/User.java',
        language: 'java',
        packageName: 'com.acme.shared',
        symbols: [makeSymbol({ name: 'User', kind: 'class' })],
      }),
    ]);
    const mod2 = makeModule('api', [
      makeScannedFile({
        filePath: '/src/com/acme/api/UserController.java',
        language: 'java',
        packageName: 'com.acme.api',
        imports: ['com.acme.shared.User'],
        symbols: [makeSymbol({ name: 'UserController', kind: 'class' })],
      }),
    ]);

    store.ingestModule(mod1);
    store.ingestModule(mod2);

    const { resolveImportEdges } = await import('../../src/graph/resolvers/import-resolver.js');
    resolveImportEdges(store);

    const ctlNodes = store.getNodesByName('UserController');
    const edges = store.getEdgesFrom(ctlNodes[0].id);
    const importEdge = edges.find(e => e.kind === 'imports');
    assert('cross-module: has imports edge', importEdge !== undefined);
    if (importEdge) {
      const target = store.getNodeById(importEdge.target_id);
      assert('cross-module: target is User', target?.name === 'User', `got "${target?.name}"`);
    }

    store.close();
  } finally { cleanup(dbPath); }
}

// ── Inheritance edges ────────────────────────────────────────────────────

async function test_java_extends_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/BaseController.java',
        language: 'java',
        packageName: 'com.acme',
        symbols: [makeSymbol({ name: 'BaseController', kind: 'class' })],
      }),
      makeScannedFile({
        filePath: '/src/UserController.java',
        language: 'java',
        packageName: 'com.acme',
        symbols: [makeSymbol({
          name: 'UserController',
          kind: 'class',
          extends: 'BaseController',
        })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveInheritanceEdges } = await import('../../src/graph/resolvers/inheritance-resolver.js');
    resolveInheritanceEdges(store);

    const ctlNodes = store.getNodesByName('UserController');
    const edges = store.getEdgesFrom(ctlNodes[0].id);
    const extendsEdge = edges.find(e => e.kind === 'extends');
    assert('java-extends: has extends edge', extendsEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    if (extendsEdge) {
      const target = store.getNodeById(extendsEdge.target_id);
      assert('java-extends: target is BaseController', target?.name === 'BaseController', `got "${target?.name}"`);
    }

    store.close();
  } finally { cleanup(dbPath); }
}

async function test_java_implements_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/UserRepository.java',
        language: 'java',
        packageName: 'com.acme',
        symbols: [makeSymbol({ name: 'UserRepository', kind: 'interface' })],
      }),
      makeScannedFile({
        filePath: '/src/UserRepositoryImpl.java',
        language: 'java',
        packageName: 'com.acme',
        symbols: [makeSymbol({
          name: 'UserRepositoryImpl',
          kind: 'class',
          implements: ['UserRepository'],
        })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveInheritanceEdges } = await import('../../src/graph/resolvers/inheritance-resolver.js');
    resolveInheritanceEdges(store);

    const implNodes = store.getNodesByName('UserRepositoryImpl');
    const edges = store.getEdgesFrom(implNodes[0].id);
    const implEdge = edges.find(e => e.kind === 'implements');
    assert('java-implements: has implements edge', implEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    if (implEdge) {
      const target = store.getNodeById(implEdge.target_id);
      assert('java-implements: target is UserRepository', target?.name === 'UserRepository', `got "${target?.name}"`);
    }

    store.close();
  } finally { cleanup(dbPath); }
}

async function test_ts_extends_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/BaseComponent.tsx',
        language: 'typescript',
        symbols: [makeSymbol({ name: 'BaseComponent', kind: 'class' })],
      }),
      makeScannedFile({
        filePath: '/src/UserComponent.tsx',
        language: 'typescript',
        symbols: [makeSymbol({
          name: 'UserComponent',
          kind: 'class',
          extends: 'BaseComponent',
        })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveInheritanceEdges } = await import('../../src/graph/resolvers/inheritance-resolver.js');
    resolveInheritanceEdges(store);

    const ucNodes = store.getNodesByName('UserComponent');
    const edges = store.getEdgesFrom(ucNodes[0].id);
    const extendsEdge = edges.find(e => e.kind === 'extends');
    assert('ts-extends: has extends edge', extendsEdge !== undefined, `edges: ${JSON.stringify(edges)}`);

    store.close();
  } finally { cleanup(dbPath); }
}

// ── Extractor enhancements ───────────────────────────────────────────────

async function test_extractor_captures_extends() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractJavaSymbols } = await import('../../src/source-scanner/java-extractor.js');
  await initParser();

  const source = `
package com.acme;

public class UserController extends BaseController {
    public void getUsers() {}
}
`;
  const tree = await parseSource(source, 'java');
  const result = extractJavaSymbols(tree, source);

  const ctl = result.symbols.find(s => s.name === 'UserController');
  assert('java-ext-extends: captures extends', ctl?.extends === 'BaseController', `got "${ctl?.extends}"`);
}

async function test_extractor_captures_implements() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractJavaSymbols } = await import('../../src/source-scanner/java-extractor.js');
  await initParser();

  const source = `
package com.acme;

public class UserServiceImpl implements UserService, Serializable {
    public void findAll() {}
}
`;
  const tree = await parseSource(source, 'java');
  const result = extractJavaSymbols(tree, source);

  const svc = result.symbols.find(s => s.name === 'UserServiceImpl');
  assert('java-ext-implements: captures implements', Array.isArray(svc?.implements), `got ${typeof svc?.implements}`);
  assert('java-ext-implements: has UserService', svc?.implements?.includes('UserService') === true, `got ${JSON.stringify(svc?.implements)}`);
  assert('java-ext-implements: has Serializable', svc?.implements?.includes('Serializable') === true, `got ${JSON.stringify(svc?.implements)}`);
}

async function test_ts_extractor_captures_extends() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractTypeScriptSymbols } = await import('../../src/source-scanner/typescript-extractor.js');
  await initParser();

  const source = `
export class UserController extends BaseController {
  getUsers() {}
}
`;
  const tree = await parseSource(source, 'typescript');
  const result = extractTypeScriptSymbols(tree, source);

  const ctl = result.symbols.find(s => s.name === 'UserController');
  assert('ts-ext-extends: captures extends', ctl?.extends === 'BaseController', `got "${ctl?.extends}"`);
}

// ── I4: Java wildcard imports ────────────────────────────────────────────

async function test_java_wildcard_import() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/com/acme/Controller.java',
        language: 'java',
        packageName: 'com.acme',
        imports: ['com.acme.services.*'],
        symbols: [makeSymbol({ name: 'Controller', kind: 'class' })],
      }),
      makeScannedFile({
        filePath: '/src/com/acme/services/UserService.java',
        language: 'java',
        packageName: 'com.acme.services',
        symbols: [makeSymbol({ name: 'UserService', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveImportEdges } = await import('../../src/graph/resolvers/import-resolver.js');
    resolveImportEdges(store);

    const ctlNodes = store.getNodesByName('Controller');
    const edges = store.getEdgesFrom(ctlNodes[0].id);
    const importEdge = edges.find(e => e.kind === 'imports');
    assert('wildcard-import: has imports edge', importEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── I9: TS implements edge ───────────────────────────────────────────────

async function test_ts_implements_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/Renderable.ts',
        language: 'typescript',
        symbols: [makeSymbol({ name: 'Renderable', kind: 'interface' })],
      }),
      makeScannedFile({
        filePath: '/src/Widget.ts',
        language: 'typescript',
        symbols: [makeSymbol({
          name: 'Widget',
          kind: 'class',
          implements: ['Renderable'],
        })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveInheritanceEdges } = await import('../../src/graph/resolvers/inheritance-resolver.js');
    resolveInheritanceEdges(store);

    const widgetNodes = store.getNodesByName('Widget');
    const edges = store.getEdgesFrom(widgetNodes[0].id);
    const implEdge = edges.find(e => e.kind === 'implements');
    assert('ts-implements: has implements edge', implEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── I7: TS interface extends ─────────────────────────────────────────────

async function test_ts_interface_extends() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/BaseProps.ts',
        language: 'typescript',
        symbols: [makeSymbol({ name: 'BaseProps', kind: 'interface' })],
      }),
      makeScannedFile({
        filePath: '/src/UserProps.ts',
        language: 'typescript',
        symbols: [makeSymbol({
          name: 'UserProps',
          kind: 'interface',
          extends: 'BaseProps',
        })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveInheritanceEdges } = await import('../../src/graph/resolvers/inheritance-resolver.js');
    resolveInheritanceEdges(store);

    const upNodes = store.getNodesByName('UserProps');
    const edges = store.getEdgesFrom(upNodes[0].id);
    const extendsEdge = edges.find(e => e.kind === 'extends');
    assert('ts-iface-extends: has extends edge', extendsEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── I8: Generic type in extends ──────────────────────────────────────────

async function test_generic_type_extends() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/AbstractController.java',
        language: 'java',
        packageName: 'com.acme',
        symbols: [makeSymbol({ name: 'AbstractController', kind: 'class' })],
      }),
      makeScannedFile({
        filePath: '/src/UserController.java',
        language: 'java',
        packageName: 'com.acme',
        symbols: [makeSymbol({
          name: 'UserController',
          kind: 'class',
          extends: 'AbstractController',
        })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveInheritanceEdges } = await import('../../src/graph/resolvers/inheritance-resolver.js');
    resolveInheritanceEdges(store);

    const ctlNodes = store.getNodesByName('UserController');
    const edges = store.getEdgesFrom(ctlNodes[0].id);
    const extendsEdge = edges.find(e => e.kind === 'extends');
    assert('generic-extends: has extends edge', extendsEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── B1: Call edges ───────────────────────────────────────────────────────

async function test_java_call_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/UserController.java',
        language: 'java',
        packageName: 'com.acme',
        symbols: [makeSymbol({
          name: 'UserController',
          kind: 'class',
          children: [makeSymbol({
            name: 'getUser',
            kind: 'method',
            callSites: [{ target: 'findById', receiver: 'userService' }],
            location: { startLine: 5, endLine: 10 },
          })],
        })],
      }),
      makeScannedFile({
        filePath: '/src/UserService.java',
        language: 'java',
        packageName: 'com.acme',
        symbols: [makeSymbol({
          name: 'UserService',
          kind: 'class',
          children: [makeSymbol({
            name: 'findById',
            kind: 'method',
            location: { startLine: 5, endLine: 10 },
          })],
        })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveCallEdges } = await import('../../src/graph/resolvers/call-resolver.js');
    resolveCallEdges(store);

    const getUser = store.getNodesByName('getUser');
    assert('java-call: getUser found', getUser.length >= 1);
    const edges = store.getEdgesFrom(getUser[0].id);
    const callEdge = edges.find(e => e.kind === 'calls');
    assert('java-call: has calls edge', callEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    if (callEdge) {
      const target = store.getNodeById(callEdge.target_id);
      assert('java-call: target is findById', target?.name === 'findById', `got "${target?.name}"`);
    }
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_ts_call_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/App.tsx',
        language: 'typescript',
        symbols: [makeSymbol({
          name: 'App',
          kind: 'component',
          callSites: [{ target: 'fetchData' }],
        })],
      }),
      makeScannedFile({
        filePath: '/src/api.ts',
        language: 'typescript',
        symbols: [makeSymbol({ name: 'fetchData', kind: 'function' })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveCallEdges } = await import('../../src/graph/resolvers/call-resolver.js');
    resolveCallEdges(store);

    const appNodes = store.getNodesByName('App');
    const edges = store.getEdgesFrom(appNodes[0].id);
    const callEdge = edges.find(e => e.kind === 'calls');
    assert('ts-call: has calls edge', callEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    if (callEdge) {
      const target = store.getNodeById(callEdge.target_id);
      assert('ts-call: target is fetchData', target?.name === 'fetchData', `got "${target?.name}"`);
    }
    store.close();
  } finally { cleanup(dbPath); }
}

// ── B2: React-specific edges ─────────────────────────────────────────────

async function test_jsx_renders_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/App.tsx',
        language: 'typescript',
        symbols: [makeSymbol({
          name: 'App',
          kind: 'component',
          jsxElements: ['UserProfile'],
        })],
      }),
      makeScannedFile({
        filePath: '/src/UserProfile.tsx',
        language: 'typescript',
        symbols: [makeSymbol({ name: 'UserProfile', kind: 'component' })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveReactEdges } = await import('../../src/graph/resolvers/react-resolver.js');
    resolveReactEdges(store);

    const appNodes = store.getNodesByName('App');
    const edges = store.getEdgesFrom(appNodes[0].id);
    const rendersEdge = edges.find(e => e.kind === 'renders');
    assert('jsx-renders: has renders edge', rendersEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    if (rendersEdge) {
      const target = store.getNodeById(rendersEdge.target_id);
      assert('jsx-renders: target is UserProfile', target?.name === 'UserProfile', `got "${target?.name}"`);
    }
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_hook_call_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/App.tsx',
        language: 'typescript',
        symbols: [makeSymbol({
          name: 'App',
          kind: 'component',
          callSites: [{ target: 'useAuth' }],
        })],
      }),
      makeScannedFile({
        filePath: '/src/useAuth.ts',
        language: 'typescript',
        symbols: [makeSymbol({ name: 'useAuth', kind: 'hook' })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveCallEdges } = await import('../../src/graph/resolvers/call-resolver.js');
    resolveCallEdges(store);

    const appNodes = store.getNodesByName('App');
    const edges = store.getEdgesFrom(appNodes[0].id);
    const callEdge = edges.find(e => e.kind === 'calls');
    assert('hook-call: has calls edge', callEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    if (callEdge) {
      const target = store.getNodeById(callEdge.target_id);
      assert('hook-call: target is useAuth', target?.name === 'useAuth', `got "${target?.name}"`);
    }
    store.close();
  } finally { cleanup(dbPath); }
}

// ── I10: Edge deduplication ──────────────────────────────────────────────

async function test_edge_deduplication_on_re_resolve() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/A.java',
        language: 'java',
        packageName: 'com.acme',
        imports: ['com.acme.B'],
        symbols: [makeSymbol({ name: 'A', kind: 'class' })],
      }),
      makeScannedFile({
        filePath: '/src/B.java',
        language: 'java',
        packageName: 'com.acme',
        symbols: [makeSymbol({ name: 'B', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveImportEdges } = await import('../../src/graph/resolvers/import-resolver.js');
    resolveImportEdges(store);
    resolveImportEdges(store); // second time — should NOT duplicate

    const aNodes = store.getNodesByName('A');
    const edges = store.getEdgesFrom(aNodes[0].id);
    const importEdges = edges.filter(e => e.kind === 'imports');
    assert('dedup: exactly 1 imports edge after 2 resolves', importEdges.length === 1, `got ${importEdges.length}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── Extractor: TS implements ─────────────────────────────────────────────

async function test_ts_extractor_captures_implements() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractTypeScriptSymbols } = await import('../../src/source-scanner/typescript-extractor.js');
  await initParser();

  const source = `
export class Widget implements Renderable {
  render() {}
}
`;
  const tree = await parseSource(source, 'typescript');
  const result = extractTypeScriptSymbols(tree, source);

  const widget = result.symbols.find(s => s.name === 'Widget');
  assert('ts-ext-impl: captures implements', Array.isArray(widget?.implements), `got ${typeof widget?.implements}`);
  assert('ts-ext-impl: has Renderable', widget?.implements?.includes('Renderable') === true, `got ${JSON.stringify(widget?.implements)}`);
}

// ── Extractor: TS interface extends ──────────────────────────────────────

async function test_ts_extractor_interface_extends() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractTypeScriptSymbols } = await import('../../src/source-scanner/typescript-extractor.js');
  await initParser();

  const source = `
export interface UserProps extends BaseProps {
  name: string;
}
`;
  const tree = await parseSource(source, 'typescript');
  const result = extractTypeScriptSymbols(tree, source);

  const up = result.symbols.find(s => s.name === 'UserProps');
  assert('ts-iface-ext: captures extends', up?.extends === 'BaseProps', `got "${up?.extends}"`);
}

// ── Extractor: Java generic extends ──────────────────────────────────────

async function test_java_extractor_generic_extends() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractJavaSymbols } = await import('../../src/source-scanner/java-extractor.js');
  await initParser();

  const source = `
package com.acme;

public class UserController extends AbstractController<User> {
    public void getUsers() {}
}
`;
  const tree = await parseSource(source, 'java');
  const result = extractJavaSymbols(tree, source);

  const ctl = result.symbols.find(s => s.name === 'UserController');
  assert('java-generic-ext: captures extends stripping generic', ctl?.extends === 'AbstractController', `got "${ctl?.extends}"`);
}

// ── Extractor: Java call sites ───────────────────────────────────────────

async function test_java_extractor_call_sites() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractJavaSymbols } = await import('../../src/source-scanner/java-extractor.js');
  await initParser();

  const source = `
package com.acme;

public class UserController {
    private UserService userService;

    public void getUser() {
        userService.findById("1");
        doSomething();
    }
}
`;
  const tree = await parseSource(source, 'java');
  const result = extractJavaSymbols(tree, source);

  const ctl = result.symbols.find(s => s.name === 'UserController');
  const getUser = ctl?.children?.find(c => c.name === 'getUser');
  assert('java-calls: getUser has callSites', Array.isArray(getUser?.callSites), `got ${typeof getUser?.callSites}`);
  assert('java-calls: has findById call', getUser?.callSites?.some(c => c.target === 'findById') === true, `got ${JSON.stringify(getUser?.callSites)}`);
}

// ── Extractor: TS call sites + JSX ───────────────────────────────────────

async function test_ts_extractor_call_sites() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractTypeScriptSymbols } = await import('../../src/source-scanner/typescript-extractor.js');
  await initParser();

  const source = `
export function App() {
  const data = fetchData('/api');
  const auth = useAuth();
  return null;
}
`;
  const tree = await parseSource(source, 'typescript');
  const result = extractTypeScriptSymbols(tree, source);

  const app = result.symbols.find(s => s.name === 'App');
  assert('ts-calls: App has callSites', Array.isArray(app?.callSites), `got ${typeof app?.callSites}`);
  assert('ts-calls: has fetchData call', app?.callSites?.some(c => c.target === 'fetchData') === true, `got ${JSON.stringify(app?.callSites)}`);
  assert('ts-calls: has useAuth call', app?.callSites?.some(c => c.target === 'useAuth') === true, `got ${JSON.stringify(app?.callSites)}`);
}

async function test_ts_extractor_jsx_usage() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractTypeScriptSymbols } = await import('../../src/source-scanner/typescript-extractor.js');
  await initParser();

  const source = `
export function App() {
  return <UserProfile user={null} />;
}
`;
  const tree = await parseSource(source, 'tsx');
  const result = extractTypeScriptSymbols(tree, source);

  const app = result.symbols.find(s => s.name === 'App');
  assert('tsx-jsx: App has jsxElements', Array.isArray(app?.jsxElements), `got ${typeof app?.jsxElements}`);
  assert('tsx-jsx: has UserProfile', app?.jsxElements?.includes('UserProfile') === true, `got ${JSON.stringify(app?.jsxElements)}`);
}
