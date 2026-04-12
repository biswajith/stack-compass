# Stack Compass — Setup & Usage Guide

A step-by-step guide to installing, configuring, and using the Stack Compass MCP server.

## Prerequisites

- **Node.js 18+** — check with `node --version`
- **npm** — comes with Node.js
- **An MCP-compatible client** — Cursor, Claude Code, Claude Desktop, or any MCP host
- **gh CLI** (optional) — for automatic GitHub token resolution. Install: `brew install gh` / `winget install GitHub.cli`

## Installation

```bash
git clone https://github.com/biswajith/stack-compass.git
cd stack-compass
npm install
npm run build
```

Verify the build succeeded:

```bash
ls dist/index.js
```

## Connecting to Your MCP Client

Stack Compass communicates over **stdio** — it reads JSON-RPC from stdin and writes to stdout. Your MCP client spawns it as a subprocess.

### Cursor

Add to `~/.cursor/mcp.json` (create the file if it doesn't exist):

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

Replace `/absolute/path/to/` with the actual path where you cloned the repo.

Restart Cursor after saving. You should see "stack-compass" in the MCP servers list.

### Claude Code

```bash
claude mcp add stack-compass node /absolute/path/to/stack-compass/dist/index.js
```

### Claude Desktop

Add to your Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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

Restart Claude Desktop after saving.

### Generic MCP Host

Any MCP host that supports stdio transports can use Stack Compass. Spawn it as:

```bash
node /path/to/stack-compass/dist/index.js
```

It expects JSON-RPC messages on stdin and responds on stdout.

## GitHub Authentication (Recommended)

Stack Compass makes GitHub API requests to fetch README files. Without authentication, GitHub limits you to 60 requests/hour. With a token, you get 5,000/hour and can access private repositories.

### Option 1: Environment variable (CI / production)

```bash
export GH_TOKEN=ghp_your_token_here
```

Or use `GITHUB_TOKEN` (the GitHub Actions convention). `GH_TOKEN` takes priority if both are set.

### Option 2: gh CLI (local development)

If you have `gh` installed and logged in:

```bash
gh auth login
```

Stack Compass automatically picks up the token via `gh auth token`. This works with SSO-enabled tokens too.

### Option 3: No authentication

Stack Compass works without a token — it gracefully falls back to unauthenticated requests. You'll hit rate limits sooner (60/hr) and won't be able to access private repos.

### Disabling CLI fallback

In environments where you don't want Stack Compass calling `gh auth token` as a subprocess:

```bash
export STACK_COMPASS_NO_GH_CLI=1
```

### Private company repositories

To access private repos (e.g., GitHub Enterprise), provide a token with `repo` scope:

```bash
export GH_TOKEN=ghp_token_with_repo_scope
```

This works with any GitHub-hosted repository your token has access to, including company-internal ones.

## Environment Variables Reference

| Variable | Purpose | Default |
|----------|---------|---------|
| `GH_TOKEN` | GitHub auth token (highest priority) | none |
| `GITHUB_TOKEN` | GitHub auth token fallback (GitHub Actions) | none |
| `STACK_COMPASS_NO_GH_CLI` | Set to `1` to disable `gh auth token` subprocess | disabled |

## Verify It's Working

Once connected, ask your LLM:

```
List all supported frameworks from stack-compass.
```

It should call the `list-all-supported-frameworks` tool and return 30+ frameworks with version ranges.

## Usage

### Step 1: Analyze Your Project

Tell the LLM to scan your project:

```
Analyze the project at /Users/me/workspace/my-monorepo
```

The LLM calls `analyze-project`. Stack Compass scans build files (`pom.xml`, `build.gradle`, `build.sbt`, `package.json`), container configs (`Dockerfile`, `docker-compose.yml`), orchestration (`k8s/`, `Chart.yaml`), and API schemas (`.graphql`) to detect every framework and its exact version.

**Output:**

```
Detected Modules (3)

api/ (backend) — ./api
  - spring-boot (v3.2.0) — Spring Boot 3.x — jakarta.* namespace, Java 17+
  - hibernate (v6.4.0) — Hibernate 6 — jakarta.persistence, JPA 3.1
  - spring-security (v6.2.0) — Spring Security 6.x — SecurityFilterChain bean

frontend/ (frontend) — ./frontend
  - react (v18.2.0) — React 18 — concurrent rendering, Suspense
  - redux (v5.0.0) — Predictable state container
  - graphql (v16.8.0) — A query language for APIs

infra/ (infra) — ./infra
  - docker
  - kubernetes
```

### Step 2: Browse Documentation

Ask about any detected framework:

```
Show me the documentation index for spring-boot.
```

**If docs are cached or available via GitHub/llms.txt:**

The LLM calls `get-doc-index` and gets a section tree immediately.

**If docs need to be fetched:**

The server tells the LLM it needs a documentation URL. The LLM knows where Spring Boot 3.2 docs live, so it calls `resolve-doc-url` with the URL. The server fetches the page, converts HTML to Markdown, parses it into sections, and caches everything.

You see a section tree like:

```
- Getting Started [getting-started]
  Introduction to Spring Boot and prerequisites
- Configuration [configuration]
  External configuration, profiles, YAML support
- Web [web]
  Spring MVC, embedded servers, error handling
- Security [security]
  Spring Security integration, OAuth2
```

### Step 3: Read a Specific Section

```
Show me the "security" section for spring-boot.
```

The LLM calls `get-doc-section` with `sectionId: "security"` and gets the full content of just that section — not the entire document.

### Step 4: Add Custom Framework Docs

Your project uses an internal library not in the built-in registry:

```
Add a framework called "our-auth-lib" with description "Internal OAuth2 authentication library built on Spring Security".
```

The LLM calls `add-framework`, then when you ask for its docs, the server asks the LLM for the documentation URL (your internal wiki, a GitHub README, etc.). Once fetched, it's cached like any other framework.

### Step 5: Scan Internal Source Code

For internal monorepo modules that don't have published documentation, Stack Compass can parse their source code directly:

```
Configure internal patterns: maven group prefixes ["com.company"], npm scopes ["@company"].
```

```
Scan internal source at /path/to/monorepo
```

The server:
1. Parses build files to detect which dependencies are internal to your org
2. Resolves source paths for each internal dependency
3. Scans source code with Tree-sitter WASM (Java, TypeScript, Scala, GraphQL)
4. Extracts classes, methods, interfaces, annotations, REST endpoints, components, hooks
5. Automatically excludes test files using content-based detection (not filename heuristics)

**Output:**

```
## Detected Internal Dependencies (3)
- com.company:shared-auth@2.0.0 (declared in api/pom.xml, maven) → source found at shared-auth/
- com.company:event-bus@1.5.0 (declared in api/pom.xml, maven) → source found at event-bus/
- @company/ui-kit@3.0.0 (declared in frontend/package.json, npm) → source found at packages/ui-kit/

## Source Code Scan (3 modules)
### shared-auth
- Language: java | Files: 15 | Symbols: 42
- Classes: 8 | Interfaces: 3 | Methods: 42
- REST endpoints: 5
- Annotations: @RestController, @Service, @Entity, @Transactional

### event-bus
- Language: java | Files: 8 | Symbols: 28
- Classes: 6 | Interfaces: 2 | Methods: 28
- Annotations: @EventHandler, @Async

### @company/ui-kit
- Language: typescript | Files: 22 | Symbols: 35
- Classes: 0 | Interfaces: 12 | Methods: 35
```

### Step 6: Browse Internal APIs

```
Show me the API for shared-auth.
```

The LLM calls `get-internal-api` and gets a tree index of all extracted symbols:

```
## API Sections
- AuthController (3 REST endpoints: POST /login, POST /refresh, DELETE /logout)
- TokenService (5 public methods)
- UserRepository (JpaRepository<User, Long>)
- SecurityConfig (@Configuration, @EnableWebSecurity)
```

For full details including method signatures and doc comments:

```
Show me the full API details for shared-auth.
```

### Step 7: List Internal Dependencies

```
List all internal dependencies across the monorepo.
```

Shows which modules depend on which, with scan status:

```
## api/pom.xml
- com.company:shared-auth@2.0.0 (maven) — scanned
- com.company:event-bus@1.5.0 (maven) — scanned

## frontend/package.json
- @company/ui-kit@3.0.0 (npm) — scanned
```

### Monorepo Configuration

If the auto-detection doesn't find all modules, tell the LLM the structure:

```
Configure the monorepo structure:
- frontend at ./packages/web (frontend)
- api at ./services/api (backend)
- shared at ./packages/shared (shared)
- infra at ./deploy (infra)
```

The LLM calls `configure-monorepo`, then call `analyze-project` again.

## How Caching Works

Stack Compass uses a two-layer cache:

| Layer | TTL | Location |
|-------|-----|----------|
| In-memory | 30 minutes | Process memory (cleared on restart) |
| Disk | 7 days | `~/.stack-compass/cache/` |

- **First request**: fetches from the internet, stores to both caches
- **Subsequent requests (same session)**: served from memory (~1ms)
- **New session (within 7 days)**: served from disk cache (~5ms)
- **After 7 days**: re-fetches from the internet

To force a re-fetch, use `remove-framework` then `add-framework`, or delete the cache directory:

```bash
rm -rf ~/.stack-compass/cache/
```

## All Available Tools (15)

### External Documentation Tools

| Tool | What it does |
|------|-------------|
| `analyze-project` | Scans a directory and detects all frameworks with versions |
| `configure-monorepo` | Describes monorepo layout so the analyzer knows where to look |
| `resolve-doc-url` | LLM supplies a docs URL; server fetches, indexes, and caches it |
| `get-doc-index` | Returns a lightweight section tree (titles + summaries only) |
| `get-doc-section` | Returns full content of one section by ID |
| `fetch-external-docs` | Returns the entire document assembled as one Markdown string |
| `get-project-stack` | Full architecture overview with version-specific descriptions |
| `list-detected-frameworks` | All detected framework keys with versions |
| `add-framework` | Register a new framework at runtime |
| `remove-framework` | Remove a custom framework and its cache |
| `list-all-supported-frameworks` | All 30+ built-in frameworks with version ranges |

### Internal Source Scanning Tools

| Tool | What it does |
|------|-------------|
| `configure-internal-patterns` | Define Maven group prefixes, npm scopes, SBT org prefixes, custom regex to identify internal deps |
| `scan-internal-source` | Detect cross-module deps and scan source code via Tree-sitter WASM |
| `get-internal-api` | Browse the extracted API tree for a scanned module (`tree` or `full` format) |
| `list-internal-deps` | List all detected internal dependencies with scan status |

## Example Conversations

### New developer onboarding

```
You: I just joined the team. Analyze /path/to/our-monorepo and tell me
     what frameworks are used and how they fit together.

LLM: [calls analyze-project, then get-project-stack]
     Your project uses Spring Boot 3.2 with Hibernate 6 and Spring Security 6
     on the backend, React 18 with Redux on the frontend, and GraphQL
     connecting the two layers. Everything runs in Docker on Kubernetes.

You: I've never used GraphQL. Give me the basics.

LLM: [calls get-doc-index for graphql, then get-doc-section for key sections]
     GraphQL is a query language for your API. You define a schema with types,
     then write queries to request exactly the data you need...
```

### Understanding version-specific differences

```
You: We're upgrading from Spring Boot 2.7 to 3.2. What changed?

LLM: [calls get-doc-index for spring-boot with version 2.7.0]
     Server: "I need a documentation URL for spring-boot v2.7.0"
LLM: [calls resolve-doc-url with the Spring Boot 2.7 reference URL]
     Server fetches, indexes → returns section tree for 2.7

LLM: [calls get-doc-index for spring-boot with version 3.2.0]
     Server: "I need a documentation URL for spring-boot v3.2.0"
LLM: [calls resolve-doc-url with the Spring Boot 3.2 reference URL]
     Server fetches, indexes → returns section tree for 3.2

LLM: [reads relevant sections from both, compares them]
     Key changes: javax.* → jakarta.* namespace migration, Java 17 minimum,
     new observability features, GraalVM native image support...
```

Note: the server doesn't diff documents itself — it fetches and indexes each version separately. The LLM reads sections from both and does the comparison.

### Exploring internal dependencies

```
You: Our monorepo has internal shared libraries under com.company.*.
     Configure that and scan the source.

LLM: [calls configure-internal-patterns with mavenGroupPrefixes: ["com.company"]]
LLM: [calls scan-internal-source with projectPath: "/path/to/monorepo"]
     Found 4 internal deps, scanned 3 modules:
       shared-auth/ → 15 classes, 42 methods, 5 REST endpoints
       event-bus/   → 8 classes, 28 methods
       common-utils/ → 12 classes, 56 methods

You: How does the auth module handle token refresh?

LLM: [calls get-internal-api for shared-auth with format: "full"]
     TokenService.refreshToken(String refreshToken): TokenPair
     - @Transactional
     - Validates refresh token, rotates both tokens
     - Javadoc: "Atomically refreshes an expired access token..."
```

### Documenting internal libraries

For internal libraries, check the source into the monorepo and use source scanning instead of URL fetching:

```
You: Our event-bus module is at ./event-bus in the monorepo.
     Configure internal patterns for maven group "com.company"
     and scan the source.

LLM: [calls configure-internal-patterns, then scan-internal-source]
     Scanned event-bus/ → 8 classes, 28 methods, @EventHandler annotations

You: How do I publish an event?

LLM: [calls get-internal-api for event-bus]
     EventBus.publish(Event event) — publishes to all registered handlers...
```

## Security Considerations

### URL fetch allowlist (SSRF protection)

The `resolve-doc-url` tool accepts URLs from the LLM, which the server then fetches. To prevent Server-Side Request Forgery (SSRF) — where a malicious prompt tricks the server into fetching internal resources — Stack Compass uses a **closed domain allowlist**.

Only known documentation hosts are permitted (GitHub, official framework sites like `docs.spring.io`, `react.dev`, `kubernetes.io`, etc.). Everything else is rejected — IP addresses, unknown hostnames, internal company domains, DNS rebinding tricks (`127.0.0.1.nip.io`), IPv6 encodings, etc. The allowlist is intentionally not user-extensible.

For internal/private documentation, don't try to fetch it over the network. Instead, check the source code into the monorepo and use `scan-internal-source` — Tree-sitter parses it locally and extracts queryable API documentation without any network requests.

### Path containment

`scan-internal-source` canonicalizes all paths with `fs.realpathSync` before checking containment. This prevents symlinks within the project from escaping the project root. Paths that resolve outside the root are rejected.

### Path sanitization

Tool responses never expose absolute filesystem paths. All paths in output are project-relative. Warning and error messages are sanitized to strip the project root prefix.

### GitHub tokens

Token values are never logged or included in tool responses. The token is resolved once and cached in process memory for the session lifetime. Auth headers are only sent to recognized GitHub domains — never to other hosts, even if the LLM supplies a URL on a different domain.

### ReDoS protection

Custom regex patterns (from `configure-internal-patterns`) are length-capped (500 chars for values, 200 chars for patterns) to prevent catastrophic backtracking.

## Troubleshooting

### "No modules detected"

The analyzer looks for `package.json`, `pom.xml`, `build.gradle`, `build.sbt` in the project root and up to 2 levels of subdirectories. If your project uses a non-standard layout, use `configure-monorepo` first.

### "I need a documentation URL"

This is normal. The server doesn't hardcode docs URLs — it asks the LLM to provide them. The LLM will call `resolve-doc-url` automatically.

### Empty or minimal documentation

Some GitHub READMEs are just badges and a one-liner. The server handles many common cases (`.adoc`, `.rst`, lowercase filenames, monorepo pointer files), but if content is still thin, ask the LLM to try a different URL:

```
The docs for resilience4j were too short. Try the official guide at
https://resilience4j.readme.io/docs/getting-started
```

### GitHub rate limiting

If you see empty/failed doc fetches, you may be hitting the unauthenticated rate limit (60/hr). Set up authentication:

```bash
export GH_TOKEN=ghp_your_token_here
# or
gh auth login
```

### Cache issues

Clear the disk cache and start fresh:

```bash
rm -rf ~/.stack-compass/cache/
```

### Server not appearing in Cursor/Claude

1. Check the path in your config is absolute and correct
2. Verify the build: `ls /path/to/stack-compass/dist/index.js`
3. Test manually: `echo '{}' | node /path/to/stack-compass/dist/index.js` — it should not crash
4. Restart your MCP client after config changes

### Source scanning issues

- **"Rejected: path escapes project root"** — the module path resolves outside the project directory (possibly via a symlink). Use absolute paths or ensure symlinks stay within the project.
- **"Module capped to 2000 files"** — very large modules are truncated to prevent excessive scan times. Split into sub-modules or add directories to the skip list.
- **Test files appearing in API output** — check that the module's build file declares its test framework as a test-scoped dependency. The server detects test frameworks from `pom.xml` (`<scope>test</scope>`), `package.json` (`devDependencies`), `build.gradle` (`testImplementation`), and `build.sbt` (`% Test`).

## Running Tests

```bash
npm test
```

This runs 684 tests using `InMemoryTransport` (no subprocess spawning):

- **Unit tests** — tree-builder, disk-cache, source-scanner (Java/TS/Scala/GraphQL extraction, content-based test detection), internal-deps detector (Maven/Gradle/npm/SBT, complex POMs, `dependencyManagement` exclusion), GitHub token resolution
- **Integration tests** — each MCP tool individually, source scanning tools with path traversal protection
- **Workflow test** — full mock-LLM conversation simulating the 5-step flow
- **Scenario tests** — real-world framework discovery (15 frameworks), usage pattern search, internal API search (aggressive search over extracted source-code documentation)

## Development

```bash
npm run dev    # Run with tsx (no build step, auto-reloads)
npm run build  # Compile TypeScript to dist/
npm test       # Run the test suite
```
