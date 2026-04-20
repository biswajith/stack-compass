import { assert } from '../helpers.js';
import { GraphStore } from '../../src/graph/index.js';
import type { ScannedModule, ScannedFile, ExtractedSymbol } from '../../src/source-scanner/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-lang-test-'));
  return path.join(dir, 'test-graph.db');
}

function cleanup(dbPath: string) {
  const dir = path.dirname(dbPath);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeSymbol(overrides: Partial<ExtractedSymbol> & { name: string; kind: ExtractedSymbol['kind'] }): ExtractedSymbol {
  return {
    visibility: 'public',
    location: { startLine: 1, endLine: 10 },
    ...overrides,
  };
}

function makeScannedFile(overrides: Partial<ScannedFile> & { filePath: string }): ScannedFile {
  return { language: 'java', symbols: [], ...overrides };
}

function makeModule(name: string, files: ScannedFile[]): ScannedModule {
  return {
    name, path: '/fake/' + name, language: files[0]?.language ?? 'java', files,
    summary: {
      totalFiles: files.length,
      totalSymbols: files.reduce((s, f) => s + f.symbols.length, 0),
      publicClasses: [], publicInterfaces: [], publicMethods: 0,
      annotations: [], restEndpoints: [], entities: [], events: [],
    },
  };
}

export async function testCrossLanguage() {
  console.log('\n--- Unit: Cross-Language Edge Resolution (Phase 2B) ---');

  // 2B-1: React → GraphQL
  await test_ts_gql_template_extraction();
  await test_ts_usequery_detection();
  await test_gql_operation_to_schema_edge();
  await test_gql_parent_type_no_false_positive();

  // 2B-2: GraphQL → Java resolver
  await test_java_dgs_query_extraction();
  await test_java_dgs_data_extraction();
  await test_java_query_mapping_extraction();
  await test_java_schema_mapping_extraction();
  await test_java_resolver_to_schema_edge();

  // 2B-3: React → Spring REST
  await test_class_request_mapping_composition();
  await test_ts_fetch_extraction();
  await test_ts_axios_extraction();
  await test_ts_template_literal_url();
  await test_rest_match_edge();
  await test_rest_path_normalization();

  // 2B-4: GraphQL type → Java entity
  await test_gql_type_to_entity_edge();
  await test_type_match_requires_entity_annotation();

  // 2B-5: Spring DI
  await test_autowired_di_resolution();

  // 2B-6: Full chain
  await test_full_cross_language_chain();
}

// ══════════════════════════════════════════════════════════════════════════
// 2B-1: React → GraphQL
// ══════════════════════════════════════════════════════════════════════════

async function test_ts_gql_template_extraction() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractTypeScriptSymbols } = await import('../../src/source-scanner/typescript-extractor.js');
  await initParser();

  const source = `
import { gql } from '@apollo/client';

export const GET_USERS = gql\`
  query GetUsers {
    users { id name email }
  }
\`;
`;
  const tree = await parseSource(source, 'typescript');
  const result = extractTypeScriptSymbols(tree, source);

  const gqlOp = result.symbols.find(s => s.kind === 'gql-operation');
  assert('gql-extract: found gql-operation symbol', gqlOp !== undefined, `symbols: ${JSON.stringify(result.symbols.map(s => s.name + ':' + s.kind))}`);
  assert('gql-extract: name is GET_USERS', gqlOp?.name === 'GET_USERS', `got "${gqlOp?.name}"`);
  assert('gql-extract: has gqlFields', Array.isArray((gqlOp as any)?.gqlFields), `got ${typeof (gqlOp as any)?.gqlFields}`);
  assert('gql-extract: fields contains users', (gqlOp as any)?.gqlFields?.includes('users') === true, `got ${JSON.stringify((gqlOp as any)?.gqlFields)}`);
  assert('gql-extract: has gqlOperationType', (gqlOp as any)?.gqlOperationType === 'query', `got "${(gqlOp as any)?.gqlOperationType}"`);
}

