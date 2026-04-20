# Plan: Code Knowledge Graph Enhancement for Stack Compass

## Context

When an AI agent explores a codebase, it spawns file-scanning operations — grep, glob, read — consuming tokens on every tool call. A pre-indexed knowledge graph gives agents instant access to symbol relationships, call graphs, and code structure, eliminating redundant scanning.

Stack Compass already has the hard infrastructure for this — Tree-sitter AST parsing across Java, TypeScript, Scala, and GraphQL, plus build-file parsers for pom.xml, package.json, build.gradle, and build.sbt. The missing piece is **persistence and relationship resolution**: today Stack Compass extracts symbols and formats them as disposable markdown. This plan adds a SQLite graph layer that persists symbols, connects them with edges, and exposes graph-query MCP tools.

## Why this is an enhancement (not a separate project)

1. **Parsing infrastructure already exists.** Tree-sitter WASM, language-specific extractors, build-file parsers — all built. A separate project would duplicate this work. Adding a graph layer reuses everything.
2. **The features are complementary.** Stack Compass currently answers "what frameworks and APIs exist?" The graph layer adds "how do symbols relate to each other?" One project answering both is more useful than two projects each answering one.
3. **One MCP server, one config.** Users already configure Stack Compass for their mono-repo. A separate graph server means double the config, double the context window overhead, and the user has to know which to ask.
4. **Natural data flow.** `scan-internal-source` already extracts `ExtractedSymbol[]` with kind, visibility, annotations, location, children, and `ScannedFile` with imports. Today these get formatted to markdown and discarded. The graph layer persists them and adds edges — a storage change, not a conceptual one.

## Cross-language capability assessment

Cross-language linking doesn't require type-system-level resolution. The frameworks in a typical mono-repo (Spring, React, GraphQL, DGS) enforce **naming conventions** that act as stable join keys across languages. The key insight: operation names, URL paths, and type names are strings that appear identically in all three layers. We match on those strings.

### What the extractors already capture today

| Extractor | Already extracts | Missing |
|---|---|---|
| **Java** (`java-extractor.ts`) | `@GetMapping("/api/users")` → `RestEndpoint { method, path, handler }` (method-level only — see caveat below). Raw annotation strings including `@DgsQuery`, `@QueryMapping` as unstructured text. Method names, class names, imports, package names | Call sites (`method_invocation` nodes). `@Autowired` field type resolution. Class-level `@RequestMapping` prefix composition. Structured annotation parameter parsing (current: stores `@DgsData(parentType = "Query", field = "users")` as one string, not as name/value pairs) |
| **TypeScript** (`typescript-extractor.ts`) | Exported functions, classes, interfaces, components (capitalized names), hooks (`use*`), imports | `gql` tagged template literal contents. `useQuery()`/`useMutation()` call arguments. `fetch()`/`axios` call arguments |
| **GraphQL** (`graphql-extractor.ts`) | `type Query { users: [User!]! }` → `{ name: "users", kind: "query" }`. All types, inputs, enums, mutations, subscriptions with field-level detail | No `imports` field (returns `{ symbols }` only). Fragment definitions and spreads not tracked |

**Caveat — REST endpoint paths are incomplete:** The current `extractRestEndpoint` in `java-extractor.ts` only reads method-level annotations. It does not compose class-level `@RequestMapping("/api/v1")` with method-level `@GetMapping("/users")`. The resulting path is `/users` instead of `/api/v1/users`. This must be fixed in Phase 2d before REST matching can work reliably.

### The three cross-language join patterns

**Pattern 1: React → GraphQL schema (operation name match)**

```
React:    useQuery(GET_USERS)  →  gql`query GetUsers { users { ... } }`
                                                        ─────
GraphQL:  type Query { users: [User!]! }                  │
                       ─────  ◄────────────────────────────┘
```

Join key: the GraphQL field name `"users"` appears in both the `gql` literal in TypeScript and the `type Query` block in the `.graphql` schema file. The GraphQL extractor already captures `{ name: "users", kind: "query" }`. We need to add extraction of `gql` template literals from TypeScript to get the other side.

**Pattern 2: GraphQL schema → Java resolver (method name = field name)**

```
GraphQL:  type Query { users: [User!]! }
                       ─────
Java:     @DgsQuery                        │
          public List<User> users() { }    │
                            ─────  ◄───────┘
```

Join key: DGS and Spring GraphQL both resolve `@DgsQuery` / `@QueryMapping` methods by matching the **method name** to the **schema query field name**. This is not a heuristic — it's how the frameworks work. The Java extractor already captures the method name and `@DgsQuery` annotation. The GraphQL extractor already captures the query field name. The join is a string equality check.

**Pattern 3: React → Spring REST endpoint (URL path match)**

```
React:    fetch("/api/users")  or  axios.get("/api/users")
                ────────────
Spring:   @GetMapping("/api/users")     │
                      ────────────  ◄───┘
          public List<User> getUsers() { }
```

Join key: the URL path `"/api/users"`. The Java extractor already produces `RestEndpoint { method: "GET", path: "/api/users", handler: "UserController.getUsers" }`. We need to add extraction of `fetch()` and `axios` call arguments from TypeScript.

### Complete chain: React → GraphQL → Spring → Database

With all three patterns combined, a single `get-impact` query on a Java entity can trace the full chain:

```
UserList.tsx            →  useQuery(GET_USERS)          (TS: gql literal)
                              │
                              ▼  operation name: "users"
schema.graphql          →  type Query { users: [User!]! }  (GQL: query field)
                              │
                              ▼  method name: "users"
UserResolver.java       →  @DgsQuery List<User> users()    (Java: resolver)
                              │
                              ▼  calls
UserService.java        →  userService.findAll()            (Java: service)
                              │
                              ▼  calls
UserRepository.java     →  userRepository.findAll()         (Java: repository)
```

Every hop is a string match on data we either already extract or can extract with small additions.

### Full feasibility table

| Relationship | Feasibility | Join key | Extraction status |
|---|---|---|---|
| Java → Java (calls, extends, implements) | **Buildable** | Import path + symbol name | Symbols extracted; need call site extraction |
| TS/React → TS/React (imports, JSX, hooks) | **Buildable** | Import path + symbol name | Symbols extracted; need call site extraction |
| React `useQuery` → GraphQL schema query | **Buildable** | Operation/field name string | GQL side done; need `gql` literal extraction in TS |
| GraphQL schema → Java DGS/Spring resolver | **Buildable** | Query field name = method name | Both sides already extracted |
| React `fetch`/`axios` → Spring REST endpoint | **Buildable** | URL path string | Java side done; need `fetch`/`axios` extraction in TS |
| Spring `@Autowired` → `@Service` impl | **Buildable** | Interface type name | Annotations extracted; need type matching |
| React component props → TS interface | **Buildable** | Type name (same language) | Both sides extracted |
| GraphQL type → Java entity class | **Buildable** | Type name string: GQL `User` = Java `User` | Both sides extracted |
| Google ADK agent → tool → service | **Exploratory** | ADK-specific patterns, still evolving | Needs new extractors |
| Event-driven (Kafka/WebSocket) | **Not feasible** | Runtime connections invisible to static analysis | N/A |

