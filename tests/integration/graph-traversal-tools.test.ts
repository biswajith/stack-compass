import { setupClient, getText, assert, assertIncludes } from '../helpers.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export async function testGraphTraversalTools() {
  console.log('\n--- Integration: Graph Traversal MCP Tools (Phase 3B) ---');

  const client = await setupClient();

  // Build a realistic multi-file call chain fixture
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traversal-tools-'));

  const apiDir = path.join(tmpDir, 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'pom.xml'), '<project></project>');

  fs.writeFileSync(path.join(apiDir, 'UserController.java'), `
package com.acme.api;

import com.acme.api.UserService;

@RestController
public class UserController {

    private UserService userService;

    @GetMapping("/api/users/{id}")
    public User getUser(String id) {
        return userService.findById(id);
    }

    @PostMapping("/api/users")
    public User createUser(User user) {
        return userService.create(user);
    }
}
`);

  fs.writeFileSync(path.join(apiDir, 'UserService.java'), `
package com.acme.api;

@Service
public class UserService {

    private UserRepository repository;

    public User findById(String id) {
        return repository.findOne(id);
    }

    public User create(User user) {
        return repository.save(user);
    }
}
`);

  fs.writeFileSync(path.join(apiDir, 'UserRepository.java'), `
package com.acme.api;

public class UserRepository {

    public User findOne(String id) {
        return null;
    }

    public User save(User user) {
        return user;
    }
}
`);

  const webDir = path.join(tmpDir, 'web');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(path.join(webDir, 'package.json'), '{"name":"web"}');

  fs.writeFileSync(path.join(webDir, 'UserProfile.tsx'), `
export function UserProfile({ user }: { user: any }) {
  return <div>{user.name}</div>;
}
`);

  fs.writeFileSync(path.join(webDir, 'App.tsx'), `
import { UserProfile } from './UserProfile';

export function App() {
  const data = fetchData('/api/users');
  return <UserProfile user={data} />;
}
`);

  fs.writeFileSync(path.join(webDir, 'api.ts'), `
export function fetchData(url: string) {
  return fetch(url).then(r => r.json());
}
`);

  // Scan to populate graph
  const scanRes = getText(await client.callTool({
    name: 'scan-internal-source',
    arguments: {
      projectPath: tmpDir,
      modulePaths: ['api', 'web'],
    },
  }));
  assertIncludes('scan: populated graph', scanRes, 'Knowledge Graph');

  // ── get-callers ─────────────────────────────────────────────────────

  // Depth 1: who calls findById?
  {
    const res = getText(await client.callTool({
      name: 'get-callers',
      arguments: { symbolName: 'findById', depth: 1 },
    }));
    assertIncludes('callers-d1: shows caller', res, 'getUser');
    assertIncludes('callers-d1: shows edge kind', res, 'calls');
  }

  // Depth 2: who calls findOne? → findById → getUser
  {
    const res = getText(await client.callTool({
      name: 'get-callers',
      arguments: { symbolName: 'findOne', depth: 2 },
    }));
    assertIncludes('callers-d2: depth 1 caller', res, 'findById');
    assertIncludes('callers-d2: depth 2 caller', res, 'getUser');
  }

  // No callers
  {
    const res = getText(await client.callTool({
      name: 'get-callers',
      arguments: { symbolName: 'getUser' },
    }));
    assertIncludes('callers-none: no callers message', res, 'No callers');
  }

  // Symbol not found
  {
    const res = getText(await client.callTool({
      name: 'get-callers',
      arguments: { symbolName: 'NonExistentSymbolXYZ' },
    }));
    assertIncludes('callers-missing: not found', res, 'not found');
  }

  // Graph not initialized
  {
    const freshClient = await setupClient();
    const res = getText(await freshClient.callTool({
      name: 'get-callers',
      arguments: { symbolName: 'Foo' },
    }));
    assertIncludes('callers-fresh: not initialized', res, 'not initialized');
  }

  // ── get-callees ─────────────────────────────────────────────────────

  // Depth 1: what does getUser call?
  {
    const res = getText(await client.callTool({
      name: 'get-callees',
      arguments: { symbolName: 'getUser', depth: 1 },
    }));
    assertIncludes('callees-d1: shows callee', res, 'findById');
    assertIncludes('callees-d1: shows edge kind', res, 'calls');
  }

  // Depth 2: getUser → findById → findOne
  {
    const res = getText(await client.callTool({
      name: 'get-callees',
      arguments: { symbolName: 'getUser', depth: 2 },
    }));
    assertIncludes('callees-d2: depth 1', res, 'findById');
    assertIncludes('callees-d2: depth 2', res, 'findOne');
  }

  // No callees
  {
    const res = getText(await client.callTool({
      name: 'get-callees',
      arguments: { symbolName: 'findOne' },
    }));
    assertIncludes('callees-none: no callees message', res, 'No callees');
  }

  // ── get-impact ──────────────────────────────────────────────────────

  // Impact of UserService: reverse traverse ALL edge types
  {
    const res = getText(await client.callTool({
      name: 'get-impact',
      arguments: { symbolName: 'UserService', depth: 3 },
    }));
    assertIncludes('impact: shows affected', res, 'Affected');
    assertIncludes('impact: UserController affected', res, 'UserController');
    assertIncludes('impact: shows direct count', res, 'direct');
    assertIncludes('impact: shows transitive count', res, 'transitive');
  }

  // Impact with depth limit
  {
    const res1 = getText(await client.callTool({
      name: 'get-impact',
      arguments: { symbolName: 'UserRepository', depth: 1 },
    }));
    const res3 = getText(await client.callTool({
      name: 'get-impact',
      arguments: { symbolName: 'UserRepository', depth: 3 },
    }));
    // Deeper should find at least as many affected symbols
    const count1 = (res1.match(/\|/g) || []).length;
    const count3 = (res3.match(/\|/g) || []).length;
    assert('impact-depth: deeper finds more', count3 >= count1, `depth1=${count1} depth3=${count3}`);
  }

  // Symbol not found
  {
    const res = getText(await client.callTool({
      name: 'get-impact',
      arguments: { symbolName: 'NonExistentSymbolXYZ' },
    }));
    assertIncludes('impact-missing: not found', res, 'not found');
  }

  // ── build-context ───────────────────────────────────────────────────

  // Task-driven search
  {
    const res = getText(await client.callTool({
      name: 'build-context',
      arguments: { task: 'fix the user creation endpoint' },
    }));
    assertIncludes('context: has results', res, 'Context');
    assertIncludes('context: found createUser', res, 'createUser');
  }

  // maxNodes budget
  {
    const res = getText(await client.callTool({
      name: 'build-context',
      arguments: { task: 'user service', maxNodes: 2 },
    }));
    // Count the number of symbol sections (each starts with "###" or "**")
    const symbolCount = (res.match(/^###\s/gm) || []).length;
    assert('context-budget: respects maxNodes', symbolCount <= 3, `got ${symbolCount} symbols`);
  }

  // No matching symbols
  {
    const res = getText(await client.callTool({
      name: 'build-context',
      arguments: { task: 'zyxwvutsrqp completely random' },
    }));
    assertIncludes('context-empty: no results message', res, 'No relevant');
  }

  // Graph not initialized
  {
    const freshClient = await setupClient();
    const res = getText(await freshClient.callTool({
      name: 'build-context',
      arguments: { task: 'anything' },
    }));
    assertIncludes('context-fresh: not initialized', res, 'not initialized');
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
