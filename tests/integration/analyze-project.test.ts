import path from 'path';
import { setupClient, getText, assertIncludes, assertNotEmpty } from '../helpers.js';

export async function testAnalyzeProject() {
  console.log('\n── Integration: analyze-project ────────────────────');
  const client = await setupClient();
  const projectPath = path.resolve(import.meta.dirname!, '../..');

  const r = getText(await client.callTool({ name: 'analyze-project', arguments: { projectPath } }));
  assertIncludes('Detects typescript', r, 'typescript');
  assertIncludes('Detects npm', r, 'npm');
  assertIncludes('Shows Build Tools', r, 'Build Tools');
  assertIncludes('Shows get-doc-index in next steps', r, 'get-doc-index');
  assertIncludes('Shows resolve-doc-url in next steps', r, 'resolve-doc-url');
  assertNotEmpty('Analysis has substance', r);

  // Stateful: list-detected-frameworks should work after analyze
  const detected = getText(await client.callTool({ name: 'list-detected-frameworks', arguments: {} }));
  assertIncludes('Lists typescript after analyze', detected, 'typescript');

  // Stateful: get-project-stack should work after analyze
  const stack = getText(await client.callTool({ name: 'get-project-stack', arguments: {} }));
  assertIncludes('Shows root path', stack, 'pom-to-doc-mcp');

  // Before analyze: should tell user to analyze first
  const client2 = await setupClient();
  const noAnalyze = getText(await client2.callTool({ name: 'list-detected-frameworks', arguments: {} }));
  assertIncludes('Before analyze: prompts user', noAnalyze, 'analyze-project');

  await client.close();
  await client2.close();
}