---

## Phase 1: SQLite Graph Storage Layer

**Goal:** Persist the symbols Stack Compass already extracts into a queryable graph database.

**New dependency:** `better-sqlite3` must be added to `dependencies` in `package.json` (it is NOT currently present). Also add `@types/better-sqlite3` to `devDependencies`. It compiles SQLite with `SQLITE_ENABLE_FTS5` by default, which is required for the `search-symbols` and `build-context` tools. `node-sqlite3-wasm` was considered but **does not support FTS5**. The tradeoff is that `better-sqlite3` requires native compilation — this is acceptable since Stack Compass already depends on Tree-sitter WASM grammars that have native build steps. For CI environments (Alpine Docker, ARM), prebuild binaries are available via `prebuild-install`.

### Schema

```sql
-- Indexed source files
CREATE TABLE files (
  id        INTEGER PRIMARY KEY,
  path      TEXT NOT NULL UNIQUE,
  hash      TEXT NOT NULL,
  language  TEXT NOT NULL,
  module    TEXT,
  scanned_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Symbol nodes (functions, classes, methods, components, etc.)
CREATE TABLE nodes (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  qualified   TEXT,              -- e.g. "com.company.UserService.createUser"
  kind        TEXT NOT NULL,     -- matches existing SymbolKind type
  visibility  TEXT NOT NULL DEFAULT 'public',
  signature   TEXT,
  doc_comment TEXT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  parent_id   INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  module      TEXT,
  UNIQUE(file_id, name, kind, start_line)  -- enables idempotent re-ingestion via ON CONFLICT
);

-- Edges between nodes
CREATE TABLE edges (
  source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,      -- 'calls', 'imports', 'extends', 'implements',
                                -- 'uses', 'annotated_by', 'rest_match', 'renders',
                                -- 'gql_resolves', 'type_match', 'injects'
  metadata  TEXT,               -- JSON, e.g. {"url": "/api/users"} for rest_match
  PRIMARY KEY (source_id, target_id, kind)
);

-- Annotation storage (many-to-many, allows repeating annotation names)
CREATE TABLE annotations (
  id      INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,        -- e.g. "@GetMapping"
  value   TEXT,                 -- e.g. "/api/users" (parsed from raw annotation text)
  raw     TEXT                  -- original annotation text, e.g. '@GetMapping("/api/users")'
);

-- REST endpoints (denormalized for fast cross-language matching)
CREATE TABLE rest_endpoints (
  node_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  method    TEXT NOT NULL,      -- GET, POST, PUT, DELETE, *
  path      TEXT NOT NULL,
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, method, path)
);

-- GraphQL resolver mappings (Java/Kotlin methods that resolve schema fields)
CREATE TABLE graphql_resolvers (
  node_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,   -- 'query', 'mutation', 'subscription', 'field'
  field_name     TEXT NOT NULL,   -- the schema field this resolver handles
  parent_type    TEXT NOT NULL DEFAULT 'Query',  -- e.g. "Query", "User" for nested resolvers
  PRIMARY KEY (node_id, field_name, parent_type)
);

-- GraphQL operations used in frontend code (extracted from gql`` literals)
CREATE TABLE graphql_operations (
  node_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,   -- 'query', 'mutation', 'subscription'
  fields         TEXT NOT NULL,   -- JSON array of top-level field names, e.g. '["users","posts"]'
  PRIMARY KEY (node_id)
);

-- Full-text search on symbol names and signatures
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  name, qualified, signature, doc_comment,
  content=nodes, content_rowid=id
);

-- FTS5 content-sync triggers (required — content= tables do NOT auto-sync)
CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, qualified, signature, doc_comment)
  VALUES (new.id, new.name, new.qualified, new.signature, new.doc_comment);
END;

CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified, signature, doc_comment)
  VALUES ('delete', old.id, old.name, old.qualified, old.signature, old.doc_comment);
END;

CREATE TRIGGER nodes_fts_update AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified, signature, doc_comment)
  VALUES ('delete', old.id, old.name, old.qualified, old.signature, old.doc_comment);
  INSERT INTO nodes_fts(rowid, name, qualified, signature, doc_comment)
  VALUES (new.id, new.name, new.qualified, new.signature, new.doc_comment);
END;

CREATE INDEX idx_nodes_file ON nodes(file_id);
CREATE INDEX idx_nodes_kind ON nodes(kind);
CREATE INDEX idx_nodes_name ON nodes(name);
CREATE INDEX idx_nodes_qualified ON nodes(qualified);
CREATE INDEX idx_nodes_module_name ON nodes(module, name);
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);
CREATE INDEX idx_edges_kind ON edges(kind);
CREATE INDEX idx_annotations_node ON annotations(node_id);
CREATE INDEX idx_annotations_name ON annotations(name);
CREATE INDEX idx_rest_path ON rest_endpoints(path);
CREATE INDEX idx_gql_field ON graphql_resolvers(field_name);
CREATE INDEX idx_gql_parent ON graphql_resolvers(parent_type, field_name);
```

### Implementation

- New directory: `src/graph/`
  - `store.ts` — `GraphStore` class wrapping SQLite: open/close, migrations, CRUD for nodes/edges/files
  - `schema.sql` — the schema above
  - `queries.ts` — prepared statements for search, callers, callees, impact traversal
  - `index.ts` — re-exports
- Database location: `.stack-compass/graph.db` in the project root (alongside the existing `~/.stack-compass/cache/` for docs)
- Wire into existing `scan-internal-source` flow: after Tree-sitter extraction produces `ScannedModule`, persist to SQLite via `GraphStore`
- Existing `ScannedModule` in-memory storage continues working — the graph is additive

**Note on `rest_endpoints.file_id`:** The current `extractRestEndpoint` in `java-extractor.ts` returns `file: ''` (empty string) because the extractor has no file path context. Graph ingestion must NOT use `RestEndpoint.file` for `file_id`. Instead, `GraphStore.ingestModule()` resolves `file_id` from the enclosing `ScannedFile.filePath` — which is always available since the module iterates over `ScannedFile[]`. REST endpoints are associated with their handler node's `file_id`, not a separately stored path.

### Changes to existing code

