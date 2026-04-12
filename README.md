# Stack Compass

An MCP server that auto-detects your monorepo's full technology stack and serves **dynamically fetched, version-specific framework documentation** using a tree-indexed, two-phase retrieval approach.

**No hardcoded documentation URLs.** When the server needs docs for a framework it hasn't seen before, it asks the LLM to provide the most relevant official documentation URL. The server then fetches, converts, indexes, and caches it locally. The LLM's built-in knowledge of where documentation lives replaces a brittle, manually maintained URL registry.

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

## Why LLM-Supplied URLs?

Traditional approaches hardcode documentation URLs in a registry. This breaks when:
- URLs change (Spring Boot docs restructure between versions)
- New frameworks appear (the registry doesn't know about them)
- Version-specific URLs differ (Hibernate 5 vs 6 have completely different URL structures)

**Stack Compass flips this:** the LLM knows where docs live. It has that knowledge baked in. The server just needs to be told once per framework — then it fetches, indexes, and caches everything.

## Documentation Resolution Priority

When `get-doc-index` is called, the server tries these sources in order:

1. **Disk cache** — previously fetched docs (`~/.stack-compass/cache/`, 7-day TTL)
2. **llms.txt** — structured for LLMs, highest quality (Next.js, Tailwind publish these)
3. **GitHub README** — fetched via raw.githubusercontent.com or GitHub API
4. **Ask the LLM** — server returns a "needs URL" prompt → LLM calls `resolve-doc-url`
5. **Offline fallback** — thin one-paragraph summaries for key frameworks

## Two-Phase Retrieval

Traditional doc serving dumps entire guides into the LLM context. This wastes tokens and degrades reasoning.

Stack Compass uses the same principle as [PageIndex](https://github.com/VectifyAI/PageIndex):

1. **Phase 1: Read the index** — titles + summaries (~500 tokens)
2. **LLM reasons** — "I need authentication config, that's the `security` section"
3. **Phase 2: Fetch targeted content** — just that section (~300 tokens)

vs. dumping everything: ~5000+ tokens, most irrelevant.

## Tools (11)

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

## Testing

```bash
npm test
```

The test suite uses `InMemoryTransport` for in-process MCP client-server communication — no subprocess spawning.

Tests cover:
- **Unit**: tree-builder (markdown parsing, heading nesting, section map generation)
- **Unit**: disk-cache (write, read, invalidate, TTL)
- **Integration**: Full MCP tool lifecycle — analyze, fetch docs, navigate sections, add/remove frameworks
- **Integration**: `resolve-doc-url` flow — simulate the LLM supplying URLs
- **Integration**: Dynamic doc fetching from real URLs (GraphQL, React, Spring Boot)
- **Scenario**: Real-world framework discovery simulation (spring-retry, resilience4j, zustand, etc.)
- **Scenario**: Usage pattern search across fetched documentation sections

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

### 2. Add custom framework docs

```
User: Add framework "our-auth-lib" with description "Internal OAuth2 library"

LLM calls add-framework → then resolve-doc-url with the wiki URL

User: Get doc index for our-auth-lib
→ Section tree from the wiki page, converted to markdown
```

### 3. Works offline after first fetch

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
│   │   ├── url-fetcher.ts          # HTTP fetch + truncation
│   │   ├── html-converter.ts       # Turndown HTML → Markdown
│   │   ├── github-fetcher.ts       # GitHub README (main/master/API fallback)
│   │   └── offline-fallback.ts     # Static blurbs when offline
│   ├── analyzer/
│   │   ├── index.ts                # ProjectAnalyzer class
│   │   ├── pom-parser.ts           # Maven pom.xml → DetectedFramework[]
│   │   ├── gradle-parser.ts        # Gradle build files → DetectedFramework[]
│   │   ├── sbt-parser.ts           # SBT build.sbt → DetectedFramework[]
│   │   ├── package-json-parser.ts  # npm/yarn package.json → DetectedFramework[]
│   │   ├── infra-detector.ts       # Docker, K8s, Helm, GraphQL detection
│   │   └── helpers.ts              # Shared utilities (cleanVersion)
│   └── server/
│       ├── index.ts                # createServer() factory
│       ├── context.ts              # ServerContext type + findDetectedVersion
│       ├── formatters.ts           # formatNeedsUrl, formatTreeIndex
│       ├── analysis-tools.ts       # analyze-project, configure-monorepo, get-project-stack, list-detected
│       ├── doc-tools.ts            # get-doc-index, get-doc-section, fetch-external-docs
│       ├── resolve-tools.ts        # resolve-doc-url
│       └── framework-tools.ts      # add-framework, remove-framework, list-all-supported
├── tests/
│   ├── helpers.ts                  # Shared setup, assertions, mock LLM (dynamic URL derivation)
│   ├── run-all.ts                  # Test runner entry point
│   ├── unit/
│   │   ├── tree-builder.test.ts
│   │   └── disk-cache.test.ts
│   ├── integration/
│   │   ├── analyze-project.test.ts
│   │   ├── resolve-doc-url.test.ts
│   │   ├── doc-index.test.ts
│   │   ├── doc-section.test.ts
│   │   ├── framework-management.test.ts
│   │   └── supported-frameworks.test.ts
│   ├── workflow/
│   │   └── full-workflow.test.ts   # Mock LLM ↔ MCP server conversation
│   └── scenario/
│       ├── real-world-discovery.test.ts
│       └── usage-pattern-search.test.ts
├── package.json
└── tsconfig.json
```

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
