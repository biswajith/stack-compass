import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod/v3';
import { ServerContext } from './context.js';
import { moduleToDocSections, formatModuleMarkdown } from '../source-scanner/index.js';
import { formatTreeIndex } from './formatters.js';

/**
 * Strip absolute path prefixes from a string, leaving only project-relative paths.
 * Replaces occurrences of resolvedRoot (+ separator) with empty string.
 */
function sanitizePaths(text: string, resolvedRoot: string): string {
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return text.replaceAll(rootWithSep, '').replaceAll(resolvedRoot, '.');
}

export function registerSourceScanTools(ctx: ServerContext): void {

  ctx.server.tool(
    'configure-internal-patterns',
    'Configures which dependency patterns are considered "internal" to the monorepo. This lets the server detect cross-module dependencies within the same org. Call before scan-internal-source.',
    {
      mavenGroupPrefixes: z.array(z.string()).optional().describe('Maven group ID prefixes, e.g. ["com.company", "com.company.shared"]'),
      npmScopes: z.array(z.string()).optional().describe('npm scope prefixes, e.g. ["@company", "@myorg"]'),
      sbtOrgPrefixes: z.array(z.string()).optional().describe('SBT/Scala org prefixes, e.g. ["com.company"]'),
      customPatterns: z.array(z.string()).optional().describe('Additional regex patterns to match internal dependency names'),
    },
    async ({ mavenGroupPrefixes, npmScopes, sbtOrgPrefixes, customPatterns }) => {
      ctx.internalPatterns = {
        mavenGroupPrefixes: mavenGroupPrefixes ?? ctx.internalPatterns.mavenGroupPrefixes,
        npmScopes: npmScopes ?? ctx.internalPatterns.npmScopes,
        sbtOrgPrefixes: sbtOrgPrefixes ?? ctx.internalPatterns.sbtOrgPrefixes,
        customPatterns: customPatterns ?? ctx.internalPatterns.customPatterns,
      };
      ctx.internalDepsDetector.setPatterns(ctx.internalPatterns);

      let r = '# Internal Dependency Patterns Configured\n\n';
      if (ctx.internalPatterns.mavenGroupPrefixes.length)
        r += `- **Maven prefixes**: ${ctx.internalPatterns.mavenGroupPrefixes.join(', ')}\n`;
      if (ctx.internalPatterns.npmScopes.length)
        r += `- **npm scopes**: ${ctx.internalPatterns.npmScopes.join(', ')}\n`;
      if (ctx.internalPatterns.sbtOrgPrefixes.length)
        r += `- **SBT prefixes**: ${ctx.internalPatterns.sbtOrgPrefixes.join(', ')}\n`;
      if (ctx.internalPatterns.customPatterns.length)
        r += `- **Custom patterns**: ${ctx.internalPatterns.customPatterns.join(', ')}\n`;
      r += '\nNow call `scan-internal-source` with the project root to detect internal dependencies and scan their source code.\n';
      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  ctx.server.tool(
    'scan-internal-source',
    'Detects internal cross-module dependencies and scans their source code using Tree-sitter to extract classes, methods, interfaces, REST endpoints, and annotations. Produces documentation from source code for modules that have no published docs.',
    {
      projectPath: z.string().describe('Absolute path to the project root directory'),
      modulePaths: z.array(z.string()).optional().describe('Specific module paths to scan (relative to projectPath). If omitted, scans all modules with internal deps.'),
    },
    async ({ projectPath, modulePaths }) => {
      try {
        let resolvedRoot: string;
        try { resolvedRoot = fs.realpathSync(path.resolve(projectPath)); }
        catch { resolvedRoot = path.resolve(projectPath); }

        ctx.scannedModules.clear();
        ctx.detectedInternalDeps = [];

        const deps = ctx.internalDepsDetector.detect(resolvedRoot);
        ctx.detectedInternalDeps = ctx.internalDepsDetector.resolveSourcePaths(resolvedRoot, deps);

        let r = '# Internal Dependency Scan\n\n';

        if (ctx.detectedInternalDeps.length > 0) {
          r += `## Detected Internal Dependencies (${ctx.detectedInternalDeps.length})\n\n`;
          for (const dep of ctx.detectedInternalDeps) {
            const ver = dep.version ? `@${dep.version}` : '';
            const displayPath = dep.sourcePath ? path.relative(resolvedRoot, dep.sourcePath) || dep.sourcePath : null;
            const src = displayPath ? ` → source found at \`${displayPath}\`` : ' → source not found locally';
            r += `- \`${dep.artifact}${ver}\` (declared in **${dep.declaredIn}**, ${dep.ecosystem})${src}\n`;
          }
          r += '\n';
        } else {
          r += 'No internal dependencies detected. ';
          if (ctx.internalPatterns.mavenGroupPrefixes.length === 0 &&
              ctx.internalPatterns.npmScopes.length === 0 &&
              ctx.internalPatterns.sbtOrgPrefixes.length === 0) {
            r += 'Call `configure-internal-patterns` first to define which dependencies are internal.\n';
          } else {
            r += 'No dependencies matched the configured internal patterns.\n';
          }
          r += '\n';
        }

        const pathsToScan = modulePaths ?? [
          ...ctx.detectedInternalDeps
            .filter(d => d.sourcePath)
            .map(d => d.sourcePath!),
        ];

        const scanWarnings: string[] = [];

        if (pathsToScan.length > 0) {
          r += `## Source Code Scan (${pathsToScan.length} modules)\n\n`;
          for (const mp of pathsToScan) {
            let realModulePath: string;
            try { realModulePath = fs.realpathSync(path.resolve(resolvedRoot, mp)); }
            catch { realModulePath = path.resolve(resolvedRoot, mp); }
            const rel = path.relative(resolvedRoot, realModulePath);
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
              r += `### ${mp}\n- Rejected: path escapes project root\n\n`;
              continue;
            }
            const moduleName = rel || path.basename(realModulePath);
            try {
              const scanned = await ctx.sourceScanner.scanModule(realModulePath, moduleName);
              scanWarnings.push(...ctx.sourceScanner.warnings);
              ctx.scannedModules.set(moduleName, scanned);
              const baseName = path.basename(realModulePath);
              if (baseName !== moduleName && !ctx.scannedModules.has(baseName)) {
                ctx.scannedModules.set(baseName, scanned);
              }
              const s = scanned.summary;
              r += `### ${moduleName}\n`;
              r += `- Language: ${scanned.language} | Files: ${s.totalFiles} | Symbols: ${s.totalSymbols}\n`;
              r += `- Classes: ${s.publicClasses.length} | Interfaces: ${s.publicInterfaces.length} | Methods: ${s.publicMethods}\n`;
              if (s.restEndpoints.length) r += `- REST endpoints: ${s.restEndpoints.length}\n`;
              if (s.entities.length) r += `- Entities: ${s.entities.join(', ')}\n`;
              if (s.annotations.length) r += `- Annotations: ${s.annotations.slice(0, 10).join(', ')}${s.annotations.length > 10 ? '...' : ''}\n`;
              r += '\n';
            } catch (err) {
              const errMsg = sanitizePaths(err instanceof Error ? err.message : String(err), resolvedRoot);
              r += `### ${moduleName}\n- Error scanning: ${errMsg}\n\n`;
            }
          }
        }

        const allWarnings = [
          ...ctx.internalDepsDetector.warnings,
          ...scanWarnings,
        ];
        if (allWarnings.length > 0) {
          r += `## Warnings (${allWarnings.length})\n\n`;
          for (const w of allWarnings.slice(0, 20)) r += `- ${sanitizePaths(w, resolvedRoot)}\n`;
          if (allWarnings.length > 20) r += `- ... and ${allWarnings.length - 20} more\n`;
          r += '\n';
        }

        r += '## Next Steps\n\n';
        r += '- `get-internal-api` — get the full API documentation tree for any scanned module\n';
        r += '- `list-internal-deps` — list all detected cross-module internal dependencies\n';
        return { content: [{ type: 'text' as const, text: r }] };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Error: ${errMsg.replace(/\/[\w/.-]+/g, '<path>')}` }], isError: true };
      }
    }
  );

  ctx.server.tool(
    'get-internal-api',
    'Returns the API documentation tree for an internally scanned module. Shows classes, interfaces, methods, REST endpoints, and annotations extracted from source code via Tree-sitter. Use scan-internal-source first.',
    {
      moduleName: z.string().describe('Name of the scanned module'),
      format: z.enum(['tree', 'full']).optional().describe('"tree" returns section index only (default), "full" returns complete markdown with all signatures'),
    },
    async ({ moduleName, format }) => {
      const scanned = ctx.scannedModules.get(moduleName);
      if (!scanned) {
        const available = Array.from(ctx.scannedModules.keys());
        let msg = `Module "${moduleName}" has not been scanned yet.\n`;
        if (available.length > 0) {
          msg += `\nAvailable scanned modules: ${available.map(a => `\`${a}\``).join(', ')}\n`;
        } else {
          msg += 'Call `scan-internal-source` first to scan module source code.\n';
        }
        return { content: [{ type: 'text' as const, text: msg }] };
      }

      if (format === 'full') {
        const markdown = formatModuleMarkdown(scanned);
        return { content: [{ type: 'text' as const, text: markdown }] };
      }

      const sections = moduleToDocSections(scanned);
      let r = `# ${scanned.name} — Internal API\n\n`;
      r += `> Language: ${scanned.language} | Files: ${scanned.summary.totalFiles} | Symbols: ${scanned.summary.totalSymbols}\n\n`;
      r += '## API Sections\n\n';
      r += formatTreeIndex(sections);
      r += '\nUse `get-internal-api` with `format: "full"` for complete details.\n';

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  ctx.server.tool(
    'list-internal-deps',
    'Lists all detected internal cross-module dependencies. Call scan-internal-source first.',
    {},
    async () => {
      if (ctx.detectedInternalDeps.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No internal dependencies detected. Call `scan-internal-source` first.' }] };
      }

      let r = `# Internal Dependencies (${ctx.detectedInternalDeps.length})\n\n`;

      const byModule = new Map<string, typeof ctx.detectedInternalDeps>();
      for (const dep of ctx.detectedInternalDeps) {
        const list = byModule.get(dep.declaredIn) ?? [];
        list.push(dep);
        byModule.set(dep.declaredIn, list);
      }

      for (const [module, deps] of byModule) {
        r += `## ${module}\n`;
        for (const dep of deps) {
          const ver = dep.version ? `@${dep.version}` : '';
          let scanned = false;
          if (dep.sourcePath) {
            const baseName = path.basename(dep.sourcePath);
            scanned = ctx.scannedModules.has(baseName) ||
              Array.from(ctx.scannedModules.keys()).some(k =>
                k === dep.sourcePath || dep.sourcePath!.endsWith(path.sep + k) || dep.sourcePath!.endsWith('/' + k)
              );
          }
          const status = dep.sourcePath ? (scanned ? 'scanned' : 'source found') : 'external only';
          r += `- \`${dep.artifact}${ver}\` (${dep.ecosystem}) — ${status}\n`;
        }
        r += '\n';
      }

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );
}