- `source-scan-tools.ts`: after `ctx.sourceScanner.scanModule()`, call `ctx.graphStore.ingestModule(scannedModule)` to persist
- `server/context.ts`: add `graphStore: GraphStore` to `ServerContext`
- `server/index.ts`: initialize `GraphStore` in `createServer()`

### Database lifecycle and migration strategy

- **Creation:** `GraphStore.open(dbPath)` creates the DB and runs `schema.sql` if the file doesn't exist. Use `PRAGMA user_version` to track schema version.
- **Migration:** On open, check `PRAGMA user_version`. If it's behind the current code version, run migration SQL scripts sequentially (`migrations/002.sql`, `003.sql`, etc.). For early development (Phase 1-3), the simpler approach is acceptable: if the schema version doesn't match, delete and rebuild the DB — the source code is the authority, and re-indexing takes seconds.
- **WAL mode:** Enable `PRAGMA journal_mode=WAL` on open for concurrent read safety (the MCP server reads while file watcher writes).
- **Transaction boundaries:** All writes from a single `scanModule` call go in one transaction. If it fails mid-write, the transaction rolls back and the file is left unindexed (not partially indexed).
- **Locking:** If two MCP server instances target the same project, SQLite's built-in locking handles contention. WAL mode allows concurrent readers with a single writer.
- **Cleanup:** `GraphStore.close()` called on MCP server shutdown. If the process crashes, WAL recovery happens automatically on next open.

### Annotation parameter parsing

The current extractors store annotations as raw text strings (e.g., `@DgsData(parentType = "Query", field = "users")`). The graph ingestion step must parse these into structured `(name, value, raw)` tuples for the `annotations` table. Implementation:

- Extract annotation name: everything before the first `(`, e.g., `@DgsData`
- Extract annotation value: for single-value annotations like `@GetMapping("/api/users")`, the value is the string literal. For named parameters, parse `key = "value"` pairs and store the primary value (the `value` or `path` parameter for mappings, the `field` parameter for `@DgsData`).
- Store the original raw text for fallback queries.
- This parsing happens in `GraphStore.ingestModule()`, not in the extractors themselves — keeping extractors backward-compatible.

### SymbolKind and return type changes

The graph layer introduces new symbol kinds that must be added to the `SymbolKind` union in `source-scanner/types.ts`:

- `gql-operation` — a `gql` tagged template literal in TypeScript containing a GraphQL operation
- `api-call` — a `fetch()` or `axios` HTTP client call site in TypeScript

These additions are **backward-compatible**: existing code that switches on `SymbolKind` has default/fallthrough cases, and the formatter (`formatter.ts`) renders unknown kinds as generic entries. New kinds only appear when the enhanced extractors produce them, so existing scan results are unaffected.

The extractor return types (`extractJavaSymbols`, `extractTypeScriptSymbols`) gain optional new fields but remain backward-compatible — callers that don't use the new fields continue working.

---

## Phase 2A: Same-Language Edge Resolution

**Goal:** Connect symbols within each language via imports, calls, and inheritance. This is the foundation — cross-language linking (Phase 2B) depends on it.

**Import edges:**
- `ScannedFile` already has `imports: string[]`
- Resolve each import string to a file → look up the exported symbol → create `imports` edge
- Java: `import com.company.UserService` → find the `UserService` class node
- TypeScript: `import { useAuth } from './hooks'` → find the `useAuth` function node

**Call edges:**
- Add Tree-sitter queries for call sites:
  - Java: `method_invocation` nodes → extract receiver type + method name
  - TypeScript: `call_expression` nodes → extract function name or `obj.method` pattern
- Match call site to known node → create `calls` edge
- Store call site location in edge metadata for "jump to usage" capability

**Inheritance edges:**
- Java: `class_declaration` with `superclass` / `super_interfaces` → `extends` / `implements` edges
- TypeScript: `class_declaration` with `extends_clause` / `implements_clause`
- The extractors already capture class names; this resolves them to node IDs

**React-specific edges:**
- JSX element `<UserProfile />` → `renders` edge to the `UserProfile` component node
- Hook call `useAuth()` → `calls` edge to the hook definition
- Already partially captured by the TypeScript extractor's component/hook detection

---

## Phase 2B: Cross-Language Edge Resolution

**Goal:** Link the full cross-language chain: React → GraphQL → Spring. Depends on Phase 2A for same-language edges that complete the chain within each layer.

### 2B-1: React → GraphQL schema (operation name match)

**What we need from TypeScript (new extraction):**

Extract `gql` tagged template literals to capture GraphQL operation names used in the frontend:

```typescript
// We need to extract "users" from this chain:
export const GET_USERS = gql`
  query GetUsers {
    users { id name email }
  }
`;

// And detect that useQuery/useMutation references the operation:
const { data } = useQuery(GET_USERS);
```

Implementation in `typescript-extractor.ts`:
- Walk the AST for `call_expression` nodes where the function is `gql` (tagged template literal)
- Parse the template string content to extract the operation type (`query`/`mutation`/`subscription`) and the fields inside it (e.g., `users`)
- Walk for `call_expression` nodes where the function is `useQuery`, `useMutation`, `useSubscription`, `useLazyQuery`
- Resolve the variable argument (e.g., `GET_USERS`) to its `gql` literal in the same file or via imports
- Store as nodes with kind `gql-operation` with metadata `{ operationType: "query", fields: ["users"] }`

**What we already have from GraphQL:**

The GraphQL extractor already produces `{ name: "users", kind: "query" }` from `type Query { users: [User!]! }`.

**The join:**
- Match TS `gql-operation` field names to GraphQL `query`/`mutation` node names
- **Must filter by parent type** when joining — `posts` could match both `Query.posts` and `User.posts`. The join should be `(field_name, parent_type)` not just `field_name`.
- Create `gql_resolves` edge: React `useQuery(GET_USERS)` → GraphQL `Query.users`

**Known limitations for GraphQL matching:**
- **Aliases:** `query { allUsers: users { ... } }` — the actual field is `users` but aliased as `allUsers`. The extractor must parse past the alias to the real field name.
- **Fragments:** `...UserFragment` spreads are extremely common with Apollo Client. Fragment field names won't appear in the top-level operation fields array. Fragment support is deferred to a future iteration — document this gap.
- **Inline fragments:** `... on User { name }` — similar issue. Deferred.
- **Multiple operations in one `gql` literal:** Rare but possible. Each should produce a separate `gql-operation` node.

### 2B-2: GraphQL schema → Java resolver (method name = field name)

**What we need from Java (enhancement to existing extraction):**

The Java extractor already captures `@DgsQuery` and `@QueryMapping` as annotation strings. We need to additionally recognize these as GraphQL resolver markers and extract the **resolved field name**:

