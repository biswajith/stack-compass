import { printReport, passed, failed } from './helpers.js';

// Unit tests
import { testTreeBuilder } from './unit/tree-builder.test.js';
import { testDiskCache } from './unit/disk-cache.test.js';

// Integration tests
import { testAnalyzeProject } from './integration/analyze-project.test.js';
import { testResolveDocUrl } from './integration/resolve-doc-url.test.js';
import { testDocIndex } from './integration/doc-index.test.js';
import { testDocSection } from './integration/doc-section.test.js';
import { testFrameworkManagement } from './integration/framework-management.test.js';
import { testSupportedFrameworks } from './integration/supported-frameworks.test.js';

// Workflow tests
import { testFullWorkflow } from './workflow/full-workflow.test.js';

// Scenario tests
import { testRealWorldDiscovery } from './scenario/real-world-discovery.test.js';
import { testUsagePatternSearch } from './scenario/usage-pattern-search.test.js';

async function run() {
  console.log('=========================================');
  console.log('Stack Compass — Test Suite');
  console.log('=========================================');

  // Unit
  testTreeBuilder();
  testDiskCache();

  // Integration
  await testAnalyzeProject();
  await testResolveDocUrl();
  await testDocIndex();
  await testDocSection();
  await testFrameworkManagement();
  await testSupportedFrameworks();

  // Workflow (mock LLM ↔ MCP server conversation)
  await testFullWorkflow();

  // Scenarios (real-world framework discovery + usage pattern search)
  await testRealWorldDiscovery();
  await testUsagePatternSearch();

  printReport();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(2);
});
