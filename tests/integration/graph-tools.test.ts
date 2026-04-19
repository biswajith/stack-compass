import { setupClient, getText, assert, assertIncludes } from '../helpers.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export async function testGraphTools() {
  console.log('\n--- Integration: Graph Query MCP Tools ---');

  const client = await setupClient();

  // Create a synthetic project with Java and TypeScript files
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-tools-'));

  const apiDir = path.join(tmpDir, 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'pom.xml'), '<project></project>');

  fs.writeFileSync(path.join(apiDir, 'UserController.java'), `
package com.acme.api;

import org.springframework.web.bind.annotation.*;

/**
 * REST controller for user operations.
 */
@RestController
@RequestMapping("/api/users")
public class UserController {

    @Autowired
    private UserService userService;

    @GetMapping("/{id}")
    public User getUser(@PathVariable String id) {
        return userService.findById(id);
    }

    @PostMapping
    public User createUser(@RequestBody User user) {
        return userService.create(user);
    }
}
`);

  fs.writeFileSync(path.join(apiDir, 'UserService.java'), `
package com.acme.api;

import org.springframework.stereotype.Service;

/**
 * Business logic for user management.
 */
@Service
public class UserService {

    public User findById(String id) {
        return null;
    }

    public User create(User user) {
        return user;
    }
}
`);

  const webDir = path.join(tmpDir, 'web');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(path.join(webDir, 'package.json'), '{"name":"web"}');
  fs.writeFileSync(path.join(webDir, 'UserList.tsx'), `
import React from 'react';

interface UserListProps {
  users: User[];
}

export function UserList({ users }: UserListProps) {
  return (
    <ul>
      {users.map(u => <li key={u.id}>{u.name}</li>)}
    </ul>
  );
}
`);

  // Scan both modules to populate the graph
  const scanRes = getText(await client.callTool({
    name: 'scan-internal-source',
    arguments: {
      projectPath: tmpDir,
      modulePaths: ['api', 'web'],
    },
  }));
  assertIncludes('scan: populated graph', scanRes, 'Knowledge Graph');

  // ── graph-status ─────────────────────────────────────────────────────

  {
    const res = getText(await client.callTool({
      name: 'graph-status',
      arguments: {},
    }));
    assertIncludes('status: shows total nodes', res, 'Nodes');
    assertIncludes('status: shows total files', res, 'Files');
    assertIncludes('status: shows total edges', res, 'Edges');
    assertIncludes('status: shows last scan', res, 'Last scan');
    assert('status: node count > 0', /Nodes:?\*?\*?\s*[1-9]/.test(res), `no nodes found in: ${res.substring(0, 200)}`);
    assert('status: file count > 0', /Files:?\*?\*?\s*[1-9]/.test(res), `no files found in: ${res.substring(0, 200)}`);
  }

  // ── search-symbols ───────────────────────────────────────────────────

  // Basic search
  {
    const res = getText(await client.callTool({
      name: 'search-symbols',
      arguments: { query: 'UserController' },
    }));
    assertIncludes('search: finds UserController', res, 'UserController');
    assertIncludes('search: shows kind', res, 'class');
    assertIncludes('search: shows module', res, 'api');
  }

  // Search with kind filter
  {
    const res = getText(await client.callTool({
      name: 'search-symbols',
      arguments: { query: 'User*', kind: 'class' },
    }));
    assertIncludes('search-kind: finds class', res, 'class');
    assert('search-kind: no methods in results', !res.includes('| method |'), 'methods should be filtered out');
  }

  // Search with module filter
  {
    const res = getText(await client.callTool({
      name: 'search-symbols',
      arguments: { query: 'User*', module: 'web' },
    }));
    assert('search-module: only web results', !res.includes('| api |'), 'api module should be filtered out');
  }

  // Search with no results
  {
    const res = getText(await client.callTool({
      name: 'search-symbols',
      arguments: { query: 'NonExistentSymbolXYZ123' },
    }));
    assertIncludes('search-empty: no results message', res, 'No symbols');
  }

  // ── get-symbol-detail ────────────────────────────────────────────────

  // Detail for a class
  {
    const res = getText(await client.callTool({
      name: 'get-symbol-detail',
      arguments: { symbolName: 'UserController' },
    }));
    assertIncludes('detail: shows name', res, 'UserController');
    assertIncludes('detail: shows kind', res, 'class');
    assertIncludes('detail: shows file path', res, 'UserController.java');
    assertIncludes('detail: shows annotations', res, 'RestController');
    assertIncludes('detail: shows doc comment', res, 'REST controller');
    assertIncludes('detail: shows children', res, 'getUser');
  }

  // Detail with module disambiguation
  {
    const res = getText(await client.callTool({
      name: 'get-symbol-detail',
      arguments: { symbolName: 'UserController', module: 'api' },
    }));
    assertIncludes('detail-module: finds in api module', res, 'UserController');
  }

  // Detail for a non-existent symbol
  {
    const res = getText(await client.callTool({
      name: 'get-symbol-detail',
      arguments: { symbolName: 'NonExistentSymbolXYZ123' },
    }));
    assertIncludes('detail-missing: not found message', res, 'not found');
  }

  // Detail with includeSource
  {
    const res = getText(await client.callTool({
      name: 'get-symbol-detail',
      arguments: { symbolName: 'UserController', includeSource: true },
    }));
    assertIncludes('detail-source: includes source', res, 'Source');
    assertIncludes('detail-source: has actual code', res, 'RestController');
  }

  // ── I12: graph-status includes stale files placeholder ────────────────

  {
    const res = getText(await client.callTool({
      name: 'graph-status',
      arguments: {},
    }));
    assertIncludes('status: shows stale files', res, 'Stale files');
  }

  // ── I13: search-symbols includes signature column ────────────────────

  {
    const res = getText(await client.callTool({
      name: 'search-symbols',
      arguments: { query: 'UserService' },
    }));
    assertIncludes('search-sig: has Signature header', res, 'Signature');
  }

  // ── I14: get-symbol-detail uses Incoming/Outgoing edge labels ────────

  // (edges are empty until Phase 2, but verify header labels are correct
  //  by manually inserting edges and checking output — skip for now,
  //  just check that the annotation display doesn't have double @)

  // ── B1: annotation display has single @ ──────────────────────────────

  {
    const res = getText(await client.callTool({
      name: 'get-symbol-detail',
      arguments: { symbolName: 'UserController' },
    }));
    assert('detail-ann: no double @@', !res.includes('@@'), `found @@ in: ${res.substring(0, 500)}`);
    assertIncludes('detail-ann: has @RestController', res, '@RestController');
  }

  // ── I15a: search-symbols with limit parameter ────────────────────────

  {
    const res = getText(await client.callTool({
      name: 'search-symbols',
      arguments: { query: 'User*', limit: 1 },
    }));
    assertIncludes('search-limit: found 1 symbol', res, 'Found 1 symbol');
  }

  // ── I15b: get-symbol-detail when source file deleted ─────────────────

  {
    // Delete the source file so includeSource reads from a missing path
    const ctlPath = path.join(apiDir, 'UserService.java');
    const ctlContent = fs.readFileSync(ctlPath, 'utf-8');
    fs.unlinkSync(ctlPath);
    const res = getText(await client.callTool({
      name: 'get-symbol-detail',
      arguments: { symbolName: 'UserService', includeSource: true },
    }));
    assertIncludes('detail-missing-src: fallback message', res, 'not available');
    // N20: error message should include the file path
    assertIncludes('detail-missing-src: shows file path', res, 'UserService.java');
    // Restore file for subsequent tests
    fs.writeFileSync(ctlPath, ctlContent);
  }

  // ── graph-status without prior scan (fresh server) ───────────────────

  {
    const freshClient = await setupClient();
    const res = getText(await freshClient.callTool({
      name: 'graph-status',
      arguments: {},
    }));
    assertIncludes('status-fresh: shows not initialized', res, 'not initialized');
  }

  // ── search-symbols without prior scan ────────────────────────────────

  {
    const freshClient = await setupClient();
    const res = getText(await freshClient.callTool({
      name: 'search-symbols',
      arguments: { query: 'Foo' },
    }));
    assertIncludes('search-fresh: shows not initialized', res, 'not initialized');
  }

  // ── get-symbol-detail without prior scan ─────────────────────────────

  {
    const freshClient = await setupClient();
    const res = getText(await freshClient.callTool({
      name: 'get-symbol-detail',
      arguments: { symbolName: 'Foo' },
    }));
    assertIncludes('detail-fresh: shows not initialized', res, 'not initialized');
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
