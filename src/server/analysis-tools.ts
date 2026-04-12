import { z } from 'zod/v3';
import { ProjectAnalyzer } from '../analyzer/index.js';
import { ServerContext } from './context.js';

export function registerAnalysisTools(ctx: ServerContext): void {
  ctx.server.tool(
    'analyze-project',
    'Scans a project directory and detects all frameworks with their exact versions from build files (pom.xml, build.gradle, build.sbt, package.json), container configs (Dockerfile, docker-compose), orchestration (k8s, Helm), and API schemas (.graphql). Call this first.',
    {
      projectPath: z.string().describe('Absolute path to the project root directory'),
    },
    async ({ projectPath }) => {
      try {
        const analyzer = new ProjectAnalyzer(projectPath);
        if (ctx.currentConfig) analyzer.setConfig(ctx.currentConfig);
        ctx.currentStack = await analyzer.analyze();

        let r = `# Project Analysis: ${projectPath}\n\n`;

        if (ctx.currentStack.modules.length === 0) {
          r += 'No modules detected. If this is a monorepo, call `configure-monorepo` first.\n';
          return { content: [{ type: 'text' as const, text: r }] };
        }

        r += `## Detected Modules (${ctx.currentStack.modules.length})\n\n`;
        for (const mod of ctx.currentStack.modules) {
          r += `### ${mod.name} (${mod.type}) — \`${mod.path}\`\n`;
          for (const f of mod.frameworks) {
            const ver = f.version ? `v${f.version}` : 'version unknown';
            const desc = ctx.docFetcher.getFrameworkDescription(f.docKey ?? f.name, f.version);
            r += `- **${f.name}** (${ver})${desc ? ` — ${desc}` : ''}\n`;
          }
          r += '\n';
        }

        const { summary } = ctx.currentStack;
        r += '## Stack Summary\n\n';
        if (summary.frontend.length) r += `- **Frontend**: ${summary.frontend.join(', ')}\n`;
        if (summary.backend.length) r += `- **Backend**: ${summary.backend.join(', ')}\n`;
        if (summary.apis.length) r += `- **API Layer**: ${summary.apis.join(', ')}\n`;
        if (summary.databases.length) r += `- **Databases**: ${summary.databases.join(', ')}\n`;
        if (summary.containers.length) r += `- **Containers**: ${summary.containers.join(', ')}\n`;
        if (summary.orchestration.length) r += `- **Orchestration**: ${summary.orchestration.join(', ')}\n`;
        if (summary.build.length) r += `- **Build Tools**: ${summary.build.join(', ')}\n`;
        if (summary.testing.length) r += `- **Testing**: ${summary.testing.join(', ')}\n`;
        if (summary.other.length) r += `- **Other**: ${summary.other.join(', ')}\n`;

        r += '\n## Next Steps\n\n';
        r += '1. `get-doc-index` — get a lightweight tree index of any framework\'s documentation\n';
        r += '2. `get-doc-section` — fetch the full content of a specific section from the index\n';
        r += '3. `resolve-doc-url` — supply a documentation URL so the server can fetch and index it\n';

        return { content: [{ type: 'text' as const, text: r }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  ctx.server.tool(
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
        ctx.currentConfig = { structure: parsed };

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

  ctx.server.tool(
    'get-project-stack',
    'Returns the full architecture overview with version-specific descriptions for every detected framework.',
    {},
    async () => {
      if (!ctx.currentStack) {
        return { content: [{ type: 'text' as const, text: 'No project analyzed yet. Call `analyze-project` first.' }] };
      }

      let r = `# Project Stack: ${ctx.currentStack.rootPath}\n\n## Architecture\n\n\`\`\`\n`;
      for (const mod of ctx.currentStack.modules) {
        const fwList = mod.frameworks.map(f => f.version ? `${f.name}@${f.version}` : f.name).join(', ');
        r += `├── ${mod.name}/ (${mod.type})\n│   └── [${fwList}]\n`;
      }
      r += '```\n\n## Frameworks by Category\n\n';

      const allFrameworks = ctx.currentStack.modules.flatMap(m => m.frameworks);
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
          const desc = ctx.docFetcher.getFrameworkDescription(f.docKey ?? f.name, f.version);
          r += `- **${f.name}${ver}**${desc ? ` — ${desc}` : ''}\n`;
        }
        r += '\n';
      }

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  ctx.server.tool(
    'list-detected-frameworks',
    'Lists all detected framework keys with versions. Use these keys with get-doc-index and get-doc-section.',
    {},
    async () => {
      if (!ctx.currentStack) {
        return { content: [{ type: 'text' as const, text: 'No project analyzed yet. Call `analyze-project` first.' }] };
      }

      const seen = new Map<string, string | undefined>();
      for (const mod of ctx.currentStack.modules) {
        for (const f of mod.frameworks) {
          const key = f.docKey ?? f.name;
          if (!seen.has(key)) seen.set(key, f.version);
        }
      }

      let r = '# Detected Frameworks\n\n';
      for (const [key, version] of seen) {
        const ver = version ? ` (v${version})` : '';
        const desc = ctx.docFetcher.getFrameworkDescription(key, version);
        r += `- \`${key}\`${ver}${desc ? ` — ${desc}` : ''}\n`;
      }
      r += `\n**Total**: ${seen.size} frameworks\n`;
      return { content: [{ type: 'text' as const, text: r }] };
    }
  );
}
