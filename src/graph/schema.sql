-- Stack Compass Knowledge Graph Schema (v1)
-- PRAGMAs are set programmatically in GraphStore.open()

-- Indexed source files
CREATE TABLE IF NOT EXISTS files (
  id        INTEGER PRIMARY KEY,
  path      TEXT NOT NULL UNIQUE,
  hash      TEXT NOT NULL,
  language  TEXT NOT NULL,
  module    TEXT,
  scanned_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Symbol nodes (functions, classes, methods, components, etc.)
CREATE TABLE IF NOT EXISTS nodes (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  qualified   TEXT,
  kind        TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'public',
  signature   TEXT,
  doc_comment TEXT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  parent_id   INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  module      TEXT,
  UNIQUE(file_id, name, kind, start_line)
);

-- Edges between nodes
CREATE TABLE IF NOT EXISTS edges (
  source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  metadata  TEXT,
  PRIMARY KEY (source_id, target_id, kind)
);

-- Annotation storage (surrogate PK allows repeating annotation names)
CREATE TABLE IF NOT EXISTS annotations (
  id      INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  value   TEXT,
  raw     TEXT
);

-- REST endpoints (denormalized for fast cross-language matching)
CREATE TABLE IF NOT EXISTS rest_endpoints (
  node_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  method    TEXT NOT NULL,
  path      TEXT NOT NULL,
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, method, path)
);

-- GraphQL resolver mappings (Java/Kotlin methods that resolve schema fields)
-- NOTE: Populated in Phase 2B — cross-language edge resolution
CREATE TABLE IF NOT EXISTS graphql_resolvers (
  node_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  field_name     TEXT NOT NULL,
  parent_type    TEXT NOT NULL DEFAULT 'Query',
  PRIMARY KEY (node_id, field_name, parent_type)
);

-- GraphQL operations used in frontend code (extracted from gql`` literals)
-- NOTE: Populated in Phase 2B — cross-language edge resolution
CREATE TABLE IF NOT EXISTS graphql_operations (
  node_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  fields         TEXT NOT NULL,
  PRIMARY KEY (node_id)
);

-- Full-text search on symbol names and signatures
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, qualified, signature, doc_comment,
  content=nodes, content_rowid=id
);

-- FTS5 content-sync triggers (content= tables do NOT auto-sync)
CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, qualified, signature, doc_comment)
  VALUES (new.id, new.name, new.qualified, new.signature, new.doc_comment);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_delete AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified, signature, doc_comment)
  VALUES ('delete', old.id, old.name, old.qualified, old.signature, old.doc_comment);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_update AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified, signature, doc_comment)
  VALUES ('delete', old.id, old.name, old.qualified, old.signature, old.doc_comment);
  INSERT INTO nodes_fts(rowid, name, qualified, signature, doc_comment)
  VALUES (new.id, new.name, new.qualified, new.signature, new.doc_comment);
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_id);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified ON nodes(qualified);
CREATE INDEX IF NOT EXISTS idx_nodes_module_name ON nodes(module, name);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_annotations_node ON annotations(node_id);
CREATE INDEX IF NOT EXISTS idx_annotations_name ON annotations(name);
CREATE INDEX IF NOT EXISTS idx_rest_path ON rest_endpoints(path);
CREATE INDEX IF NOT EXISTS idx_gql_field ON graphql_resolvers(field_name);
CREATE INDEX IF NOT EXISTS idx_gql_parent ON graphql_resolvers(parent_type, field_name);
