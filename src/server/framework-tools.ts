import { z } from 'zod/v3';
import { FRAMEWORK_DOCS, FrameworkDocEntry } from '../types/index.js';
import { ServerContext } from './context.js';

export function registerFrameworkTools(ctx: ServerContext): void {
  ctx.server.tool(
    'add-framework',
    'Registers a new framework so the server knows about it. You can optionally provide a documentation URL, or call resolve-doc-url later to supply one.',
    {
      key: z.string().describe('Framework key (e.g. "my-internal-lib")'),
      description: z.string().describe('Short description'),
      github: z.string().optional().describe('GitHub repo in "owner/repo" format'),
      llmsTxt: z.string().optional().describe('URL to llms.txt file'),
      minMajor: z.number().optional().describe('Minimum major version (inclusive)'),
      maxMajor: z.number().optional().describe('Maximum major version (exclusive)'),
    },
    async ({ key, description, github, llmsTxt, minMajor, maxMajor }) => {
      const existing = ctx.docFetcher.listCustomFrameworks().get(key);
      const entry: FrameworkDocEntry = existing ?? { versions: [] };
      entry.versions.push({ description, github, llmsTxt, minMajor, maxMajor });
      entry.versions.sort((a, b) => (a.minMajor ?? 0) - (b.minMajor ?? 0));
      ctx.docFetcher.addFramework(key, entry);

      let r = `# Framework Registered: ${key}\n\n`;
      r += `- **Description**: ${description}\n`;
      if (github) r += `- **GitHub**: ${github}\n`;
      if (minMajor !== undefined) r += `- **Version range**: ${minMajor}.x${maxMajor !== undefined ? ` to ${maxMajor - 1}.x` : '+'}\n`;
      r += `\nTotal version entries: ${entry.versions.length}\n`;
      r += '\nCall `resolve-doc-url` to supply the documentation URL for this framework.\n';
      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  ctx.server.tool(
    'remove-framework',
    'Removes a custom-registered framework and its cached documentation. Built-in frameworks cannot be removed.',
    {
      key: z.string().describe('Framework key to remove'),
    },
    async ({ key }) => {
      const removed = ctx.docFetcher.removeFramework(key);
      return { content: [{ type: 'text' as const, text: removed ? `Removed \`${key}\`.` : `No custom framework \`${key}\` found.` }] };
    }
  );

  ctx.server.tool(
    'list-all-supported-frameworks',
    'Lists ALL frameworks with version ranges this server knows about.',
    {},
    async () => {
      const allKeys = ctx.docFetcher.listAvailableFrameworks();
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
        const entry = FRAMEWORK_DOCS[key] ?? ctx.docFetcher.listCustomFrameworks().get(key);
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
}
