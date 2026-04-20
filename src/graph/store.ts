import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ScannedModule, ScannedFile, ExtractedSymbol } from '../source-scanner/types.js';

const CURRENT_SCHEMA_VERSION = 5;

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
  extends_name: string | null;
  implements_names: string | null;
  gql_operation_type: string | null;
  gql_fields: string | null;
  api_method: string | null;
  api_path: string | null;
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
  extendsName: string | null;
  implementsNames: string | null;
  gqlOperationType: string | null;
  gqlFields: string | null;
  apiMethod: string | null;
  apiPath: string | null;
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

  // Array value: @RequestMapping(value = {"/api/v1", "/api/v2"})
  const arrayMatch = paramsStr.match(/\{\s*"([^"]*)"(?:\s*,\s*"[^"]*")*\s*\}/);
  if (arrayMatch) {
    return { name, value: arrayMatch[1] };
  }

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

const GQL_ANNOTATION_MAP: Record<string, { defaultParentType: string; operationType: string }> = {
  DgsQuery:        { defaultParentType: 'Query',    operationType: 'query' },
  DgsMutation:     { defaultParentType: 'Mutation',  operationType: 'mutation' },
  QueryMapping:    { defaultParentType: 'Query',    operationType: 'query' },
  MutationMapping: { defaultParentType: 'Mutation',  operationType: 'mutation' },
  DgsData:         { defaultParentType: 'Query',    operationType: 'query' },
  SchemaMapping:   { defaultParentType: 'Query',    operationType: 'query' },
};