```java
@DgsQuery                                  // field name = method name "users"
public List<User> users() { ... }

@DgsData(parentType = "Query", field = "users")  // field name from annotation
public List<User> getUsers() { ... }

@QueryMapping                              // Spring GraphQL: field name = method name
public List<User> users() { ... }

@SchemaMapping(typeName = "User", field = "posts")  // nested resolver
public List<Post> getPosts(User user) { ... }
```

Implementation in `java-extractor.ts`:
- When a method has `@DgsQuery`, `@DgsMutation`, `@QueryMapping`, `@MutationMapping`, or `@SchemaMapping`: extract the resolved GraphQL field name (from annotation `field` param, or fall back to method name)
- Store in a new `graphql_resolvers` table: `{ node_id, operation_type, field_name, parent_type }`

**What we already have from GraphQL:**

`{ name: "users", kind: "query" }` — the field name and operation type.

**The join:**
- Match Java resolver `field_name` to GraphQL schema node `name` where operation types align
- Create `gql_resolves` edge: Java `UserResolver.users()` → GraphQL `Query.users`

### 2B-3: React → Spring REST endpoint (URL path match)

**Producers (partially extracted — needs fix):**
- `RestEndpoint { method: "GET", path: "/api/users", handler: "UserController.getUsers" }`
- Stored in `rest_endpoints` table linked to the Java handler node
- **Prerequisite fix:** `extractRestEndpoint` in `java-extractor.ts` must compose class-level `@RequestMapping("/api/v1")` prefix with method-level `@GetMapping("/users")` to produce the full path `/api/v1/users`. Current implementation only reads the method-level annotation.

**Consumers (new extraction in `typescript-extractor.ts`):**

Detect HTTP client call sites:

```typescript
fetch("/api/users")                              // direct fetch
axios.get("/api/users")                          // axios
api.get("/api/users")                            // custom axios instance
fetch(`/api/users/${id}`)                        // template literal (partial match)
useQuery({ queryFn: () => fetch("/api/users") }) // nested in React Query
```

Implementation:
- Walk `call_expression` nodes where callee is `fetch` or matches `*.get`/`*.post`/`*.put`/`*.delete`/`*.patch` (axios pattern)
- Extract the first string literal argument as the URL path
- For template literals: extract the static prefix (e.g., `/api/users/` from `` `/api/users/${id}` ``)
- Store as nodes with kind `api-call` and metadata `{ method, path }`

**Matching:**
- Normalize path parameters: `/api/users/:id` and `/api/users/{id}` → `/api/users/{param}`
- Join `rest_endpoints.path` to `api_calls.path` (exact match after normalization)
- For template literal prefixes: prefix match against `rest_endpoints.path`
- Create `rest_match` edges between the React call-site node and the Spring handler node

**Known limitations:**
- Dynamically constructed URLs (string concatenation) won't be caught
- URLs built through helper functions (`buildUrl("users")`) won't be caught
- Base URL configured in axios interceptors isn't resolved — the path must appear as a literal
- Environment-variable base URLs (`fetch(\`${API_BASE}/users\`)`) are extremely common in production React apps and won't be matched. This is the biggest gap for REST matching in real-world codebases.
- Prefix matching is restricted to one path segment beyond the static prefix to avoid false positives (e.g., `/api/users/` prefix matches `/api/users/{id}` but not `/api/users/{id}/posts`)

### 2B-4: GraphQL type → Java entity (type name match)

```
GraphQL:  type User { id: ID!, name: String!, email: String! }
Java:     @Entity public class User { ... }
```

- Match GraphQL type names to Java class names (case-sensitive)
- Create `type_match` edge between GraphQL `User` type node and Java `User` class node
- Filter to classes annotated with `@Entity`, `@DgsData`, or `@Document` to avoid false positives

### 2B-5: Spring dependency injection resolution

- `@Autowired` / `@Inject` on a field of type `UserRepository` → find the `@Repository` / `@Service` / `@Component` class that implements `UserRepository`
- Create `injects` edge from the containing class to the implementation class
- Already have annotation data from the Java extractor; need to add interface-to-implementation matching by:
  1. Extracting `implements` clauses from Java class declarations
  2. Matching the interface name from `@Autowired` field types to classes that implement it

### 2B-6: Full chain assembly

After all individual resolvers run, the graph contains edges that can be traversed end-to-end:

```
UserList.tsx                                            (TS component)
  │  useQuery(GET_USERS)
  ▼  ── gql_resolves (field: "users") ──►
schema.graphql :: Query.users                           (GQL query)
  │
  ▼  ── gql_resolves (method: "users") ──►
UserResolver.java :: users()                            (Java resolver)
  │
  ▼  ── calls ──►
UserService.java :: findAll()                           (Java service)
  │
  ▼  ── calls ──►
UserRepository.java :: findAll()                        (Java repository)
  │
  ▼  ── implements ──►
JpaRepository (interface)                               (Spring Data)
```

A single `get-impact { symbolName: "User", depth: 5 }` call traverses this entire chain and returns every symbol from the React component down to the repository.

### Implementation

- New directory: `src/graph/resolvers/`
  - `import-resolver.ts` — resolves import strings to node IDs, creates edges
  - `call-resolver.ts` — resolves call sites to target nodes, creates edges
  - `graphql-resolver.ts` — matches GQL schema fields ↔ TS gql operations ↔ Java resolvers
  - `rest-resolver.ts` — matches REST endpoints to HTTP client calls across languages
  - `spring-resolver.ts` — DI resolution (`@Autowired` → implementation) and entity matching
  - `react-resolver.ts` — JSX usage → component definition, hook calls
  - `index.ts` — `resolveAllEdges(graphStore)` orchestrator that runs all resolvers in sequence
- The `graphql_resolvers` and `graphql_operations` tables are already defined in the Phase 1 schema.
- Enhancements to existing extractors:
  - `typescript-extractor.ts`: extract `gql` template literal contents, `useQuery`/`useMutation` calls, `fetch()`/`axios` call sites with URL arguments
  - `java-extractor.ts`: recognize `@DgsQuery`/`@DgsMutation`/`@QueryMapping`/`@MutationMapping`/`@SchemaMapping` as GraphQL resolver markers, extract resolved field names. Extract `method_invocation` call sites (receiver + method name)
- Resolution runs after all modules are ingested in Phase 1, as a second pass over the full graph

---

## Phase 3A: Graph Query Tools (depends on Phase 1)

**Goal:** Expose basic graph queries that work as soon as nodes are indexed — no edges required.

**`search-symbols`** — Full-text search across all indexed symbols.

```
Input:  { query: "UserService", kind?: "class", module?: "api" }
Output: [ { name, kind, file, line, module, signature } ]  (~10 tokens per result)
```

Uses FTS5 for fast fuzzy matching. Optional filters by kind and module. When `qualified` names are ambiguous (two modules define `UserService`), results include the module name for disambiguation.

