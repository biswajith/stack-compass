import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ScannedModule, ScannedFile, ExtractedSymbol } from '../source-scanner/types.js';

const CURRENT_SCHEMA_VERSION = 1;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// ── Types ────────────────────────────────────────────────────────────────

export interface FileRow {
  id: number;
  path: string;
  hash: string;
  language: string;
  module: string | null;
  scanned_at: number;
}

export interface NodeRow {
  id: number;
  name: string;
  qualified: string | null;
  kind: string;
  visibility: string;
  signature: string | null;
  doc_comment: string | null;
  file_id: number;
  start_line: number;
  end_line: number;
  parent_id: number | null;
  module: string | null;
}

export interface EdgeRow {
  source_id: number;
  target_id: number;
  kind: string;
  metadata: string | null;
}

export interface AnnotationRow {
  id: number;
  node_id: number;
  name: string;
  value: string | null;
  raw: string | null;
}

export interface NodeInsert {
  name: string;
  qualified: string | null;
  kind: string;
  visibility: string;
  signature: string | null;
  docComment: string | null;
  fileId: number;
  startLine: number;
  endLine: number;
  parentId: number | null;
  module: string | null;
}

export interface GraphStats {
  totalFiles: number;
  totalNodes: number;
  totalEdges: number;
  lastScanEpoch: number | null;
}

export interface SearchResult {
  id: number;
  name: string;
  qualified: string | null;
  kind: string;
  file_id: number;
  file_path: string | null;
  start_line: number;
  module: string | null;
  signature: string | null;
}

// ── Annotation parsing ───────────────────────────────────────────────────

const PRIMARY_VALUE_PARAMS = new Set(['value', 'path', 'field', 'name']);

export function parseAnnotation(raw: string): { name: string; value: string | null } {
  const parenIdx = raw.indexOf('(');
  if (parenIdx === -1) {
    return { name: raw.trim().replace(/^@/, ''), value: null };
  }

  const name = raw.substring(0, parenIdx).trim().replace(/^@/, '');
  const paramsStr = raw.substring(parenIdx + 1, raw.lastIndexOf(')'));

  // Single unnamed string value: @GetMapping("/api/users")
  const singleMatch = paramsStr.match(/^\s*"([^"]*)"(?:\s*,\s*"[^"]*")*\s*$/);
  if (singleMatch) {
    return { name, value: singleMatch[1] };
  }

  // Named parameters: @DgsData(parentType = "Query", field = "users")
  const paramRegex = /(\w+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  let primaryValue: string | null = null;
  let firstValue: string | null = null;

  while ((match = paramRegex.exec(paramsStr)) !== null) {
    const [, key, val] = match;
    if (firstValue === null) firstValue = val;
    if (PRIMARY_VALUE_PARAMS.has(key)) {
      primaryValue = val;
    }
  }

  return { name, value: primaryValue ?? firstValue };
}

// ── REST endpoint extraction ─────────────────────────────────────────────

const REST_ANNOTATION_MAP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: 'ANY',
};

function extractRestEndpoint(annotationName: string, value: string | null): { method: string; path: string } | null {
  const method = REST_ANNOTATION_MAP[annotationName];
  if (!method) return null;
  return { method, path: value ?? '/' };
}

// ── GraphStore ───────────────────────────────────────────────────────────

export class GraphStore {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(dbPath: string): GraphStore {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const version = db.pragma('user_version', { simple: true }) as number;

    if (version === 0) {
      // Fresh DB — run full schema
      const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
      db.exec(schema);
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    } else if (version !== CURRENT_SCHEMA_VERSION) {
      // Version mismatch — rebuild
      db.close();
      fs.unlinkSync(dbPath);
      // Remove WAL/SHM files if present
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ok */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ok */ }

      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
      db.exec(schema);
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    }