function extractGqlResolver(
  annotationName: string,
  value: string | null,
  methodName: string,
): { fieldName: string; parentType: string; operationType: string } | null {
  const config = GQL_ANNOTATION_MAP[annotationName];
  if (!config) return null;

  let fieldName = methodName;
  let parentType = config.defaultParentType;
  let operationType = config.operationType;

  if (value) {
    const fieldMatch = value.match(/field\s*=\s*["']?([^"',)]+)/);
    if (fieldMatch) fieldName = fieldMatch[1].trim();

    const parentMatch = value.match(/(?:parentType|typeName)\s*=\s*["']?([^"',)]+)/);
    if (parentMatch) {
      parentType = parentMatch[1].trim();
      if (parentType === 'Mutation') operationType = 'mutation';
      else if (parentType === 'Subscription') operationType = 'subscription';
    }
  }

  return { fieldName, parentType, operationType };
}

function serializeSymbolForHash(s: ExtractedSymbol): string {
  let part = `${s.name}:${s.kind}:${s.visibility}:${s.location.startLine}-${s.location.endLine}:${s.signature ?? ''}:${s.docComment ?? ''}:${(s.annotations ?? []).join(',')}:${s.extends ?? ''}:${(s.implements ?? []).join(',')}:${(s.callSites ?? []).map(c => c.target).join(',')}:${(s.jsxElements ?? []).join(',')}:${s.gqlOperationType ?? ''}:${(s.gqlFields ?? []).join(',')}:${s.apiMethod ?? ''}:${s.apiPath ?? ''}`;
  if (s.children && s.children.length > 0) {
    part += ':children=[' + s.children.map(serializeSymbolForHash).join(',') + ']';
  }
  return part;
}

function sanitizeFtsQuery(raw: string): string {
  // Strip FTS5 operators to prevent syntax errors and injection
  const cleaned = raw.replace(/[*:"^(){}[\]]/g, ' ').trim();
  if (!cleaned) return '';
  // Wrap each token in double quotes to force literal matching
  const tokens = cleaned.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map(t => `"${t}"`).join(' ');
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
    this.db.prepare(`
      INSERT INTO files (path, hash, language, module)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, language=excluded.language,
        module=excluded.module, scanned_at=unixepoch()
    `).run(filePath, hash, language, module);
    const row = this.db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number };
    return row.id;
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

  insertFileImport(fileId: number, importPath: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO file_imports (file_id, import_path) VALUES (?, ?)'
    ).run(fileId, importPath);
  }

  getFileImports(fileId: number): string[] {
    return (this.db.prepare('SELECT import_path FROM file_imports WHERE file_id = ?').all(fileId) as Array<{ import_path: string }>)
      .map(r => r.import_path);
  }

  getAllFiles(): FileRow[] {
    return this.db.prepare('SELECT * FROM files').all() as FileRow[];
  }

  getTopLevelNodesByFileId(fileId: number): NodeRow[] {
    return this.db.prepare('SELECT * FROM nodes WHERE file_id = ? AND parent_id IS NULL').all(fileId) as NodeRow[];
  }

  /** @deprecated Use getTopLevelNodesByFileId for top-level or getAllNodesByFileId for all */
  getNodesByFileId(fileId: number): NodeRow[] {
    return this.getTopLevelNodesByFileId(fileId);
  }

  getAllNodesByFileId(fileId: number): NodeRow[] {
    return this.db.prepare('SELECT * FROM nodes WHERE file_id = ?').all(fileId) as NodeRow[];
  }

  // ── Nodes ────────────────────────────────────────────────────────────

  insertNode(n: NodeInsert): number {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (name, qualified, kind, visibility, signature, doc_comment,
                         file_id, start_line, end_line, parent_id, module,
                         extends_name, implements_names,
                         gql_operation_type, gql_fields, api_method, api_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id, name, kind, start_line) DO UPDATE SET
        qualified=excluded.qualified, visibility=excluded.visibility,
        signature=excluded.signature, doc_comment=excluded.doc_comment,
        end_line=excluded.end_line, parent_id=excluded.parent_id, module=excluded.module,
        extends_name=excluded.extends_name, implements_names=excluded.implements_names,
        gql_operation_type=excluded.gql_operation_type, gql_fields=excluded.gql_fields,
        api_method=excluded.api_method, api_path=excluded.api_path
    `);
    stmt.run(
      n.name, n.qualified, n.kind, n.visibility, n.signature, n.docComment,
      n.fileId, n.startLine, n.endLine, n.parentId, n.module,
      n.extendsName, n.implementsNames,
      n.gqlOperationType, n.gqlFields, n.apiMethod, n.apiPath,
    );
    const row = this.db.prepare(
      'SELECT id FROM nodes WHERE file_id = ? AND name = ? AND kind = ? AND start_line = ?'
    ).get(n.fileId, n.name, n.kind, n.startLine) as { id: number };
    return row.id;
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

  getNodesByNameSuffix(suffix: string): NodeRow[] {
    const escaped = suffix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    return this.db.prepare(
      "SELECT * FROM nodes WHERE name LIKE ? ESCAPE '\\' AND kind IN ('class', 'interface', 'component')"
    ).all(`%${escaped}`) as NodeRow[];
  }

  getAllRestEndpoints(): Array<{ node_id: number; method: string; path: string }> {
    return this.db.prepare('SELECT node_id, method, path FROM rest_endpoints').all() as Array<{ node_id: number; method: string; path: string }>;
  }

  getClassesWithImplements(): NodeRow[] {
    return this.db.prepare(
      "SELECT * FROM nodes WHERE kind = 'class' AND implements_names IS NOT NULL"
    ).all() as NodeRow[];
  }

  getRestEndpointsByNodeId(nodeId: number): Array<{ method: string; path: string }> {
    return this.db.prepare(
      'SELECT method, path FROM rest_endpoints WHERE node_id = ?'
    ).all(nodeId) as Array<{ method: string; path: string }>;
  }

  // ── Call sites ──────────────────────────────────────────────────────

  insertCallSite(nodeId: number, target: string, receiver: string | null): void {
    this.db.prepare(
      'INSERT INTO call_sites (node_id, target, receiver) VALUES (?, ?, ?)'
    ).run(nodeId, target, receiver);
  }

  getCallSites(nodeId: number): Array<{ target: string; receiver: string | null }> {
    return this.db.prepare(
      'SELECT target, receiver FROM call_sites WHERE node_id = ?'
    ).all(nodeId) as Array<{ target: string; receiver: string | null }>;
  }

  // ── JSX usages ────────────────────────────────────────────────────

  insertJsxUsage(nodeId: number, elementName: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO jsx_usages (node_id, element_name) VALUES (?, ?)'
    ).run(nodeId, elementName);
  }

  getJsxUsages(nodeId: number): string[] {
    const rows = this.db.prepare(
      'SELECT element_name FROM jsx_usages WHERE node_id = ?'
    ).all(nodeId) as Array<{ element_name: string }>;
    return rows.map(r => r.element_name);
  }

  // ── REST endpoints ────────────────────────────────────────────────

  insertRestEndpoint(nodeId: number, method: string, endpointPath: string, fileId: number): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO rest_endpoints (node_id, method, path, file_id) VALUES (?, ?, ?, ?)'
    ).run(nodeId, method, endpointPath, fileId);
  }

  // ── GraphQL resolvers ──────────────────────────────────────────────

  insertGqlResolver(nodeId: number, operationType: string, fieldName: string, parentType: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO graphql_resolvers (node_id, operation_type, field_name, parent_type) VALUES (?, ?, ?, ?)'
    ).run(nodeId, operationType, fieldName, parentType);
  }

  getGqlResolvers(): Array<{ node_id: number; operation_type: string; field_name: string; parent_type: string }> {
    return this.db.prepare('SELECT * FROM graphql_resolvers').all() as Array<{ node_id: number; operation_type: string; field_name: string; parent_type: string }>;
  }

  // ── GraphQL operations ────────────────────────────────────────────

  insertGqlOperation(nodeId: number, operationType: string, fields: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO graphql_operations (node_id, operation_type, fields) VALUES (?, ?, ?)'
    ).run(nodeId, operationType, fields);
  }

  getGqlOperations(): Array<{ node_id: number; operation_type: string; fields: string }> {
    return this.db.prepare('SELECT * FROM graphql_operations').all() as Array<{ node_id: number; operation_type: string; fields: string }>;
  }

  // ── API calls ─────────────────────────────────────────────────────

  getApiCalls(): Array<{ node_id: number; method: string | null; path: string | null }> {
    return this.db.prepare(
      "SELECT n.id AS node_id, n.api_method AS method, n.api_path AS path FROM nodes n WHERE n.kind = 'api-call'"
    ).all() as Array<{ node_id: number; method: string | null; path: string | null }>;
  }

  // ── FTS5 Search ──────────────────────────────────────────────────────

  searchSymbols(query: string, opts?: { kind?: string; module?: string; limit?: number; rawFts?: boolean }): SearchResult[] {
    const sanitized = opts?.rawFts ? query : sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const limit = opts?.limit ?? 20;
    let sql = `
      SELECT n.id, n.name, n.qualified, n.kind, n.file_id, f.path AS file_path,
             n.start_line, n.module, n.signature
      FROM nodes_fts fts
      JOIN nodes n ON n.id = fts.rowid
      LEFT JOIN files f ON f.id = n.file_id
      WHERE nodes_fts MATCH ?
    `;
    const params: (string | number)[] = [sanitized];

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

    if (file.imports) {
      for (const imp of file.imports) {
        this.insertFileImport(fileId, imp);
      }
    }

    for (const sym of file.symbols) {
      this.ingestSymbol(sym, fileId, null, moduleName, file.packageName, '');
    }
  }

  private extractClassRestPrefix(sym: ExtractedSymbol): string {
    if (!sym.annotations) return '';
    for (const raw of sym.annotations) {
      const parsed = parseAnnotation(raw);
      if (parsed.name === 'RequestMapping' && parsed.value) {
        return parsed.value.replace(/\/$/, '');
      }
    }
    return '';
  }

  private ingestSymbol(
    sym: ExtractedSymbol,
    fileId: number,
    parentId: number | null,
    moduleName: string,
    packageName?: string,
    classRestPrefix: string = '',
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
      extendsName: sym.extends ?? null,
      implementsNames: sym.implements ? JSON.stringify(sym.implements) : null,
      gqlOperationType: sym.gqlOperationType ?? null,
      gqlFields: sym.gqlFields ? JSON.stringify(sym.gqlFields) : null,
      apiMethod: sym.apiMethod ?? null,
      apiPath: sym.apiPath ?? null,
    });

    // Populate graphql_operations table for gql-operation nodes
    if (sym.kind === 'gql-operation' && sym.gqlOperationType && sym.gqlFields) {
      this.insertGqlOperation(nodeId, sym.gqlOperationType, JSON.stringify(sym.gqlFields));
    }

    if (sym.annotations) {
      for (const raw of sym.annotations) {
        const parsed = parseAnnotation(raw);
        this.insertAnnotation(nodeId, parsed.name, parsed.value, raw);

        const restInfo = extractRestEndpoint(parsed.name, parsed.value);
        if (restInfo && sym.kind !== 'class' && sym.kind !== 'interface') {
          const fullPath = classRestPrefix + restInfo.path;
          this.insertRestEndpoint(nodeId, restInfo.method, fullPath, fileId);
        }

        const gqlInfo = extractGqlResolver(parsed.name, parsed.value, sym.name);
        if (gqlInfo) {
          this.insertGqlResolver(nodeId, gqlInfo.operationType, gqlInfo.fieldName, gqlInfo.parentType);
        }
      }
    }

    if (sym.callSites) {
      for (const cs of sym.callSites) {
        this.insertCallSite(nodeId, cs.target, cs.receiver ?? null);
      }
    }

    if (sym.jsxElements) {
      for (const el of sym.jsxElements) {
        this.insertJsxUsage(nodeId, el);
      }
    }

    if (sym.children) {
      const childPrefix = sym.kind === 'class' ? this.extractClassRestPrefix(sym) : classRestPrefix;
      for (const child of sym.children) {
        this.ingestSymbol(child, fileId, nodeId, moduleName, packageName, childPrefix);
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

    const fileRow = this.db.prepare('SELECT path FROM files WHERE id = ?').get(fileId) as { path: string } | undefined;
    if (fileRow?.path) return `${fileRow.path}#${sym.name}`;

    return null;
  }

  private computeFileHash(file: ScannedFile): string {
    try {
      const content = fs.readFileSync(file.filePath, 'utf-8');
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch {
      // File not on disk (e.g. synthetic test data) — fall back to structural hash
      const parts = file.symbols.map(s => serializeSymbolForHash(s));
      parts.push(file.filePath);
      return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
    }
  }
}
