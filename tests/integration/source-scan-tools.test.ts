import { setupClient, getText, assert, assertIncludes, assertNotEmpty } from '../helpers.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

export async function testSourceScanTools() {
  console.log('\n--- Integration: Source Scan MCP Tools ---');
  const client = await setupClient();

  // configure-internal-patterns
  {
    const res = getText(await client.callTool({
      name: 'configure-internal-patterns',
      arguments: {
        mavenGroupPrefixes: ['com.company'],
        npmScopes: ['@company'],
      },
    }));
    assertIncludes('configure: confirms maven', res, 'com.company');
    assertIncludes('configure: confirms npm', res, '@company');
    assertIncludes('configure: suggests next step', res, 'scan-internal-source');
  }

  // scan-internal-source on this repo (no internal deps expected, but source scan should work)
  {
    const res = getText(await client.callTool({
      name: 'scan-internal-source',
      arguments: {
        projectPath: PROJECT_ROOT,
        modulePaths: ['src'],
      },
    }));
    assertIncludes('scan: Source Code Scan header', res, 'Source Code Scan');
    assertIncludes('scan: found src module', res, 'src');
    assertIncludes('scan: reports language', res, 'typescript');
    assertIncludes('scan: reports files', res, 'Files:');
    assertIncludes('scan: reports symbols', res, 'Symbols:');
    assertIncludes('scan: suggests next steps', res, 'get-internal-api');
  }

  // get-internal-api with tree format (default)
  {
    const res = getText(await client.callTool({
      name: 'get-internal-api',
      arguments: { moduleName: 'src' },
    }));
    assertIncludes('api-tree: has title', res, 'Internal API');
    assertIncludes('api-tree: has section IDs', res, '[`');
    assertIncludes('api-tree: has overview', res, 'Overview');
    assert('api-tree: substantial content', res.length > 500, `only ${res.length} chars`);
  }

  // get-internal-api with full format
  {
    const res = getText(await client.callTool({
      name: 'get-internal-api',
      arguments: { moduleName: 'src', format: 'full' },
    }));
    assertIncludes('api-full: has classes', res, 'ProjectAnalyzer');
    assertIncludes('api-full: has interfaces', res, 'DetectedFramework');
    assertIncludes('api-full: has method signatures', res, 'analyze');
    assert('api-full: substantial content', res.length > 3000, `only ${res.length} chars`);
  }

  // get-internal-api for non-existent module
  {
    const res = getText(await client.callTool({
      name: 'get-internal-api',
      arguments: { moduleName: 'nonexistent' },
    }));
    assertIncludes('api-missing: error message', res, 'not been scanned');
    assertIncludes('api-missing: lists available', res, 'src');
  }

  // path traversal protection — relative escape
  {
    const res = getText(await client.callTool({
      name: 'scan-internal-source',
      arguments: {
        projectPath: PROJECT_ROOT,
        modulePaths: ['../../etc'],
      },
    }));
    assertIncludes('traversal: rejected', res, 'Rejected');
    assertIncludes('traversal: escapes root', res, 'escapes project root');
  }

  // path traversal protection — startsWith bypass (e.g. /tmp/proj vs /tmp/project)
  {
    const res = getText(await client.callTool({
      name: 'scan-internal-source',
      arguments: {
        projectPath: PROJECT_ROOT,
        modulePaths: [`../${path.basename(PROJECT_ROOT)}ect/sub`],
      },
    }));
    assertIncludes('traversal-startsWith: rejected', res, 'Rejected');
  }

  // list-internal-deps (no patterns matched in this repo)
  {
    const res = getText(await client.callTool({
      name: 'list-internal-deps',
      arguments: {},
    }));
    // This repo doesn't have com.company or @company deps
    assertIncludes('list-deps: appropriate message', res, 'No internal dependencies');
  }

  // Test with a synthetic monorepo that has internal deps
  await testWithSyntheticMonorepo(client);
}

async function testWithSyntheticMonorepo(client: Awaited<ReturnType<typeof setupClient>>) {
  console.log('  Synthetic monorepo with internal deps...');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-integ-'));

  // Create shared lib
  const sharedDir = path.join(tmpDir, 'shared-models');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(sharedDir, 'pom.xml'), '<project></project>');
  fs.writeFileSync(path.join(sharedDir, 'User.java'), `
package com.acme.shared.models;

/**
 * Represents a user in the system.
 */
public class User {
    private String id;
    private String name;
    private String email;

    public String getId() { return id; }
    public String getName() { return name; }
    public String getEmail() { return email; }
    public void setName(String name) { this.name = name; }
}
`);

  // Create API module
  const apiDir = path.join(tmpDir, 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'pom.xml'), `
<project>
  <dependencies>
    <dependency>
      <groupId>com.acme.shared</groupId>
      <artifactId>shared-models</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`);

  // Reconfigure patterns
  await client.callTool({
    name: 'configure-internal-patterns',
    arguments: { mavenGroupPrefixes: ['com.acme'] },
  });

  // Scan with internal deps
  const scanRes = getText(await client.callTool({
    name: 'scan-internal-source',
    arguments: {
      projectPath: tmpDir,
      modulePaths: ['shared-models'],
    },
  }));

  assertIncludes('synth: scan reports shared-models', scanRes, 'shared-models');

  // Check the scanned API
  const apiRes = getText(await client.callTool({
    name: 'get-internal-api',
    arguments: { moduleName: 'shared-models', format: 'full' },
  }));
  assertIncludes('synth: User class found', apiRes, 'User');
  assertIncludes('synth: getId method found', apiRes, 'getId');
  assertIncludes('synth: doc comment found', apiRes, 'user in the system');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}