async function test_ts_usequery_detection() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractTypeScriptSymbols } = await import('../../src/source-scanner/typescript-extractor.js');
  await initParser();

  const source = `
import { gql, useQuery } from '@apollo/client';

const GET_USERS = gql\`
  query GetUsers {
    users { id name }
  }
\`;

export function UserList() {
  const { data } = useQuery(GET_USERS);
  return null;
}
`;
  const tree = await parseSource(source, 'typescript');
  const result = extractTypeScriptSymbols(tree, source);

  const userList = result.symbols.find(s => s.name === 'UserList');
  assert('usequery: UserList has callSites', Array.isArray(userList?.callSites), `got ${typeof userList?.callSites}`);
  const uqCall = userList?.callSites?.find(c => c.target === 'useQuery');
  assert('usequery: detected useQuery call', uqCall !== undefined, `callSites: ${JSON.stringify(userList?.callSites)}`);
}

async function test_gql_operation_to_schema_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Frontend: gql-operation with field "users"
    const frontendMod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/queries.ts', language: 'typescript',
        symbols: [makeSymbol({
          name: 'GET_USERS', kind: 'gql-operation',
          gqlOperationType: 'query', gqlFields: ['users'],
        })],
      }),
    ]);
    store.ingestModule(frontendMod);

    // Schema: query "users"
    const schemaMod = makeModule('schema', [
      makeScannedFile({
        filePath: '/schema/schema.graphql', language: 'graphql',
        symbols: [makeSymbol({ name: 'users', kind: 'query' })],
      }),
    ]);
    store.ingestModule(schemaMod);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    const gqlNode = store.getNodesByName('GET_USERS');
    assert('gql-edge: GET_USERS found', gqlNode.length > 0);
    const edges = store.getEdgesFrom(gqlNode[0].id);
    const gqlEdge = edges.find(e => e.kind === 'gql_resolves');
    assert('gql-edge: has gql_resolves edge', gqlEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    if (gqlEdge) {
      const target = store.getNodeById(gqlEdge.target_id);
      assert('gql-edge: target is users query', target?.name === 'users', `got "${target?.name}"`);
    }
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_gql_parent_type_no_false_positive() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // Frontend asks for Query.posts
    const frontendMod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/queries.ts', language: 'typescript',
        symbols: [makeSymbol({
          name: 'GET_POSTS', kind: 'gql-operation',
          gqlOperationType: 'query', gqlFields: ['posts'],
        })],
      }),
    ]);
    store.ingestModule(frontendMod);

    // Schema has Query.posts AND User.posts (different parent types)
    const schemaMod = makeModule('schema', [
      makeScannedFile({
        filePath: '/schema/schema.graphql', language: 'graphql',
        symbols: [
          makeSymbol({ name: 'posts', kind: 'query', location: { startLine: 1, endLine: 1 } }),
          makeSymbol({
            name: 'User', kind: 'graphql-type',
            children: [makeSymbol({ name: 'posts', kind: 'field', location: { startLine: 5, endLine: 5 } })],
            location: { startLine: 3, endLine: 10 },
          }),
        ],
      }),
    ]);
    store.ingestModule(schemaMod);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    const gqlNode = store.getNodesByName('GET_POSTS');
    const edges = store.getEdgesFrom(gqlNode[0].id);
    const gqlEdges = edges.filter(e => e.kind === 'gql_resolves');
    // Should resolve to Query.posts, NOT User.posts
    assert('false-pos: exactly 1 gql_resolves edge', gqlEdges.length === 1, `got ${gqlEdges.length}`);
    if (gqlEdges.length === 1) {
      const target = store.getNodeById(gqlEdges[0].target_id);
      assert('false-pos: target is query-level posts', target?.kind === 'query', `got "${target?.kind}"`);
    }
    store.close();
  } finally { cleanup(dbPath); }
}

// ══════════════════════════════════════════════════════════════════════════
// 2B-2: GraphQL → Java resolver
// ══════════════════════════════════════════════════════════════════════════

async function test_java_dgs_query_extraction() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractJavaSymbols } = await import('../../src/source-scanner/java-extractor.js');
  await initParser();

  const source = `
package com.example;

public class UserResolver {
    @DgsQuery
    public List<User> users() {
        return userService.findAll();
    }
}
`;
  const tree = await parseSource(source, 'java');
  const result = extractJavaSymbols(tree, source);

  assert('dgs-query: has gqlResolvers', Array.isArray(result.gqlResolvers), `got ${typeof result.gqlResolvers}`);
  const resolver = result.gqlResolvers?.find((r: any) => r.fieldName === 'users');
  assert('dgs-query: found users resolver', resolver !== undefined, `resolvers: ${JSON.stringify(result.gqlResolvers)}`);
  assert('dgs-query: parentType is Query', resolver?.parentType === 'Query', `got "${resolver?.parentType}"`);
}

