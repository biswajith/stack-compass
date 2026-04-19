import { assert } from '../helpers.js';
import { GraphStore } from '../../src/graph/index.js';
import type { ScannedModule, ScannedFile, ExtractedSymbol } from '../../src/source-scanner/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
}

function cleanup(dir: string) {
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

export async function testIncrementalSync() {
  console.log('\n--- Unit: Incremental Sync (Phase 4) ---');

  await test_unchanged_file_skipped();
  await test_changed_file_reingested();
  await test_deleted_file_cascade();
  await test_selective_edge_resolution();
  await test_incremental_sync_class();
  await test_graph_status_stale_count();
}

// ── Test 1: Unchanged file skipped ──────────────────────────────────────

async function test_unchanged_file_skipped() {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'graph.db');

  try {
    // Write a real file on disk so SHA-256 hash is computed from content
    const javaFile = path.join(dir, 'Foo.java');
    fs.writeFileSync(javaFile, 'public class Foo { void bar() {} }');

    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: javaFile,
        symbols: [makeSymbol({ name: 'Foo', kind: 'class' })],
      }),
    ]);

    // First ingest
    store.ingestModule(mod);
    const stats1 = store.getStats();
    assert('skip: initial ingest has 1 node', stats1.totalNodes === 1, `got ${stats1.totalNodes}`);

    // Second ingest with same content — should skip
    store.ingestModule(mod);
    const stats2 = store.getStats();
    assert('skip: re-ingest same content still 1 node', stats2.totalNodes === 1, `got ${stats2.totalNodes}`);

    // Verify no duplicate files
    const files = store.getAllFiles();
    assert('skip: still 1 file', files.length === 1, `got ${files.length}`);

    store.close();
  } finally { cleanup(dir); }
}

// ── Test 2: Changed file re-ingested ────────────────────────────────────

async function test_changed_file_reingested() {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'graph.db');

  try {
    const javaFile = path.join(dir, 'Svc.java');
    fs.writeFileSync(javaFile, 'public class Svc { void doWork() {} }');

    const store = GraphStore.open(dbPath);

    // First ingest
    const mod1 = makeModule('api', [
      makeScannedFile({
        filePath: javaFile,
        symbols: [makeSymbol({
          name: 'Svc', kind: 'class',
          children: [makeSymbol({ name: 'doWork', kind: 'method', location: { startLine: 1, endLine: 3 } })],
        })],
      }),
    ]);
    store.ingestModule(mod1);

    const nodesBefore = store.getNodesByName('doWork');
    assert('changed: doWork exists initially', nodesBefore.length === 1);

    // Change file content
    fs.writeFileSync(javaFile, 'public class Svc { void doWork() {} void newMethod() {} }');

    // Re-ingest with updated symbols
    const mod2 = makeModule('api', [
      makeScannedFile({
        filePath: javaFile,
        symbols: [makeSymbol({
          name: 'Svc', kind: 'class',
          children: [
            makeSymbol({ name: 'doWork', kind: 'method', location: { startLine: 1, endLine: 3 } }),
            makeSymbol({ name: 'newMethod', kind: 'method', location: { startLine: 4, endLine: 6 } }),
          ],
        })],
      }),
    ]);
    store.ingestModule(mod2);

    const newMethodNodes = store.getNodesByName('newMethod');
    assert('changed: newMethod exists after re-ingest', newMethodNodes.length === 1, `got ${newMethodNodes.length}`);

    // Still only 1 file
    const files = store.getAllFiles();
    assert('changed: still 1 file', files.length === 1, `got ${files.length}`);

    store.close();
  } finally { cleanup(dir); }
}

// ── Test 3: Deleted file cascade ────────────────────────────────────────