**`get-symbol-detail`** — Full info for one symbol.

```
Input:  { symbolName: "UserController", module?: "api", includeSource?: true }
Output: { name, kind, file, lines, signature, docComment, annotations, 
          callers: [...], callees: [...], restEndpoints: [...] }
```

The optional `module` parameter disambiguates when multiple symbols share a name. Optionally includes the source code snippet (read from disk using stored line range). `callers`/`callees` are empty until Phase 2A populates edges.

**`graph-status`** — Check index health and freshness.

```
Input:  {}
Output: { totalNodes: 387, totalEdges: 0, totalFiles: 42,
          lastSync: "2 minutes ago", staleFiles: 0 }
```

---

## Phase 3B: Graph Traversal Tools (depends on Phase 2A)

**Goal:** Expose relationship-aware queries that require edges to exist.

**`get-callers`** — Who calls this symbol?

```
Input:  { symbolName: "UserService.createUser", depth?: 2 }
Output: Call chain: Controller.handlePost → UserService.createUser
        Each entry: { name, kind, file, line, edgeKind }
```

Traverses `calls` edges in reverse up to `depth` levels.

**`get-callees`** — What does this symbol call?

```
Input:  { symbolName: "UserService.createUser", depth?: 2 }
Output: UserService.createUser → UserRepository.save → JpaRepository.save
```

Traverses `calls` edges forward.

**`get-impact`** — Blast radius of a change.

```
Input:  { symbolName: "UserService", depth?: 3 }
Output: Affected symbols (transitively): 
        - UserController (calls)
        - AdminController (calls) 
        - UserProfileComponent (rest_match via /api/users)
        Total: 3 direct, 8 transitive
```

Traverses all edge types in reverse to find everything affected. Cross-language edges (from Phase 2B) appear here automatically once they exist.

**`build-context`** — Task-driven context assembly.

```
Input:  { task: "fix the login endpoint", maxNodes?: 20 }
Output: Relevant symbols with source snippets, organized by relevance:
        1. AuthController.login (REST: POST /api/auth/login)
        2. AuthService.authenticate (called by login)
        3. TokenService.generateToken (called by authenticate)
        4. LoginForm component (rest_match: /api/auth/login)
        ...
```

### `build-context` algorithm

1. **Term extraction:** Split the task string into keywords. Remove stop words. Use remaining terms as FTS5 query (e.g., `"fix the login endpoint"` → `login endpoint`).
2. **Seed search:** Run FTS5 query against `nodes_fts`. Take the top 10 results ranked by FTS5 relevance score.
3. **Graph expansion:** From each seed node, BFS-walk edges (all types: `calls`, `imports`, `gql_resolves`, `rest_match`, etc.) up to depth 2. Collect all visited nodes.
4. **Scoring:** Score each node by: `fts_rank * 3 + edge_proximity_score + kind_boost`. Where `kind_boost` gives extra weight to classes/interfaces (2), REST endpoints (3), and components (2). `edge_proximity_score` = `1 / (depth_from_seed + 1)`.
5. **Budget enforcement:** Sort by score descending. Take top `maxNodes` results (default: 20). No token budget — complete traces are a core goal of this project.
6. **Source assembly:** For each selected node, read the source file from disk and extract the line range. Return as structured markdown with symbol metadata.

This algorithm is intentionally simple. It can be refined based on real-world usage — the key constraint is that it must complete in <500ms for graphs under 10K nodes.

### Integration with existing tools

The existing 15 tools are **unchanged**. The new tools are additive. The graph tools require `scan-internal-source` to have been run (which populates the graph), or a new `index-project` tool that does a graph-only scan without the internal-deps workflow.

### Tool design principles

- Every tool returns **structured, token-efficient output** — no dumping entire files
- `search-symbols` returns ~10 tokens per result (name, kind, file, line)
- `get-callers`/`get-callees` return chains, not full source
- `get-symbol-detail` is the only tool that optionally returns source code
- `build-context` is the power tool — it does the graph walk + source assembly that would otherwise take 20+ file reads

---

## Phase 4: Incremental Sync & File Watching

**Goal:** Keep the graph fresh without full re-scans.

### Incremental sync

- Store file content SHA-256 hash in the `files` table (already in the schema)
- On `scan-internal-source`, compare hashes before re-extracting:
  - Hash matches → skip (symbols already in graph)
  - Hash changed → delete old nodes/edges for that file, re-extract, re-insert
  - File deleted → cascade-delete nodes/edges
- Re-run edge resolution only for changed files and their dependents

### File watcher (optional, for MCP server process)

- Use Node.js `fs.watch` with `recursive: true` on the project root
- Filter to source file extensions only (`.java`, `.ts`, `.tsx`, `.js`, `.scala`, `.graphql`)
- Debounce with a 2-second quiet window
- On change: incremental sync for affected files only
- Add a `graph-status` tool so the LLM can check freshness:

```
Input:  {}
Output: { totalNodes: 387, totalEdges: 1204, totalFiles: 42,
          lastSync: "2 minutes ago", staleFiles: 0 }
```

### Implementation

- `src/graph/sync.ts` — `IncrementalSync` class: hash comparison, selective re-extraction
- `src/graph/watcher.ts` — `FileWatcher` class: native fs.watch, debounce, file filter
- Enhancement to `server/index.ts`: optionally start watcher when MCP server launches

---

## Phase 5: GenAI Framework Support (Future)

**Goal:** First-class knowledge graph support for GenAI/agent frameworks — Google ADK, LangChain ecosystem (LangChain, LangGraph, LangSmith, LangServe), CrewAI, and related orchestration tools. This phase is deferred — the plan below captures the full scope for future implementation.

**Status:** PLANNED — not yet implemented.

### 5A: Python Extractor (prerequisite for all Python-based GenAI frameworks)

**Why:** Google ADK, LangChain, LangGraph, and CrewAI are primarily Python frameworks. Stack Compass currently has no Python extractor. This is the critical prerequisite.

**Implementation:**
- Add `tree-sitter-python` WASM grammar to the parser
- New file: `src/source-scanner/python-extractor.ts`
- Add `'python'` to `SupportedLanguage`
- Extract from Python AST:
  - Classes (including `__init__`, class variables, decorators)
  - Functions/methods (including `async def`)
  - Decorators as annotations (e.g., `@tool`, `@chain`, `@agent`)
  - Imports (`import x`, `from x import y`, relative imports)
  - Type hints (for DI-style resolution)
  - Docstrings (as `docComment`)
- Detect `.py` files in `findSourceFiles`
- Estimated effort: comparable to the existing Java extractor

### 5B: Google ADK