async function test_java_dgs_data_extraction() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractJavaSymbols } = await import('../../src/source-scanner/java-extractor.js');
  await initParser();

  const source = `
package com.example;

public class UserResolver {
    @DgsData(parentType = "Query", field = "users")
    public List<User> getUsers() {
        return userService.findAll();
    }
}
`;
  const tree = await parseSource(source, 'java');
  const result = extractJavaSymbols(tree, source);

  const resolver = result.gqlResolvers?.find((r: any) => r.fieldName === 'users');
  assert('dgs-data: found users resolver', resolver !== undefined, `resolvers: ${JSON.stringify(result.gqlResolvers)}`);
  assert('dgs-data: parentType is Query', resolver?.parentType === 'Query', `got "${resolver?.parentType}"`);
}

async function test_java_query_mapping_extraction() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractJavaSymbols } = await import('../../src/source-scanner/java-extractor.js');
  await initParser();

  const source = `
package com.example;

public class UserController {
    @QueryMapping
    public List<User> users() {
        return userService.findAll();
    }
}
`;
  const tree = await parseSource(source, 'java');
  const result = extractJavaSymbols(tree, source);

  const resolver = result.gqlResolvers?.find((r: any) => r.fieldName === 'users');
  assert('query-mapping: found users resolver', resolver !== undefined, `resolvers: ${JSON.stringify(result.gqlResolvers)}`);
}

async function test_java_schema_mapping_extraction() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractJavaSymbols } = await import('../../src/source-scanner/java-extractor.js');
  await initParser();

  const source = `
package com.example;

public class UserResolver {
    @SchemaMapping(typeName = "User", field = "posts")
    public List<Post> getPosts(User user) {
        return postService.findByUser(user);
    }
}
`;
  const tree = await parseSource(source, 'java');
  const result = extractJavaSymbols(tree, source);

  const resolver = result.gqlResolvers?.find((r: any) => r.fieldName === 'posts');
  assert('schema-mapping: found posts resolver', resolver !== undefined, `resolvers: ${JSON.stringify(result.gqlResolvers)}`);
  assert('schema-mapping: parentType is User', resolver?.parentType === 'User', `got "${resolver?.parentType}"`);
}

async function test_java_resolver_to_schema_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const javaMod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/UserResolver.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({
          name: 'UserResolver', kind: 'class',
          children: [makeSymbol({
            name: 'users', kind: 'method',
            annotations: ['@DgsQuery'],
            location: { startLine: 5, endLine: 10 },
          })],
        })],
      }),
    ]);
    store.ingestModule(javaMod);

    const schemaMod = makeModule('schema', [
      makeScannedFile({
        filePath: '/schema/schema.graphql', language: 'graphql',
        symbols: [makeSymbol({ name: 'users', kind: 'query' })],
      }),
    ]);
    store.ingestModule(schemaMod);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    const resolverMethod = store.getNodesByName('users', { kind: 'method' });
    assert('java-gql-edge: users method found', resolverMethod.length > 0);
    const edges = store.getEdgesFrom(resolverMethod[0].id);
    const gqlEdge = edges.find(e => e.kind === 'gql_resolves');
    assert('java-gql-edge: has gql_resolves edge', gqlEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ══════════════════════════════════════════════════════════════════════════
// 2B-3: React → Spring REST
// ══════════════════════════════════════════════════════════════════════════

async function test_class_request_mapping_composition() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractJavaSymbols } = await import('../../src/source-scanner/java-extractor.js');
  await initParser();

  const source = `
package com.example;

@RestController
@RequestMapping("/api/v1")
public class UserController {

    @GetMapping("/users")
    public List<User> getUsers() { return null; }

    @PostMapping("/users")
    public User createUser(User user) { return null; }
}
`;
  const tree = await parseSource(source, 'java');
  const result = extractJavaSymbols(tree, source);

  const getEp = result.restEndpoints.find(ep => ep.method === 'GET');
  assert('rest-compose: GET endpoint found', getEp !== undefined, `eps: ${JSON.stringify(result.restEndpoints)}`);
  assert('rest-compose: GET path is /api/v1/users', getEp?.path === '/api/v1/users', `got "${getEp?.path}"`);
  const postEp = result.restEndpoints.find(ep => ep.method === 'POST');
  assert('rest-compose: POST path is /api/v1/users', postEp?.path === '/api/v1/users', `got "${postEp?.path}"`);
}