async function test_deleted_file_cascade() {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'graph.db');

  try {
    const javaFile = path.join(dir, 'Gone.java');
    fs.writeFileSync(javaFile, 'public class Gone {}');

    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: javaFile,
        symbols: [makeSymbol({ name: 'Gone', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    assert('del: Gone exists', store.getNodesByName('Gone').length === 1);

    // Use IncrementalSync to detect deletion and remove
    const { IncrementalSync } = await import('../../src/graph/sync.js');
    const sync = new IncrementalSync(store);
    // Delete file from disk
    fs.unlinkSync(javaFile);
    sync.removeDeletedFiles();

    assert('del: Gone removed after cascade', store.getNodesByName('Gone').length === 0, `got ${store.getNodesByName('Gone').length}`);
    assert('del: file removed', store.getAllFiles().length === 0, `got ${store.getAllFiles().length}`);

    store.close();
  } finally { cleanup(dir); }
}

// ── Test 4: Selective edge resolution ───────────────────────────────────

async function test_selective_edge_resolution() {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'graph.db');

  try {
    const fileA = path.join(dir, 'A.java');
    const fileB = path.join(dir, 'B.java');
    fs.writeFileSync(fileA, 'class A extends B {}');
    fs.writeFileSync(fileB, 'class B {}');

    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: fileA,
        symbols: [makeSymbol({ name: 'A', kind: 'class', extends: 'B' })],
      }),
      makeScannedFile({
        filePath: fileB,
        symbols: [makeSymbol({ name: 'B', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    // Verify initial edge exists
    const aNode = store.getNodesByName('A');
    const edgesBefore = store.getEdgesFrom(aNode[0].id);
    assert('sel-edge: A→B edge exists', edgesBefore.some(e => e.kind === 'extends'), `edges: ${JSON.stringify(edgesBefore)}`);

    // Change file A's content
    fs.writeFileSync(fileA, 'class A extends C {}');

    // Re-ingest only changed file
    const { IncrementalSync } = await import('../../src/graph/sync.js');
    const sync = new IncrementalSync(store);
    const changed = sync.detectChangedFiles();

    assert('sel-edge: detects A.java changed', changed.some(f => f.endsWith('A.java')), `changed: ${JSON.stringify(changed)}`);

    store.close();
  } finally { cleanup(dir); }
}

// ── Test 5: IncrementalSync class ───────────────────────────────────────

async function test_incremental_sync_class() {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'graph.db');

  try {
    const javaFile = path.join(dir, 'Svc.java');
    fs.writeFileSync(javaFile, 'public class Svc {}');

    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: javaFile,
        symbols: [makeSymbol({ name: 'Svc', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    const { IncrementalSync } = await import('../../src/graph/sync.js');
    const sync = new IncrementalSync(store);

    // Initially no changes
    const noChanges = sync.detectChangedFiles();
    assert('sync-class: no changes initially', noChanges.length === 0, `got ${noChanges.length}`);

    // Modify file
    fs.writeFileSync(javaFile, 'public class Svc { int x; }');
    const changes = sync.detectChangedFiles();
    assert('sync-class: detects change', changes.length === 1, `got ${changes.length}`);

    // Delete file
    fs.unlinkSync(javaFile);
    const deleted = sync.detectDeletedFiles();
    assert('sync-class: detects deletion', deleted.length === 1, `got ${deleted.length}`);

    store.close();
  } finally { cleanup(dir); }
}

// ── Test 6: graph-status stale count ────────────────────────────────────

async function test_graph_status_stale_count() {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'graph.db');

  try {
    const javaFile = path.join(dir, 'Stale.java');
    fs.writeFileSync(javaFile, 'public class Stale {}');

    const store = GraphStore.open(dbPath);
    const mod = makeModule('api', [
      makeScannedFile({
        filePath: javaFile,
        symbols: [makeSymbol({ name: 'Stale', kind: 'class' })],
      }),
    ]);
    store.ingestModule(mod);

    // Initially no stale files
    const { IncrementalSync } = await import('../../src/graph/sync.js');
    const sync = new IncrementalSync(store);
    assert('stale: 0 initially', sync.getStaleFileCount() === 0, `got ${sync.getStaleFileCount()}`);

    // Modify file — now stale
    fs.writeFileSync(javaFile, 'public class Stale { int x; }');
    assert('stale: 1 after modification', sync.getStaleFileCount() === 1, `got ${sync.getStaleFileCount()}`);

    store.close();
  } finally { cleanup(dir); }
}

export async function testFileWatcher() {
  console.log('\n--- Unit: File Watcher (Phase 4) ---');

  await test_watcher_extension_filter();
  await test_watcher_debounce();
  await test_watcher_recursive_watch();
}

// ── Test 7: Watcher extension filter ────────────────────────────────────

async function test_watcher_extension_filter() {
  const { FileWatcher } = await import('../../src/graph/watcher.js');

  const accepted: string[] = [];
  const rejected: string[] = [];

  const testFiles = [
    'Foo.java', 'bar.ts', 'baz.tsx', 'app.js', 'Main.scala', 'schema.graphql',
    'readme.md', 'data.json', 'config.yml', 'image.png', '.gitignore',
  ];

  for (const f of testFiles) {
    if (FileWatcher.isWatchableExtension(f)) {
      accepted.push(f);
    } else {
      rejected.push(f);
    }
  }

  assert('ext-filter: java accepted', accepted.includes('Foo.java'));
  assert('ext-filter: ts accepted', accepted.includes('bar.ts'));
  assert('ext-filter: tsx accepted', accepted.includes('baz.tsx'));
  assert('ext-filter: js accepted', accepted.includes('app.js'));
  assert('ext-filter: scala accepted', accepted.includes('Main.scala'));
  assert('ext-filter: graphql accepted', accepted.includes('schema.graphql'));
  assert('ext-filter: md rejected', rejected.includes('readme.md'));
  assert('ext-filter: json rejected', rejected.includes('data.json'));
  assert('ext-filter: yml rejected', rejected.includes('config.yml'));
}

// ── Test 8: Watcher debounce ────────────────────────────────────────────

async function test_watcher_debounce() {
  const { FileWatcher } = await import('../../src/graph/watcher.js');

  let callbackCount = 0;
  const watcher = new FileWatcher({
    debounceMs: 100, // shorter for test
    onChange: (_files: string[]) => { callbackCount++; },
  });

  // Simulate rapid file changes
  watcher.enqueueChange('/src/Foo.java');
  watcher.enqueueChange('/src/Bar.java');
  watcher.enqueueChange('/src/Foo.java'); // duplicate

  // Wait for debounce to fire
  await new Promise(resolve => setTimeout(resolve, 200));

  assert('debounce: callback fired once', callbackCount === 1, `got ${callbackCount}`);

  watcher.stop();
}

// ── Test 9: Watcher recursive watch ─────────────────────────────────────

async function test_watcher_recursive_watch() {
  const dir = tmpDir();

  try {
    // Create nested directory structure
    const subDir = path.join(dir, 'src', 'main');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'App.java'), 'class App {}');

    const { FileWatcher } = await import('../../src/graph/watcher.js');
    const changedFiles: string[] = [];

    const watcher = new FileWatcher({
      debounceMs: 100,
      onChange: (files: string[]) => { changedFiles.push(...files); },
    });

    watcher.watchDirectory(dir);

    // Create a new file in the nested directory
    fs.writeFileSync(path.join(subDir, 'New.java'), 'class New {}');

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 300));

    assert('recursive: detected change in subdirectory', changedFiles.some(f => f.includes('New.java')),
      `changed: ${JSON.stringify(changedFiles)}`);

    watcher.stop();
  } finally { cleanup(dir); }
}