**Detection:**
- New file: `src/analyzer/adk-detector.ts`
- Detect by:
  - Python: `google-adk` or `google-genai` in `requirements.txt` / `pyproject.toml`
  - TypeScript/JS: `@google/genai` or `@google/adk` in `package.json`
  - Presence of `agent.py`, `agent.ts`, or ADK config files
- Add `google-adk` to the framework registry with doc URLs:
  - `https://google.github.io/adk-docs/`
  - `https://ai.google.dev/gemini-api/docs`

**Extraction targets (Python):**
- Agent class definitions: subclasses of `Agent`, `LlmAgent`, `SequentialAgent`, `ParallelAgent`, `LoopAgent`
- Tool declarations: `@tool` decorator, `FunctionDeclaration`, `google.adk.tools.Tool` subclasses
- Sub-agent references: `sub_agents=[agent_a, agent_b]` in agent constructors
- Model configuration: `model="gemini-2.0-flash"` or `model=` parameter
- Callback definitions: `before_model_callback`, `after_model_callback`
- State schemas: `input_schema`, `output_schema` Pydantic models
- Session/memory config: `SessionService`, `MemoryService` references

**Extraction targets (TypeScript, if used):**
- `new Agent({ ... })`, `new LlmAgent({ ... })` constructor patterns
- Tool arrays: `tools: [myTool, anotherTool]`
- Model bindings: `model: 'gemini-2.0-flash'`

**Edge resolution:**
- `composes` edges: Agent → sub-agent (from `sub_agents` list)
- `uses_tool` edges: Agent → Tool (from `tools` list or `@tool` decorated functions)
- `uses_model` edges: Agent → model identifier node
- `calls` edges: Tool function body → backend service/REST endpoint (reuses existing call resolver)
- `configures` edges: Agent → callback functions, state schemas

**New SymbolKinds:** `'agent'`, `'tool-decl'`, `'model-config'`, `'state-schema'`

**New edge kinds:** `'composes'`, `'uses_tool'`, `'uses_model'`, `'configures'`

### 5C: LangChain Ecosystem

Covers: `langchain`, `langchain-core`, `langchain-community`, `langchain-openai`, `langchain-google-genai`, `langserve`, `langsmith`

**Detection:**
- Python: `langchain`, `langchain-core`, `langchain-community`, `langchain-openai`, `langchain-google-genai` in `requirements.txt` / `pyproject.toml`
- TypeScript/JS: `langchain`, `@langchain/core`, `@langchain/openai`, `@langchain/google-genai` in `package.json`
- Add each as a framework in the registry with doc URLs:
  - `https://python.langchain.com/docs/`
  - `https://js.langchain.com/docs/`
  - `https://api.python.langchain.com/`
  - `https://docs.smith.langchain.com/`

**Extraction targets:**

*Chains & Runnables (langchain-core):*
- `RunnableSequence`, `RunnableLambda`, `RunnablePassthrough`, `RunnableBranch` compositions
- LCEL pipe operator chains: `prompt | llm | parser` (detect `__or__` / `pipe()` patterns)
- `@chain` decorator for custom chains

*Chat models & LLMs:*
- `ChatOpenAI(model="gpt-4")`, `ChatGoogleGenerativeAI(model="gemini-pro")` — extract model bindings
- Custom LLM subclasses
- Embedding model references

*Prompts:*
- `ChatPromptTemplate.from_messages([...])` — extract template variable names
- `PromptTemplate(template="...", input_variables=[...])` — extract input variables
- `FewShotPromptTemplate` and example selectors

*Tools:*
- `@tool` decorator (same as ADK, shared extraction logic)
- `StructuredTool` subclasses with `name`, `description`, `args_schema`
- `Tool.from_function(...)` factory pattern
- `BaseTool` subclasses with `_run()` / `_arun()` methods

*Retrievers & Vector Stores:*
- `VectorStoreRetriever`, `SelfQueryRetriever`, `MultiQueryRetriever`
- Vector store bindings: `Chroma`, `FAISS`, `Pinecone`, `Weaviate` constructors
- `RecursiveCharacterTextSplitter`, `CharacterTextSplitter` references

*Agents (legacy & modern):*
- `create_react_agent(llm, tools, prompt)` — the ReAct pattern
- `create_openai_functions_agent(llm, tools, prompt)`
- `AgentExecutor(agent=..., tools=[...])` — extract agent→tool bindings
- `create_tool_calling_agent(llm, tools, prompt)` — tool-calling pattern

*Output parsers:*
- `StrOutputParser`, `JsonOutputParser`, `PydanticOutputParser` references
- `OutputFixingParser` chains

*LangServe (deployment):*
- `add_routes(app, chain, path="/my-chain")` — extract served chain endpoints
- Maps to REST endpoint concept — creates `serves` edges linking chain to URL path

*LangSmith (observability):*
- `@traceable` decorator — marks functions as traced
- `RunTree` usage for custom tracing
- `Client().create_dataset(...)` — dataset references

**Edge resolution:**
- `chain_step` edges: RunnableSequence step N → step N+1 (LCEL pipe order)
- `uses_tool` edges: Agent/AgentExecutor → Tool (shared with ADK)
- `uses_model` edges: Chain/Agent → ChatModel/LLM
- `uses_retriever` edges: Chain → Retriever → VectorStore
- `uses_prompt` edges: Chain → PromptTemplate
- `serves` edges: LangServe route → Chain (links to REST path concept)
- `traces` edges: `@traceable` function → LangSmith trace

**New SymbolKinds:** `'chain'`, `'runnable'`, `'prompt-template'`, `'retriever'`, `'vector-store'`, `'output-parser'`

### 5D: LangGraph

Covers: `langgraph`, `langgraph-checkpoint`, `langgraph-sdk`

**Detection:**
- Python: `langgraph` in `requirements.txt` / `pyproject.toml`
- TypeScript/JS: `@langchain/langgraph` in `package.json`

**Extraction targets:**
- `StateGraph(State)` — extract state schema (TypedDict / Pydantic model)
- `.add_node("name", function)` — graph nodes with handler functions
- `.add_edge("from", "to")` — static edges
- `.add_conditional_edges("from", router_fn, {mapping})` — conditional routing
- `.set_entry_point("node_name")` — entry point
- `.set_finish_point("node_name")` — terminal node
- `ToolNode(tools=[...])` — tool node with tool list
- `create_react_agent(model, tools)` — prebuilt ReAct agent graph
- Checkpointer references: `MemorySaver`, `SqliteSaver`, `PostgresSaver`
- Human-in-the-loop: `interrupt_before`, `interrupt_after` configuration
- Subgraph composition: graph used as a node in another graph

**Edge resolution:**
- `graph_edge` edges: Node → Node (static edges from `.add_edge`)
- `graph_conditional` edges: Node → conditional targets (from `.add_conditional_edges`)
- `graph_entry` edge: START → entry node
- `graph_exit` edge: terminal node → END
- `handles` edges: Graph node name → handler function
- `uses_state` edges: Graph → State schema class
- `composes` edges: Parent graph → subgraph (when a graph is used as a node)

