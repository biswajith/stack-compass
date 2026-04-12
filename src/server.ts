import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v3';
import { ProjectAnalyzer } from './analyzer.js';
import { DocFetcher } from './doc-fetcher.js';
import {
  MonorepoConfig, ProjectStack, FRAMEWORK_DOCS,
  FrameworkDocEntry, DocSection,
} from './types.js';

export function createServer() {
  let currentStack: ProjectStack | null = null;
  let currentConfig: MonorepoConfig | null = null;
  const docFetcher = new DocFetcher();

  const server = new McpServer({
    name: 'stack-compass',
    version: '2.0.0',
  }, {
    capabilities: { tools: {} },
  });

  function findDetectedVersion(docKey: string): string | undefined {
    if (!currentStack) return undefined;
    for (const mod of currentStack.modules) {
      for (const f of mod.frameworks) {
        if ((f.docKey === docKey || f.name === docKey) && f.version) return f.version;
      }
    }
    return undefined;
  }

  function formatTreeIndex(sections: DocSection[], indent = 0): string {
    let out = '';
    for (const s of sections) {
      const pad = '  '.repeat(indent);
      out += `${pad}- **${s.title}** [\`${s.id}\`]\n`;
      out += `${pad}  ${s.summary}\n`;
      if (s.children) out += formatTreeIndex(s.children, indent + 1);
    }
    return out;
  }

  // ─── Tool: analyze-project ──────────────────────────────────────────────

  server.tool(
    'analyze-project',
    'Scans a project directory and detects all frameworks with their exact versions from build files (pom.xml, build.gradle, build.sbt, package.json), container configs (Dockerfile, docker-compose), orchestration (k8s, Helm), and API schemas (.graphql). Call this first.',
    {
      projectPath: z.string().describe('Absolute path to the project root directory'),
    },
    async ({ projectPath }) => {
      try {
        const analyzer = new ProjectAnalyzer(projectPath);
        if (currentConfig) analyzer.setConfig(currentConfig);
        currentStack = await analyzer.analyze();

        let r = `# Project Analysis: ${projectPath}\n\n`;

        if (currentStack.modules.length === 0) {
          r += 'No modules detected. If this is a monorepo, call `configure-monorepo` first.\n';
          return { content: [{ type: 'text' as const, text: r }] };
        }

        r += `## Detected Modules (${currentStack.modules.length})\n\n`;
        for (const mod of currentStack.modules) {
          r += `### ${mod.name} (${mod.type}) — \`${mod.path}\`\n`;
          for (const f of mod.frameworks) {
            const ver = f.version ? `v${f.version}` : 'version unknown';
            const desc = docFetcher.getFrameworkDescription(f.docKey ?? f.name, f.version);
            r += `- **${f.name}** (${ver})${desc ? ` — ${desc}` : ''}\n`;
          }
          r += '\n';
        }

        const { summary } = currentStack;
        r += '## Stack Summary\n\n';
        if (summary.frontend.length) r += `- **Frontend**: ${summary.frontend.join(', ')}\n`;
        if (summary.backend.length) r += `- **Backend**: ${summary.backend.join(', ')}\n`;
        if (summary.apis.length) r += `- **API Layer**: ${summary.apis.join(', ')}\n`;
        if (summary.databases.length) r += `- **Databases**: ${summary.databases.join(', ')}\n`;
        if (summary.containers.length) r += `- **Containers**: ${summary.containers.join(', ')}\n`;
        if (summary.orchestration.length) r += `- **Orchestration**: ${summary.orchestration.join(', ')}\n`;
        if (summary.build.length) r += `- **Build Tools**: ${summary.build.join(', ')}\n`;
        if (summary.testing.length) r += `- **Testing**: ${summary.testing.join(', ')}\n`;

        r += '\n## Next Steps\n\n';
        r += '1. `get-doc-index` — get a lightweight tree index of any framework\'s documentation\n';
        r += '2. `get-doc-section` — fetch the full content of a specific section from the index\n';
        r += '3. `fetch-external-docs` — fetch live docs from llms.txt or GitHub README\n';

        return { content: [{ type: 'text' as const, text: r }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── Tool: configure-monorepo ───────────────────────────────────────────

  server.tool(
    'configure-monorepo',
    'Describes the monorepo structure (module paths and types) so the analyzer knows where to look. Call before analyze-project.',
    {
      structure: z.string().describe(
        'JSON object. Example: {"frontend":{"path":"frontend","type":"frontend"},"api":{"path":"api","type":"backend"}}. Types: frontend, backend, service, shared, infra, unknown.'
      ),
    },
    async ({ structure }) => {
      try {
        const parsed = JSON.parse(structure);
        currentConfig = { structure: parsed };

        let r = '# Monorepo Configuration Saved\n\n';
        for (const [name, config] of Object.entries(parsed)) {
          const cfg = config as { path: string; type: string; description?: string };
          r += `- **${name}**: \`${cfg.path}\` (${cfg.type})${cfg.description ? ` — ${cfg.description}` : ''}\n`;
        }
        r += '\nNow call `analyze-project` with the project root path.\n';
        return { content: [{ type: 'text' as const, text: r }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── Tool: get-doc-index (Phase 1 — lightweight tree) ───────────────────

  server.tool(
    'get-doc-index',
    'Returns a lightweight tree index of a framework\'s documentation — section titles and summaries only, no full content. The LLM should read this index to decide which section(s) to fetch with get-doc-section. This minimizes context window usage. Version-aware: uses the version detected in your project.',
    {
      framework: z.string().describe('Framework key (e.g. "spring-boot", "react", "graphql", "hibernate", "docker")'),
      version: z.string().optional().describe('Override version. If omitted, uses the version detected in your project.'),
    },
    async ({ framework, version }) => {
      const effectiveVersion = version ?? findDetectedVersion(framework);
      const index = docFetcher.getDocIndex(framework, effectiveVersion);

      if (!index) {
        return { content: [{ type: 'text' as const, text: `No documentation found for "${framework}". Use \`add-framework\` to register it, or \`list-all-supported-frameworks\` to see available frameworks.` }] };
      }

      let r = `# ${index.framework}`;
      if (index.version) r += ` v${index.version}`;
      r += '\n\n';
      r += `> ${index.description}\n`;
      if (index.officialDocs) r += `> Official docs: ${index.officialDocs}\n`;
      if (index.github) r += `> GitHub: ${index.github}\n`;
      r += '\n';

      if (currentStack) {
        const modules = currentStack.modules.filter(m =>
          m.frameworks.some(f => f.docKey === framework || f.name === framework)
        );
        if (modules.length > 0) {
          r += `> Used in: ${modules.map(m => `**${m.name}** (\`${m.path}\`)`).join(', ')}\n\n`;
        }
      }

      r += '## Documentation Sections\n\n';
      r += 'Use `get-doc-section` with the section `id` in brackets to fetch full content.\n\n';
      r += formatTreeIndex(index.sections);

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  // ─── Tool: get-doc-section (Phase 2 — targeted content) ─────────────────

  server.tool(
    'get-doc-section',
    'Fetches the full content of a specific documentation section by ID. Use get-doc-index first to see available section IDs. Returns version-specific content — e.g. Spring Boot 2.x security shows WebSecurityConfigurerAdapter while 3.x shows SecurityFilterChain.',
    {
      framework: z.string().describe('Framework key (e.g. "spring-boot", "react", "graphql")'),
      sectionId: z.string().describe('Section ID from the doc index (e.g. "security", "namespace", "mutations")'),
      version: z.string().optional().describe('Override version. If omitted, uses the version detected in your project.'),
    },
    async ({ framework, sectionId, version }) => {
      const effectiveVersion = version ?? findDetectedVersion(framework);
      const content = docFetcher.getSectionContent(framework, sectionId, effectiveVersion);

      if (!content) {
        const available = docFetcher.listSectionIds(framework, effectiveVersion);
        let r = `Section "${sectionId}" not found for ${framework}.\n\n`;
        if (available.length > 0) {
          r += `Available sections: ${available.map(s => `\`${s}\``).join(', ')}\n`;
        } else {
          r += 'No sections available. Try `fetch-external-docs` to get live docs instead.\n';
        }
        return { content: [{ type: 'text' as const, text: r }] };
      }

      let r = '';
      if (effectiveVersion) r += `> Version: **${effectiveVersion}** detected in project\n\n`;
      r += content;

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  // ─── Tool: fetch-external-docs ──────────────────────────────────────────

  server.tool(
    'fetch-external-docs',
    'Fetches live documentation from the framework\'s llms.txt file or GitHub README. Use this for the most up-to-date content, or when built-in sections don\'t cover your question. Results are cached for 1 hour.',
    {
      framework: z.string().describe('Framework key'),
      version: z.string().optional().describe('Override version'),
    },
    async ({ framework, version }) => {
      const effectiveVersion = version ?? findDetectedVersion(framework);
      const docs = await docFetcher.fetchExternalDocs(framework, effectiveVersion);
      return { content: [{ type: 'text' as const, text: docs }] };
    }
  );

  // ─── Tool: get-project-stack ────────────────────────────────────────────

  server.tool(
    'get-project-stack',
    'Returns the full architecture overview with version-specific descriptions for every detected framework.',
    {},
    async () => {
      if (!currentStack) {
        return { content: [{ type: 'text' as const, text: 'No project analyzed yet. Call `analyze-project` first.' }] };
      }

      let r = `# Project Stack: ${currentStack.rootPath}\n\n## Architecture\n\n\`\`\`\n`;
      for (const mod of currentStack.modules) {
        const fwList = mod.frameworks.map(f => f.version ? `${f.name}@${f.version}` : f.name).join(', ');
        r += `├── ${mod.name}/ (${mod.type})\n│   └── [${fwList}]\n`;
      }
      r += '```\n\n## Frameworks by Category\n\n';

      const allFrameworks = currentStack.modules.flatMap(m => m.frameworks);
      const byCategory = new Map<string, typeof allFrameworks>();
      for (const f of allFrameworks) {
        const list = byCategory.get(f.category) || [];
        if (!list.some(x => x.docKey === f.docKey)) list.push(f);
        byCategory.set(f.category, list);
      }

      for (const [category, frameworks] of byCategory) {
        r += `### ${category.charAt(0).toUpperCase() + category.slice(1)}\n`;
        for (const f of frameworks) {
          const ver = f.version ? `@${f.version}` : '';
          const desc = docFetcher.getFrameworkDescription(f.docKey ?? f.name, f.version);
          r += `- **${f.name}${ver}**${desc ? ` — ${desc}` : ''}\n`;
        }
        r += '\n';
      }

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  // ─── Tool: list-detected-frameworks ─────────────────────────────────────

  server.tool(
    'list-detected-frameworks',
    'Lists all detected framework keys with versions. Use these keys with get-doc-index and get-doc-section.',
    {},
    async () => {
      if (!currentStack) {
        return { content: [{ type: 'text' as const, text: 'No project analyzed yet. Call `analyze-project` first.' }] };
      }

      const seen = new Map<string, string | undefined>();
      for (const mod of currentStack.modules) {
        for (const f of mod.frameworks) {
          const key = f.docKey ?? f.name;
          if (!seen.has(key)) seen.set(key, f.version);
        }
      }

      let r = '# Detected Frameworks\n\n';
      for (const [key, version] of seen) {
        const ver = version ? ` (v${version})` : '';
        const desc = docFetcher.getFrameworkDescription(key, version);
        r += `- \`${key}\`${ver}${desc ? ` — ${desc}` : ''}\n`;
      }
      r += `\n**Total**: ${seen.size} frameworks\n`;
      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  // ─── Tool: add-framework ────────────────────────────────────────────────

  server.tool(
    'add-framework',
    'Registers a new framework (or version range) so get-doc-index and get-doc-section can serve its documentation. Useful for internal libraries or overriding built-in docs.',
    {
      key: z.string().describe('Framework key (e.g. "my-internal-lib")'),
      description: z.string().describe('Short description'),
      officialDocs: z.string().optional().describe('URL to official docs'),
      github: z.string().optional().describe('GitHub repo in "owner/repo" format'),
      llmsTxt: z.string().optional().describe('URL to llms.txt file'),
      minMajor: z.number().optional().describe('Minimum major version (inclusive)'),
      maxMajor: z.number().optional().describe('Maximum major version (exclusive)'),
    },
    async ({ key, description, officialDocs, github, llmsTxt, minMajor, maxMajor }) => {
      const existing = docFetcher.listCustomFrameworks().get(key);
      const entry: FrameworkDocEntry = existing ?? { versions: [] };
      entry.versions.push({ description, officialDocs, github, llmsTxt, minMajor, maxMajor });
      entry.versions.sort((a, b) => (a.minMajor ?? 0) - (b.minMajor ?? 0));
      docFetcher.addFramework(key, entry);

      let r = `# Framework Registered: ${key}\n\n`;
      r += `- **Description**: ${description}\n`;
      if (officialDocs) r += `- **Docs**: ${officialDocs}\n`;
      if (github) r += `- **GitHub**: ${github}\n`;
      if (minMajor !== undefined) r += `- **Version range**: ${minMajor}.x${maxMajor !== undefined ? ` to ${maxMajor - 1}.x` : '+'}\n`;
      r += `\nTotal version entries: ${entry.versions.length}\n`;
      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  // ─── Tool: remove-framework ─────────────────────────────────────────────

  server.tool(
    'remove-framework',
    'Removes a custom-registered framework. Built-in frameworks cannot be removed.',
    {
      key: z.string().describe('Framework key to remove'),
    },
    async ({ key }) => {
      const removed = docFetcher.removeFramework(key);
      return { content: [{ type: 'text' as const, text: removed ? `Removed \`${key}\`.` : `No custom framework \`${key}\` found.` }] };
    }
  );

  // ─── Tool: list-all-supported-frameworks ────────────────────────────────

  server.tool(
    'list-all-supported-frameworks',
    'Lists ALL frameworks with version ranges this server can provide documentation for.',
    {},
    async () => {
      const allKeys = docFetcher.listAvailableFrameworks();
      let r = `# All Supported Frameworks (${allKeys.length})\n\n`;

      const categoryMap: Record<string, string> = {
        'react': 'Frontend', 'redux': 'Frontend', '@reduxjs/toolkit': 'Frontend',
        'graphql': 'Frontend', '@apollo/client': 'Frontend', 'next': 'Frontend',
        'vue': 'Frontend', 'angular': 'Frontend', 'vite': 'Frontend',
        'typescript': 'Frontend', 'tailwindcss': 'Frontend',
        'spring-boot': 'Backend (Java)', 'spring-framework': 'Backend (Java)',
        'spring-data-jpa': 'Backend (Java)', 'spring-data-mongodb': 'Backend (Java)',
        'spring-security': 'Backend (Java)', 'hibernate': 'Backend (Java)',
        'junit': 'Backend (Java)', 'mockito': 'Backend (Java)',
        'lombok': 'Backend (Java)', 'graphql-java': 'Backend (Java)',
        'netflix-dgs': 'Backend (Java)',
        'akka': 'Backend (Scala)', 'play': 'Backend (Scala)', 'scala': 'Backend (Scala)',
        'sbt': 'Backend (Scala)', 'cats': 'Backend (Scala)', 'zio': 'Backend (Scala)',
        'sangria': 'Backend (Scala)',
        'mongodb': 'Databases', 'mysql': 'Databases', 'postgresql': 'Databases', 'redis': 'Databases',
        'docker': 'Containers', 'kubernetes': 'Containers', 'helm': 'Containers',
        'maven': 'Build Tools', 'gradle': 'Build Tools', 'yarn': 'Build Tools', 'npm': 'Build Tools',
      };

      const categories: Record<string, string[]> = {};
      for (const key of allKeys) {
        const cat = categoryMap[key] || 'Other / Custom';
        if (!categories[cat]) categories[cat] = [];
        const entry = FRAMEWORK_DOCS[key] ?? docFetcher.listCustomFrameworks().get(key);
        const versions = entry?.versions;
        let line = `\`${key}\``;
        if (versions && versions.length > 1) {
          const ranges = versions.map(v => {
            const lo = v.minMajor ?? '?';
            const hi = v.maxMajor ? `${v.maxMajor - 1}` : 'latest';
            return `${lo}-${hi}`;
          });
          line += ` [${ranges.join(', ')}]`;
        }
        if (versions?.length) line += ` — ${versions[versions.length - 1].description}`;
        categories[cat].push(line);
      }

      for (const [cat, items] of Object.entries(categories)) {
        r += `## ${cat}\n`;
        for (const item of items) r += `- ${item}\n`;
        r += '\n';
      }

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  return server;
}
