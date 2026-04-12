# Stack Compass

An MCP server that auto-detects your monorepo's full technology stack and serves version-specific framework documentation using a **tree-indexed, two-phase retrieval** approach — inspired by [PageIndex](https://github.com/VectifyAI/PageIndex)'s reasoning-based RAG.

Instead of dumping entire docs into the LLM's context window, Stack Compass returns a lightweight **section index** first. The LLM reads titles and summaries, reasons about which section is relevant, then fetches only that section's content. This means the LLM spends tokens on what matters, not on irrelevant documentation.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  1. analyze-project                                         │
│     Scans pom.xml, build.gradle, package.json, etc.         │
│     Detects: spring-boot@3.2.0, react@18.2.0, ...          │
├─────────────────────────────────────────────────────────────┤
│  2. get-doc-index (lightweight — titles + summaries only)   │
│     Returns:                                                │
│     - Namespace (jakarta.*) [namespace]                     │
│       BREAKING CHANGE: javax.* → jakarta.*                  │
│     - Security Configuration [security]                     │
│       SecurityFilterChain bean — no WebSecurityConfigurer    │
│     - Migration from 2.x [migration]                        │
│       javax→jakarta, Java 17 min, ...                       │
├─────────────────────────────────────────────────────────────┤
│  3. get-doc-section (targeted — full content for 1 section) │
│     LLM picks "security" → gets SecurityFilterChain code,   │
│     requestMatchers() examples, Customizer.withDefaults()   │
└─────────────────────────────────────────────────────────────┘
```

**Phase 1** is cheap (fits in ~500 tokens). **Phase 2** gives exactly what's needed. No wasted context window.

## Tools (10)

| Tool | Phase | Description |
|------|-------|-------------|
| `analyze-project` | Setup | Scans project, detects frameworks with exact versions |
| `configure-monorepo` | Setup | Describes monorepo structure before analysis |
| `get-doc-index` | **Phase 1** | Returns lightweight tree index — section titles + summaries |
| `get-doc-section` | **Phase 2** | Returns full content for a specific section by ID |
| `fetch-external-docs` | Phase 2 | Fetches live docs from llms.txt / GitHub README, falls back to built-in content |
| `get-project-stack` | Query | Full architecture overview |
| `list-detected-frameworks` | Query | All detected framework keys with versions |
| `add-framework` | Config | Register new framework or version-specific docs at runtime |
| `remove-framework` | Config | Remove a custom-registered framework |
| `list-all-supported-frameworks` | Query | All 30+ supported frameworks with version ranges |

## Version-Aware Documentation

Different major versions get different section trees and different section content:

| Framework | v2.x / Older | v3.x / Newer |
|-----------|-------------|-------------|
| Spring Boot | `security` → WebSecurityConfigurerAdapter, antMatchers() | `security` → SecurityFilterChain bean, requestMatchers() |
| Spring Boot | `namespace` → javax.* | `namespace` → jakarta.* (BREAKING) |
| Spring Boot | — | `observability` → Micrometer, `native` → GraalVM, `virtual-threads` |
| Spring Security | `config` → extends WebSecurityConfigurerAdapter | `config` → SecurityFilterChain @Bean, lambda DSL |
| Hibernate | `entity` → javax.persistence | `entity` → jakarta.persistence |
| React 18 | `concurrent` → useTransition, Suspense | React 19: `actions` → useActionState, `compiler`, Server Components |
| Scala | `implicits` → implicit classes/params | `given-using` → given/using/extension, `enums` |
| JUnit | `basics` → @RunWith, @Before | `basics` → @ExtendWith, @BeforeEach, `parameterized`, `nested` |

## Documentation Fallback Chain

`fetch-external-docs` never returns empty. It tries sources in order:

1. **`llms.txt` URL** — structured docs designed for LLMs (Next.js, Tailwind)
2. **GitHub README** — project overview from the repo
3. **Built-in content** — assembles all version-specific `SECTION_CONTENT` entries into a comprehensive document
4. **Actionable error** — suggests `add-framework` with a `llmsTxt` or `github` source

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

The test suite uses the MCP SDK's `Client` + `InMemoryTransport` to wire a real client directly to the server in-process — no subprocess spawning, no stdio.

```bash
npm test
```

```
Stack Compass v2.0 — TypeScript Test Suite
Test 1: analyze-project (this repo)
Test 2: get-doc-index (spring-boot v3.2.0)
...
Test 63: fetch-external-docs (hibernate v6.4.0 — v6 built-in)

Results: 170 passed, 0 failed out of 170 tests
```

63 test cases covering 170 assertions across:
- Project analysis (dynamic file reading)
- Version-dispatched doc indexes (Spring Boot 2 vs 3, React 18 vs 19, Scala 2 vs 3, JUnit 4 vs 5, Spring Security 5 vs 6)
- Version-dispatched section content (javax vs jakarta, SecurityFilterChain vs WebSecurityConfigurerAdapter, etc.)
- External docs fallback chain (llms.txt → GitHub → built-in → error)
- Stateful tools (list-detected-frameworks, get-project-stack after analyze)
- Runtime framework management (add/remove)

## Usage Examples

### 1. Analyze and browse

```
User: Analyze the project at /path/to/monorepo

stack-compass detects:
  api/ → spring-boot@3.2.0, hibernate@6.4.0, spring-security@6.2.0
  frontend/ → react@18.2.0, redux@5.0.0, graphql@16.8.0

User: Get the doc index for spring-boot

Returns lightweight tree:
  - Namespace (jakarta.*) [namespace]
  - Security Configuration [security]
  - Migration from 2.x [migration]
  ... 12 sections total

User: Get the security section for spring-boot

Returns SecurityFilterChain code, requestMatchers() examples —
NOT WebSecurityConfigurerAdapter (because v3.2.0 was detected)
```

### 2. Compare versions

```
User: Get the security section for spring-boot version 2.7.0
→ WebSecurityConfigurerAdapter, antMatchers(), javax.servlet

User: Get the security section for spring-boot version 3.2.0
→ SecurityFilterChain bean, requestMatchers(), jakarta.servlet
```

### 3. Add custom framework docs

```
User: Add framework "my-auth-lib" with description "Internal OAuth2 library"
      and docs at https://wiki.company.com/auth

User: Get doc index for my-auth-lib
→ Returns overview section with link to internal docs
```

## Why Tree-Indexed Retrieval?

Traditional doc serving dumps entire guides into the LLM context. This wastes tokens and degrades reasoning (see [Chroma's context rot research](https://research.trychroma.com/context-rot)).

Stack Compass uses the same principle as [PageIndex](https://github.com/VectifyAI/PageIndex) — a hierarchical index that the LLM navigates by reasoning:

1. **Read the index** — titles + summaries (~500 tokens)
2. **Reason** — "I need authentication config, that's the `security` section"
3. **Fetch targeted content** — just the SecurityFilterChain code (~300 tokens)

vs. dumping everything: ~5000+ tokens, most irrelevant.

## Project Structure

```
stack-compass/
├── src/
│   ├── index.ts          # Entry point — stdio transport
│   ├── server.ts         # MCP server factory — all 10 tools
│   ├── analyzer.ts       # Project scanner — version extraction from build files
│   ├── doc-fetcher.ts    # Tree-indexed docs — section trees + section content + fallback chain
│   ├── types.ts          # Types, version resolution, DocTreeIndex/DocSection
│   └── test.ts           # 170-assertion test suite using MCP Client + InMemoryTransport
├── package.json
└── tsconfig.json
```

## License

ISC