**New SymbolKinds:** `'state-graph'`, `'graph-node'`, `'graph-edge'`, `'checkpointer'`

**MCP tool enhancement:**
- `build-context` should understand graph topology — when asked about a LangGraph workflow, return the full node/edge structure including conditional routing, not just caller/callee chains

### 5E: CrewAI (optional, lower priority)

**Detection:**
- Python: `crewai` in `requirements.txt` / `pyproject.toml`

**Extraction targets:**
- `Agent(role="...", goal="...", backstory="...", tools=[...])` — agent definitions
- `Task(description="...", agent=agent, expected_output="...")` — task definitions
- `Crew(agents=[...], tasks=[...], process=Process.sequential)` — crew composition
- `@tool` decorator (shared with LangChain/ADK)
- `@CrewBase` class decorator for structured crews

**Edge resolution:**
- `crew_member` edges: Crew → Agent
- `assigned_to` edges: Task → Agent
- `uses_tool` edges: Agent → Tool (shared)
- `task_sequence` edges: Task N → Task N+1 (for sequential process)

### 5F: Cross-Framework GenAI Resolution

When a codebase uses multiple GenAI frameworks (common in production), create edges across framework boundaries:

- **LangChain tool → ADK tool:** Same function used as tool in both frameworks
- **LangGraph node → LangChain chain:** A graph node handler that runs a LangChain chain
- **ADK agent → LangChain retriever:** ADK tool that calls a LangChain retrieval chain
- **Any agent → Spring REST:** Tool handler calls a Spring endpoint (already supported via existing call/REST resolution)
- **LangServe endpoint → React frontend:** `fetch("/my-chain/invoke")` in React → LangServe route (extends existing REST matching)

This creates a unified graph across: `React → LangServe → LangChain Chain → LangGraph Workflow → ADK Agent → Spring Backend`

### Implementation strategy

**Recommended build order for Phase 5:**

```
5A (Python extractor) → 5B (ADK) → 5C (LangChain) → 5D (LangGraph) → 5E (CrewAI) → 5F (Cross-framework)
```

- 5A is the critical-path prerequisite — without it, no Python framework works
- 5B and 5C can run in parallel after 5A since they're independent frameworks
- 5D depends on 5C (LangGraph builds on LangChain concepts)
- 5E is optional and lowest priority
- 5F is the integration layer — do last when individual frameworks are solid

**New tables:**
- `agent_tools (node_id, tool_node_id)` — agent-to-tool bindings
- `model_bindings (node_id, model_name, provider)` — model configuration
- `graph_topology (graph_node_id, from_name, to_name, condition)` — LangGraph edges
- `served_routes (node_id, path, method)` — LangServe endpoints (extends `rest_endpoints` concept)

**New dependency:**
- `tree-sitter-python` WASM grammar (for 5A)

**Estimated total effort:** Large — 5A alone is medium, plus 4-5 framework-specific extractors and resolvers. Recommend implementing incrementally, one framework at a time, with real codebase validation after each.

---

## Phase 6: Test Impact Analysis (Deferred)

**Status:** DEFERRED — LLMs can infer affected tests via `get-impact`/`build-context` and grep, and CI systems handle test selection. Revisit if manual test targeting becomes a bottleneck.

**Goal:** Given changed files, find which tests are affected.

### New tool: `affected-tests`

```
Input:  { changedFiles: ["src/api/UserService.java", "src/frontend/hooks/useAuth.ts"] }
Output: Affected test files:
        - tests/api/UserServiceTest.java (imports UserService)
        - tests/frontend/useAuth.test.ts (imports useAuth)
        - tests/integration/LoginFlow.test.ts (transitively via useAuth → LoginForm)
        Total: 3 test files
```

### How it works

- Traverse `imports` edges in reverse from each changed file's nodes
- Continue transitively up to configurable depth (default: 5)
- Filter results to files that match test patterns (already have `test-detector.ts` for content-based test detection)
- Return the list of affected test files

### Prerequisite: scanner must index test files

The current `SourceScanner` skips test directories entirely (`SKIP_DIRS` includes `test`, `tests`, `__tests__`, `spec`, `e2e`, etc. in `scanner.ts` lines 18-24), and `isTestSource()` filters out remaining test files by content detection.

For `affected-tests` to work, test files must be in the graph — at minimum their import edges. Options:
1. **Scan test files with a `test_only` flag:** Index test files into the graph with a `is_test` flag on the `files` table. The existing MCP tools (`get-internal-api`, etc.) continue filtering them out. Only `affected-tests` includes them.
2. **Separate scan pass:** Run `findSourceFiles` without `SKIP_DIRS` filtering, then tag discovered files as test/non-test using the existing `isTestSource` detector. Store both but surface differently.

Option 1 is simpler. Add a `is_test BOOLEAN DEFAULT 0` column to the `files` table.

### CI integration example

```bash
git diff --name-only HEAD~1 | stack-compass affected-tests --stdin --quiet
```

Exposed as an MCP tool so the LLM can query it directly, and usable from the command line for CI integration.

---

## Testing Strategy

### Unit tests (per phase)

**Phase 1 — GraphStore:**
- CRUD: insert files, nodes, edges; verify reads; verify cascade deletes
- FTS5: insert nodes, search by name/signature, verify ranking
- Transactions: verify rollback on error leaves DB clean
- Migration: verify `PRAGMA user_version` check and schema creation
- Idempotency: `ingestModule()` called twice with same data produces no duplicates (uses `INSERT OR REPLACE` against `UNIQUE(file_id, name, kind, start_line)` constraint)
- Annotation parsing: raw annotation strings → structured `(name, value, raw)` tuples

**Phase 2A — Same-language resolvers:**
- Import resolver: Java `import com.company.Foo` → resolves to `Foo` node. TS `import { x } from './y'` → resolves to `x` node. Unresolvable imports produce warnings, not errors.
- Call resolver: Java `method_invocation` → `calls` edge. TS `call_expression` → `calls` edge. Unresolved calls are silently skipped.
- Inheritance resolver: Java `extends`/`implements` → edges. TS `extends` → edge.

**Phase 2B — Cross-language resolvers:**
- GQL resolver: `Query.users` in schema + `@DgsQuery` method `users()` in Java → `gql_resolves` edge
- REST resolver: `@GetMapping("/api/users")` in Java + `fetch("/api/users")` in TS → `rest_match` edge
- Class-level `@RequestMapping` composition: `/api/v1` + `/users` → `/api/v1/users`
- False positive test: two different schemas with `items` field → no cross-contamination when parent_type filtering is applied

