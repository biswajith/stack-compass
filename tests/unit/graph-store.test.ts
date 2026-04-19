import { assert } from '../helpers.js';
import { GraphStore } from '../../src/graph/index.js';
import type { ScannedModule, ScannedFile, ExtractedSymbol } from '../../src/source-scanner/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-test-'));
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

function makeScannedModule(files: ScannedFile[]): ScannedModule {
  return {
    name: 'test-module',
    path: '/fake/path',
    language: 'java',
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

export async function testGraphStore() {
  console.log('\n--- Unit: GraphStore ---');

  await test_should_create_db_with_schema_version();
  await test_should_enable_wal_mode();
  await test_should_insert_and_read_files();
  await test_should_insert_and_read_nodes();
  await test_should_insert_and_read_edges();
  await test_should_cascade_delete_file();
  await test_should_search_nodes_by_name();
  await test_should_search_nodes_by_signature();
  await test_should_rollback_on_error();
  await test_should_rebuild_on_version_mismatch();
  await test_should_be_idempotent_on_reingest();
  await test_should_parse_single_value_annotation();
  await test_should_parse_named_param_annotation();
  await test_should_parse_bare_annotation();
  await test_should_ingest_scanned_module();
  await test_should_close_cleanly();
  await test_should_return_graph_stats();
  // Review fixes
  await test_annotation_name_no_double_at();
  await test_file_hash_sha256();
  await test_fts5_update_trigger();
  await test_upsert_file_update();
  await test_rest_endpoint_ingestion();
  await test_graph_stats_has_last_scan_epoch();
}

// ── 1. DB creation + schema version ──────────────────────────────────────

async function test_should_create_db_with_schema_version() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const version = store.schemaVersion();
    assert('create: schema version is 3', version === 3, `got ${version}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 2. WAL mode ──────────────────────────────────────────────────────────

async function test_should_enable_wal_mode() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mode = store.journalMode();
    assert('wal: journal_mode is wal', mode === 'wal', `got ${mode}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 3. Insert + read files ───────────────────────────────────────────────

async function test_should_insert_and_read_files() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const fileId = store.upsertFile('/src/Foo.java', 'abc123', 'java', 'api');
    assert('files: id is positive', fileId > 0, `got ${fileId}`);

    const file = store.getFileByPath('/src/Foo.java');
    assert('files: found by path', file !== null);
    assert('files: hash matches', file!.hash === 'abc123');
    assert('files: language matches', file!.language === 'java');
    assert('files: module matches', file!.module === 'api');
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 4. Insert + read nodes ───────────────────────────────────────────────

async function test_should_insert_and_read_nodes() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const fileId = store.upsertFile('/src/Foo.java', 'abc', 'java', 'api');
    const nodeId = store.insertNode({
      name: 'Foo',
      qualified: 'com.example.Foo',
      kind: 'class',
      visibility: 'public',
      signature: 'public class Foo',
      docComment: 'A foo class',
      fileId,
      startLine: 1,
      endLine: 50,
      parentId: null,
      module: 'api',
      extendsName: null,
      implementsNames: null,
    });
    assert('nodes: id is positive', nodeId > 0);

    const node = store.getNodeById(nodeId);
    assert('nodes: name matches', node!.name === 'Foo');
    assert('nodes: qualified matches', node!.qualified === 'com.example.Foo');
    assert('nodes: kind matches', node!.kind === 'class');
    assert('nodes: signature matches', node!.signature === 'public class Foo');
    assert('nodes: doc_comment matches', node!.doc_comment === 'A foo class');
    assert('nodes: start_line matches', node!.start_line === 1);
    assert('nodes: end_line matches', node!.end_line === 50);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 5. Insert + read edges ───────────────────────────────────────────────

async function test_should_insert_and_read_edges() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const fileId = store.upsertFile('/src/A.java', 'a', 'java', 'api');
    const n1 = store.insertNode({ name: 'A', kind: 'class', visibility: 'public', fileId, startLine: 1, endLine: 10, parentId: null, module: 'api', qualified: null, signature: null, docComment: null, extendsName: null, implementsNames: null });
    const n2 = store.insertNode({ name: 'B', kind: 'class', visibility: 'public', fileId, startLine: 11, endLine: 20, parentId: null, module: 'api', qualified: null, signature: null, docComment: null, extendsName: null, implementsNames: null });
    store.insertEdge(n1, n2, 'calls', null);

    const edges = store.getEdgesFrom(n1);
    assert('edges: one edge found', edges.length === 1);
    assert('edges: target is B', edges[0].target_id === n2);
    assert('edges: kind is calls', edges[0].kind === 'calls');
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 6. Cascade delete ────────────────────────────────────────────────────

async function test_should_cascade_delete_file() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const fileId = store.upsertFile('/src/Gone.java', 'x', 'java', 'api');
    const n1 = store.insertNode({ name: 'Gone', kind: 'class', visibility: 'public', fileId, startLine: 1, endLine: 5, parentId: null, module: 'api', qualified: null, signature: null, docComment: null, extendsName: null, implementsNames: null });
    const n2 = store.insertNode({ name: 'method', kind: 'method', visibility: 'public', fileId, startLine: 6, endLine: 8, parentId: n1, module: 'api', qualified: null, signature: null, docComment: null, extendsName: null, implementsNames: null });
    store.insertEdge(n1, n2, 'calls', null);

    store.deleteFile(fileId);
    const node = store.getNodeById(n1);
    assert('cascade: node deleted', node === null);
    const edges = store.getEdgesFrom(n1);
    assert('cascade: edges deleted', edges.length === 0);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 7. FTS5 search by name ───────────────────────────────────────────────

async function test_should_search_nodes_by_name() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const fileId = store.upsertFile('/src/Svc.java', 'h', 'java', 'api');
    store.insertNode({ name: 'UserService', kind: 'class', visibility: 'public', fileId, startLine: 1, endLine: 100, parentId: null, module: 'api', qualified: 'com.example.UserService', signature: 'public class UserService', docComment: null, extendsName: null, implementsNames: null });
    store.insertNode({ name: 'OrderService', kind: 'class', visibility: 'public', fileId, startLine: 101, endLine: 200, parentId: null, module: 'api', qualified: 'com.example.OrderService', signature: 'public class OrderService', docComment: null, extendsName: null, implementsNames: null });

    const results = store.searchSymbols('UserService');
    assert('fts name: found 1 result', results.length === 1, `got ${results.length}`);
    assert('fts name: correct name', results[0].name === 'UserService');
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 8. FTS5 search by signature ──────────────────────────────────────────

async function test_should_search_nodes_by_signature() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const fileId = store.upsertFile('/src/Ctl.java', 'h', 'java', 'api');
    store.insertNode({ name: 'createUser', kind: 'method', visibility: 'public', fileId, startLine: 1, endLine: 10, parentId: null, module: 'api', qualified: null, signature: 'public User createUser(CreateUserRequest req)', docComment: null, extendsName: null, implementsNames: null });

    const results = store.searchSymbols('CreateUserRequest');
    assert('fts sig: found via signature', results.length === 1, `got ${results.length}`);
    assert('fts sig: correct method', results[0].name === 'createUser');
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 9. Transaction rollback ──────────────────────────────────────────────

async function test_should_rollback_on_error() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const fileId = store.upsertFile('/src/Safe.java', 's', 'java', 'api');

    let threw = false;
    try {
      store.transaction(() => {
        store.insertNode({ name: 'Temp', kind: 'class', visibility: 'public', fileId, startLine: 1, endLine: 5, parentId: null, module: 'api', qualified: null, signature: null, docComment: null, extendsName: null, implementsNames: null });
        throw new Error('simulated failure');
      });
    } catch { threw = true; }

    assert('rollback: threw error', threw);
    const results = store.searchSymbols('Temp');
    assert('rollback: node not persisted', results.length === 0, `got ${results.length}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 10. Schema version mismatch → rebuild ────────────────────────────────

async function test_should_rebuild_on_version_mismatch() {
  const dbPath = tmpDbPath();
  try {
    // Create a DB with version 999 (future/wrong version)
    const store1 = GraphStore.open(dbPath);
    store1.setSchemaVersion(999);
    const fileId = store1.upsertFile('/old.java', 'old', 'java', 'legacy');
    store1.insertNode({ name: 'OldClass', kind: 'class', visibility: 'public', fileId, startLine: 1, endLine: 5, parentId: null, module: 'legacy', qualified: null, signature: null, docComment: null, extendsName: null, implementsNames: null });
    store1.close();

    // Re-open — should detect mismatch and rebuild
    const store2 = GraphStore.open(dbPath);
    const version = store2.schemaVersion();
    assert('rebuild: version reset to current', version === 3, `got ${version}`);
    const results = store2.searchSymbols('OldClass');
    assert('rebuild: old data gone', results.length === 0, `got ${results.length}`);
    store2.close();
  } finally { cleanup(dbPath); }
}

// ── 11. Idempotent ingestModule ──────────────────────────────────────────

async function test_should_be_idempotent_on_reingest() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeScannedModule([
      makeScannedFile({
        filePath: '/src/com/example/Foo.java',
        language: 'java',
        symbols: [
          makeSymbol({ name: 'Foo', kind: 'class', children: [
            makeSymbol({ name: 'bar', kind: 'method', location: { startLine: 5, endLine: 10 } }),
          ]}),
        ],
        packageName: 'com.example',
        imports: [],
      }),
    ]);

    store.ingestModule(mod);
    store.ingestModule(mod); // second time — should not duplicate

    const stats = store.getStats();
    assert('idempotent: 1 file', stats.totalFiles === 1, `got ${stats.totalFiles}`);
    // Foo (class) + bar (method) = 2 nodes
    assert('idempotent: 2 nodes', stats.totalNodes === 2, `got ${stats.totalNodes}`);

    const results = store.searchSymbols('Foo', { kind: 'class' });
    assert('idempotent: exactly one Foo class', results.length === 1, `got ${results.length}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 12. Annotation parsing: single value ─────────────────────────────────

async function test_should_parse_single_value_annotation() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeScannedModule([
      makeScannedFile({
        filePath: '/src/Ctl.java',
        symbols: [
          makeSymbol({
            name: 'getUsers',
            kind: 'method',
            annotations: ['@GetMapping("/api/users")'],
          }),
        ],
      }),
    ]);
    store.ingestModule(mod);

    const nodes = store.searchSymbols('getUsers');
    assert('ann single: found node', nodes.length === 1);
    const annotations = store.getAnnotations(nodes[0].id);
    assert('ann single: one annotation', annotations.length === 1, `got ${annotations.length}`);
    assert('ann single: name is GetMapping', annotations[0].name === 'GetMapping', `got "${annotations[0].name}"`);
    assert('ann single: value is /api/users', annotations[0].value === '/api/users', `got ${annotations[0].value}`);
    assert('ann single: raw preserved', annotations[0].raw === '@GetMapping("/api/users")');
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 13. Annotation parsing: named parameters ─────────────────────────────

async function test_should_parse_named_param_annotation() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeScannedModule([
      makeScannedFile({
        filePath: '/src/Resolver.java',
        symbols: [
          makeSymbol({
            name: 'getUsers',
            kind: 'method',
            annotations: ['@DgsData(parentType = "Query", field = "users")'],
          }),
        ],
      }),
    ]);
    store.ingestModule(mod);

    const nodes = store.searchSymbols('getUsers');
    const annotations = store.getAnnotations(nodes[0].id);
    assert('ann named: name is DgsData', annotations[0].name === 'DgsData', `got "${annotations[0].name}"`);
    assert('ann named: value is users (field param)', annotations[0].value === 'users', `got ${annotations[0].value}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 14. Annotation parsing: bare annotation ──────────────────────────────

async function test_should_parse_bare_annotation() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeScannedModule([
      makeScannedFile({
        filePath: '/src/Svc.java',
        symbols: [
          makeSymbol({
            name: 'doWork',
            kind: 'method',
            annotations: ['@Override'],
          }),
        ],
      }),
    ]);
    store.ingestModule(mod);

    const nodes = store.searchSymbols('doWork');
    const annotations = store.getAnnotations(nodes[0].id);
    assert('ann bare: name is Override', annotations[0].name === 'Override', `got "${annotations[0].name}"`);
    assert('ann bare: value is null', annotations[0].value === null);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 15. Full ingestModule ────────────────────────────────────────────────

async function test_should_ingest_scanned_module() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeScannedModule([
      makeScannedFile({
        filePath: '/src/com/example/UserController.java',
        language: 'java',
        packageName: 'com.example',
        imports: ['com.example.UserService'],
        symbols: [
          makeSymbol({
            name: 'UserController',
            kind: 'class',
            annotations: ['@RestController', '@RequestMapping("/api/users")'],
            children: [
              makeSymbol({
                name: 'getUsers',
                kind: 'method',
                signature: 'public List<User> getUsers()',
                annotations: ['@GetMapping'],
                location: { startLine: 10, endLine: 15 },
              }),
              makeSymbol({
                name: 'createUser',
                kind: 'method',
                signature: 'public User createUser(CreateUserRequest req)',
                annotations: ['@PostMapping'],
                location: { startLine: 17, endLine: 25 },
              }),
            ],
          }),
        ],
      }),
      makeScannedFile({
        filePath: '/src/com/example/UserService.java',
        language: 'java',
        packageName: 'com.example',
        symbols: [
          makeSymbol({
            name: 'UserService',
            kind: 'class',
            annotations: ['@Service'],
            docComment: 'Handles user business logic',
          }),
        ],
      }),
    ]);

    store.ingestModule(mod);
    const stats = store.getStats();
    assert('ingest: 2 files', stats.totalFiles === 2, `got ${stats.totalFiles}`);
    // UserController + getUsers + createUser + UserService = 4
    assert('ingest: 4 nodes', stats.totalNodes === 4, `got ${stats.totalNodes}`);

    // Verify the class has children linked via parent_id
    const controllers = store.searchSymbols('UserController', { kind: 'class' });
    assert('ingest: found controller', controllers.length === 1, `got ${controllers.length}`);
    const children = store.getChildNodes(controllers[0].id);
    assert('ingest: 2 children', children.length === 2, `got ${children.length}`);

    // Verify annotations
    const controllerAnns = store.getAnnotations(controllers[0].id);
    assert('ingest: controller has 2 annotations', controllerAnns.length === 2, `got ${controllerAnns.length}`);

    // FTS finds UserService by doc_comment
    const byDoc = store.searchSymbols('business logic');
    assert('ingest: fts finds by doc_comment', byDoc.length === 1);
    assert('ingest: fts doc result is UserService', byDoc[0].name === 'UserService');
    store.close();
  } finally { cleanup(dbPath); }
}

// ── 16. Close is safe ────────────────────────────────────────────────────

async function test_should_close_cleanly() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    store.upsertFile('/src/X.java', 'x', 'java', 'api');
    store.close();

    // Re-open after close
    const store2 = GraphStore.open(dbPath);
    const file = store2.getFileByPath('/src/X.java');
    assert('close: data persisted after close+reopen', file !== null);
    store2.close();
  } finally { cleanup(dbPath); }
}

// ── 17. Graph stats ──────────────────────────────────────────────────────

async function test_should_return_graph_stats() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const f1 = store.upsertFile('/a.java', 'a', 'java', 'api');
    const f2 = store.upsertFile('/b.java', 'b', 'java', 'api');
    const n1 = store.insertNode({ name: 'A', kind: 'class', visibility: 'public', fileId: f1, startLine: 1, endLine: 10, parentId: null, module: 'api', qualified: null, signature: null, docComment: null, extendsName: null, implementsNames: null });
    const n2 = store.insertNode({ name: 'B', kind: 'class', visibility: 'public', fileId: f2, startLine: 1, endLine: 10, parentId: null, module: 'api', qualified: null, signature: null, docComment: null, extendsName: null, implementsNames: null });
    store.insertEdge(n1, n2, 'calls', null);

    const stats = store.getStats();
    assert('stats: 2 files', stats.totalFiles === 2, `got ${stats.totalFiles}`);
    assert('stats: 2 nodes', stats.totalNodes === 2, `got ${stats.totalNodes}`);
    assert('stats: 1 edge', stats.totalEdges === 1, `got ${stats.totalEdges}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── B1: Annotation name should not have double @ ─────────────────────────

async function test_annotation_name_no_double_at() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeScannedModule([
      makeScannedFile({
        filePath: '/src/Ctl.java',
        symbols: [
          makeSymbol({
            name: 'getUsers',
            kind: 'method',
            annotations: ['@GetMapping("/api/users")'],
          }),
        ],
      }),
    ]);
    store.ingestModule(mod);

    const nodes = store.searchSymbols('getUsers');
    const annotations = store.getAnnotations(nodes[0].id);
    // Name should be stored WITHOUT the @ prefix so display code can add it once
    assert('ann-no-double-at: name has no @ prefix', !annotations[0].name.startsWith('@'), `got "${annotations[0].name}"`);
    assert('ann-no-double-at: name is GetMapping', annotations[0].name === 'GetMapping', `got "${annotations[0].name}"`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ── B2: File hash should be SHA-256 of file contents ─────────────────────

async function test_file_hash_sha256() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-test-'));
  const dbPath = path.join(tmpDir, 'graph.db');
  const javaFile = path.join(tmpDir, 'Foo.java');

  try {
    // Write a real file so SHA-256 can be computed
    fs.writeFileSync(javaFile, 'public class Foo { void bar() {} }');

    const store = GraphStore.open(dbPath);
    const mod = makeScannedModule([
      makeScannedFile({
        filePath: javaFile,
        symbols: [makeSymbol({ name: 'Foo', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    const file = store.getFileByPath(javaFile);
    assert('sha256: hash looks like hex sha256', file !== null && /^[0-9a-f]{64}$/.test(file!.hash), `got "${file?.hash}"`);

    // Ingest again — same content — should be skipped (same hash)
    store.ingestModule(mod);
    const stats = store.getStats();
    assert('sha256: idempotent (1 file)', stats.totalFiles === 1, `got ${stats.totalFiles}`);

    // Change file content but keep same symbols
    fs.writeFileSync(javaFile, 'public class Foo { void bar() { return; } }');
    store.ingestModule(mod);
    const file2 = store.getFileByPath(javaFile);
    assert('sha256: hash changed after file edit', file2!.hash !== file!.hash, 'hash should differ');

    store.close();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

// ── I6: FTS5 update trigger fires on ON CONFLICT DO UPDATE ───────────────

async function test_fts5_update_trigger() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const fileId = store.upsertFile('/src/Svc.java', 'h', 'java', 'api');

    // Insert a node with one signature
    store.insertNode({
      name: 'doWork', qualified: null, kind: 'method', visibility: 'public',
      signature: 'public void doWork()', docComment: null,
      fileId, startLine: 1, endLine: 10, parentId: null, module: 'api',
      extendsName: null, implementsNames: null,
    });

    // Verify FTS finds old signature
    const before = store.searchSymbols('doWork');
    assert('fts-update: found before', before.length === 1);

    // ON CONFLICT DO UPDATE with a new signature
    store.insertNode({
      name: 'doWork', qualified: null, kind: 'method', visibility: 'public',
      signature: 'public String doWork(Request req)', docComment: null,
      fileId, startLine: 1, endLine: 10, parentId: null, module: 'api',
      extendsName: null, implementsNames: null,
    });

    // FTS should find the new signature term "Request"
    const afterNew = store.searchSymbols('Request');
    assert('fts-update: finds new signature term', afterNew.length === 1, `got ${afterNew.length}`);
    assert('fts-update: correct node', afterNew[0].name === 'doWork');

    store.close();
  } finally { cleanup(dbPath); }
}

// ── I7: upsertFile updates hash instead of duplicating ───────────────────

async function test_upsert_file_update() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const id1 = store.upsertFile('/src/Foo.java', 'hash-v1', 'java', 'api');
    const id2 = store.upsertFile('/src/Foo.java', 'hash-v2', 'java', 'api');

    const stats = store.getStats();
    assert('upsert-file: still 1 file', stats.totalFiles === 1, `got ${stats.totalFiles}`);

    const file = store.getFileByPath('/src/Foo.java');
    assert('upsert-file: hash updated', file!.hash === 'hash-v2', `got "${file!.hash}"`);
    assert('upsert-file: same id', id1 === id2 || file!.id === id1, 'file id should be stable');

    store.close();
  } finally { cleanup(dbPath); }
}

// ── I3: REST endpoint ingestion during ingestModule ──────────────────────

async function test_rest_endpoint_ingestion() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);
    const mod = makeScannedModule([
      makeScannedFile({
        filePath: '/src/Ctl.java',
        symbols: [
          makeSymbol({
            name: 'UserController',
            kind: 'class',
            annotations: ['@RestController', '@RequestMapping("/api/users")'],
            children: [
              makeSymbol({
                name: 'getUser',
                kind: 'method',
                annotations: ['@GetMapping("/{id}")'],
                location: { startLine: 5, endLine: 10 },
              }),
              makeSymbol({
                name: 'createUser',
                kind: 'method',
                annotations: ['@PostMapping'],
                location: { startLine: 12, endLine: 18 },
              }),
            ],
          }),
        ],
      }),
    ]);
    store.ingestModule(mod);

    // getUser should have a GET endpoint
    const getNodes = store.getNodesByName('getUser');
    assert('rest-ingest: getUser exists', getNodes.length === 1);
    const getEndpoints = store.getRestEndpointsByNodeId(getNodes[0].id);
    assert('rest-ingest: getUser has endpoint', getEndpoints.length === 1, `got ${getEndpoints.length}`);
    if (getEndpoints.length > 0) {
      assert('rest-ingest: method is GET', getEndpoints[0].method === 'GET', `got "${getEndpoints[0].method}"`);
      assert('rest-ingest: path is /{id}', getEndpoints[0].path === '/{id}', `got "${getEndpoints[0].path}"`);
    }

    // createUser should have a POST endpoint
    const postNodes = store.getNodesByName('createUser');
    const postEndpoints = store.getRestEndpointsByNodeId(postNodes[0].id);
    assert('rest-ingest: createUser has endpoint', postEndpoints.length === 1, `got ${postEndpoints.length}`);
    if (postEndpoints.length > 0) {
      assert('rest-ingest: method is POST', postEndpoints[0].method === 'POST', `got "${postEndpoints[0].method}"`);
    }

    store.close();
  } finally { cleanup(dbPath); }
}

// ── I12: getStats includes lastScanEpoch ─────────────────────────────────

async function test_graph_stats_has_last_scan_epoch() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Empty DB — lastScanEpoch should be null
    const emptyStats = store.getStats();
    assert('stats-epoch: null when empty', emptyStats.lastScanEpoch === null);

    store.upsertFile('/a.java', 'a', 'java', 'api');
    const stats = store.getStats();
    assert('stats-epoch: not null after insert', stats.lastScanEpoch !== null);
    // Should be a recent epoch (within last 60 seconds)
    const now = Math.floor(Date.now() / 1000);
    assert('stats-epoch: recent', Math.abs(now - stats.lastScanEpoch!) < 60, `epoch ${stats.lastScanEpoch} vs now ${now}`);

    store.close();
  } finally { cleanup(dbPath); }
}
