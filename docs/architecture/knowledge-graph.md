# Knowledge Graph Architecture

Stack Compass's knowledge graph indexes source code symbols across Java, TypeScript, and GraphQL into a SQLite database, resolves edges between them (including cross-language links), and exposes graph-query MCP tools for traversal, impact analysis, and task-driven context assembly.

## Data Flow

```
Source Code (Java, TS, GraphQL)
        │
        ▼
┌─────────────────────┐
│  Tree-sitter WASM   │   AST parsing per file
│  Extractors          │   (java-extractor, typescript-extractor, graphql-extractor)
└────────┬────────────┘
         ▼
┌─────────────────────┐
│  ScannedModule       │   In-memory: files[], symbols[], imports[], callSites[]
└────────┬────────────┘
         ▼
┌─────────────────────┐
│  GraphStore          │   SQLite + FTS5
│  .ingestModule()     │   Persist nodes, annotations, call sites, REST endpoints,
│                      │   GQL resolvers, GQL operations, file imports
└────────┬────────────┘
         ▼
┌─────────────────────┐
│  Edge Resolvers (7)  │   Match symbols across files and languages
│  resolveAllEdges()   │   Produces: imports, extends, implements, calls, renders,
│                      │   hook_calls, gql_resolves, rest_match, type_match, injects
└────────┬────────────┘
         ▼
┌─────────────────────┐
│  MCP Tools (7)       │   search-symbols, get-symbol-detail, graph-status,
│                      │   get-callers, get-callees, get-impact, build-context
└─────────────────────┘
```

## SQLite Schema

Database location: `<project-root>/.stack-compass/graph.db`

Schema version is tracked via `PRAGMA user_version`. On version mismatch, the database is rebuilt from scratch (source code is the authority — re-indexing takes seconds).

### Tables

| Table | Purpose |
|-------|---------|
| `files` | Indexed source files with SHA-256 hash, language, module name |
| `nodes` | Symbol nodes (classes, methods, interfaces, components, etc.) with qualified names, location, visibility, signature, doc comment |
| `edges` | Directed edges between nodes (source → target) with kind and optional metadata |
| `annotations` | Annotation storage with parsed name, value, and raw text |
| `file_imports` | Import declarations per file (used by import resolver) |
| `rest_endpoints` | Denormalized REST endpoints for fast cross-language matching |
| `graphql_resolvers` | Java/Kotlin methods that resolve GraphQL schema fields |
| `graphql_operations` | GraphQL operations extracted from `gql` tagged templates in TypeScript |
| `call_sites` | Method/function call sites with target name and optional receiver |
| `jsx_usages` | JSX element usage in React components |
| `nodes_fts` | FTS5 virtual table for full-text search on name, qualified, signature, doc_comment |

### Key Design Decisions

**ON DELETE CASCADE everywhere.** Deleting a file cascades to its nodes, which cascades to their edges, annotations, call sites, etc. This makes re-ingestion clean: delete old file data, re-insert.

**FTS5 content-sync triggers.** The `nodes_fts` table uses `content=nodes` with manual triggers for INSERT/UPDATE/DELETE. FTS5 content tables do not auto-sync — the triggers are required.

**Idempotent ingestion.** `nodes` has a `UNIQUE(file_id, name, kind, start_line)` constraint. Re-ingesting the same file updates existing nodes via `ON CONFLICT DO UPDATE`.

**SHA-256 hash skip.** Before re-extracting a file, the store compares the file's content hash. If unchanged, the file is skipped entirely. The hash computation recursively includes child symbols for synthetic test data that isn't on disk.

### Entity Relationship Diagram

```
files 1──* nodes 1──* annotations
  │           │
  │           ├──* edges (source_id)
  │           ├──* edges (target_id)
  │           ├──* call_sites
  │           ├──* jsx_usages
  │           ├──* rest_endpoints
  │           ├──* graphql_resolvers
  │           └──* graphql_operations
  │
  └──* file_imports
```

## Edge Resolvers

All 7 resolvers run sequentially via `resolveAllEdges()`. Before resolving, all previously created edges are deleted to prevent stale ghost dependencies.

### Import Resolver (`import-resolver.ts`)

Resolves import strings to target nodes.

- **Java FQN:** `import com.company.UserService` → finds the node with matching qualified name
- **Java wildcard:** `import com.acme.*` → finds all top-level nodes in that package using a pre-built `qualifiedIndex` Map
- **TypeScript relative:** `import { useAuth } from './hooks'` → resolves path with `.ts`/`.tsx`/`.js`/`/index.ts` extensions using a file path Map for O(1) lookup

### Inheritance Resolver (`inheritance-resolver.ts`)

Creates `extends` and `implements` edges from class/interface declarations. Strips generic type parameters (`AbstractController<T>` → `AbstractController`). Includes cycle detection via a visited set to prevent stack overflow on malformed data.

### Call Resolver (`call-resolver.ts`)

Matches call sites to target nodes. Uses receiver suffix matching: `userService.findAll()` → receiver `userService` matches `UserService` class via case-insensitive suffix. Returns `null` for ambiguous matches (multiple candidates with no module disambiguation) rather than picking arbitrarily.

### React Resolver (`react-resolver.ts`)

- JSX `<UserProfile />` → `renders` edge to the `UserProfile` component
- Hook `useAuth()` → `hook_calls` edge to the hook definition

### GraphQL Resolver (`graphql-resolver.ts`)

Three sub-resolvers:

1. **GQL operation → schema:** Matches TypeScript `gql` template field names to GraphQL schema query/mutation nodes. Filters by operation type (`query`/`mutation`/`subscription`).
2. **Java resolver → schema:** Matches `@DgsQuery`/`@QueryMapping` method field names to GraphQL schema nodes.
3. **GQL type → Java entity:** Matches GraphQL type names to Java classes annotated with `@Entity`/`@Document`.