async function test_ts_fetch_extraction() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractTypeScriptSymbols } = await import('../../src/source-scanner/typescript-extractor.js');
  await initParser();

  const source = `
export async function getUsers() {
  const res = await fetch("/api/users");
  return res.json();
}
`;
  const tree = await parseSource(source, 'typescript');
  const result = extractTypeScriptSymbols(tree, source);

  const apiCall = result.symbols.find(s => s.kind === 'api-call');
  assert('fetch-extract: found api-call symbol', apiCall !== undefined, `symbols: ${JSON.stringify(result.symbols.map(s => s.name + ':' + s.kind))}`);
  assert('fetch-extract: path is /api/users', (apiCall as any)?.apiPath === '/api/users', `got "${(apiCall as any)?.apiPath}"`);
  assert('fetch-extract: method is GET', (apiCall as any)?.apiMethod === 'GET', `got "${(apiCall as any)?.apiMethod}"`);
}

async function test_ts_axios_extraction() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractTypeScriptSymbols } = await import('../../src/source-scanner/typescript-extractor.js');
  await initParser();

  const source = `
export async function createUser(user: any) {
  return axios.post("/api/users", user);
}
`;
  const tree = await parseSource(source, 'typescript');
  const result = extractTypeScriptSymbols(tree, source);

  const apiCall = result.symbols.find(s => s.kind === 'api-call');
  assert('axios-extract: found api-call', apiCall !== undefined, `symbols: ${JSON.stringify(result.symbols.map(s => s.name + ':' + s.kind))}`);
  assert('axios-extract: method is POST', (apiCall as any)?.apiMethod === 'POST', `got "${(apiCall as any)?.apiMethod}"`);
  assert('axios-extract: path is /api/users', (apiCall as any)?.apiPath === '/api/users', `got "${(apiCall as any)?.apiPath}"`);
}

async function test_ts_template_literal_url() {
  const { initParser, parseSource } = await import('../../src/source-scanner/parser.js');
  const { extractTypeScriptSymbols } = await import('../../src/source-scanner/typescript-extractor.js');
  await initParser();

  const source = `
export async function getUser(id: string) {
  return fetch(\`/api/users/\${id}\`);
}
`;
  const tree = await parseSource(source, 'typescript');
  const result = extractTypeScriptSymbols(tree, source);

  const apiCall = result.symbols.find(s => s.kind === 'api-call');
  assert('tpl-url: found api-call', apiCall !== undefined, `symbols: ${JSON.stringify(result.symbols.map(s => s.name + ':' + s.kind))}`);
  assert('tpl-url: static prefix extracted', (apiCall as any)?.apiPath === '/api/users/{param}', `got "${(apiCall as any)?.apiPath}"`);
}