    return new GraphStore(db);
  }

  close(): void {
    this.db.close();
  }

  // ── Diagnostics ──────────────────────────────────────────────────────

  schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  /** Exposed for tests only — forces a schema version to simulate mismatch */
  setSchemaVersion(v: number): void {
    this.db.pragma(`user_version = ${v}`);
  }

  journalMode(): string {
    return (this.db.pragma('journal_mode', { simple: true }) as string).toLowerCase();
  }

  getStats(): GraphStats {
    const files = (this.db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
    const nodes = (this.db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    const edges = (this.db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
    const lastScan = (this.db.prepare('SELECT MAX(scanned_at) as t FROM files').get() as { t: number | null }).t;
    return { totalFiles: files, totalNodes: nodes, totalEdges: edges, lastScanEpoch: lastScan };
  }

  // ── Transactions ─────────────────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── Files ────────────────────────────────────────────────────────────

  upsertFile(filePath: string, hash: string, language: string, module: string | null): number {
    const stmt = this.db.prepare(`
      INSERT INTO files (path, hash, language, module)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, language=excluded.language,
        module=excluded.module, scanned_at=unixepoch()
    `);
    const result = stmt.run(filePath, hash, language, module);
    if (result.changes > 0 && result.lastInsertRowid) {
      return Number(result.lastInsertRowid);
    }
    // ON CONFLICT UPDATE doesn't always return lastInsertRowid, so look it up
    const row = this.db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number } | undefined;
    return row!.id;
  }

  getFileByPath(filePath: string): FileRow | null {
    return (this.db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as FileRow) ?? null;
  }

  getFileById(fileId: number): FileRow | null {
    return (this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow) ?? null;
  }

  deleteFile(fileId: number): void {
    this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  }

  // ── Nodes ────────────────────────────────────────────────────────────

  insertNode(n: NodeInsert): number {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (name, qualified, kind, visibility, signature, doc_comment,
                         file_id, start_line, end_line, parent_id, module)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id, name, kind, start_line) DO UPDATE SET
        qualified=excluded.qualified, visibility=excluded.visibility,
        signature=excluded.signature, doc_comment=excluded.doc_comment,
        end_line=excluded.end_line, parent_id=excluded.parent_id, module=excluded.module
    `);
    const result = stmt.run(
      n.name, n.qualified, n.kind, n.visibility, n.signature, n.docComment,
      n.fileId, n.startLine, n.endLine, n.parentId, n.module,
    );
    if (result.changes > 0 && result.lastInsertRowid) {
      return Number(result.lastInsertRowid);
    }
    const row = this.db.prepare(
      'SELECT id FROM nodes WHERE file_id = ? AND name = ? AND kind = ? AND start_line = ?'
    ).get(n.fileId, n.name, n.kind, n.startLine) as { id: number } | undefined;
    return row!.id;
  }

  getNodeById(id: number): NodeRow | null {
    return (this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow) ?? null;
  }

  getChildNodes(parentId: number): NodeRow[] {
    return this.db.prepare('SELECT * FROM nodes WHERE parent_id = ?').all(parentId) as NodeRow[];
  }

  // ── Edges ────────────────────────────────────────────────────────────

  insertEdge(sourceId: number, targetId: number, kind: string, metadata: string | null): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO edges (source_id, target_id, kind, metadata) VALUES (?, ?, ?, ?)
    `).run(sourceId, targetId, kind, metadata);
  }

  getEdgesFrom(sourceId: number): EdgeRow[] {
    return this.db.prepare('SELECT * FROM edges WHERE source_id = ?').all(sourceId) as EdgeRow[];
  }

  getEdgesTo(targetId: number): EdgeRow[] {
    return this.db.prepare('SELECT * FROM edges WHERE target_id = ?').all(targetId) as EdgeRow[];
  }

  // ── Annotations ──────────────────────────────────────────────────────

  insertAnnotation(nodeId: number, name: string, value: string | null, raw: string | null): void {
    this.db.prepare(
      'INSERT INTO annotations (node_id, name, value, raw) VALUES (?, ?, ?, ?)'
    ).run(nodeId, name, value, raw);
  }

  getAnnotations(nodeId: number): AnnotationRow[] {
    return this.db.prepare('SELECT * FROM annotations WHERE node_id = ?').all(nodeId) as AnnotationRow[];
  }

  // ── Node lookups ────────────────────────────────────────────────────

  getNodesByName(name: string, opts?: { kind?: string; module?: string }): NodeRow[] {
    let sql = 'SELECT * FROM nodes WHERE name = ?';
    const params: unknown[] = [name];
    if (opts?.kind) { sql += ' AND kind = ?'; params.push(opts.kind); }
    if (opts?.module) { sql += ' AND module = ?'; params.push(opts.module); }
    return this.db.prepare(sql).all(...params) as NodeRow[];
  }

  getRestEndpointsByNodeId(nodeId: number): Array<{ method: string; path: string }> {
    return this.db.prepare(
      'SELECT method, path FROM rest_endpoints WHERE node_id = ?'
    ).all(nodeId) as Array<{ method: string; path: string }>;
  }

  insertRestEndpoint(nodeId: number, method: string, endpointPath: string, fileId: number): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO rest_endpoints (node_id, method, path, file_id) VALUES (?, ?, ?, ?)'
    ).run(nodeId, method, endpointPath, fileId);
  }

  // ── FTS5 Search ──────────────────────────────────────────────────────

  searchSymbols(query: string, opts?: { kind?: string; module?: string; limit?: number }): SearchResult[] {
    const limit = opts?.limit ?? 20;
    let sql = `
      SELECT n.id, n.name, n.qualified, n.kind, n.file_id, f.path AS file_path,
             n.start_line, n.module, n.signature
      FROM nodes_fts fts
      JOIN nodes n ON n.id = fts.rowid
      LEFT JOIN files f ON f.id = n.file_id
      WHERE nodes_fts MATCH ?
    `;
    const params: (string | number)[] = [query];

    if (opts?.kind) {
      sql += ' AND n.kind = ?';
      params.push(opts.kind);
    }
    if (opts?.module) {
      sql += ' AND n.module = ?';
      params.push(opts.module);
    }
    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params) as SearchResult[];
  }

  // ── Module ingestion ─────────────────────────────────────────────────

  ingestModule(mod: ScannedModule): void {
    this.transaction(() => {
      for (const file of mod.files) {
        this.ingestFile(file, mod.name);
      }
    });
  }

  private ingestFile(file: ScannedFile, moduleName: string): void {
    const hash = this.computeFileHash(file);
    const existing = this.getFileByPath(file.filePath);

    if (existing && existing.hash === hash) {
      return; // unchanged — skip
    }

    if (existing) {
      // File changed — delete old data (cascade takes care of nodes/edges).
      // KNOWN ISSUE (Phase 2A): This destroys inbound cross-file edges pointing
      // to nodes in this file. Edge resolution must be re-run for dependents.
      this.deleteFile(existing.id);
    }

    const fileId = this.upsertFile(file.filePath, hash, file.language, moduleName);

    for (const sym of file.symbols) {
      this.ingestSymbol(sym, fileId, null, moduleName, file.packageName);
    }
  }

  private ingestSymbol(
    sym: ExtractedSymbol,
    fileId: number,
    parentId: number | null,
    moduleName: string,
    packageName?: string,
  ): void {
    const qualified = this.buildQualifiedName(sym, packageName, parentId, fileId);

    const nodeId = this.insertNode({
      name: sym.name,
      qualified,
      kind: sym.kind,
      visibility: sym.visibility,
      signature: sym.signature ?? null,
      docComment: sym.docComment ?? null,
      fileId,
      startLine: sym.location.startLine,
      endLine: sym.location.endLine,
      parentId,
      module: moduleName,
    });

    if (sym.annotations) {
      for (const raw of sym.annotations) {
        const parsed = parseAnnotation(raw);
        this.insertAnnotation(nodeId, parsed.name, parsed.value, raw);

        const restInfo = extractRestEndpoint(parsed.name, parsed.value);
        if (restInfo) {
          this.insertRestEndpoint(nodeId, restInfo.method, restInfo.path, fileId);
        }
      }
    }

    if (sym.children) {
      for (const child of sym.children) {
        this.ingestSymbol(child, fileId, nodeId, moduleName, packageName);
      }
    }
  }

  private buildQualifiedName(
    sym: ExtractedSymbol,
    packageName: string | undefined,
    parentId: number | null,
    fileId: number,
  ): string | null {
    if (packageName) {
      // Java-style: package.ClassName or package.ClassName.methodName
      if (parentId !== null) {
        const parent = this.getNodeById(parentId);
        if (parent?.qualified) return `${parent.qualified}.${sym.name}`;
      }
      return `${packageName}.${sym.name}`;
    }

    // TS/GQL: use relative file path + symbol name
    if (parentId !== null) {
      const parent = this.getNodeById(parentId);
      if (parent?.qualified) return `${parent.qualified}.${sym.name}`;
    }

    const file = this.getFileByPath(
      (this.db.prepare('SELECT path FROM files WHERE id = ?').get(fileId) as { path: string })?.path ?? ''
    );
    if (file) return `${file.path}#${sym.name}`;

    return null;
  }

  private computeFileHash(file: ScannedFile): string {
    try {
      const content = fs.readFileSync(file.filePath, 'utf-8');
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch {
      // File not on disk (e.g. synthetic test data) — fall back to structural hash
      const parts = file.symbols.map(s =>
        `${s.name}:${s.kind}:${s.visibility}:${s.location.startLine}-${s.location.endLine}:${s.signature ?? ''}:${s.docComment ?? ''}:${(s.annotations ?? []).join(',')}`
      );
      parts.push(file.filePath);
      return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
    }
  }
}
