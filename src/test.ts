import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.js';
import path from 'path';

// ─── Test harness ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, text: string, expected: string) {
  if (text.includes(expected)) {
    passed++;
  } else {
    failed++;
    failures.push(`  FAIL: ${name} — expected "${expected}" not found`);
  }
}

function assertNot(name: string, text: string, unexpected: string) {
  if (!text.includes(unexpected)) {
    passed++;
  } else {
    failed++;
    failures.push(`  FAIL: ${name} — unexpected "${unexpected}" was found`);
  }
}

function getText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content?.[0]?.text ?? '';
}

// ─── Setup ────────────────────────────────────────────────────────────────

async function setup(): Promise<Client> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);

  return client;
}

// ─── Tests ────────────────────────────────────────────────────────────────

async function run() {
  const client = await setup();
  const projectPath = path.resolve(import.meta.dirname!, '..');

  console.log('=========================================');
  console.log('Stack Compass v2.0 — TypeScript Test Suite');
  console.log('=========================================\n');

  // ── 1. analyze-project ────────────────────────────────────────────────
  {
    console.log('Test 1: analyze-project (this repo)');
    const r = getText(await client.callTool({ name: 'analyze-project', arguments: { projectPath } }));
    assert('Detects typescript', r, 'typescript');
    assert('Detects npm', r, 'npm');
    assert('Shows version', r, 'v6.0.2');
    assert('Shows Build Tools', r, 'Build Tools');
  }

  // ── 2. Spring Boot 3 doc index ────────────────────────────────────────
  {
    console.log('Test 2: get-doc-index (spring-boot v3.2.0)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'spring-boot', version: '3.2.0' } }));
    assert('Has jakarta namespace', r, 'jakarta');
    assert('Has SecurityFilterChain', r, 'SecurityFilterChain');
    assert('Has observability', r, 'observability');
    assert('Has migration', r, 'migration');
    assert('Has native', r, 'native');
    assert('Has virtual-threads', r, 'virtual-threads');
  }

  // ── 3. Spring Boot 2 doc index ────────────────────────────────────────
  {
    console.log('Test 3: get-doc-index (spring-boot v2.7.0)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'spring-boot', version: '2.7.0' } }));
    assert('Has javax namespace', r, 'javax');
    assert('Has WebSecurityConfigurerAdapter', r, 'WebSecurityConfigurerAdapter');
    assertNot('No observability in Boot 2', r, 'observability');
    assertNot('No virtual-threads in Boot 2', r, 'virtual-threads');
  }

  // ── 4. Spring Boot 3 security section ─────────────────────────────────
  {
    console.log('Test 4: get-doc-section (spring-boot/security v3.2.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-boot', sectionId: 'security', version: '3.2.0' } }));
    assert('SecurityFilterChain code', r, 'SecurityFilterChain');
    assert('requestMatchers', r, 'requestMatchers');
    assert('Lambda DSL', r, 'lambda');
  }

  // ── 5. Spring Boot 2 security section ─────────────────────────────────
  {
    console.log('Test 5: get-doc-section (spring-boot/security v2.7.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-boot', sectionId: 'security', version: '2.7.0' } }));
    assert('WebSecurityConfigurerAdapter', r, 'WebSecurityConfigurerAdapter');
    assert('antMatchers', r, 'antMatchers');
    assertNot('No requestMatchers in v2', r, 'requestMatchers');
  }

  // ── 6. Namespace Boot 3 ───────────────────────────────────────────────
  {
    console.log('Test 6: get-doc-section (spring-boot/namespace v3.2.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-boot', sectionId: 'namespace', version: '3.2.0' } }));
    assert('jakarta.persistence', r, 'jakarta.persistence');
    assert('jakarta.servlet', r, 'jakarta.servlet');
    assert('BREAKING CHANGE', r, 'BREAKING');
  }

  // ── 7. Namespace Boot 2 ───────────────────────────────────────────────
  {
    console.log('Test 7: get-doc-section (spring-boot/namespace v2.7.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-boot', sectionId: 'namespace', version: '2.7.0' } }));
    assert('javax.persistence', r, 'javax.persistence');
    assert('javax.servlet', r, 'javax.servlet');
  }

  // ── 8. Hibernate 6 entity ─────────────────────────────────────────────
  {
    console.log('Test 8: get-doc-section (hibernate/entity v6.4.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'hibernate', sectionId: 'entity', version: '6.4.0' } }));
    assert('Has jakarta.persistence', r, 'jakarta.persistence');
  }

  // ── 9. Hibernate 5 entity ─────────────────────────────────────────────
  {
    console.log('Test 9: get-doc-section (hibernate/entity v5.6.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'hibernate', sectionId: 'entity', version: '5.6.0' } }));
    assert('Has javax.persistence', r, 'javax.persistence');
  }

  // ── 10. React 18 index ────────────────────────────────────────────────
  {
    console.log('Test 10: get-doc-index (react v18.2.0)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'react', version: '18.2.0' } }));
    assert('Has concurrent', r, 'concurrent');
    assert('Has Suspense', r, 'Suspense');
    assert('Has createRoot', r, 'createRoot');
    assertNot('No useActionState in React 18', r, 'useActionState');
  }

  // ── 11. React 19 index ────────────────────────────────────────────────
  {
    console.log('Test 11: get-doc-index (react v19.0.0)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'react', version: '19.0.0' } }));
    assert('Has Actions', r, 'Actions');
    assert('Has use() API', r, 'use()');
    assert('Has Compiler', r, 'Compiler');
    assert('Has Server Components', r, 'Server Components');
  }

  // ── 12. GraphQL index ─────────────────────────────────────────────────
  {
    console.log('Test 12: get-doc-index (graphql)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'graphql' } }));
    assert('Has schema', r, 'schema');
    assert('Has queries', r, 'queries');
    assert('Has mutations', r, 'mutations');
    assert('Has resolvers', r, 'resolvers');
    assert('Has subscriptions', r, 'subscriptions');
  }

  // ── 13. GraphQL schema content ────────────────────────────────────────
  {
    console.log('Test 13: get-doc-section (graphql/schema)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'graphql', sectionId: 'schema' } }));
    assert('Has type Query', r, 'type Query');
    assert('Has type Mutation', r, 'type Mutation');
    assert('Has input type', r, 'input CreateUserInput');
  }

  // ── 14. GraphQL mutations content ─────────────────────────────────────
  {
    console.log('Test 14: get-doc-section (graphql/mutations)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'graphql', sectionId: 'mutations' } }));
    assert('Has mutation keyword', r, 'mutation');
    assert('Has input', r, 'input');
  }

  // ── 15. Docker index ──────────────────────────────────────────────────
  {
    console.log('Test 15: get-doc-index (docker)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'docker' } }));
    assert('Has dockerfile', r, 'dockerfile');
    assert('Has multistage', r, 'multistage');
    assert('Has compose', r, 'compose');
  }

  // ── 16. Docker multistage content ─────────────────────────────────────
  {
    console.log('Test 16: get-doc-section (docker/multistage)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'docker', sectionId: 'multistage' } }));
    assert('Has FROM ... AS build', r, 'AS build');
    assert('Has COPY --from', r, 'COPY --from');
    assert('Has maven', r, 'maven');
  }

  // ── 17. Kubernetes index ──────────────────────────────────────────────
  {
    console.log('Test 17: get-doc-index (kubernetes)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'kubernetes' } }));
    assert('Has deployment', r, 'deployment');
    assert('Has service', r, 'service');
    assert('Has ConfigMap', r, 'ConfigMap');
  }

  // ── 18. Kubernetes section content ────────────────────────────────────
  {
    console.log('Test 18: get-doc-section (kubernetes/deployment)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'kubernetes', sectionId: 'deployment' } }));
    assert('Has replicas', r, 'replicas');
    assert('Has containers', r, 'containers');
    assert('Has image', r, 'image');
  }

  {
    console.log('Test 19: get-doc-section (kubernetes/service)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'kubernetes', sectionId: 'service' } }));
    assert('Has ClusterIP', r, 'ClusterIP');
    assert('Has selector', r, 'selector');
  }

  // ── 20. Scala 2 vs 3 index ───────────────────────────────────────────
  {
    console.log('Test 20: get-doc-index (scala v2.13.0)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'scala', version: '2.13.0' } }));
    assert('Has implicits', r, 'implicits');
    assertNot('No given-using in Scala 2', r, 'given-using');
  }

  {
    console.log('Test 21: get-doc-index (scala v3.3.0)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'scala', version: '3.3.0' } }));
    assert('Has given-using', r, 'given-using');
    assert('Has enums', r, 'enums');
  }

  // ── 22. Scala section content ─────────────────────────────────────────
  {
    console.log('Test 22: get-doc-section (scala/implicits v2.13.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'scala', sectionId: 'implicits', version: '2.13.0' } }));
    assert('Has implicit val', r, 'implicit val');
    assert('Has implicit class', r, 'implicit class');
    assert('Has JsonWriter', r, 'JsonWriter');
  }

  {
    console.log('Test 23: get-doc-section (scala/given-using v3.3.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'scala', sectionId: 'given-using', version: '3.3.0' } }));
    assert('Has given keyword', r, 'given');
    assert('Has using keyword', r, 'using');
    assert('Has extension', r, 'extension');
  }

  // ── 24. JUnit 4 vs 5 index ───────────────────────────────────────────
  {
    console.log('Test 24: get-doc-index (junit v4.13.0)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'junit', version: '4.13.0' } }));
    assert('Has @RunWith', r, '@RunWith');
    assertNot('No @ExtendWith in JUnit 4', r, '@ExtendWith');
  }

  {
    console.log('Test 25: get-doc-index (junit v5.9.0)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'junit', version: '5.9.0' } }));
    assert('Has @ExtendWith', r, '@ExtendWith');
    assert('Has parameterized', r, 'parameterized');
  }

  // ── 26. JUnit section content ─────────────────────────────────────────
  {
    console.log('Test 26: get-doc-section (junit/basics v4.13.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'junit', sectionId: 'basics', version: '4.13.0' } }));
    assert('Has @Before', r, '@Before');
    assert('Has @RunWith', r, '@RunWith');
  }

  {
    console.log('Test 27: get-doc-section (junit/basics v5.9.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'junit', sectionId: 'basics', version: '5.9.0' } }));
    assert('Has @BeforeEach', r, '@BeforeEach');
    assert('Has @ExtendWith', r, '@ExtendWith');
    assert('Has @DisplayName', r, '@DisplayName');
  }

  {
    console.log('Test 28: get-doc-section (junit/parameterized v5.9.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'junit', sectionId: 'parameterized', version: '5.9.0' } }));
    assert('Has @ParameterizedTest', r, '@ParameterizedTest');
    assert('Has @ValueSource', r, '@ValueSource');
    assert('Has @CsvSource', r, '@CsvSource');
    assert('Has @MethodSource', r, '@MethodSource');
  }

  // ── 29. Spring Security 5 vs 6 content ────────────────────────────────
  {
    console.log('Test 29: get-doc-section (spring-security/config v5.8.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-security', sectionId: 'config', version: '5.8.0' } }));
    assert('Has WebSecurityConfigurerAdapter', r, 'WebSecurityConfigurerAdapter');
    assert('Has antMatchers', r, 'antMatchers');
  }

  {
    console.log('Test 30: get-doc-section (spring-security/config v6.2.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-security', sectionId: 'config', version: '6.2.0' } }));
    assert('Has SecurityFilterChain', r, 'SecurityFilterChain');
    assert('Has requestMatchers', r, 'requestMatchers');
  }

  {
    console.log('Test 31: get-doc-section (spring-security/migration)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-security', sectionId: 'migration', version: '6.2.0' } }));
    assert('Has antMatchers→requestMatchers', r, 'requestMatchers');
    assert('Has jakarta.servlet', r, 'jakarta.servlet');
  }

  // ── 32. Redux content ─────────────────────────────────────────────────
  {
    console.log('Test 32: get-doc-section (redux/slices)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'redux', sectionId: 'slices' } }));
    assert('Has createSlice', r, 'createSlice');
    assert('Has Immer', r, 'Immer');
  }

  {
    console.log('Test 33: get-doc-section (redux/store)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'redux', sectionId: 'store' } }));
    assert('Has configureStore', r, 'configureStore');
  }

  // ── 34. MongoDB content ───────────────────────────────────────────────
  {
    console.log('Test 34: get-doc-section (mongodb/aggregation)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'mongodb', sectionId: 'aggregation' } }));
    assert('Has $match', r, '$match');
    assert('Has $group', r, '$group');
    assert('Has $lookup', r, '$lookup');
  }

  {
    console.log('Test 35: get-doc-section (mongodb/spring-data)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'mongodb', sectionId: 'spring-data' } }));
    assert('Has @Document', r, '@Document');
    assert('Has MongoRepository', r, 'MongoRepository');
  }

  // ── 36. Spring Boot 3 migration ───────────────────────────────────────
  {
    console.log('Test 36: get-doc-section (spring-boot/migration v3.2.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-boot', sectionId: 'migration', version: '3.2.0' } }));
    assert('javax→jakarta', r, 'jakarta');
    assert('Java 17', r, 'Java 17');
    assert('spring.factories', r, 'spring.factories');
  }

  // ── 37. Akka content ──────────────────────────────────────────────────
  {
    console.log('Test 37: get-doc-section (akka/typed-actors)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'akka', sectionId: 'typed-actors' } }));
    assert('Has Behavior[Command]', r, 'Behavior[Command]');
    assert('Has ActorRef', r, 'ActorRef');
    assert('Has Behaviors.receive', r, 'Behaviors.receive');
  }

  {
    console.log('Test 38: get-doc-section (akka/streams)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'akka', sectionId: 'streams' } }));
    assert('Has Source', r, 'Source');
    assert('Has Flow', r, 'Flow');
    assert('Has Sink', r, 'Sink');
    assert('Has Backpressure', r, 'Backpressure');
  }

  {
    console.log('Test 39: get-doc-section (akka/persistence)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'akka', sectionId: 'persistence' } }));
    assert('Has EventSourcedBehavior', r, 'EventSourcedBehavior');
    assert('Has journal', r, 'journal');
    assert('Has snapshot', r, 'snapshot');
  }

  // ── 40. Docker compose content ────────────────────────────────────────
  {
    console.log('Test 40: get-doc-section (docker/compose)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'docker', sectionId: 'compose' } }));
    assert('Has services', r, 'services');
    assert('Has ports', r, 'ports');
    assert('Has volumes', r, 'volumes');
  }

  // ── 41. Invalid section returns available list ────────────────────────
  {
    console.log('Test 41: get-doc-section (invalid section)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-boot', sectionId: 'nonexistent', version: '3.0.0' } }));
    assert('Shows not found', r, 'not found');
    assert('Lists available sections', r, 'Available sections');
  }

  // ── 42. Unknown framework ─────────────────────────────────────────────
  {
    console.log('Test 42: get-doc-index (unknown framework)');
    const r = getText(await client.callTool({ name: 'get-doc-index', arguments: { framework: 'some-unknown-lib' } }));
    assert('Suggests add-framework', r, 'add-framework');
  }

  // ── 43. add-framework ─────────────────────────────────────────────────
  {
    console.log('Test 43: add-framework');
    const r = getText(await client.callTool({ name: 'add-framework', arguments: { key: 'my-lib', description: 'Test library', officialDocs: 'https://example.com', minMajor: 1 } }));
    assert('Framework registered', r, 'Framework Registered');
    assert('Shows description', r, 'Test library');
  }

  // ── 44. list-all-supported-frameworks ─────────────────────────────────
  {
    console.log('Test 44: list-all-supported-frameworks');
    const r = getText(await client.callTool({ name: 'list-all-supported-frameworks', arguments: {} }));
    assert('Has spring-boot', r, 'spring-boot');
    assert('Has react', r, 'react');
    assert('Has graphql', r, 'graphql');
    assert('Has docker', r, 'docker');
    assert('Has scala', r, 'scala');
    assert('Has mongodb', r, 'mongodb');
    assert('Has spring-security', r, 'spring-security');
    assert('Has junit', r, 'junit');
    assert('Has akka', r, 'akka');
    assert('Has redux', r, 'redux');
    assert('Has kubernetes', r, 'kubernetes');
    assert('Has hibernate', r, 'hibernate');
  }

  // ── 45. Stateful: list-detected-frameworks after analyze ──────────────
  {
    console.log('Test 45: list-detected-frameworks (stateful)');
    const r = getText(await client.callTool({ name: 'list-detected-frameworks', arguments: {} }));
    assert('Lists typescript', r, 'typescript');
    assert('Lists npm', r, 'npm');
  }

  // ── 46. Stateful: get-project-stack after analyze ─────────────────────
  {
    console.log('Test 46: get-project-stack (stateful)');
    const r = getText(await client.callTool({ name: 'get-project-stack', arguments: {} }));
    assert('Shows root path', r, 'pom-to-doc-mcp');
    assert('Shows modules', r, 'root');
  }

  // ── 47. Scala enums content (Scala 3 only) ────────────────────────────
  {
    console.log('Test 47: get-doc-section (scala/enums v3.3.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'scala', sectionId: 'enums', version: '3.3.0' } }));
    assert('Has enum keyword', r, 'enum Color');
    assert('Has case', r, 'case Red');
  }

  // ── 48. Scala migration content ───────────────────────────────────────
  {
    console.log('Test 48: get-doc-section (scala/migration v3.3.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'scala', sectionId: 'migration', version: '3.3.0' } }));
    assert('implicit→given', r, 'given');
    assert('Has wildcard import change', r, 'import pkg.*');
  }

  // ── 49. JUnit migration content ───────────────────────────────────────
  {
    console.log('Test 49: get-doc-section (junit/migration v5.9.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'junit', sectionId: 'migration', version: '5.9.0' } }));
    assert('@Before→@BeforeEach', r, '@BeforeEach');
    assert('@RunWith→@ExtendWith', r, '@ExtendWith');
    assert('assertThrows', r, 'assertThrows');
  }

  // ── 50. JUnit 5 nested tests content ──────────────────────────────────
  {
    console.log('Test 50: get-doc-section (junit/nested v5.9.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'junit', sectionId: 'nested', version: '5.9.0' } }));
    assert('Has @Nested', r, '@Nested');
    assert('Has @DisplayName', r, '@DisplayName');
  }

  // ── 51. Akka HTTP content ─────────────────────────────────────────────
  {
    console.log('Test 51: get-doc-section (akka/http)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'akka', sectionId: 'http' } }));
    assert('Has routes', r, 'routes');
    assert('Has pathPrefix', r, 'pathPrefix');
    assert('Has complete', r, 'complete');
  }

  // ── 52. Akka cluster content ──────────────────────────────────────────
  {
    console.log('Test 52: get-doc-section (akka/cluster)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'akka', sectionId: 'cluster' } }));
    assert('Has ClusterSharding', r, 'ClusterSharding');
    assert('Has seed-nodes', r, 'seed-nodes');
  }

  // ── 53. Spring Security authorization content ─────────────────────────
  {
    console.log('Test 53: get-doc-section (spring-security/authorization v5.8.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-security', sectionId: 'authorization', version: '5.8.0' } }));
    assert('Has antMatchers', r, 'antMatchers');
    assert('Has permitAll', r, 'permitAll');
    assert('Has hasRole', r, 'hasRole');
  }

  {
    console.log('Test 54: get-doc-section (spring-security/authorization v6.2.0)');
    const r = getText(await client.callTool({ name: 'get-doc-section', arguments: { framework: 'spring-security', sectionId: 'authorization', version: '6.2.0' } }));
    assert('Has requestMatchers', r, 'requestMatchers');
    assert('Has authorizeHttpRequests', r, 'authorizeHttpRequests');
  }

  // ── 55. remove-framework ──────────────────────────────────────────────
  {
    console.log('Test 55: remove-framework');
    const r = getText(await client.callTool({ name: 'remove-framework', arguments: { key: 'my-lib' } }));
    assert('Shows removed', r, 'Removed');
  }

  {
    console.log('Test 56: remove-framework (non-existent)');
    const r = getText(await client.callTool({ name: 'remove-framework', arguments: { key: 'nope' } }));
    assert('Shows not found', r, 'No custom framework');
  }

  // ── 57. fetch-external-docs — framework with no llmsTxt/github falls back to built-in
  {
    console.log('Test 57: fetch-external-docs (spring-boot v3.2.0 — fallback to built-in)');
    const r = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'spring-boot', version: '3.2.0' } }));
    assert('Has banner', r, '# spring-boot v3.2.0');
    assert('Has description', r, 'Spring Boot');
    assert('Falls back to built-in content', r, 'SecurityFilterChain');
    assert('Has namespace section', r, 'jakarta.persistence');
    assert('Has entry-point section', r, '@SpringBootApplication');
  }

  // ── 58. fetch-external-docs — version-specific fallback
  {
    console.log('Test 58: fetch-external-docs (spring-boot v2.7.0 — v2 built-in)');
    const r = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'spring-boot', version: '2.7.0' } }));
    assert('Has javax namespace', r, 'javax.persistence');
    assert('Has WebSecurityConfigurerAdapter', r, 'WebSecurityConfigurerAdapter');
  }

  // ── 59. fetch-external-docs — completely unknown framework
  {
    console.log('Test 59: fetch-external-docs (unknown framework)');
    const r = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'totally-unknown' } }));
    assert('Suggests add-framework', r, 'add-framework');
  }

  // ── 60. fetch-external-docs — custom framework with no sources
  {
    console.log('Test 60: fetch-external-docs (custom framework, no llmsTxt/github)');
    await client.callTool({ name: 'add-framework', arguments: { key: 'internal-lib', description: 'Our internal library' } });
    const r = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'internal-lib' } }));
    assert('Has banner', r, '# internal-lib');
    assert('Shows no external docs available', r, 'No external documentation available');
    assert('Suggests add-framework with source', r, 'add-framework');
    await client.callTool({ name: 'remove-framework', arguments: { key: 'internal-lib' } });
  }

  // ── 61. fetch-external-docs — framework with github always returns content
  {
    console.log('Test 61: fetch-external-docs (graphql — has github, returns content)');
    const r = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'graphql' } }));
    assert('Has banner', r, '# graphql');
    assert('Has description', r, 'query language');
    assert('Returns non-trivial content', r, '---');
  }

  // ── 62. fetch-external-docs — hibernate version fallback
  {
    console.log('Test 62: fetch-external-docs (hibernate v5.6.0 — v5 built-in)');
    const r = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'hibernate', version: '5.6.0' } }));
    assert('Has javax.persistence', r, 'javax.persistence');
  }

  {
    console.log('Test 63: fetch-external-docs (hibernate v6.4.0 — v6 built-in)');
    const r = getText(await client.callTool({ name: 'fetch-external-docs', arguments: { framework: 'hibernate', version: '6.4.0' } }));
    assert('Has jakarta.persistence', r, 'jakarta.persistence');
  }

  // ── Results ───────────────────────────────────────────────────────────
  console.log('\n=========================================');
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log('=========================================');

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(f);
  }

  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(2);
});
