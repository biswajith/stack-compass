# Stack Compass

An MCP server that auto-detects your monorepo's full technology stack, serves **version-specific framework documentation** via a tree-indexed two-phase retrieval approach, and — most importantly — provides **cross-language code intelligence** through a SQLite-backed knowledge graph that traces symbol relationships from React components through GraphQL schemas down to Java repositories.

### Where this project adds the most value

1. **Cross-language knowledge graph.** Stack Compass indexes your entire mono-repo with Tree-sitter WASM, resolves edges across Java, TypeScript, and GraphQL, and exposes graph traversal tools. Ask "who calls this service?" and get the full chain: React component → GraphQL operation → Java resolver → Spring service → JPA repository. No other MCP tool does cross-language tracing.

2. **Internal source scanning.** Your company's internal shared libraries — `shared-auth`, `event-bus`, `common-utils` — have no public docs, no Context7 entry, no llms.txt. Stack Compass parses their source code, extracts structured API documentation, and indexes it into the knowledge graph.

3. **Version-specific framework docs.** External documentation features (Spring Boot, React, etc.) use a two-phase retrieval approach: index first, fetch targeted sections on demand. Useful but honestly overlaps with what an LLM can do via web search. The knowledge graph is the differentiator.

### How it compares to Context7

[Context7](https://github.com/upstash/context7) is a paid hosted service where all documentation is pre-indexed on their backend. Their MCP server is a thin API client — it never fetches arbitrary URLs, so it has no SSRF surface at all. Stack Compass takes a different approach: it's fully self-hosted, fetches documentation from public sources, and generates documentation from your own source code. The tradeoff is that fetching external URLs requires a security boundary (see [Security](#security)).

## Quick Start

```bash
git clone https://github.com/biswajith/stack-compass.git
cd stack-compass
npm install
npm run build
```

Add to your MCP client config (Cursor, Claude Code, Claude Desktop — see [Setup Guide](docs/SETUP.md) for all options):

```json
{
  "mcpServers": {
    "stack-compass": {
      "command": "node",
      "args": ["/absolute/path/to/stack-compass/dist/index.js"]
    }
  }
}
```

## Setting Up the Knowledge Graph on a Mono-Repo

This is the primary use case. Here's how to get cross-language code intelligence working on your mono-repo from scratch.

### Step 1: Configure internal patterns

Tell Stack Compass which dependencies are internal to your organization:

```
Configure internal patterns:
  Maven group prefixes: ["com.company", "com.company.shared"]
  npm scopes: ["@company"]
```

The LLM calls `configure-internal-patterns`. This lets the scanner distinguish your org's internal modules from third-party dependencies.

### Step 2: Scan and index

```
Scan internal source at /path/to/my-monorepo
```

The LLM calls `scan-internal-source`. Stack Compass:

1. Parses build files (`pom.xml`, `package.json`, `build.gradle`, `build.sbt`) to detect cross-module dependencies
2. Resolves local source paths for each internal dependency
3. Scans source code with Tree-sitter WASM (Java, TypeScript/TSX, Scala, GraphQL)
4. Extracts classes, methods, interfaces, annotations, REST endpoints, GraphQL operations, components, hooks, call sites, imports
5. Persists everything into a SQLite knowledge graph at `<project>/.stack-compass/graph.db`
6. Resolves edges: imports, calls, extends/implements, REST matches, GraphQL links, Spring DI
7. Excludes test files automatically via content-based detection

**Output:**

```
## Source Code Scan (4 modules)

### api
- Language: java | Files: 45 | Symbols: 312
- Classes: 28 | Interfaces: 12 | Methods: 187
- REST endpoints: 23

### frontend
- Language: typescript | Files: 62 | Symbols: 198
- Classes: 0 | Interfaces: 15 | Methods: 198

## Knowledge Graph
- Nodes: 510 | Edges: 1,847 | Files: 107
- DB: .stack-compass/graph.db
```

### Step 3: Query the graph

Now you can use all 7 graph tools:

```
Search for "UserService" in the knowledge graph.
```
→ `search-symbols` — FTS5 full-text search across all indexed symbols

```
Show me the full details for UserController, including source code.
```
→ `get-symbol-detail` — kind, file, lines, signature, annotations, callers, callees, REST endpoints, source snippet

```
Who calls createUser?
```
→ `get-callers` — reverse BFS on call edges showing the full caller chain

```
What does the login endpoint call?
```
→ `get-callees` — forward BFS showing everything downstream

```
What's the blast radius if I change UserService?
```
→ `get-impact` — traverses ALL edge types in reverse (calls, imports, extends, renders, gql_resolves, rest_match, injects) to find every affected symbol across languages

```
I need to fix the user registration flow. Give me context.
```
→ `build-context` — task-driven context assembly: extracts keywords, seeds via FTS5, BFS-expands through the graph, scores by relevance, returns source snippets. Complete traces with no token budget.

### Step 4: Keep it fresh

Re-run `scan-internal-source` after code changes. The graph uses SHA-256 hashes to skip unchanged files — only modified/new files are re-indexed. All resolver-created edges are rebuilt from scratch to prevent ghost dependencies.

Check graph health anytime:

```
What's the knowledge graph status?
```
→ `graph-status` — shows node/edge/file counts, last scan time, stale file count

### Mono-Repo Folder Structure Example

Stack Compass works with any folder structure. It discovers modules via build files:

```
my-monorepo/
├── api/                          # Java Spring Boot
│   ├── pom.xml                   # → detected as maven module
│   └── src/main/java/...
├── frontend/                     # React + TypeScript
│   ├── package.json              # → detected as npm module
│   └── src/...
├── shared-auth/                  # Internal shared library
│   ├── pom.xml
│   └── src/main/java/...
├── packages/ui-kit/              # Internal npm package
│   ├── package.json
│   └── src/...
├── schema/                       # GraphQL schemas
│   └── schema.graphql
└── .stack-compass/               # Created by Stack Compass
    └── graph.db                  # SQLite knowledge graph
```

If auto-detection misses modules, point the scanner at specific paths:

```
Scan internal source at /path/to/my-monorepo with module paths:
  ["api", "frontend", "shared-auth", "packages/ui-kit", "schema"]
```

## How It Works

### Knowledge Graph (Cross-Language Code Intelligence)

```
Source Code                    Knowledge Graph                MCP Tools
───────────                    ───────────────                ─────────
Java files    ─┐               ┌─ nodes ──────────────┐      search-symbols
TS/TSX files  ─┤─ Tree-sitter ─┤─ edges (10 kinds)    │──►   get-symbol-detail
GraphQL files ─┘  extraction   ├─ REST endpoints      │      get-callers
                               ├─ GQL resolvers        │      get-callees
                               ├─ call sites           │      get-impact
                               └─ FTS5 search index ───┘      build-context
                                                              graph-status
```

The graph resolves edges across languages using framework naming conventions as join keys:

| Pattern | Join Key | Edge Kind |
|---------|----------|-----------|
| React `useQuery` → GraphQL schema | Operation field name | `gql_resolves` |
| GraphQL schema → Java `@DgsQuery` resolver | Method name = field name | `gql_resolves` |
| React `fetch()`/`axios` → Spring `@GetMapping` | URL path (normalized) | `rest_match` |
| GraphQL type → Java `@Entity` class | Type name | `type_match` |
| `@Autowired` field → `@Service` implementation | Interface type name | `injects` |

See [Architecture: Knowledge Graph](docs/architecture/knowledge-graph.md) for full details on the schema, resolvers, traversal algorithms, and performance characteristics.

### External Documentation (Two-Phase Retrieval)

```
┌──────────────────────────────────────────────┐
│  analyze-project                              │
│  Scans pom.xml, build.gradle, package.json    │
│  Detects frameworks with exact versions        │
└──────────────────┬───────────────────────────┘
                   ▼
┌──────────────────────────────────────────────┐
│  get-doc-index (Phase 1)                      │
│  Returns section tree: titles + summaries     │
│  ~500 tokens                                  │
└──────────────────┬───────────────────────────┘
                   ▼
┌──────────────────────────────────────────────┐
│  get-doc-section (Phase 2)                    │
│  Returns full content for one section         │
│  ~300 tokens                                  │
└──────────────────────────────────────────────┘
```

The LLM supplies documentation URLs via `resolve-doc-url` when needed. URLs are domain-allowlisted for SSRF protection. Fetched docs are cached to disk (7-day TTL).

### Internal Source Scanning

```
┌──────────────────────────────────────────────┐
│  configure-internal-patterns                  │
│  mavenGroupPrefixes, npmScopes, etc.          │
└──────────────────┬───────────────────────────┘
                   ▼
┌──────────────────────────────────────────────┐
│  scan-internal-source                         │
│  Detect deps → resolve paths → Tree-sitter    │
│  scan → ingest to graph → resolve edges       │
└──────────────────┬───────────────────────────┘
                   ▼
┌──────────────────────────────────────────────┐
│  get-internal-api / list-internal-deps        │
│  Browse extracted API tree or dep graph        │
│  + all 7 graph tools for deep queries          │
└──────────────────────────────────────────────┘
```

## Tools (22)

### Knowledge Graph Tools (7) — requires `scan-internal-source` first

| Tool | Description |
|------|-------------|
| `search-symbols` | FTS5 full-text search across all indexed symbols. Filter by kind, module |
| `get-symbol-detail` | Full details: kind, file, lines, signature, annotations, callers, callees, REST endpoints, source snippet |
| `graph-status` | Node/edge/file counts, last scan time, stale file count |
| `get-callers` | Reverse BFS on call edges — who calls this symbol? |
| `get-callees` | Forward BFS on call edges — what does this symbol call? |
| `get-impact` | Blast radius: reverse BFS on ALL edge types across languages |
| `build-context` | Task-driven context assembly: FTS5 seed → graph expansion → scoring → source snippets |

### External Documentation Tools (11)

| Tool | Description |
|------|-------------|
| `analyze-project` | Scan project, detect frameworks with exact versions |
| `configure-monorepo` | Describe monorepo structure before analysis |
| `resolve-doc-url` | LLM supplies a docs URL; server fetches, indexes, caches |
| `get-doc-index` | Section tree — titles + summaries only |
| `get-doc-section` | Full content for one section by ID |
| `fetch-external-docs` | Full assembled documentation as one document |
| `get-project-stack` | Full architecture overview |
| `list-detected-frameworks` | All detected framework keys with versions |
| `add-framework` | Register new framework at runtime |
| `remove-framework` | Remove a custom framework |
| `list-all-supported-frameworks` | All 30+ built-in frameworks with version ranges |

### Internal Source Scanning Tools (4)

| Tool | Description |
|------|-------------|
| `configure-internal-patterns` | Define Maven prefixes, npm scopes, SBT prefixes, custom regex |
| `scan-internal-source` | Detect cross-module deps, scan source, ingest to graph, resolve edges |
| `get-internal-api` | Browse extracted API tree (`tree` or `full` format) |
| `list-internal-deps` | List all detected internal dependencies with scan status |

## Source Code Scanning

Stack Compass uses **Tree-sitter WASM** to parse source code and extract structured API documentation:

- **Languages:** Java, TypeScript/TSX/JS, Scala, GraphQL
- **Extraction:** classes, interfaces, methods, fields, annotations, REST endpoints, React components/hooks, Scala traits/case classes, GraphQL types/queries/mutations
- **Doc comments:** Javadoc, JSDoc, ScalaDoc linked to their declarations
- **Test exclusion:** content-based detection (checks imports, annotations, supertypes) — not fragile filename heuristics

## Version-Aware Detection

| Source File | Extracts |
|-------------|----------|
| `pom.xml` | Spring Boot (parent + properties), Hibernate, JUnit, Java version, databases |
| `build.gradle` | Spring Boot plugin, Gradle wrapper version, Java toolchain |
| `build.sbt` | Scala version, Akka, Play, ZIO, Cats from libraryDependencies |
| `package.json` | React, Redux, GraphQL, TypeScript, testing frameworks, package manager |
| `Dockerfile` | Docker usage |
| `k8s/`, `Chart.yaml` | Kubernetes, Helm |
| `*.graphql`, `*.gql` | GraphQL (recursive search up to 3 levels deep) |

## Supported Frameworks (30+)

### Frontend
React (<=16, 17, 18, 19), Redux, Redux Toolkit, GraphQL, Apollo Client (2, 3), Next.js (<=12, 13-14, 15), Vue (2, 3), Angular, Vite, TypeScript, Tailwind CSS (<=3, 4)

### Backend (Java/Spring)
Spring Boot (1.x, 2.x, 3.x), Spring Framework (4, 5, 6), Spring Data JPA (2, 3), Spring Data MongoDB, Spring Security (5, 6), Hibernate (4, 5, 6), JUnit (4, 5), Mockito, Lombok, GraphQL Java, Netflix DGS

### Backend (Scala)
Scala (2, 3), SBT, Akka (2, 3), Play (2, 3), Cats, ZIO (1, 2), Sangria

### Databases
MongoDB, MySQL (5, 8), PostgreSQL, Redis

### Containers & Orchestration
Docker, Kubernetes, Helm (2, 3)

### Build Tools
Maven, Gradle (7, 8), Yarn (1, 2+), npm

## GitHub Authentication

Stack Compass authenticates GitHub API requests to avoid rate limits (60/hr → 5,000/hr) and access private repos.

Token resolution: `GH_TOKEN` env → `GITHUB_TOKEN` env → `gh auth token` CLI

```bash
export GH_TOKEN=ghp_your_token_here
```

Set `STACK_COMPASS_NO_GH_CLI=1` to disable the CLI fallback.

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `GH_TOKEN` | GitHub token for authenticated API requests (highest priority) | none |
| `GITHUB_TOKEN` | GitHub token fallback (GitHub Actions convention) | none |
| `STACK_COMPASS_NO_GH_CLI` | Set to `1` to disable `gh auth token` CLI fallback | disabled |

## Security

### SSRF protection via closed domain allowlist

The `resolve-doc-url` tool lets the LLM supply URLs for the server to fetch. Only known documentation hosts are permitted (GitHub, official framework sites). Everything else is rejected — IP addresses, unknown hostnames, internal domains, DNS rebinding tricks. The allowlist is intentionally not user-extensible.

For internal/private documentation, use `scan-internal-source` — Tree-sitter parses locally without any network requests.

### Other protections

- **FTS5 injection prevention:** Search queries sanitized via `sanitizeFtsQuery()` — strips operators, quotes literals
- **LIKE injection prevention:** Wildcard characters escaped in suffix searches
- **Traversal depth cap:** All graph traversal capped at depth 10
- **GitHub token scoping:** Auth tokens only sent to GitHub domains
- **Path containment:** All paths canonicalized with `fs.realpathSync`, symlink escapes rejected
- **Path sanitization:** Tool responses never expose absolute filesystem paths
- **ReDoS guards:** Custom regex patterns length-capped
- **Resource cleanup:** Graph store closed on SIGINT/SIGTERM, error paths close before nulling

## Testing

```bash
npm test
```

**1,023 tests** covering:

- **Unit:** graph-store, edge-resolvers, graph-traversal, cross-language resolution, incremental-sync, graph-safety (FTS5/LIKE injection, N+1 bulk queries), graph-resilience (cycle detection, upsert IDs, depth cap), tree-builder, disk-cache, url-fetcher, source-scanner, internal-deps, github-token
- **Integration:** graph-performance (self-scan ingestion, edge resolution, FTS5 throughput, traversal latency, N+1 detection with timing thresholds), graph-tools, graph-traversal-tools, MCP tool lifecycle, resolve-doc-url flow, dynamic doc fetching
- **Workflow:** full mock-LLM ↔ MCP server conversation
- **Scenario:** real-world framework discovery, usage pattern search, internal API search

## Project Structure

```
stack-compass/
├── src/
│   ├── index.ts                    # Entry point — stdio transport
│   ├── version.ts                  # App name/version from package.json
│   ├── types/
│   │   ├── index.ts                # Interfaces — DetectedFramework, DocSection, ProjectStack
│   │   └── registry.ts             # FRAMEWORK_DOCS constant, resolveFrameworkMeta
│   ├── cache/
│   │   ├── disk-cache.ts           # ~/.stack-compass/cache/ with 7-day TTL
│   │   └── memory-cache.ts         # In-memory TTL cache (30 min)
│   ├── tree-builder/
│   │   └── index.ts                # Markdown → heading tree → DocSection[]
│   ├── fetcher/
│   │   ├── index.ts                # DocFetcher class
│   │   ├── url-fetcher.ts          # HTTP fetch + domain allowlist SSRF guard
│   │   ├── html-converter.ts       # Turndown HTML → Markdown
│   │   ├── github-fetcher.ts       # GitHub README (multi-filename, monorepo pointers)
│   │   ├── github-token.ts         # GitHub auth: env vars → gh CLI → cached token
│   │   └── offline-fallback.ts     # Static blurbs when offline
│   ├── analyzer/
│   │   ├── index.ts                # ProjectAnalyzer class
│   │   ├── pom-parser.ts           # Maven pom.xml → DetectedFramework[]
│   │   ├── gradle-parser.ts        # Gradle → DetectedFramework[]
│   │   ├── sbt-parser.ts           # SBT → DetectedFramework[]
│   │   ├── package-json-parser.ts  # npm/yarn → DetectedFramework[]
│   │   ├── infra-detector.ts       # Docker, K8s, Helm, GraphQL
│   │   └── helpers.ts              # Shared utilities
│   ├── internal-deps/
│   │   ├── types.ts                # InternalDep, InternalPatterns interfaces
│   │   └── detector.ts             # Cross-module dependency detection
│   ├── source-scanner/
│   │   ├── types.ts                # ScannedFile, ScannedModule, ExtractedSymbol
│   │   ├── parser.ts               # Tree-sitter WASM init, language loading
│   │   ├── scanner.ts              # File discovery, scanning orchestration
│   │   ├── formatter.ts            # ScannedModule → DocSection[] and Markdown
│   │   ├── java-extractor.ts       # Java AST → classes, methods, REST, GQL resolvers
│   │   ├── typescript-extractor.ts # TS/TSX → components, hooks, gql ops, api calls
│   │   ├── scala-extractor.ts      # Scala AST → traits, case classes, objects
│   │   ├── graphql-extractor.ts    # GraphQL → types, queries, mutations
│   │   └── test-detector.ts        # Content-based test file detection
│   ├── graph/
│   │   ├── store.ts                # GraphStore: SQLite + FTS5 CRUD, ingestion, search
│   │   ├── schema.sql              # Full schema (v5): 10 tables, FTS5, triggers, indexes
│   │   ├── traversal.ts            # BFS traversal, buildContext algorithm
│   │   ├── sync.ts                 # IncrementalSync: hash-based change detection
│   │   ├── watcher.ts              # FileWatcher: fs.watch with debounce
│   │   ├── index.ts                # Re-exports
│   │   └── resolvers/
│   │       ├── index.ts            # resolveAllEdges orchestrator
│   │       ├── import-resolver.ts  # Java FQN, TS relative, wildcard imports
│   │       ├── inheritance-resolver.ts  # extends/implements with cycle detection
│   │       ├── call-resolver.ts    # method_invocation, call_expression
│   │       ├── react-resolver.ts   # JSX renders, hook calls
│   │       ├── graphql-resolver.ts # GQL ops ↔ schema ↔ Java resolvers
│   │       ├── rest-resolver.ts    # TS fetch/axios ↔ Spring endpoints
│   │       └── spring-resolver.ts  # @Autowired → implementation
│   └── server/
│       ├── index.ts                # createServer() factory
│       ├── context.ts              # ServerContext type
│       ├── formatters.ts           # Output formatters
│       ├── analysis-tools.ts       # analyze-project, configure-monorepo, etc.
│       ├── doc-tools.ts            # get-doc-index, get-doc-section, etc.
│       ├── resolve-tools.ts        # resolve-doc-url
│       ├── framework-tools.ts      # add-framework, remove-framework, etc.
│       ├── source-scan-tools.ts    # scan-internal-source, get-internal-api, etc.
│       └── graph-tools.ts          # search-symbols, get-callers, build-context, etc.
├── tests/
│   ├── helpers.ts                  # Shared setup, assertions
│   ├── run-all.ts                  # Test runner entry point
│   ├── unit/                       # graph-store, edge-resolvers, traversal, cross-language,
│   │                               # incremental-sync, safety, resilience, scanner, etc.
│   ├── integration/                # graph-performance, graph-tools, MCP lifecycle
│   ├── workflow/                   # Full mock-LLM conversation
│   └── scenario/                   # Real-world discovery, search patterns, internal API
├── docs/
│   ├── SETUP.md                    # Step-by-step setup & usage guide
│   ├── plans/
│   │   └── knowledge-graph.md      # Full implementation plan + code review log
│   └── architecture/
│       └── knowledge-graph.md      # Schema, resolvers, traversal, performance
├── package.json
├── tsconfig.json
└── LICENSE                         # Apache 2.0
```

## Documentation

- [Setup & Usage Guide](docs/SETUP.md) — installation, MCP client config, example conversations, caching, troubleshooting
- [Architecture: Knowledge Graph](docs/architecture/knowledge-graph.md) — schema, resolvers, traversal algorithms, cross-language patterns, performance
- [Plan: Knowledge Graph](docs/plans/knowledge-graph.md) — implementation plan, phase breakdown, code review findings log

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
