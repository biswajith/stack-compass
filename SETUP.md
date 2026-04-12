# Stack Compass — Setup & Usage Guide

A step-by-step guide to installing, configuring, and using the Stack Compass MCP server.

## Prerequisites

- **Node.js 18+** — check with `node --version`
- **npm** — comes with Node.js
- **An MCP-compatible client** — Cursor, Claude Code, Claude Desktop, or any MCP host

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

### Step 4: Add Custom Frameworks

Your project uses an internal library not in the built-in registry:

```
Add a framework called "our-auth-lib" with description "Internal OAuth2 authentication library built on Spring Security".
```

The LLM calls `add-framework`, then when you ask for its docs, the server asks the LLM for the documentation URL (your internal wiki, a GitHub README, etc.). Once fetched, it's cached like any other framework.

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

## All Available Tools

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

### Adding internal documentation

```
You: Add our company's event bus library. The docs are at
     https://wiki.company.com/event-bus/guide

LLM: [calls add-framework, then resolve-doc-url with the wiki URL]
     Done — I've indexed 12 sections from the wiki. Ask me anything about it.

You: How do I publish an event?

LLM: [calls get-doc-section for the relevant section]
     Use EventBus.publish(new OrderCreatedEvent(orderId))...
```

## Troubleshooting

### "No modules detected"

The analyzer looks for `package.json`, `pom.xml`, `build.gradle`, `build.sbt` in the project root and up to 2 levels of subdirectories. If your project uses a non-standard layout, use `configure-monorepo` first.

### "I need a documentation URL"

This is normal. The server doesn't hardcode docs URLs — it asks the LLM to provide them. The LLM will call `resolve-doc-url` automatically.

### Empty or minimal documentation

Some GitHub READMEs are just badges and a one-liner. When the server fetches a URL and gets minimal content, ask the LLM to try a different URL:

```
The docs for resilience4j were too short. Try the official guide at
https://resilience4j.readme.io/docs/getting-started
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

## Running Tests

```bash
npm test
```

This runs 311 tests using `InMemoryTransport` (no subprocess spawning):

- **Unit tests** — tree-builder, disk-cache
- **Integration tests** — each MCP tool individually
- **Workflow test** — full mock-LLM conversation simulating the 5-step flow
- **Scenario tests** — real-world framework discovery, usage pattern search

## Development

```bash
npm run dev    # Run with tsx (no build step, auto-reloads)
npm run build  # Compile TypeScript to dist/
npm test       # Run the test suite
```
