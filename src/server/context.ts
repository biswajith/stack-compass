import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DocFetcher } from '../fetcher/index.js';
import { ProjectStack, MonorepoConfig } from '../types/index.js';

export interface ServerContext {
  server: McpServer;
  docFetcher: DocFetcher;
  currentStack: ProjectStack | null;
  currentConfig: MonorepoConfig | null;
}

export function findDetectedVersion(ctx: ServerContext, docKey: string): string | undefined {
  if (!ctx.currentStack) return undefined;
  for (const mod of ctx.currentStack.modules) {
    for (const f of mod.frameworks) {
      if ((f.docKey === docKey || f.name === docKey) && f.version) return f.version;
    }
  }
  return undefined;
}
