import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DocFetcher } from '../fetcher/index.js';
import { APP_NAME, APP_VERSION } from '../version.js';
import { ServerContext } from './context.js';
import { registerAnalysisTools } from './analysis-tools.js';
import { registerDocTools } from './doc-tools.js';
import { registerResolveTools } from './resolve-tools.js';
import { registerFrameworkTools } from './framework-tools.js';

export function createServer() {
  const server = new McpServer({ name: APP_NAME, version: APP_VERSION }, { capabilities: { tools: {} } });
  const ctx: ServerContext = {
    server,
    docFetcher: new DocFetcher(),
    currentStack: null,
    currentConfig: null,
  };

  registerAnalysisTools(ctx);
  registerDocTools(ctx);
  registerResolveTools(ctx);
  registerFrameworkTools(ctx);

  return server;
}