### REST Resolver (`rest-resolver.ts`)

Matches TypeScript `fetch()`/`axios` API call paths to Java REST endpoints. Path normalization converts `:id` and `{id}` to `{param}` for comparison. Uses bulk queries to avoid N+1.

### Spring Resolver (`spring-resolver.ts`)

Resolves `@Autowired`/`@Inject` fields to their implementing classes. Builds an in-memory index of class names → node IDs from `getClassesWithImplements()` for O(1) lookup.

## Graph Traversal

### BFS-based traversal (`traversal.ts`)

All traversal tools use breadth-first search with configurable depth (capped at `MAX_TRAVERSAL_DEPTH = 10`):

- **`getCallers(symbol, depth)`** — reverse BFS on `calls` edges
- **`getCallees(symbol, depth)`** — forward BFS on `calls` edges
- **`getImpact(symbol, depth)`** — reverse BFS on ALL edge types (calls, imports, extends, implements, renders, hook_calls, gql_resolves, rest_match, type_match, injects)

### `buildContext` algorithm

Task-driven context assembly in 6 steps:

1. **Term extraction:** Split task string into keywords, remove stop words (common English + action verbs like "fix", "add", "update")
2. **FTS5 seed search:** Query `nodes_fts` with extracted terms joined by `OR`. All terms go through `sanitizeFtsQuery()` which strips FTS5 operators and quotes literals.
3. **Graph expansion:** BFS-walk from each seed node across all edge types, up to depth 2
4. **Scoring:** `fts_rank * 3 + edge_proximity_score + kind_boost`. Kind boost: classes/interfaces (2), REST endpoints (3), components (2)
5. **Selection:** Sort by score descending, take top `maxNodes` (default 20). No token budget — complete traces are the core goal.
6. **Source assembly:** Read source file from disk for each selected node's line range

## Cross-Language Link Patterns

The knowledge graph resolves three cross-language patterns using string matching on framework-enforced naming conventions:

### React → GraphQL (operation name match)

```
TypeScript:  gql`query GetUsers { users { id name } }`
                                   ─────
GraphQL:     type Query { users: [User!]! }
                          ─────
Edge: gql_resolves (TS gql-operation node → GQL query node)
```

### GraphQL → Java (method name = field name)

```
GraphQL:  type Query { users: [User!]! }
                       ─────
Java:     @DgsQuery
          public List<User> users() { }
                            ─────
Edge: gql_resolves (Java resolver node → GQL query node)
```

### React → Spring REST (URL path match)

```
TypeScript:  fetch("/api/users")
                   ────────────
Java:        @GetMapping("/api/users")
                         ────────────
Edge: rest_match (TS api-call node → Java handler node)
```

### Full chain traversal

With all patterns combined, `get-impact` on a Java entity traces:

```
UserList.tsx → useQuery(GET_USERS) → schema.graphql Query.users
→ UserResolver.java users() → UserService.findAll()
→ UserRepository.findAll() → JpaRepository
```

## Incremental Sync

`IncrementalSync` in `sync.ts` keeps the graph fresh:

- **Single-pass detection:** `getStaleInfo()` iterates stored files once, comparing SHA-256 hashes against disk content. Returns `{ changed[], deleted[], count }`.
- **Changed files:** Delete old data (CASCADE handles nodes/edges), re-extract, re-insert
- **Deleted files:** CASCADE delete removes all associated data
- **Edge re-resolution:** `resolveAllEdges()` clears all resolver-created edges and re-resolves from scratch

## File Watching

`FileWatcher` in `watcher.ts` uses `fs.watch` with `recursive: true` to detect file system changes:

- Filters to source file extensions (`.java`, `.ts`, `.tsx`, `.js`, `.scala`, `.graphql`)
- Debounces with a configurable quiet window (default 2 seconds)
- `stop(flush?)` option to process pending changes before stopping

> **Note:** `fs.watch` recursive mode is not supported on Linux. On Linux, only the top-level directory is watched. See the [Node.js docs](https://nodejs.org/api/fs.html#caveats) for platform-specific behavior.

## Performance Characteristics

Measured via integration tests against the Stack Compass codebase itself:

| Operation | Target |
|-----------|--------|
| Full scan + ingestion (this repo) | < 15s |
| Edge resolution | < 5s |
| FTS5 search (100 queries) | < 2s total |
| Single traversal (depth 3) | < 100ms |
| `buildContext` | < 500ms |
| Incremental sync (no changes) | < 1s |
| `graph-status` | < 2s |

## Prepared Statement Caching

Six hot-path queries are prepared once in the `GraphStore` constructor and reused across all calls:

- `getNodeById`, `getFileById`, `getEdgesFrom`, `getEdgesTo`, `getChildNodes`, `getAnnotations`

All other queries use inline `db.prepare()` — they run infrequently enough that the overhead is negligible.

## Security

- **FTS5 injection prevention:** All user-provided search queries go through `sanitizeFtsQuery()` which strips FTS5 operators (`*`, `"`, `^`, `()`, `{}`, `[]`) and wraps tokens in double quotes. The `OR` operator is preserved for disjunctive queries.
- **LIKE injection prevention:** `getNodesByNameSuffix` escapes `\`, `%`, `_` wildcards with `ESCAPE '\'`.
- **Traversal depth cap:** All traversal tools are capped at `MAX_TRAVERSAL_DEPTH = 10` via both Zod schema validation and runtime `Math.min()`.
- **Path containment:** All module paths are canonicalized with `fs.realpathSync` before containment checks.
- **Resource cleanup:** `GraphStore` is closed on `SIGINT`/`SIGTERM`. Error paths in `source-scan-tools.ts` close the store before nulling.
