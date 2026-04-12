import { z } from 'zod/v3';
import { DocTreeIndex } from '../types/index.js';
import { ServerContext, findDetectedVersion } from './context.js';
import { formatNeedsUrl, formatTreeIndex } from './formatters.js';

export function registerDocTools(ctx: ServerContext): void {
  ctx.server.tool(
    'get-doc-index',
    'Returns a lightweight tree index of a framework\'s documentation — section titles and summaries only. If the docs haven\'t been fetched yet, you\'ll be prompted to call resolve-doc-url with the correct URL. The LLM is responsible for providing the documentation URL.',
    {
      framework: z.string().describe('Framework key (e.g. "spring-boot", "react", "graphql")'),
      version: z.string().optional().describe('Override version. If omitted, uses the version detected in your project.'),
    },
    async ({ framework, version }) => {
      const effectiveVersion = version ?? findDetectedVersion(ctx, framework);

      try {
        const result = await ctx.docFetcher.getDocIndex(framework, effectiveVersion);

        if (!result) {
          return { content: [{ type: 'text' as const, text: `No documentation found for "${framework}". Use \`add-framework\` to register it, or \`list-all-supported-frameworks\` to see available frameworks.` }] };
        }

        if ('kind' in result && result.kind === 'needs-url') {
          return { content: [{ type: 'text' as const, text: formatNeedsUrl(result) }] };
        }

        const index = result as DocTreeIndex;
        let r = `# ${index.framework}`;
        if (index.version) r += ` v${index.version}`;
        r += '\n\n';
        r += `> ${index.description}\n`;
        if (index.docUrl) r += `> Docs source: ${index.docUrl}\n`;
        if (index.github) r += `> GitHub: ${index.github}\n`;
        r += '\n';

        if (ctx.currentStack) {
          const modules = ctx.currentStack.modules.filter(m =>
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
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error fetching docs for "${framework}": ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  ctx.server.tool(
    'get-doc-section',
    'Fetches the full content of a specific documentation section by ID. Use get-doc-index first to see available section IDs. If docs haven\'t been indexed yet, you\'ll be prompted to call resolve-doc-url first.',
    {
      framework: z.string().describe('Framework key'),
      sectionId: z.string().describe('Section ID from the doc index'),
      version: z.string().optional().describe('Override version'),
    },
    async ({ framework, sectionId, version }) => {
      const effectiveVersion = version ?? findDetectedVersion(ctx, framework);

      try {
        const content = await ctx.docFetcher.getSectionContent(framework, sectionId, effectiveVersion);

        if (content && typeof content === 'object' && 'kind' in content && content.kind === 'needs-url') {
          return { content: [{ type: 'text' as const, text: formatNeedsUrl(content) }] };
        }

        if (!content) {
          const available = await ctx.docFetcher.listSectionIds(framework, effectiveVersion);
          let r = `Section "${sectionId}" not found for ${framework}.\n\n`;
          if (available.length > 0) {
            r += `Available sections: ${available.map(s => `\`${s}\``).join(', ')}\n`;
          } else {
            r += 'No sections available. Call `resolve-doc-url` to provide the documentation URL.\n';
          }
          return { content: [{ type: 'text' as const, text: r }] };
        }

        let r = '';
        if (effectiveVersion) r += `> Version: **${effectiveVersion}** detected in project\n\n`;
        r += content as string;

        return { content: [{ type: 'text' as const, text: r }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  ctx.server.tool(
    'fetch-external-docs',
    'Fetches the full assembled documentation for a framework. If the documentation URL hasn\'t been provided yet, you\'ll be prompted to call resolve-doc-url first.',
    {
      framework: z.string().describe('Framework key'),
      version: z.string().optional().describe('Override version'),
    },
    async ({ framework, version }) => {
      const effectiveVersion = version ?? findDetectedVersion(ctx, framework);
      const result = await ctx.docFetcher.fetchExternalDocs(framework, effectiveVersion);

      if (typeof result === 'object' && 'kind' in result && result.kind === 'needs-url') {
        return { content: [{ type: 'text' as const, text: formatNeedsUrl(result) }] };
      }

      return { content: [{ type: 'text' as const, text: result as string }] };
    }
  );
}