async function test_rest_match_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const javaMod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/UserController.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({
          name: 'UserController', kind: 'class',
          annotations: ['@RestController', '@RequestMapping("/api")'],
          children: [makeSymbol({
            name: 'getUsers', kind: 'method',
            annotations: ['@GetMapping("/users")'],
            location: { startLine: 5, endLine: 10 },
          })],
        })],
      }),
    ]);
    store.ingestModule(javaMod);

    const tsMod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/api.ts', language: 'typescript',
        symbols: [makeSymbol({
          name: 'fetchUsers', kind: 'api-call',
          apiPath: '/api/users', apiMethod: 'GET',
        })],
      }),
    ]);
    store.ingestModule(tsMod);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    const apiCallNode = store.getNodesByName('fetchUsers');
    assert('rest-match: fetchUsers found', apiCallNode.length > 0);
    const edges = store.getEdgesFrom(apiCallNode[0].id);
    const restEdge = edges.find(e => e.kind === 'rest_match');
    assert('rest-match: has rest_match edge', restEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    if (restEdge) {
      const target = store.getNodeById(restEdge.target_id);
      assert('rest-match: target is getUsers', target?.name === 'getUsers', `got "${target?.name}"`);
    }
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_rest_path_normalization() {
  const { normalizePath } = await import('../../src/graph/resolvers/rest-resolver.js');
  assert('norm: /users/:id → /users/{param}', normalizePath('/users/:id') === '/users/{param}');
  assert('norm: /users/{id} → /users/{param}', normalizePath('/users/{id}') === '/users/{param}');
  assert('norm: /api/users → /api/users', normalizePath('/api/users') === '/api/users');
  assert('norm: trailing slash stripped', normalizePath('/api/users/') === '/api/users');
}

// ══════════════════════════════════════════════════════════════════════════
// 2B-4: GraphQL type → Java entity
// ══════════════════════════════════════════════════════════════════════════

async function test_gql_type_to_entity_edge() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const schemaMod = makeModule('schema', [
      makeScannedFile({
        filePath: '/schema/schema.graphql', language: 'graphql',
        symbols: [makeSymbol({ name: 'User', kind: 'graphql-type' })],
      }),
    ]);
    store.ingestModule(schemaMod);

    const javaMod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/User.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({
          name: 'User', kind: 'class',
          annotations: ['@Entity'],
        })],
      }),
    ]);
    store.ingestModule(javaMod);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    const gqlUser = store.getNodesByName('User', { kind: 'graphql-type' });
    assert('type-match: GQL User found', gqlUser.length > 0);
    const edges = store.getEdgesFrom(gqlUser[0].id);
    const typeEdge = edges.find(e => e.kind === 'type_match');
    assert('type-match: has type_match edge', typeEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

async function test_type_match_requires_entity_annotation() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const schemaMod = makeModule('schema', [
      makeScannedFile({
        filePath: '/schema/schema.graphql', language: 'graphql',
        symbols: [makeSymbol({ name: 'Config', kind: 'graphql-type' })],
      }),
    ]);
    store.ingestModule(schemaMod);

    // Java class WITHOUT @Entity/@Document annotation
    const javaMod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/Config.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({ name: 'Config', kind: 'class' })],
      }),
    ]);
    store.ingestModule(javaMod);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    const gqlConfig = store.getNodesByName('Config', { kind: 'graphql-type' });
    const edges = store.getEdgesFrom(gqlConfig[0].id);
    const typeEdge = edges.find(e => e.kind === 'type_match');
    assert('no-entity: no type_match without annotation', typeEdge === undefined, `edges: ${JSON.stringify(edges)}`);
    store.close();
  } finally { cleanup(dbPath); }
}

// ══════════════════════════════════════════════════════════════════════════
// 2B-5: Spring DI
// ══════════════════════════════════════════════════════════════════════════

async function test_autowired_di_resolution() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    const mod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/UserService.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({
          name: 'UserService', kind: 'class',
          annotations: ['@Service'],
          children: [makeSymbol({
            name: 'repository', kind: 'field',
            annotations: ['@Autowired'],
            signature: 'UserRepository repository',
            location: { startLine: 3, endLine: 3 },
          })],
        })],
      }),
      makeScannedFile({
        filePath: '/src/UserRepositoryImpl.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({
          name: 'UserRepositoryImpl', kind: 'class',
          annotations: ['@Repository'],
          implements: ['UserRepository'],
        })],
      }),
      makeScannedFile({
        filePath: '/src/UserRepository.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({ name: 'UserRepository', kind: 'interface' })],
      }),
    ]);
    store.ingestModule(mod);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    const service = store.getNodesByName('UserService', { kind: 'class' });
    const edges = store.getEdgesFrom(service[0].id);
    const injectsEdge = edges.find(e => e.kind === 'injects');
    assert('di: has injects edge', injectsEdge !== undefined, `edges: ${JSON.stringify(edges)}`);
    if (injectsEdge) {
      const target = store.getNodeById(injectsEdge.target_id);
      assert('di: target is UserRepositoryImpl', target?.name === 'UserRepositoryImpl', `got "${target?.name}"`);
    }
    store.close();
  } finally { cleanup(dbPath); }
}

// ══════════════════════════════════════════════════════════════════════════
// 2B-6: Full chain
// ══════════════════════════════════════════════════════════════════════════

