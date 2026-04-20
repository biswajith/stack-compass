import * as fs from 'fs';
import { z } from 'zod/v3';
import { ServerContext } from './context.js';
import { getCallers, getCallees, getImpact, buildContext } from '../graph/traversal.js';

function requireGraphStore(ctx: ServerContext) {
  if (!ctx.graphStore) {
    return {
      ok: false as const,
      error: {
        content: [{ type: 'text' as const, text: 'Knowledge graph not initialized. Run `scan-internal-source` first to populate the graph.' }],
        isError: true,
      },
    };
  }
  return { ok: true as const, store: ctx.graphStore };
}

function timeAgo(epochSeconds: number): string {
  const diff = Date.now() - (epochSeconds * 1000);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function registerGraphTools(ctx: ServerContext): void {

  // ── graph-status ─────────────────────────────────────────────────────

  ctx.server.tool(
    'graph-status',
    'Check knowledge graph index health and freshness. Shows total nodes, edges, files, and last scan time. No arguments needed.',
    {},
    async () => {
      const check = requireGraphStore(ctx);
      if (!check.ok) return check.error;

      const stats = check.store.getStats();
      const lastScan = stats.lastScanEpoch
        ? `Last scan: ${timeAgo(stats.lastScanEpoch)}`
        : 'Last scan: never';

      let staleFiles = 0;
      try {
        const { IncrementalSync } = await import('../graph/sync.js');
        const sync = new IncrementalSync(check.store);
        staleFiles = sync.getStaleFileCount();
      } catch { /* sync module may fail in edge cases */ }

      const r = [
        '# Knowledge Graph Status\n',
        `- **Nodes:** ${stats.totalNodes}`,
        `- **Edges:** ${stats.totalEdges}`,
        `- **Files:** ${stats.totalFiles}`,
        `- **Stale files:** ${staleFiles}`,
        `- ${lastScan}`,
      ].join('\n');

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  // ── search-symbols ───────────────────────────────────────────────────

  ctx.server.tool(
    'search-symbols',
    'Full-text search across all indexed code symbols. Uses FTS5 for fast fuzzy matching. Optional filters by kind (class, method, interface, etc.) and module name.',
    {
      query: z.string().describe('Search query, e.g. "UserService" or "create*"'),
      kind: z.string().optional().describe('Filter by symbol kind: class, method, interface, field, enum, etc.'),
      module: z.string().optional().describe('Filter by module name'),
      limit: z.number().optional().describe('Max results to return (default 20)'),
    },
    async ({ query, kind, module, limit }) => {
      const check = requireGraphStore(ctx);
      if (!check.ok) return check.error;

      try {
        const results = check.store.searchSymbols(query, { kind, module, limit: limit ?? 20 });

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: `No symbols found matching "${query}".` }] };
        }

        let r = `# Search Results for "${query}"\n\n`;
        r += `Found ${results.length} symbol${results.length === 1 ? '' : 's'}:\n\n`;
        r += '| Name | Kind | Module | File | Line | Signature |\n';
        r += '|------|------|--------|------|------|-----------|\n';

        for (const s of results) {
          const filePath = s.file_path ?? '?';
          const mod = s.module ?? '-';
          const sig = s.signature ? `\`${s.signature}\`` : '-';
          r += `| ${s.name} | ${s.kind} | ${mod} | ${filePath} | ${s.start_line} | ${sig} |\n`;
        }

        return { content: [{ type: 'text' as const, text: r }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Search error: ${msg}` }], isError: true };
      }
    }
  );

  // ── get-symbol-detail ────────────────────────────────────────────────

  ctx.server.tool(
    'get-symbol-detail',
    'Get full details for a code symbol: kind, file, line range, signature, doc comment, annotations, children, callers, callees, and REST endpoints. Optionally includes source code snippet.',
    {
      symbolName: z.string().max(300).describe('Exact symbol name, e.g. "UserController"'),
      module: z.string().max(200).optional().describe('Module name to disambiguate when multiple symbols share a name'),
      includeSource: z.boolean().optional().describe('Include the source code snippet from disk (default false)'),
    },
    async ({ symbolName, module, includeSource }) => {
      const check = requireGraphStore(ctx);
      if (!check.ok) return check.error;

      const nodes = check.store.getNodesByName(symbolName, { module });

      if (nodes.length === 0) {
        let msg = `Symbol "${symbolName}" not found in the knowledge graph.`;
        if (module) msg += ` (filtered to module "${module}")`;
        return { content: [{ type: 'text' as const, text: msg }] };
      }

      const parts: string[] = [];

      for (const node of nodes) {
        const file = check.store.getFileById(node.file_id);
        const filePath = file?.path ?? '?';
        const annotations = check.store.getAnnotations(node.id);
        const children = check.store.getChildNodes(node.id);
        const edgesOut = check.store.getEdgesFrom(node.id);
        const edgesIn = check.store.getEdgesTo(node.id);
        const restEndpoints = check.store.getRestEndpointsByNodeId(node.id);

        let r = `# ${node.name}\n\n`;
        r += `- **Kind:** ${node.kind}\n`;
        r += `- **Module:** ${node.module ?? '-'}\n`;
        r += `- **File:** ${filePath}\n`;
        r += `- **Lines:** ${node.start_line}–${node.end_line}\n`;
        r += `- **Visibility:** ${node.visibility}\n`;

        if (node.qualified) r += `- **Qualified:** ${node.qualified}\n`;
        if (node.signature) r += `- **Signature:** ${node.signature}\n`;

        if (node.doc_comment) {
          r += `\n## Doc Comment\n\n${node.doc_comment}\n`;
        }

        if (annotations.length > 0) {
          r += `\n## Annotations\n\n`;
          for (const a of annotations) {
            r += `- \`@${a.name}\``;
            if (a.value) r += ` (${a.value})`;
            r += '\n';
          }
        }

        if (children.length > 0) {
          r += `\n## Children\n\n`;
          r += '| Name | Kind | Line |\n';
          r += '|------|------|------|\n';
          for (const c of children) {
            r += `| ${c.name} | ${c.kind} | ${c.start_line} |\n`;
          }
        }

        if (restEndpoints.length > 0) {
          r += `\n## REST Endpoints\n\n`;
          for (const ep of restEndpoints) {
            r += `- \`${ep.method} ${ep.path}\`\n`;
          }
        }

        if (edgesIn.length > 0) {
          r += `\n## Incoming Edges\n\n`;
          for (const e of edgesIn) {
            const src = check.store.getNodeById(e.source_id);
            r += `- ${src?.name ?? `node#${e.source_id}`} (${e.kind})\n`;
          }
        }

        if (edgesOut.length > 0) {
          r += `\n## Outgoing Edges\n\n`;
          for (const e of edgesOut) {
            const tgt = check.store.getNodeById(e.target_id);
            r += `- ${tgt?.name ?? `node#${e.target_id}`} (${e.kind})\n`;
          }
        }

        if (includeSource && file) {
          r += `\n## Source\n\n`;
          try {
            const lines = fs.readFileSync(file.path, 'utf-8').split('\n');
            const start = Math.max(0, node.start_line - 1);
            const end = Math.min(lines.length, node.end_line);
            const snippet = lines.slice(start, end).join('\n');
            r += '```\n' + snippet + '\n```\n';
          } catch {
            r += `_Source file not available on disk: \`${file.path}\`_\n`;
          }
        }

        parts.push(r);
      }

      return { content: [{ type: 'text' as const, text: parts.join('\n---\n\n') }] };
    }
  );

  // ── get-callers ─────────────────────────────────────────────────────

  ctx.server.tool(
    'get-callers',
    'Find all callers of a symbol. Traverses call edges in reverse up to the specified depth. Returns the call chain showing who calls this symbol and who calls those callers.',
    {
      symbolName: z.string().describe('Symbol name to find callers for, e.g. "createUser"'),
      module: z.string().optional().describe('Module name to disambiguate'),
      depth: z.number().optional().describe('Max traversal depth (default 2)'),
    },
    async ({ symbolName, module, depth }) => {
      const check = requireGraphStore(ctx);
      if (!check.ok) return check.error;

      const entries = getCallers(check.store, symbolName, depth ?? 2, module);

      if (entries.length === 0) {
        const nodes = check.store.getNodesByName(symbolName);
        if (nodes.length === 0) {
          return { content: [{ type: 'text' as const, text: `Symbol "${symbolName}" not found in the knowledge graph.` }] };
        }
        return { content: [{ type: 'text' as const, text: `No callers found for "${symbolName}".` }] };
      }

      let r = `# Callers of "${symbolName}"\n\n`;
      r += `| Name | Kind | File | Line | Edge | Depth |\n`;
      r += `|------|------|------|------|------|-------|\n`;
      for (const e of entries) {
        r += `| ${e.name} | ${e.kind} | ${e.file} | ${e.line} | ${e.edgeKind} | ${e.depth} |\n`;
      }

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  // ── get-callees ─────────────────────────────────────────────────────

  ctx.server.tool(
    'get-callees',
    'Find all callees of a symbol. Traverses call edges forward up to the specified depth. Returns the call chain showing what this symbol calls and what those callees call.',
    {
      symbolName: z.string().describe('Symbol name to find callees for, e.g. "handlePost"'),
      module: z.string().optional().describe('Module name to disambiguate'),
      depth: z.number().optional().describe('Max traversal depth (default 2)'),
    },
    async ({ symbolName, module, depth }) => {
      const check = requireGraphStore(ctx);
      if (!check.ok) return check.error;

      const entries = getCallees(check.store, symbolName, depth ?? 2, module);

      if (entries.length === 0) {
        const nodes = check.store.getNodesByName(symbolName);
        if (nodes.length === 0) {
          return { content: [{ type: 'text' as const, text: `Symbol "${symbolName}" not found in the knowledge graph.` }] };
        }
        return { content: [{ type: 'text' as const, text: `No callees found for "${symbolName}".` }] };
      }

      let r = `# Callees of "${symbolName}"\n\n`;
      r += `| Name | Kind | File | Line | Edge | Depth |\n`;
      r += `|------|------|------|------|------|-------|\n`;
      for (const e of entries) {
        r += `| ${e.name} | ${e.kind} | ${e.file} | ${e.line} | ${e.edgeKind} | ${e.depth} |\n`;
      }

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  // ── get-impact ──────────────────────────────────────────────────────

  ctx.server.tool(
    'get-impact',
    'Analyze the blast radius of changing a symbol. Traverses ALL edge types (calls, imports, extends, implements, renders) in reverse to find every symbol affected by a change. Shows direct and transitive impact counts.',
    {
      symbolName: z.string().describe('Symbol name to analyze impact for, e.g. "UserService"'),
      module: z.string().optional().describe('Module name to disambiguate'),
      depth: z.number().optional().describe('Max traversal depth (default 3)'),
    },
    async ({ symbolName, module, depth }) => {
      const check = requireGraphStore(ctx);
      if (!check.ok) return check.error;

      const result = getImpact(check.store, symbolName, depth ?? 3, module);

      if (result.nodes.length === 0) {
        const nodes = check.store.getNodesByName(symbolName);
        if (nodes.length === 0) {
          return { content: [{ type: 'text' as const, text: `Symbol "${symbolName}" not found in the knowledge graph.` }] };
        }
        return { content: [{ type: 'text' as const, text: `No impact found for "${symbolName}" — nothing depends on it.` }] };
      }

      let r = `# Affected by change to "${symbolName}"\n\n`;
      r += `**${result.directCount} direct, ${result.transitiveCount} transitive**\n\n`;
      r += `| Name | Kind | File | Line | Edge | Depth |\n`;
      r += `|------|------|------|------|------|-------|\n`;
      for (const n of result.nodes) {
        r += `| ${n.name} | ${n.kind} | ${n.file} | ${n.line} | ${n.edgeKind} | ${n.depth} |\n`;
      }

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );

  // ── build-context ───────────────────────────────────────────────────

  ctx.server.tool(
    'build-context',
    'Task-driven context assembly. Given a natural language task description, finds the most relevant symbols using FTS5 search, expands via graph edges, scores by relevance, and returns source code snippets. The power tool for understanding code before making changes.',
    {
      task: z.string().describe('Natural language task description, e.g. "fix the login endpoint"'),
      maxNodes: z.number().optional().describe('Max symbols to return (default 20)'),
    },
    async ({ task, maxNodes }) => {
      const check = requireGraphStore(ctx);
      if (!check.ok) return check.error;

      const entries = buildContext(check.store, task, maxNodes ?? 20);

      if (entries.length === 0) {
        return { content: [{ type: 'text' as const, text: `No relevant symbols found for task: "${task}".` }] };
      }

      let r = `# Context for: "${task}"\n\n`;
      r += `Found ${entries.length} relevant symbol${entries.length === 1 ? '' : 's'}:\n\n`;

      for (const e of entries) {
        r += `### ${e.name} (${e.kind})\n\n`;
        r += `- **File:** ${e.file}\n`;
        r += `- **Lines:** ${e.startLine}–${e.endLine}\n`;
        r += `- **Module:** ${e.module ?? '-'}\n`;
        r += `- **Score:** ${e.score.toFixed(2)}\n`;
        if (e.signature) r += `- **Signature:** \`${e.signature}\`\n`;

        if (e.source) {
          r += `\n\`\`\`\n${e.source}\n\`\`\`\n\n`;
        }
      }

      return { content: [{ type: 'text' as const, text: r }] };
    }
  );
}
