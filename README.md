# Stack Compass

An MCP server that auto-detects your monorepo's full technology stack, serves **version-specific framework documentation** via a tree-indexed two-phase retrieval approach, and — most importantly — provides **source-level API extraction** for internal dependencies that have no published docs.

### Where this project adds the most value

The external documentation features (fetching Spring Boot docs, React docs, etc.) are useful but honestly overlap with what an LLM can do via web search. **The killer feature is internal source scanning.** Your company's internal shared libraries — `shared-auth`, `event-bus`, `common-utils` — have no public docs, no Context7 entry, no llms.txt. Stack Compass uses Tree-sitter WASM to parse their source code across Java, TypeScript, Scala, and GraphQL, extracting classes, methods, interfaces, REST endpoints, annotations, and doc comments into queryable documentation. No other tool does this.

### How it compares to Context7

[Context7](https://github.com/upstash/context7) is a paid hosted service where all documentation is pre-indexed on their backend. Their MCP server is a thin API client — it never fetches arbitrary URLs, so it has no SSRF surface at all. Stack Compass takes a different approach: it's fully self-hosted, fetches documentation from public sources, and generates documentation from your own source code. The tradeoff is that fetching external URLs requires a security boundary (see [Security](#security)).

## How It Works — Full Workflow

```
┌─────────────────────────────────────────────────────────────┐
│  User: "Analyze /path/to/monorepo and generate docs"        │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 1: analyze-project                                     │
│  Scans pom.xml, build.gradle, package.json, build.sbt, etc. │
│  Returns:                                                    │
│    api/      → spring-boot@3.2.0, hibernate@6.4.0           │
│    frontend/ → react@18.2.0, redux@5.0.0, graphql@16.8.0   │
│    infra/    → docker, kubernetes, helm@3.14.0               │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2: LLM calls get-doc-index for each framework          │
│                                                              │
│  ┌─ Path A: Cache hit / llms.txt / rich GitHub README ────┐ │
│  │  Server returns section tree immediately                │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Path B: No cached docs, no URL available ─────────────┐ │
│  │  Server responds: "I need a documentation URL for       │ │
│  │  spring-boot v3.2.0. Please call resolve-doc-url."     │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 3: LLM calls resolve-doc-url                           │
│  The LLM already knows Spring Boot 3.2 docs live at:        │
│  https://docs.spring.io/spring-boot/docs/3.2.0/reference/   │
│                                                              │
│  Server fetches URL → HTML→Markdown → heading tree → cache   │
│  Returns: section index (titles + summaries, ~500 tokens)    │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 4: LLM picks a section from the index                  │
│  Calls get-doc-section { sectionId: "web" }                  │
│  Server returns full section content (~300 tokens)            │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 5: Repeat for each detected framework                  │
│  Cached frameworks → instant. New ones → resolve-doc-url.    │
│  On subsequent sessions: everything served from disk cache.  │
└─────────────────────────────────────────────────────────────┘
```

### Internal Source Scanning Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Step A: configure-internal-patterns                         │
│  Define what "internal" means for your org:                  │
│    mavenGroupPrefixes: ["com.company"]                       │
│    npmScopes: ["@company"]                                   │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step B: scan-internal-source                                │
│  Detects cross-module deps from build files, then scans      │
│  each module's source with Tree-sitter WASM:                 │
│    → Java: classes, methods, annotations, REST endpoints     │
│    → TypeScript: components, hooks, interfaces, exports      │
│    → Scala: traits, case classes, implicits                  │
│    → GraphQL: queries, mutations, types (regex-based)        │
│                                                              │
│  Test files are automatically excluded via content-based      │
│  detection (checks imports, annotations, supertypes).        │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step C: get-internal-api / list-internal-deps               │
│  Browse the extracted API tree or dependency graph.           │
│  Same two-phase retrieval: tree index → targeted section.    │
└─────────────────────────────────────────────────────────────┘
```

## Why LLM-Supplied URLs?

Traditional approaches hardcode documentation URLs in a registry. This breaks when:
- URLs change (Spring Boot docs restructure between versions)
- New frameworks appear (the registry doesn't know about them)
- Version-specific URLs differ (Hibernate 5 vs 6 have completely different URL structures)

**Stack Compass flips this:** the LLM knows where docs live. It has that knowledge baked in. The server just needs to be told once per framework — then it fetches, indexes, and caches everything.

Note: because the LLM supplies URLs that the server fetches, external doc fetching is restricted to a **domain allowlist** (GitHub, official framework sites). See [Security](#security) for details.

## Documentation Resolution Priority

When `get-doc-index` is called, the server tries these sources in order:

1. **Disk cache** — previously fetched docs (`~/.stack-compass/cache/`, 7-day TTL)
2. **llms.txt** — structured for LLMs, highest quality (Next.js, Tailwind publish these)
3. **GitHub README** — fetched via raw.githubusercontent.com or GitHub API (handles `README.md`, `README.adoc`, `readme.md`, monorepo pointers)
4. **Ask the LLM** — server returns a "needs URL" prompt → LLM calls `resolve-doc-url` (domain-allowlisted)
5. **Offline fallback** — thin one-paragraph summaries for key frameworks

## GitHub Authentication

Stack Compass automatically authenticates GitHub API requests to avoid rate limits (60/hr unauthenticated → 5,000/hr authenticated) and to access private repositories.

Token resolution order:
1. `GH_TOKEN` environment variable
2. `GITHUB_TOKEN` environment variable
3. `gh auth token` CLI subprocess (picks up SSO-enabled tokens)

Set `STACK_COMPASS_NO_GH_CLI=1` to disable the CLI fallback.

For private company repos, configure a token scoped to your organization:

```bash
export GH_TOKEN=ghp_your_token_here
```

## Two-Phase Retrieval

Traditional doc serving dumps entire guides into the LLM context. This wastes tokens and degrades reasoning.

Stack Compass uses the same principle as [PageIndex](https://github.com/VectifyAI/PageIndex):

1. **Phase 1: Read the index** — titles + summaries (~500 tokens)
2. **LLM reasons** — "I need authentication config, that's the `security` section"
3. **Phase 2: Fetch targeted content** — just that section (~300 tokens)

vs. dumping everything: ~5000+ tokens, most irrelevant.

## Tools (15)

| Tool | Phase | Description |
|------|-------|-------------|
| `analyze-project` | Setup | Scans project, detects frameworks with exact versions |
| `configure-monorepo` | Setup | Describes monorepo structure before analysis |
| `resolve-doc-url` | **URL Resolution** | LLM supplies the documentation URL; server fetches, indexes, and caches it |
| `get-doc-index` | **Phase 1** | Returns heading tree — section titles + summaries only |
| `get-doc-section` | **Phase 2** | Returns full content for a specific section by ID |
| `fetch-external-docs` | Phase 2 | Returns the full assembled documentation as one document |
| `get-project-stack` | Query | Full architecture overview |
| `list-detected-frameworks` | Query | All detected framework keys with versions |
| `add-framework` | Config | Register new framework at runtime |
| `remove-framework` | Config | Remove a custom-registered framework |
| `list-all-supported-frameworks` | Query | All 30+ supported frameworks with version ranges |
| `configure-internal-patterns` | Internal | Define which dependencies are internal to your org |
| `scan-internal-source` | Internal | Detect cross-module deps and scan source code with Tree-sitter |
| `get-internal-api` | Internal | Browse extracted API tree for a scanned module |
| `list-internal-deps` | Internal | List all detected cross-module dependencies |

## Source Code Scanning

Stack Compass uses **Tree-sitter WASM** to parse source code and extract structured API documentation. This provides:

- **Broad language coverage** from one consistent API (Java, TypeScript/TSX/JS, Scala, GraphQL)
- **Structural extraction**: classes, interfaces, methods, fields, annotations, REST endpoints, React components/hooks, Scala traits/case classes
- **Doc comment association**: Javadoc, JSDoc, and ScalaDoc comments are linked to their declarations
- **Content-based test detection**: test files are identified by inspecting parsed imports (`@Test`, `describe`), annotations, and supertypes — not fragile filename heuristics. Test frameworks are dynamically detected from build files (`pom.xml`, `package.json`, `build.gradle`, `build.sbt`).

## Version-Aware Detection

The analyzer extracts **exact versions** from build files and resolves the correct documentation for each:

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

> **New here?** See the full [Setup & Usage Guide](SETUP.md) for step-by-step instructions, example conversations, caching details, and troubleshooting.

## Installation

```bash
git clone https://github.com/biswajith/stack-compass.git
cd stack-compass
npm install
npm run build
```

## Setup in Cursor

Add to `~/.cursor/mcp.json`:

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

## Setup in Claude Code

```bash
claude mcp add stack-compass node /absolute/path/to/stack-compass/dist/index.js
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `GH_TOKEN` | GitHub token for authenticated API requests (highest priority) | none |
| `GITHUB_TOKEN` | GitHub token fallback (GitHub Actions convention) | none |
| `STACK_COMPASS_NO_GH_CLI` | Set to `1` to disable `gh auth token` CLI fallback | disabled |

## Security

### SSRF protection via closed domain allowlist

The `resolve-doc-url` tool lets the LLM supply URLs for the server to fetch. This creates a Server-Side Request Forgery (SSRF) surface — a malicious prompt could try to make the server fetch internal resources (cloud metadata endpoints, admin panels, etc.).

Instead of trying to block every possible private IP encoding (IPv4, IPv6, IPv4-mapped IPv6, DNS rebinding via nip.io, etc.), Stack Compass uses a **closed domain allowlist**. Only known documentation hosts are permitted:

- **GitHub**: `github.com`, `raw.githubusercontent.com`, `api.github.com`
- **Framework docs**: `docs.spring.io`, `react.dev`, `nextjs.org`, `tailwindcss.com`, `graphql.org`, `kubernetes.io`, `www.postgresql.org`, `dev.mysql.com`, `redis.io`, `hibernate.org`, `docs.docker.com`, `docs.scala-lang.org`, `junit.org`, `maven.apache.org`, `gradle.org`, and more

Everything else is rejected — IP addresses, unknown hostnames, internal domains, `localhost`, `127.0.0.1.nip.io`, `[::ffff:7f00:1]`, and any other encoding trick. The allowlist is intentionally not user-extensible. This is the same approach [Context7](https://github.com/upstash/context7) uses implicitly (their MCP server only talks to their own API).

**For internal/private documentation**: don't try to fetch it over the network. Instead, check the source code into the monorepo and use `scan-internal-source` — Tree-sitter will parse it and extract queryable API documentation without any network requests. This is both more secure and produces better results than scraping an internal wiki.

### Other protections

- **GitHub token scoping**: Auth tokens are only sent to GitHub domains — never leaked to other hosts, even if the LLM supplies a non-GitHub URL.
- **Path containment**: All module paths are canonicalized with `fs.realpathSync` before containment checks, preventing symlink escapes.
- **Path sanitization**: Tool responses never expose absolute filesystem paths — only project-relative paths are returned.
- **No secrets in responses**: Token values are never logged or returned in tool output.
- **ReDoS guards**: Custom regex patterns are length-capped to prevent catastrophic backtracking.
- **Node 18+ compatible**: `AbortSignal.any` is polyfilled for Node 18 where it's unavailable.

## Testing

```bash
npm test
```

The test suite uses `InMemoryTransport` for in-process MCP client-server communication — no subprocess spawning.

**684 tests** covering:

- **Unit**: tree-builder, disk-cache, url-fetcher (domain allowlist, SSRF bypass vectors), source-scanner (extraction, test detection), internal-deps detector, GitHub token resolution
- **Integration**: Full MCP tool lifecycle — analyze, fetch docs, navigate sections, add/remove frameworks, source scanning tools
- **Integration**: `resolve-doc-url` flow — simulate the LLM supplying URLs
- **Integration**: Dynamic doc fetching from real URLs (GraphQL, React, Spring Boot)
- **Workflow**: Full mock-LLM ↔ MCP server conversation simulating the complete flow
- **Scenario**: Real-world framework discovery (spring-retry, resilience4j, zustand, mapstruct, etc.)
- **Scenario**: Usage pattern search across fetched documentation sections
- **Scenario**: Internal API search — aggressive search over extracted source-code documentation

## Usage Examples

### 1. Analyze and browse

```
User: Analyze the project at /path/to/monorepo

stack-compass detects:
  api/ → spring-boot@3.2.0, hibernate@6.4.0, spring-security@6.2.0
  frontend/ → react@18.2.0, redux@5.0.0, graphql@16.8.0

User: Get the doc index for spring-boot

Server: "I need a documentation URL for spring-boot v3.2.0.
         Please call resolve-doc-url."

LLM calls resolve-doc-url with:
  url: "https://docs.spring.io/spring-boot/docs/3.2.0/reference/htmlsingle/"

Server fetches, converts, indexes → returns section tree:
  - Getting Started [getting-started]
  - Configuration [configuration]
  - Web [web]
  ...

User: Get the "web" section for spring-boot
→ Returns the full section content from cached docs
```

### 2. Scan internal dependencies

```
User: Configure internal patterns for our company's maven group "com.company"

LLM calls configure-internal-patterns with:
  mavenGroupPrefixes: ["com.company"]

User: Scan internal source at /path/to/monorepo

LLM calls scan-internal-source → detects cross-module deps,
scans each with Tree-sitter:
  shared-auth/ → 15 classes, 42 methods, 3 REST endpoints
  event-bus/   → 8 classes, 28 methods, @EventHandler annotations

User: Show me the API for shared-auth

LLM calls get-internal-api → returns API tree:
  - AuthController (3 endpoints: /login, /refresh, /logout)
  - TokenService (5 methods)
  - SecurityConfig (@Configuration, @EnableWebSecurity)

User: What are the full details?

LLM calls get-internal-api with format: "full"
→ Complete method signatures, doc comments, annotations
```

### 3. Add custom framework docs

```
User: Add framework "resilience4j" with description "Fault tolerance library for Java"

LLM calls add-framework with github: "resilience4j/resilience4j"

User: Get doc index for resilience4j
→ Section tree from the GitHub README, converted to markdown
```

### 4. Works offline after first fetch

```
First run (online): LLM provides URLs → server fetches → caches to ~/.stack-compass/cache/
Subsequent runs: Reads from disk cache instantly (7-day TTL)
Fully offline: Falls back to thin built-in summaries
```

## Project Structure

```
stack-compass/
├── src/
│   ├── index.ts                    # Entry point — stdio transport
│   ├── version.ts                  # App name/version from package.json
│   ├── types/
│   │   ├── index.ts                # Interfaces — DetectedFramework, DocSection, ProjectStack, etc.
│   │   └── registry.ts             # FRAMEWORK_DOCS constant, resolveFrameworkMeta, parseMajor
│   ├── cache/
│   │   ├── index.ts                # Re-exports
│   │   ├── disk-cache.ts           # ~/.stack-compass/cache/ with 7-day TTL
│   │   └── memory-cache.ts         # In-memory TTL cache (30 min)
│   ├── tree-builder/
│   │   └── index.ts                # Markdown → heading tree → DocSection[]
│   ├── fetcher/
│   │   ├── index.ts                # DocFetcher class — orchestrates the pipeline
│   │   ├── url-fetcher.ts          # HTTP fetch + domain allowlist SSRF guard + AbortSignal compat
│   │   ├── html-converter.ts       # Turndown HTML → Markdown
│   │   ├── github-fetcher.ts       # GitHub README (multi-filename, branch, monorepo pointer following)
│   │   ├── github-token.ts         # GitHub auth: env vars → gh CLI → cached token
│   │   └── offline-fallback.ts     # Static blurbs when offline
│   ├── analyzer/
│   │   ├── index.ts                # ProjectAnalyzer class
│   │   ├── pom-parser.ts           # Maven pom.xml → DetectedFramework[]
│   │   ├── gradle-parser.ts        # Gradle build files → DetectedFramework[]
│   │   ├── sbt-parser.ts           # SBT build.sbt → DetectedFramework[]
│   │   ├── package-json-parser.ts  # npm/yarn package.json → DetectedFramework[]
│   │   ├── infra-detector.ts       # Docker, K8s, Helm, GraphQL detection
│   │   └── helpers.ts              # Shared utilities (cleanVersion)
│   ├── internal-deps/
│   │   ├── index.ts                # Re-exports
│   │   ├── types.ts                # InternalDep, InternalPatterns interfaces
│   │   └── detector.ts             # Cross-module dependency detection from build files
│   ├── source-scanner/
│   │   ├── index.ts                # Re-exports
│   │   ├── types.ts                # ScannedFile, ScannedModule, ExtractedSymbol interfaces
│   │   ├── parser.ts               # Tree-sitter WASM init, language loading, shared parser
│   │   ├── scanner.ts              # File discovery, scanning orchestration, size caps
│   │   ├── formatter.ts            # ScannedModule → DocSection[] and Markdown
│   │   ├── java-extractor.ts       # Java AST → classes, methods, annotations, REST endpoints
│   │   ├── typescript-extractor.ts # TS/TSX/JS AST → components, hooks, interfaces, exports
│   │   ├── scala-extractor.ts      # Scala AST → traits, case classes, objects, implicits
│   │   ├── graphql-extractor.ts    # GraphQL schemas → types, queries, mutations (regex-based)
│   │   └── test-detector.ts        # Content-based test file detection from build-file markers
│   └── server/
│       ├── index.ts                # createServer() factory
│       ├── context.ts              # ServerContext type + findDetectedVersion
│       ├── formatters.ts           # formatNeedsUrl, formatTreeIndex
│       ├── analysis-tools.ts       # analyze-project, configure-monorepo, get-project-stack, list-detected
│       ├── doc-tools.ts            # get-doc-index, get-doc-section, fetch-external-docs
│       ├── resolve-tools.ts        # resolve-doc-url
│       ├── framework-tools.ts      # add-framework, remove-framework, list-all-supported
│       └── source-scan-tools.ts    # configure-internal-patterns, scan-internal-source, get-internal-api, list-internal-deps
├── tests/
│   ├── helpers.ts                  # Shared setup, assertions, mock LLM (dynamic URL derivation)
│   ├── run-all.ts                  # Test runner entry point
│   ├── unit/
│   │   ├── tree-builder.test.ts
│   │   ├── disk-cache.test.ts
│   │   ├── source-scanner.test.ts  # Extraction, test detection (content-based + build-file-driven)
│   │   ├── internal-deps.test.ts   # Dependency detection, complex POMs, dependencyManagement exclusion
│   │   ├── url-fetcher.test.ts      # Domain allowlist, SSRF bypass vectors (IPv4/IPv6/DNS rebind)
│   │   └── github-token.test.ts    # Token resolution, env var priority, CLI fallback, headers
│   ├── integration/
│   │   ├── analyze-project.test.ts
│   │   ├── resolve-doc-url.test.ts
│   │   ├── doc-index.test.ts
│   │   ├── doc-section.test.ts
│   │   ├── framework-management.test.ts
│   │   ├── supported-frameworks.test.ts
│   │   └── source-scan-tools.test.ts  # Source scanning MCP tools, path traversal protection
│   ├── workflow/
│   │   └── full-workflow.test.ts   # Mock LLM ↔ MCP server conversation
│   └── scenario/
│       ├── real-world-discovery.test.ts    # 15 frameworks end-to-end
│       ├── usage-pattern-search.test.ts    # Cross-framework search patterns
│       └── internal-api-search.test.ts     # Aggressive search over extracted source APIs
├── package.json
├── tsconfig.json
├── SETUP.md
└── LICENSE                          # Apache 2.0
```

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
