import { z } from 'zod/v3';
import { toDocSections } from '../tree-builder/index.js';
import { ServerContext, findDetectedVersion } from './context.js';
import { formatTreeIndex } from './formatters.js';

export function registerResolveTools(ctx: ServerContext): void {
  ctx.server.tool(
    'resolve-doc-url',
    'Supply the official documentation URL for a framework. The server will fetch the page, convert HTML to markdown, parse it into sections, and cache it locally. Call this when get-doc-index or get-doc-section returns a "needs URL" message. You (the LLM) should determine the best documentation URL based on the framework name and version.',
    {
      framework: z.string().describe('Framework key (e.g. "spring-boot", "react", "hibernate")'),
      url: z.string().describe('The official documentation URL to fetch (e.g. "https://docs.spring.io/spring-boot/reference/")'),
      version: z.string().optional().describe('Framework version if applicable'),
    },
    async ({ framework, url, version }) => {
      const effectiveVersion = version ?? findDetectedVersion(ctx, framework);

      try {
        const sections = await ctx.docFetcher.supplyDocUrl(framework, url, effectiveVersion);

        let r = `# Documentation indexed: ${framework}`;
        if (effectiveVersion) r += ` v${effectiveVersion}`;
        r += '\n\n';
        r += `> Fetched from: ${url}\n`;
        r += `> Sections found: ${sections.length}\n\n`;

        if (sections.length === 0) {
          r += '⚠ No sections could be parsed from this URL. The page might use client-side rendering.\n';
          r += 'Try a different URL — look for a static HTML reference guide or a single-page documentation page.\n';
        } else {
          r += '## Section Index\n\n';
          const tree = toDocSections(sections);
          r += formatTreeIndex(tree);
          r += '\nUse `get-doc-section` with a section ID to fetch its full content.\n';
        }

        return { content: [{ type: 'text' as const, text: r }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error fetching ${url}: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );
}
