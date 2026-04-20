import { printReport, passed, failed } from './helpers.js';

// Unit tests
import { testTreeBuilder } from './unit/tree-builder.test.js';
import { testDiskCache } from './unit/disk-cache.test.js';
import { testSourceScanner } from './unit/source-scanner.test.js';
import { testInternalDeps } from './unit/internal-deps.test.js';
import { testGitHubToken } from './unit/github-token.test.js';
import { testUrlFetcher } from './unit/url-fetcher.test.js';
import { testGraphStore } from './unit/graph-store.test.js';
import { testEdgeResolvers } from './unit/edge-resolvers.test.js';
import { testGraphTraversal } from './unit/graph-traversal.test.js';
import { testCrossLanguage } from './unit/cross-language.test.js';
import { testIncrementalSync, testFileWatcher } from './unit/incremental-sync.test.js';
import { testGraphSafety } from './unit/code-review-fixes.test.js';
import { testGraphResilience } from './unit/graph-resilience.test.js';

// Integration tests
import { testAnalyzeProject } from './integration/analyze-project.test.js';
import { testResolveDocUrl } from './integration/resolve-doc-url.test.js';
import { testDocIndex } from './integration/doc-index.test.js';
import { testDocSection } from './integration/doc-section.test.js';
import { testFrameworkManagement } from './integration/framework-management.test.js';
import { testSupportedFrameworks } from './integration/supported-frameworks.test.js';
import { testSourceScanTools } from './integration/source-scan-tools.test.js';
import { testGraphTools } from './integration/graph-tools.test.js';
import { testGraphTraversalTools } from './integration/graph-traversal-tools.test.js';
import { testGraphPerformance } from './integration/graph-performance.test.js';

// Workflow tests
import { testFullWorkflow } from './workflow/full-workflow.test.js';

// Scenario tests
import { testRealWorldDiscovery } from './scenario/real-world-discovery.test.js';
import { testUsagePatternSearch } from './scenario/usage-pattern-search.test.js';
import { testInternalApiSearch } from './scenario/internal-api-search.test.js';

async function run() {
  console.log('=========================================');
  console.log('Stack Compass — Test Suite');
  console.log('=========================================');

  // Unit
  testTreeBuilder();
  testDiskCache();
  await testSourceScanner();
  await testInternalDeps();
  testGitHubToken();
  testUrlFetcher();
  await testGraphStore();
  await testEdgeResolvers();
  await testGraphTraversal();
  await testCrossLanguage();
  await testIncrementalSync();
  await testFileWatcher();
  await testGraphSafety();
  await testGraphResilience();

  // Integration
  await testAnalyzeProject();
  await testResolveDocUrl();
  await testDocIndex();
  await testDocSection();
  await testFrameworkManagement();
  await testSupportedFrameworks();
  await testSourceScanTools();
  await testGraphTools();
  await testGraphTraversalTools();
  await testGraphPerformance();

  // Workflow (mock LLM ↔ MCP server conversation)
  await testFullWorkflow();

  // Scenarios (real-world framework discovery + usage pattern search)
  await testRealWorldDiscovery();
  await testUsagePatternSearch();
  await testInternalApiSearch();

  printReport();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(2);
});
