import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DocFetcher } from '../fetcher/index.js';
import { APP_NAME, APP_VERSION } from '../version.js';
import { SourceScanner } from '../source-scanner/index.js';
import { InternalDepsDetector, DEFAULT_PATTERNS } from '../internal-deps/index.js';
import { ServerContext } from './context.js';
import { registerAnalysisTools } from './analysis-tools.js';
import { registerDocTools } from './doc-tools.js';
import { registerResolveTools } from './resolve-tools.js';
import { registerFrameworkTools } from './framework-tools.js';
import { registerSourceScanTools } from './source-scan-tools.js';

export function createServer() {
  const server = new McpServer({ name: APP_NAME, version: APP_VERSION }, { capabilities: { tools: {} } });
  const ctx: ServerContext = {
    server,
    docFetcher: new DocFetcher(),
    currentStack: null,
    currentConfig: null,
    sourceScanner: new SourceScanner(),
    internalDepsDetector: new InternalDepsDetector(DEFAULT_PATTERNS),
    internalPatterns: { ...DEFAULT_PATTERNS },
    scannedModules: new Map(),
    detectedInternalDeps: [],
  };

  registerAnalysisTools(ctx);
  registerDocTools(ctx);
  registerResolveTools(ctx);
  registerFrameworkTools(ctx);
  registerSourceScanTools(ctx);

  return server;
}