**Phase 3 — MCP tools:**
- `search-symbols`: FTS5 query returns expected results, filters by kind/module work
- `get-callers`/`get-callees`: verify depth limiting, verify cross-language edge traversal
- `build-context`: verify term extraction, BFS expansion, token budget enforcement

### Integration tests

- **End-to-end pipeline:** Create a small multi-language test fixture (3 Java files, 3 TS files, 1 GraphQL schema) with known relationships. Run `scanModule` → `ingestModule` → `resolveAllEdges` → query tools. Assert expected nodes, edges, and tool outputs.
- **Backward compatibility:** Run the full existing test suite (684 tests) after every phase to verify no regressions. The existing `ScannedModule` in-memory flow must continue producing identical results.

### Test fixtures

Create `tests/fixtures/cross-language-mono/` with:
- `api/src/main/java/com/example/UserController.java` — REST endpoints + DGS resolver
- `api/src/main/java/com/example/UserService.java` — service layer
- `frontend/src/components/UserList.tsx` — `useQuery(GET_USERS)` + `fetch("/api/users")`
- `frontend/src/graphql/queries.ts` — `gql` literal with `query GetUsers { users { ... } }`
- `schema/schema.graphql` — `type Query { users: [User!]! }`

This fixture validates the full TS → GQL → Spring chain in tests.

### Performance baseline

- Index the test fixture, record time and memory
- Target: <2 seconds for 1K files, <10 seconds for 10K files
- `build-context` must complete in <500ms for graphs under 10K nodes

---

## Summary: What changes, what stays

### Stays the same (no changes)

- All 15 existing MCP tools
- Framework registry and doc fetching pipeline
- Build file parsers (pom, gradle, sbt, package.json, infra)
- Cache layer (disk + memory)
- Security model (domain allowlist, path containment, token scoping)
- Test suite (684 tests — new tests added, none removed)

### Changes to existing code (backward-compatible)

- `source-scanner/types.ts`: `SymbolKind` union gains `'gql-operation' | 'api-call'`
- `source-scanner/java-extractor.ts`: class-level `@RequestMapping` prefix composition, `@DgsQuery`/`@QueryMapping` field name extraction, call site extraction
- `source-scanner/typescript-extractor.ts`: `gql` template literal extraction, `useQuery`/`useMutation` detection, `fetch`/`axios` call site extraction
- `server/context.ts`: `graphStore: GraphStore` added to `ServerContext`
- `server/index.ts`: `GraphStore` initialization in `createServer()`
- `source-scan-tools.ts`: graph ingestion call after `scanModule()`

All changes are additive — existing return types gain optional fields, existing callers are unaffected.

### New additions

| What | Files |
|---|---|
| SQLite graph layer | `src/graph/store.ts`, `schema.sql`, `queries.ts`, `migrations/` |
| Edge resolvers (6) | `src/graph/resolvers/import-resolver.ts`, `call-resolver.ts`, `graphql-resolver.ts`, `rest-resolver.ts`, `spring-resolver.ts`, `react-resolver.ts` |
| 7 new MCP tools | `src/server/graph-tools.ts` (search-symbols, get-symbol-detail, graph-status, get-callers, get-callees, get-impact, build-context) |
| Incremental sync | `src/graph/sync.ts` |
| File watcher | `src/graph/watcher.ts` |
| Python extractor (5A) | `src/source-scanner/python-extractor.ts` |
| GenAI detectors (5B-5E) | `src/analyzer/adk-detector.ts`, `langchain-detector.ts`, `crewai-detector.ts` |
| GenAI resolvers (5B-5F) | `src/graph/resolvers/agent-resolver.ts`, `langchain-resolver.ts`, `langgraph-resolver.ts` |
| Test impact tool (6) | `src/server/graph-tools.ts` (affected-tests) |
| Test fixtures | `tests/fixtures/cross-language-mono/` |

### New dependencies

| Package | Purpose | Notes |
|---|---|---|
| `better-sqlite3` | SQLite with FTS5 | **New dependency** — add to `dependencies`. Requires native compilation (prebuilds available). |
| `@types/better-sqlite3` | TypeScript types | Add to `devDependencies`. |
| `tree-sitter-python` | Python AST parsing (Phase 5A) | WASM grammar for Python extractor. Add when implementing Phase 5A. |

### Phase order and rationale

| Phase | Depends on | Estimated effort | Value |
|---|---|---|---|
| 1: SQLite storage | Nothing | Medium | Foundation — nodes, FTS5 search |
| 2A: Same-language edges | Phase 1 | Medium | Import/call/inheritance resolution within each language |
| 2B: Cross-language edges | Phase 1 + 2A | Large | TS→GQL→Spring chain, REST matching |
| 3A: Graph query tools | Phase 1 | Small | search-symbols, get-symbol-detail, graph-status |
| 3B: Graph traversal tools | Phase 2A | Medium | get-callers, get-callees, get-impact, build-context |
| 4: Incremental sync | Phase 1 | Small | Performance — avoid redundant work |
| 5A: Python extractor | Phase 1 | Medium | Prerequisite for all Python GenAI frameworks |
| 5B: Google ADK | Phase 5A | Medium | Agent/tool/sub-agent extraction and resolution |
| 5C: LangChain ecosystem | Phase 5A | Medium-Large | Chains, tools, retrievers, prompts, LangServe, LangSmith |
| 5D: LangGraph | Phase 5A + 5C | Medium | State graphs, nodes, conditional edges, checkpointers |
| 5E: CrewAI | Phase 5A | Small | Agents, tasks, crews (optional, lower priority) |
| 5F: Cross-framework GenAI | Phase 5B + 5C + 5D | Medium | Unified graph across GenAI + Spring + React |
| 6: Test impact | Phase 2A | Small | Requires scanner change to index test files |

**Completed build order:** 1 → 3A → 2A → 3B → 2B → 4 ✅

**Next build order:** 5A → 5B/5C → 5D → 5E → 5F (Phase 6 deferred)

This order delivers usable tools early: after Phase 1 + 3A, users can search symbols. After Phase 2A + 3B, they get callers/callees/impact within each language. Phase 2B adds the cross-language chain as the final capability layer. Phase 5 adds GenAI framework intelligence incrementally, starting with the Python extractor foundation.

### The differentiator

Most code intelligence tools build same-language knowledge graphs — TypeScript-to-TypeScript, Java-to-Java. They have no cross-language resolution.

Stack Compass with this enhancement traces **React component → GraphQL operation → GraphQL schema → Java resolver → Spring service → JPA repository** as a single connected graph, using the naming conventions that these frameworks already enforce. The join keys (operation names, URL paths, type names) are not heuristics — they are how DGS, Spring GraphQL, Apollo Client, and Spring MVC resolve things at runtime.