async function test_full_cross_language_chain() {
  const dbPath = tmpDbPath();
  try {
    const store = GraphStore.open(dbPath);

    // React frontend with gql operation + useQuery
    const webMod = makeModule('web', [
      makeScannedFile({
        filePath: '/src/queries.ts', language: 'typescript',
        symbols: [makeSymbol({
          name: 'GET_USERS', kind: 'gql-operation',
          gqlOperationType: 'query', gqlFields: ['users'],
        })],
      }),
      makeScannedFile({
        filePath: '/src/UserList.tsx', language: 'typescript',
        symbols: [makeSymbol({
          name: 'UserList', kind: 'component',
          callSites: [{ target: 'useQuery' }],
          jsxElements: [],
        })],
      }),
    ]);
    store.ingestModule(webMod);

    // GraphQL schema
    const schemaMod = makeModule('schema', [
      makeScannedFile({
        filePath: '/schema/schema.graphql', language: 'graphql',
        symbols: [
          makeSymbol({ name: 'users', kind: 'query' }),
          makeSymbol({ name: 'User', kind: 'graphql-type' }),
        ],
      }),
    ]);
    store.ingestModule(schemaMod);

    // Java backend
    const apiMod = makeModule('api', [
      makeScannedFile({
        filePath: '/src/UserResolver.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({
          name: 'UserResolver', kind: 'class',
          children: [makeSymbol({
            name: 'users', kind: 'method',
            annotations: ['@DgsQuery'],
            callSites: [{ target: 'findAll', receiver: 'userService' }],
            location: { startLine: 5, endLine: 10 },
          })],
        })],
      }),
      makeScannedFile({
        filePath: '/src/UserService.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({
          name: 'UserService', kind: 'class',
          annotations: ['@Service'],
          children: [makeSymbol({
            name: 'findAll', kind: 'method',
            callSites: [{ target: 'findAll', receiver: 'repository' }],
            location: { startLine: 5, endLine: 10 },
          })],
        })],
      }),
      makeScannedFile({
        filePath: '/src/UserRepository.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({
          name: 'UserRepository', kind: 'class',
          children: [makeSymbol({
            name: 'findAll', kind: 'method',
            location: { startLine: 5, endLine: 10 },
          })],
        })],
      }),
      makeScannedFile({
        filePath: '/src/User.java', language: 'java', packageName: 'com.example',
        symbols: [makeSymbol({
          name: 'User', kind: 'class',
          annotations: ['@Entity'],
        })],
      }),
    ]);
    store.ingestModule(apiMod);

    const { resolveAllEdges } = await import('../../src/graph/resolvers/index.js');
    resolveAllEdges(store);

    // Verify the chain:
    // GET_USERS --gql_resolves--> schema users
    const getUsers = store.getNodesByName('GET_USERS');
    assert('chain: GET_USERS found', getUsers.length > 0);
    const gqlEdge = store.getEdgesFrom(getUsers[0].id).find(e => e.kind === 'gql_resolves');
    assert('chain: GET_USERS → schema users (gql_resolves)', gqlEdge !== undefined);

    // schema users <--gql_resolves-- java users() method
    const schemaUsers = store.getNodesByName('users', { kind: 'query' });
    assert('chain: schema users found', schemaUsers.length > 0);
    const javaResolverEdges = store.getEdgesTo(schemaUsers[0].id).filter(e => e.kind === 'gql_resolves');
    assert('chain: java resolver → schema users (gql_resolves)', javaResolverEdges.length > 0);

    // GQL User --type_match--> Java @Entity User
    const gqlUser = store.getNodesByName('User', { kind: 'graphql-type' });
    assert('chain: GQL User found', gqlUser.length > 0);
    const typeEdge = store.getEdgesFrom(gqlUser[0].id).find(e => e.kind === 'type_match');
    assert('chain: GQL User → Java User (type_match)', typeEdge !== undefined);

    // Use get-impact to verify the chain traverses end-to-end
    const { getImpact } = await import('../../src/graph/traversal.js');
    const impact = getImpact(store, 'UserRepository', 5);
    const impactNames = impact.nodes.map(n => n.name);
    assert('chain: impact reaches UserResolver', impactNames.includes('UserResolver') || impactNames.includes('users'),
      `impact names: ${JSON.stringify(impactNames)}`);

    store.close();
  } finally { cleanup(dbPath); }
}
