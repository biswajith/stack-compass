import {
  FRAMEWORK_DOCS, FrameworkDocEntry, VersionedDocSource,
  resolveDocSource, parseMajor,
  DocTreeIndex, DocSection,
} from './types.js';

export class DocFetcher {
  private cache = new Map<string, { content: string; timestamp: number }>();
  private customFrameworks = new Map<string, FrameworkDocEntry>();
  private cacheTTL = 1000 * 60 * 60;

  // ─── Runtime framework management ─────────────────────────────────────

  addFramework(key: string, entry: FrameworkDocEntry): void {
    this.customFrameworks.set(key, entry);
    this.invalidateCache(key);
  }

  removeFramework(key: string): boolean {
    const existed = this.customFrameworks.delete(key);
    this.invalidateCache(key);
    return existed;
  }

  listCustomFrameworks(): Map<string, FrameworkDocEntry> {
    return new Map(this.customFrameworks);
  }

  private invalidateCache(key: string) {
    for (const k of this.cache.keys()) {
      if (k.startsWith(`${key}:`)) this.cache.delete(k);
    }
  }

  private resolveEntry(key: string): FrameworkDocEntry | undefined {
    return this.customFrameworks.get(key) ?? FRAMEWORK_DOCS[key];
  }

  // ─── Phase 1: Tree index (lightweight) ────────────────────────────────

  getDocIndex(frameworkKey: string, version?: string): DocTreeIndex | null {
    const entry = this.resolveEntry(frameworkKey);
    if (!entry) return null;

    const source = resolveDocSource(entry, version);
    const sections = this.buildSectionTree(frameworkKey, version);

    return {
      framework: frameworkKey,
      version,
      description: source.description,
      officialDocs: source.officialDocs,
      github: source.github ? `https://github.com/${source.github}` : undefined,
      sections,
    };
  }

  // ─── Phase 2: Section content (targeted) ──────────────────────────────

  getSectionContent(frameworkKey: string, sectionId: string, version?: string): string | null {
    const sections = SECTION_CONTENT[frameworkKey];
    if (!sections) return null;

    const major = parseMajor(version);

    // Try version-specific section first, then unversioned
    if (major !== undefined) {
      const versionedKey = `${sectionId}:v${major}`;
      if (sections[versionedKey]) return sections[versionedKey];
    }
    return sections[sectionId] ?? null;
  }

  listSectionIds(frameworkKey: string, version?: string): string[] {
    const index = this.getDocIndex(frameworkKey, version);
    if (!index) return [];
    return this.flattenSectionIds(index.sections);
  }

  private flattenSectionIds(sections: DocSection[]): string[] {
    const ids: string[] = [];
    for (const s of sections) {
      ids.push(s.id);
      if (s.children) ids.push(...this.flattenSectionIds(s.children));
    }
    return ids;
  }

  // ─── Fetch external docs (llms.txt / GitHub README) ───────────────────

  async fetchExternalDocs(frameworkKey: string, version?: string): Promise<string> {
    const entry = this.resolveEntry(frameworkKey);
    if (!entry) return `No documentation source configured for "${frameworkKey}". Use \`add-framework\` to register it.`;

    const source = resolveDocSource(entry, version);
    const cacheKey = `${frameworkKey}:${version ?? 'latest'}:external`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) return cached.content;

    let content = '';

    // 1. Try llms.txt
    if (source.llmsTxt) content = await this.fetchUrl(source.llmsTxt, 15000);

    // 2. Try GitHub README
    if (!content && source.github) content = await this.fetchGitHubReadme(source.github);

    // 3. Fall back to built-in section content so the tool never returns empty
    if (!content) {
      const builtIn = this.assembleBuiltInDocs(frameworkKey, version);
      if (builtIn) {
        content = builtIn;
      } else {
        let fallback = `No external documentation available for "${frameworkKey}".`;
        if (source.officialDocs) fallback += `\n\nOfficial docs: ${source.officialDocs}`;
        fallback += '\n\nYou can register a documentation source with `add-framework` (provide a `llmsTxt` URL or `github` repo).';
        content = fallback;
      }
    }

    const banner = `# ${frameworkKey}${version ? ` v${version}` : ''}\n\n> ${source.description}\n`;
    content = banner + '\n---\n\n' + content;

    this.cache.set(cacheKey, { content, timestamp: Date.now() });
    return content;
  }

  private assembleBuiltInDocs(frameworkKey: string, version?: string): string | null {
    const sections = SECTION_CONTENT[frameworkKey];
    if (!sections) return null;

    const major = parseMajor(version);
    const sectionTree = this.buildSectionTree(frameworkKey, version);
    const parts: string[] = [];

    for (const sec of this.flattenSectionIdsFromTree(sectionTree)) {
      let content: string | undefined;
      if (major !== undefined) content = sections[`${sec}:v${major}`];
      if (!content) content = sections[sec];
      if (content) parts.push(content);
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
  }

  private flattenSectionIdsFromTree(sections: DocSection[]): string[] {
    const ids: string[] = [];
    for (const s of sections) {
      ids.push(s.id);
      if (s.children) ids.push(...this.flattenSectionIdsFromTree(s.children));
    }
    return ids;
  }

  // ─── Metadata helpers ─────────────────────────────────────────────────

  listAvailableFrameworks(): string[] {
    return Array.from(new Set([
      ...Object.keys(FRAMEWORK_DOCS),
      ...this.customFrameworks.keys(),
    ]));
  }

  getFrameworkDescription(key: string, version?: string): string | undefined {
    const entry = this.resolveEntry(key);
    if (!entry) return undefined;
    return resolveDocSource(entry, version).description;
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private async fetchUrl(url: string, maxLen: number): Promise<string> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'stack-compass/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return this.truncate(await res.text(), maxLen);
    } catch { /* network error */ }
    return '';
  }

  private async fetchGitHubReadme(repo: string): Promise<string> {
    for (const branch of ['main', 'master']) {
      const text = await this.fetchUrl(`https://raw.githubusercontent.com/${repo}/${branch}/README.md`, 10000);
      if (text) return text;
    }
    return '';
  }

  private truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.substring(0, max);
    const nl = cut.lastIndexOf('\n');
    return cut.substring(0, nl) + '\n\n... (content truncated)';
  }

  // ─── Build section tree for a framework ───────────────────────────────

  private buildSectionTree(key: string, version?: string): DocSection[] {
    const major = parseMajor(version);
    const tree = SECTION_TREES[key];
    if (!tree) return [{ id: 'overview', title: 'Overview', summary: 'General documentation (no detailed sections available)' }];

    // Find the best version-matched tree
    if (major !== undefined) {
      for (let i = tree.length - 1; i >= 0; i--) {
        const t = tree[i];
        const lo = t.minMajor ?? 0;
        const hi = t.maxMajor ?? Infinity;
        if (major >= lo && major < hi) return t.sections;
      }
    }
    return tree[tree.length - 1].sections;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Section trees — lightweight index the LLM navigates
// ─────────────────────────────────────────────────────────────────────────

interface VersionedSectionTree {
  minMajor?: number;
  maxMajor?: number;
  sections: DocSection[];
}

const SECTION_TREES: Record<string, VersionedSectionTree[]> = {

  'spring-boot': [
    { minMajor: 2, maxMajor: 3, sections: [
      { id: 'namespace', title: 'Namespace (javax.*)', summary: 'Spring Boot 2.x uses the javax.* namespace for all Java EE APIs — javax.persistence, javax.servlet, javax.validation' },
      { id: 'entry-point', title: 'Application Entry Point', summary: '@SpringBootApplication main class with SpringApplication.run()' },
      { id: 'rest-controller', title: 'REST Controllers', summary: '@RestController, @RequestMapping, @GetMapping/@PostMapping, @Autowired injection' },
      { id: 'security', title: 'Security Configuration', summary: 'Spring Security 5.x — extends WebSecurityConfigurerAdapter, authorizeRequests(), antMatchers()' },
      { id: 'data-access', title: 'Data Access', summary: 'Spring Data JPA with javax.persistence, JpaRepository, @Query, @Transactional' },
      { id: 'testing', title: 'Testing', summary: '@SpringBootTest, @MockBean, @WebMvcTest, MockMvc, JUnit 5' },
      { id: 'config', title: 'Configuration', summary: 'application.properties/yml, @Value, @ConfigurationProperties, profiles' },
      { id: 'key-points', title: 'Key Points', summary: 'Java 8-17 supported, javax.* namespace, spring.factories for auto-config' },
    ]},
    { minMajor: 3, sections: [
      { id: 'namespace', title: 'Namespace (jakarta.*)', summary: 'BREAKING CHANGE: Spring Boot 3 migrated from javax.* to jakarta.* — jakarta.persistence, jakarta.servlet, jakarta.validation' },
      { id: 'entry-point', title: 'Application Entry Point', summary: '@SpringBootApplication main class — same pattern as Boot 2 but requires Java 17+' },
      { id: 'rest-controller', title: 'REST Controllers', summary: '@RestController with constructor injection (preferred over @Autowired), ResponseEntity patterns' },
      { id: 'security', title: 'Security Configuration', summary: 'SecurityFilterChain bean config — WebSecurityConfigurerAdapter REMOVED. Uses requestMatchers() instead of antMatchers()' },
      { id: 'observability', title: 'Observability', summary: 'Micrometer Observation API, @Observed annotation, automatic tracing, metrics integration' },
      { id: 'native', title: 'GraalVM Native Image', summary: 'spring-boot-starter-native for AOT compilation, native builds, reduced startup time' },
      { id: 'data-access', title: 'Data Access', summary: 'Spring Data JPA with jakarta.persistence, JpaRepository, same query methods but jakarta namespace' },
      { id: 'testing', title: 'Testing', summary: '@SpringBootTest, @MockBean (deprecated in 3.4 — use @MockitoBean), MockMvc, JUnit 5' },
      { id: 'virtual-threads', title: 'Virtual Threads', summary: 'Java 21+ virtual threads support: spring.threads.virtual.enabled=true' },
      { id: 'config', title: 'Configuration', summary: 'application.properties/yml, AutoConfiguration.imports replaces spring.factories' },
      { id: 'migration', title: 'Migration from 2.x', summary: 'javax→jakarta, Java 17 minimum, WebSecurityConfigurerAdapter removed, trailing slash behavior changed' },
      { id: 'key-points', title: 'Key Points', summary: 'Java 17+ required, jakarta.* namespace, GraalVM support, Micrometer observability' },
    ]},
  ],

  'hibernate': [
    { minMajor: 5, maxMajor: 6, sections: [
      { id: 'entity', title: 'Entity Definition', summary: 'javax.persistence.* — @Entity, @Table, @Id, @GeneratedValue, @Column, @OneToMany' },
      { id: 'repository', title: 'Repository Pattern', summary: 'JpaRepository with Spring Data JPA, derived query methods, @Query with JPQL' },
      { id: 'relationships', title: 'Relationships', summary: '@OneToMany, @ManyToOne, @ManyToMany, fetch types (LAZY vs EAGER), cascade options' },
      { id: 'queries', title: 'Queries (HQL/JPQL)', summary: 'HQL and JPQL query language, Criteria API (JPA 2.x style), named queries' },
      { id: 'key-points', title: 'Key Points', summary: 'javax.persistence namespace, JPA 2.1/2.2, Session and EntityManager API' },
    ]},
    { minMajor: 6, sections: [
      { id: 'entity', title: 'Entity Definition', summary: 'BREAKING: jakarta.persistence.* — @Entity, @Table, @Id, @GeneratedValue, @Column' },
      { id: 'repository', title: 'Repository Pattern', summary: 'JpaRepository with Spring Data JPA 3.x, same query methods but jakarta namespace' },
      { id: 'relationships', title: 'Relationships', summary: '@OneToMany, @ManyToOne, @ManyToMany — same annotations, jakarta.persistence namespace' },
      { id: 'queries', title: 'Queries (SQM)', summary: 'New Semantic Query Model (SQM) replaces old HQL parser, stricter type coercion' },
      { id: 'type-system', title: 'Type System', summary: 'Major internal rewrite — @JdbcTypeCode for explicit SQL type mapping, improved embeddables' },
      { id: 'migration', title: 'Migration from 5.x', summary: 'javax→jakarta, sequence generator defaults changed, stricter implicit type coercion, custom types may need updates' },
      { id: 'key-points', title: 'Key Points', summary: 'jakarta.persistence namespace, JPA 3.1, new SQM query model, improved type system' },
    ]},
  ],

  'react': [
    { minMajor: 0, maxMajor: 17, sections: [
      { id: 'class-components', title: 'Class Components', summary: 'React.Component with constructor, this.state, this.setState(), render()' },
      { id: 'lifecycle', title: 'Lifecycle Methods', summary: 'componentDidMount, componentDidUpdate, componentWillUnmount, shouldComponentUpdate' },
      { id: 'patterns', title: 'Patterns', summary: 'HOCs (Higher-Order Components), render props for code reuse' },
      { id: 'context', title: 'Context API', summary: 'Legacy context: contextType, Consumer/Provider pattern' },
      { id: 'key-points', title: 'Key Points', summary: 'Class components with lifecycle methods, this.setState() for updates' },
    ]},
    { minMajor: 17, maxMajor: 18, sections: [
      { id: 'hooks', title: 'Hooks', summary: 'useState, useEffect, useContext, useReducer, useMemo, useCallback, useRef' },
      { id: 'components', title: 'Function Components', summary: 'Function components with hooks, props destructuring, no need for class' },
      { id: 'jsx-transform', title: 'New JSX Transform', summary: 'No need for "import React from react" — new JSX transform handles it automatically' },
      { id: 'event-delegation', title: 'Event System', summary: 'Event delegation attached to root element instead of document' },
      { id: 'key-points', title: 'Key Points', summary: 'Transition release, no new features, stepping stone for gradual upgrades' },
    ]},
    { minMajor: 18, maxMajor: 19, sections: [
      { id: 'concurrent', title: 'Concurrent Rendering', summary: 'useTransition for non-urgent updates, useDeferredValue for deferred re-renders' },
      { id: 'suspense', title: 'Suspense', summary: 'Suspense for data fetching, streaming SSR with renderToPipeableStream' },
      { id: 'new-hooks', title: 'New Hooks', summary: 'useTransition, useDeferredValue, useId, useSyncExternalStore' },
      { id: 'auto-batching', title: 'Automatic Batching', summary: 'State updates in timeouts/promises/event handlers are now all batched automatically' },
      { id: 'create-root', title: 'createRoot API', summary: 'ReactDOM.createRoot() replaces ReactDOM.render() — required for concurrent features' },
      { id: 'migration', title: 'Migration from 17', summary: 'Replace ReactDOM.render with createRoot, Strict Mode double-invokes effects in dev' },
      { id: 'key-points', title: 'Key Points', summary: 'Concurrent rendering, automatic batching, Suspense for data, streaming SSR' },
    ]},
    { minMajor: 19, sections: [
      { id: 'actions', title: 'Actions', summary: 'useActionState for form action state management, <form action> as handler' },
      { id: 'use-api', title: 'use() API', summary: 'use() to unwrap promises and read context during render' },
      { id: 'optimistic', title: 'useOptimistic', summary: 'useOptimistic hook for optimistic UI updates during async operations' },
      { id: 'compiler', title: 'React Compiler', summary: 'Experimental auto-memoization — no more manual useMemo/useCallback' },
      { id: 'server-components', title: 'Server Components', summary: 'Server Components are now stable, async components on the server' },
      { id: 'ref-as-prop', title: 'ref as Prop', summary: 'forwardRef no longer needed — ref is a regular prop' },
      { id: 'migration', title: 'Migration from 18', summary: 'forwardRef removed, Context renders directly as provider, Suspense sibling behavior changed' },
      { id: 'key-points', title: 'Key Points', summary: 'Actions, use() API, React Compiler, Server Components stable' },
    ]},
  ],

  'graphql': [{ sections: [
    { id: 'schema', title: 'Schema Definition', summary: 'type, Query, Mutation, Subscription, input types, enums, interfaces, unions' },
    { id: 'queries', title: 'Queries', summary: 'Read operations — field selection, nested objects, arguments, aliases, fragments' },
    { id: 'mutations', title: 'Mutations', summary: 'Write operations — create, update, delete with input types' },
    { id: 'subscriptions', title: 'Subscriptions', summary: 'Real-time data via WebSocket — subscribe to events' },
    { id: 'resolvers', title: 'Resolvers', summary: 'Functions that fetch data for each field — parent, args, context, info' },
    { id: 'variables', title: 'Variables & Directives', summary: 'Parameterized queries with $variables, @include/@skip/@deprecated directives' },
    { id: 'fragments', title: 'Fragments', summary: 'Reusable field selections — fragment...on Type, inline fragments' },
    { id: 'key-concepts', title: 'Key Concepts', summary: 'Type system, introspection, N+1 problem (DataLoader), pagination (cursor vs offset)' },
  ]}],

  'spring-security': [
    { minMajor: 5, maxMajor: 6, sections: [
      { id: 'config', title: 'Configuration', summary: 'Extends WebSecurityConfigurerAdapter, override configure(HttpSecurity), configure(AuthenticationManagerBuilder)' },
      { id: 'authorization', title: 'Authorization Rules', summary: 'authorizeRequests().antMatchers("/path").permitAll()/authenticated()/hasRole()' },
      { id: 'authentication', title: 'Authentication', summary: 'In-memory, JDBC, LDAP, custom UserDetailsService' },
      { id: 'key-points', title: 'Key Points', summary: 'javax.servlet namespace, WebSecurityConfigurerAdapter pattern, antMatchers()' },
    ]},
    { minMajor: 6, sections: [
      { id: 'config', title: 'Configuration', summary: 'SecurityFilterChain @Bean — NO WebSecurityConfigurerAdapter, lambda DSL, Customizer.withDefaults()' },
      { id: 'authorization', title: 'Authorization Rules', summary: 'authorizeHttpRequests(auth -> auth.requestMatchers("/path").permitAll())' },
      { id: 'authentication', title: 'Authentication', summary: 'UserDetailsService bean, PasswordEncoder bean, OAuth2 resource server' },
      { id: 'migration', title: 'Migration from 5.x', summary: 'WebSecurityConfigurerAdapter removed, antMatchers→requestMatchers, jakarta.servlet namespace' },
      { id: 'key-points', title: 'Key Points', summary: 'jakarta.servlet, SecurityFilterChain bean, requestMatchers(), lambda DSL default' },
    ]},
  ],

  'scala': [
    { minMajor: 2, maxMajor: 3, sections: [
      { id: 'basics', title: 'Basic Syntax', summary: 'val/var, case classes, pattern matching, higher-order functions, collections' },
      { id: 'implicits', title: 'Implicits', summary: 'implicit classes, implicit parameters, implicit conversions, type classes via implicits' },
      { id: 'traits', title: 'Traits & Mixins', summary: 'Trait linearization, stackable modifications, self-types' },
      { id: 'collections', title: 'Collections', summary: 'List, Vector, Map, Set, Seq — map, filter, fold, flatMap, for-comprehensions' },
      { id: 'key-points', title: 'Key Points', summary: 'Immutability preferred, implicit for type classes, macros via scala.reflect' },
    ]},
    { minMajor: 3, sections: [
      { id: 'basics', title: 'Basic Syntax', summary: 'val/var, case classes, enum keyword, pattern matching, optional braces (indentation syntax)' },
      { id: 'given-using', title: 'given/using (Replaces Implicits)', summary: 'given instances, using clauses, extension methods, context functions' },
      { id: 'enums', title: 'Enums', summary: 'enum keyword replaces sealed trait + case objects pattern' },
      { id: 'types', title: 'New Type Features', summary: 'Union types (A | B), intersection types (A & B), opaque types, type lambdas' },
      { id: 'migration', title: 'Migration from Scala 2', summary: 'implicit→given/using, _→* for wildcard imports, new macro system, optional braces' },
      { id: 'key-points', title: 'Key Points', summary: 'given/using replaces implicit, enum keyword, opaque types, new macro system' },
    ]},
  ],

  'junit': [
    { minMajor: 4, maxMajor: 5, sections: [
      { id: 'basics', title: 'Test Basics', summary: '@Test, @Before/@After, @BeforeClass/@AfterClass, @RunWith, @Ignore' },
      { id: 'assertions', title: 'Assertions', summary: 'assertEquals, assertTrue, assertNotNull, assertThat with Hamcrest matchers' },
      { id: 'exceptions', title: 'Exception Testing', summary: '@Test(expected = Exception.class) for expected exceptions' },
      { id: 'key-points', title: 'Key Points', summary: '@RunWith for extensions, Hamcrest matchers, @Rule for test rules' },
    ]},
    { minMajor: 5, sections: [
      { id: 'basics', title: 'Test Basics', summary: '@Test, @BeforeEach/@AfterEach, @BeforeAll/@AfterAll, @ExtendWith, @Disabled, @DisplayName' },
      { id: 'assertions', title: 'Assertions', summary: 'assertEquals, assertTrue, assertNotNull, assertThrows(), assertAll() for grouped assertions' },
      { id: 'parameterized', title: 'Parameterized Tests', summary: '@ParameterizedTest with @ValueSource, @CsvSource, @MethodSource, @EnumSource' },
      { id: 'nested', title: 'Nested Tests', summary: '@Nested inner classes for logically grouped tests' },
      { id: 'migration', title: 'Migration from JUnit 4', summary: '@Before→@BeforeEach, @RunWith→@ExtendWith, @Test(expected)→assertThrows(), @Rule→@ExtendWith' },
      { id: 'key-points', title: 'Key Points', summary: '@ExtendWith, assertThrows, @ParameterizedTest, @Nested, @DisplayName' },
    ]},
  ],

  'docker': [{ sections: [
    { id: 'dockerfile', title: 'Dockerfile', summary: 'FROM, WORKDIR, COPY, RUN, EXPOSE, CMD, ENTRYPOINT — building container images' },
    { id: 'multistage', title: 'Multi-stage Builds', summary: 'Separate build and runtime stages to minimize image size (e.g. Maven build → JRE runtime)' },
    { id: 'compose', title: 'Docker Compose', summary: 'Multi-container orchestration — services, ports, volumes, depends_on, networks' },
    { id: 'commands', title: 'Common Commands', summary: 'docker build, run, ps, stop, logs, exec, images, system prune' },
    { id: 'key-concepts', title: 'Key Concepts', summary: 'Images vs containers, layers, volumes for persistence, networks for service communication' },
  ]}],

  'kubernetes': [{ sections: [
    { id: 'deployment', title: 'Deployment', summary: 'Manages pod replicas, rolling updates, rollbacks — spec.replicas, spec.template' },
    { id: 'service', title: 'Service', summary: 'Stable network endpoint — ClusterIP, NodePort, LoadBalancer, ExternalName' },
    { id: 'ingress', title: 'Ingress', summary: 'HTTP routing, TLS termination, path-based and host-based routing' },
    { id: 'config', title: 'ConfigMap & Secret', summary: 'Externalized configuration — environment variables, mounted files, base64-encoded secrets' },
    { id: 'hpa', title: 'Horizontal Pod Autoscaler', summary: 'Auto-scale pods based on CPU/memory/custom metrics' },
    { id: 'key-concepts', title: 'Key Concepts', summary: 'Pod, Deployment, Service, Namespace, Labels/Selectors, Resource requests/limits' },
  ]}],

  'redux': [{ sections: [
    { id: 'store', title: 'Store Setup', summary: 'configureStore from Redux Toolkit, combining reducers, middleware' },
    { id: 'slices', title: 'Slices', summary: 'createSlice — combined reducer + actions, Immer for immutable updates' },
    { id: 'async', title: 'Async Logic', summary: 'createAsyncThunk for async actions, extraReducers for handling promise states' },
    { id: 'selectors', title: 'Selectors', summary: 'useSelector hook, createSelector for memoized selectors (reselect)' },
    { id: 'key-concepts', title: 'Key Concepts', summary: 'Single source of truth, unidirectional data flow, immutable state via Immer' },
  ]}],

  'mongodb': [{ sections: [
    { id: 'crud', title: 'CRUD Operations', summary: 'insertOne/Many, find/findOne, updateOne/Many, deleteOne/Many, replaceOne' },
    { id: 'aggregation', title: 'Aggregation Pipeline', summary: '$match, $group, $project, $sort, $lookup (joins), $unwind, $facet' },
    { id: 'spring-data', title: 'Spring Data MongoDB', summary: '@Document, @Id, MongoRepository, MongoTemplate, custom queries' },
    { id: 'indexes', title: 'Indexes', summary: 'Single field, compound, text, geospatial, TTL indexes for performance' },
    { id: 'key-concepts', title: 'Key Concepts', summary: 'Collections, Documents (BSON), Replica Sets, Sharding, Schema design patterns' },
  ]}],

  'akka': [
    { minMajor: 2, maxMajor: 3, sections: [
      { id: 'typed-actors', title: 'Typed Actors', summary: 'Behavior[T], Behaviors.receive, message protocol with sealed traits, ActorRef[T]' },
      { id: 'streams', title: 'Akka Streams', summary: 'Source, Flow, Sink — reactive stream processing, backpressure, graph DSL' },
      { id: 'http', title: 'Akka HTTP', summary: 'Route DSL, directives, marshalling/unmarshalling, server and client APIs' },
      { id: 'cluster', title: 'Cluster', summary: 'Cluster membership, sharding, distributed data, split brain resolution' },
      { id: 'persistence', title: 'Persistence', summary: 'Event sourcing with EventSourcedBehavior, journals, snapshots' },
      { id: 'key-points', title: 'Key Points', summary: 'Typed actors recommended, streams for reactive pipelines, cluster for distributed systems' },
    ]},
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Section content — full content retrieved on demand by section ID
// Keys: "sectionId" or "sectionId:vMAJOR" for version-specific content
// ─────────────────────────────────────────────────────────────────────────

const SECTION_CONTENT: Record<string, Record<string, string>> = {

  'spring-boot': {
    'namespace:v2': `## Namespace (javax.*)

Spring Boot 2.x uses the **javax.\\*** namespace for all Java EE APIs:

\`\`\`java
import javax.persistence.Entity;
import javax.persistence.Id;
import javax.persistence.GeneratedValue;
import javax.persistence.GenerationType;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.validation.constraints.NotNull;
import javax.validation.constraints.Email;
\`\`\`

All Spring Boot 2.x starters pull in javax-based dependencies automatically.`,

    'namespace:v3': `## Namespace (jakarta.*)

**BREAKING CHANGE**: Spring Boot 3.x migrated all Java EE APIs to the **jakarta.\\*** namespace:

\`\`\`java
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Email;
\`\`\`

**Find & replace**: \`javax.persistence\` → \`jakarta.persistence\`, \`javax.servlet\` → \`jakarta.servlet\`, \`javax.validation\` → \`jakarta.validation\`, etc.

Third-party libraries must also be updated to jakarta-compatible versions.`,

    'entry-point': `## Application Entry Point

\`\`\`java
@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
\`\`\`

\`@SpringBootApplication\` combines:
- \`@Configuration\` — marks as a config class
- \`@EnableAutoConfiguration\` — enables Spring Boot auto-config
- \`@ComponentScan\` — scans for components in the same package and below`,

    'rest-controller:v2': `## REST Controllers (Spring Boot 2.x)

\`\`\`java
@RestController
@RequestMapping("/api/users")
public class UserController {
    @Autowired
    private UserService userService;

    @GetMapping("/{id}")
    public ResponseEntity<User> getUser(@PathVariable Long id) {
        return ResponseEntity.ok(userService.findById(id));
    }

    @PostMapping
    public ResponseEntity<User> createUser(@Valid @RequestBody CreateUserRequest request) {
        User user = userService.create(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(user);
    }

    @PutMapping("/{id}")
    public ResponseEntity<User> updateUser(@PathVariable Long id, @Valid @RequestBody UpdateUserRequest request) {
        return ResponseEntity.ok(userService.update(id, request));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteUser(@PathVariable Long id) {
        userService.delete(id);
        return ResponseEntity.noContent().build();
    }
}
\`\`\`

Common annotations: \`@RestController\`, \`@RequestMapping\`, \`@GetMapping\`, \`@PostMapping\`, \`@PutMapping\`, \`@DeleteMapping\`, \`@PathVariable\`, \`@RequestBody\`, \`@RequestParam\`, \`@Valid\`.`,

    'rest-controller:v3': `## REST Controllers (Spring Boot 3.x)

\`\`\`java
@RestController
@RequestMapping("/api/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping("/{id}")
    public ResponseEntity<User> getUser(@PathVariable Long id) {
        return ResponseEntity.ok(userService.findById(id));
    }

    @PostMapping
    public ResponseEntity<User> createUser(@Valid @RequestBody CreateUserRequest request) {
        User user = userService.create(request);
        URI location = URI.create("/api/users/" + user.getId());
        return ResponseEntity.created(location).body(user);
    }
}
\`\`\`

Prefer **constructor injection** over \`@Autowired\` (Spring Boot 3 convention).
ProblemDetail (RFC 7807) is now the default error response format.`,

    'security:v2': `## Security Configuration (Spring Boot 2.x)

\`\`\`java
@Configuration
@EnableWebSecurity
public class SecurityConfig extends WebSecurityConfigurerAdapter {

    @Override
    protected void configure(HttpSecurity http) throws Exception {
        http
            .authorizeRequests()
                .antMatchers("/api/public/**").permitAll()
                .antMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated()
            .and()
                .oauth2ResourceServer().jwt();
    }

    @Override
    protected void configure(AuthenticationManagerBuilder auth) throws Exception {
        auth.inMemoryAuthentication()
            .withUser("user").password("{noop}password").roles("USER");
    }
}
\`\`\`

Key patterns: \`WebSecurityConfigurerAdapter\`, \`antMatchers()\`, chained \`.and()\` calls.`,

    'security:v3': `## Security Configuration (Spring Boot 3.x)

**WebSecurityConfigurerAdapter is REMOVED.** Use \`SecurityFilterChain\` beans:

\`\`\`java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/public/**").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(Customizer.withDefaults())
            )
            .build();
    }

    @Bean
    public UserDetailsService userDetailsService() {
        var user = User.withDefaultPasswordEncoder()
            .username("user")
            .password("password")
            .roles("USER")
            .build();
        return new InMemoryUserDetailsManager(user);
    }
}
\`\`\`

Key changes: \`SecurityFilterChain\` bean, lambda DSL, \`requestMatchers()\` instead of \`antMatchers()\`, \`Customizer.withDefaults()\`.`,

    'observability': `## Observability (Spring Boot 3.x)

Built-in observability via Micrometer Observation API:

\`\`\`java
@Observed(name = "user.fetch", contextualName = "fetch-user-by-id")
public User getUser(Long id) {
    return userRepository.findById(id)
        .orElseThrow(() -> new UserNotFoundException(id));
}
\`\`\`

\`\`\`yaml
# application.yml
management:
  tracing:
    sampling:
      probability: 1.0
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
\`\`\`

Supports: Zipkin, Wavefront, OTLP exporters. Auto-instruments RestClient, JdbcTemplate, etc.`,

    'native': `## GraalVM Native Image (Spring Boot 3.x)

\`\`\`xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-native</artifactId>
</dependency>
\`\`\`

\`\`\`bash
# Build native image
./mvnw -Pnative native:compile

# Run — starts in ~50ms instead of ~2s
./target/my-app
\`\`\`

AOT (Ahead-of-Time) processing generates optimized code at build time. Reduces memory footprint by 50%+ and startup time to milliseconds.

Limitations: No runtime reflection (most cases handled by Spring AOT), no dynamic class loading.`,

    'virtual-threads': `## Virtual Threads (Spring Boot 3.2+ / Java 21+)

\`\`\`yaml
spring:
  threads:
    virtual:
      enabled: true
\`\`\`

When enabled, all request-handling threads use virtual threads. Each request gets its own virtual thread — no need for reactive programming (WebFlux) for high concurrency. Blocking I/O is fine.

Compatible with Spring MVC, Spring Data JPA, RestClient, JdbcTemplate.`,

    'data-access': `## Data Access (Spring Data JPA)

\`\`\`java
public interface UserRepository extends JpaRepository<User, Long> {
    List<User> findByName(String name);
    Optional<User> findByEmail(String email);

    @Query("SELECT u FROM User u WHERE u.status = :status")
    List<User> findByStatus(@Param("status") String status);

    @Modifying
    @Query("UPDATE User u SET u.active = false WHERE u.lastLogin < :date")
    int deactivateInactiveUsers(@Param("date") LocalDate date);
}
\`\`\`

\`@Transactional\` on service methods. Spring Data JPA auto-implements repository methods from method names.`,

    'testing': `## Testing

\`\`\`java
@SpringBootTest
class UserServiceTest {

    @Autowired
    private UserService userService;

    @MockBean
    private UserRepository userRepository;

    @Test
    void shouldFindUserById() {
        given(userRepository.findById(1L))
            .willReturn(Optional.of(new User(1L, "Alice")));

        User user = userService.findById(1L);

        assertThat(user.getName()).isEqualTo("Alice");
    }
}

@WebMvcTest(UserController.class)
class UserControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private UserService userService;

    @Test
    void shouldReturnUser() throws Exception {
        given(userService.findById(1L)).willReturn(new User(1L, "Alice"));

        mockMvc.perform(get("/api/users/1"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.name").value("Alice"));
    }
}
\`\`\``,

    'config': `## Configuration

\`\`\`yaml
# application.yml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/mydb
    username: \${DB_USER}
    password: \${DB_PASS}
  jpa:
    hibernate:
      ddl-auto: validate
    show-sql: false

server:
  port: 8080

app:
  feature:
    cache-enabled: true
\`\`\`

\`\`\`java
@ConfigurationProperties(prefix = "app.feature")
public record FeatureProperties(boolean cacheEnabled) {}
\`\`\`

Profiles: \`application-dev.yml\`, \`application-prod.yml\`. Activate with \`spring.profiles.active=dev\`.`,

    'migration': `## Migration from Spring Boot 2.x to 3.x

### Must Do
1. **javax → jakarta**: Replace all \`javax.*\` imports with \`jakarta.*\`
2. **Java 17 minimum**: Upgrade from Java 8/11
3. **Security rewrite**: Remove \`WebSecurityConfigurerAdapter\`, use \`SecurityFilterChain\` beans
4. **URL matching**: Trailing slash no longer matched by default (\`/api/users/\` ≠ \`/api/users\`)
5. **Auto-config**: \`spring.factories\` → \`META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports\`

### Should Do
6. **Constructor injection**: Prefer over \`@Autowired\`
7. **ProblemDetail**: Use RFC 7807 error responses
8. **Observability**: Adopt Micrometer Observation API
9. **Spring Cloud**: Upgrade to 2022.0+ for Boot 3 compatibility

### Nice to Have
10. **GraalVM native**: Consider for microservices
11. **Virtual threads**: If on Java 21+, enable for simplified concurrency`,

    'key-points:v2': `## Key Points (Spring Boot 2.x)

- **Java 8-17** supported
- **javax.\\*** namespace throughout
- \`WebSecurityConfigurerAdapter\` for security config
- \`spring.factories\` for auto-configuration registration
- \`@Autowired\` field injection common
- JUnit 5 is default, JUnit 4 still supported
- WebFlux available for reactive programming`,

    'key-points:v3': `## Key Points (Spring Boot 3.x)

- **Java 17+ required** (Java 21 recommended for virtual threads)
- **jakarta.\\*** namespace (javax no longer works)
- \`SecurityFilterChain\` bean (WebSecurityConfigurerAdapter removed)
- \`AutoConfiguration.imports\` replaces \`spring.factories\`
- Constructor injection preferred
- GraalVM native image support
- Micrometer Observation for tracing/metrics
- Virtual threads with \`spring.threads.virtual.enabled=true\`
- ProblemDetail (RFC 7807) for error responses`,
  },

  'hibernate': {
    'entity:v5': `## Entity Definition (Hibernate 5 / javax.persistence)

\`\`\`java
import javax.persistence.*;
import java.util.List;

@Entity
@Table(name = "users")
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 100)
    private String name;

    @Column(unique = true)
    private String email;

    @OneToMany(mappedBy = "user", cascade = CascadeType.ALL, fetch = FetchType.LAZY)
    private List<Post> posts;

    @Enumerated(EnumType.STRING)
    private Status status;
}
\`\`\``,

    'entity:v6': `## Entity Definition (Hibernate 6 / jakarta.persistence)

\`\`\`java
import jakarta.persistence.*;
import java.util.List;

@Entity
@Table(name = "users")
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 100)
    private String name;

    @Column(unique = true)
    private String email;

    @OneToMany(mappedBy = "user", cascade = CascadeType.ALL, fetch = FetchType.LAZY)
    private List<Post> posts;

    @Enumerated(EnumType.STRING)
    private Status status;
}
\`\`\`

**Note**: Same annotations, but \`jakarta.persistence\` namespace. All \`javax.persistence\` imports must be replaced.`,

    'repository': `## Repository Pattern (Spring Data JPA)

\`\`\`java
@Repository
public interface UserRepository extends JpaRepository<User, Long> {

    List<User> findByName(String name);
    Optional<User> findByEmail(String email);
    List<User> findByStatusOrderByNameAsc(Status status);

    @Query("SELECT u FROM User u WHERE u.email = :email")
    Optional<User> findByEmailCustom(@Param("email") String email);

    @Query("SELECT u FROM User u JOIN FETCH u.posts WHERE u.id = :id")
    Optional<User> findByIdWithPosts(@Param("id") Long id);

    boolean existsByEmail(String email);
    long countByStatus(Status status);
}
\`\`\``,

    'relationships': `## Relationships

\`\`\`java
// One-to-Many
@OneToMany(mappedBy = "user", cascade = CascadeType.ALL, orphanRemoval = true)
private List<Post> posts = new ArrayList<>();

// Many-to-One (owning side)
@ManyToOne(fetch = FetchType.LAZY)
@JoinColumn(name = "user_id")
private User user;

// Many-to-Many
@ManyToMany
@JoinTable(
    name = "user_roles",
    joinColumns = @JoinColumn(name = "user_id"),
    inverseJoinColumns = @JoinColumn(name = "role_id")
)
private Set<Role> roles = new HashSet<>();
\`\`\`

Best practices:
- Use \`FetchType.LAZY\` by default (avoid N+1)
- Use \`JOIN FETCH\` in queries when you need eager loading
- \`orphanRemoval = true\` to auto-delete detached children`,

    'queries:v5': `## Queries (Hibernate 5 / HQL & JPQL)

\`\`\`java
// JPQL
@Query("SELECT u FROM User u WHERE u.name LIKE %:name%")
List<User> searchByName(@Param("name") String name);

// Native SQL
@Query(value = "SELECT * FROM users WHERE email = ?1", nativeQuery = true)
Optional<User> findByEmailNative(String email);

// Criteria API (JPA 2.x)
CriteriaBuilder cb = entityManager.getCriteriaBuilder();
CriteriaQuery<User> cq = cb.createQuery(User.class);
Root<User> root = cq.from(User.class);
cq.where(cb.equal(root.get("status"), Status.ACTIVE));
List<User> results = entityManager.createQuery(cq).getResultList();
\`\`\``,

    'queries:v6': `## Queries (Hibernate 6 / SQM)

Hibernate 6 uses the new **Semantic Query Model (SQM)**, which is stricter:

\`\`\`java
// JPQL — same syntax, but parsed differently internally
@Query("SELECT u FROM User u WHERE u.name LIKE %:name%")
List<User> searchByName(@Param("name") String name);

// Criteria API (JPA 3.1)
CriteriaBuilder cb = entityManager.getCriteriaBuilder();
CriteriaQuery<User> cq = cb.createQuery(User.class);
Root<User> root = cq.from(User.class);
cq.where(cb.equal(root.get("status"), Status.ACTIVE));
List<User> results = entityManager.createQuery(cq).getResultList();
\`\`\`

SQM differences:
- Stricter type coercion — may need explicit casts
- Better error messages for invalid queries
- Improved subquery handling`,

    'type-system': `## Type System (Hibernate 6)

Major rewrite of the internal type system:

\`\`\`java
// Explicit JDBC type mapping
@JdbcTypeCode(SqlTypes.JSON)
@Column(columnDefinition = "jsonb")
private Map<String, Object> metadata;

// Custom AttributeConverter
@Convert(converter = MoneyConverter.class)
private Money price;
\`\`\`

- \`@JdbcTypeCode\` for explicit SQL type control
- Improved embeddable handling
- Better support for Java records as embeddables
- Duration, Instant, etc. mapped natively`,

    'migration': `## Migration from Hibernate 5.x to 6.x

1. **javax → jakarta**: \`javax.persistence.*\` → \`jakarta.persistence.*\`
2. **Sequence generators**: Default strategy changed — add explicit \`@SequenceGenerator\` if needed
3. **Type system**: Custom \`BasicType\` implementations need rewrite
4. **SQM parser**: Some edge-case HQL queries may behave differently
5. **Implicit coercion**: Stricter — add explicit casts in queries where types don't match
6. **Temporal types**: Better handling of \`java.time\` types — review any custom \`TemporalType\` usage`,
  },

  'react': {
    'class-components': `## Class Components (React <=16)

\`\`\`jsx
class Welcome extends React.Component {
  constructor(props) {
    super(props);
    this.state = { count: 0 };
    this.handleClick = this.handleClick.bind(this);
  }

  componentDidMount() { document.title = this.props.name; }
  componentDidUpdate(prevProps) {
    if (prevProps.name !== this.props.name) {
      document.title = this.props.name;
    }
  }
  componentWillUnmount() { /* cleanup */ }

  handleClick() { this.setState(prev => ({ count: prev.count + 1 })); }

  render() {
    return (
      <div>
        <h1>Hello, {this.props.name}!</h1>
        <button onClick={this.handleClick}>Clicked {this.state.count}</button>
      </div>
    );
  }
}
\`\`\``,

    'hooks': `## Hooks (React 17)

\`\`\`jsx
import { useState, useEffect, useContext, useCallback, useMemo, useRef } from 'react';

function Welcome({ name }) {
  const [count, setCount] = useState(0);
  const renderCount = useRef(0);

  useEffect(() => {
    document.title = \`\${name}: \${count}\`;
    renderCount.current++;
    return () => { /* cleanup */ };
  }, [name, count]);

  const handleClick = useCallback(() => {
    setCount(c => c + 1);
  }, []);

  const expensiveValue = useMemo(() => computeExpensive(count), [count]);

  return (
    <div>
      <h1>Hello, {name}!</h1>
      <button onClick={handleClick}>Clicked {count}</button>
    </div>
  );
}
\`\`\`

Rules of Hooks: only call at top level, only call in React functions.`,

    'concurrent': `## Concurrent Rendering (React 18)

\`\`\`jsx
import { useTransition, useDeferredValue, Suspense } from 'react';

function SearchPage() {
  const [query, setQuery] = useState('');
  const [isPending, startTransition] = useTransition();
  const deferredQuery = useDeferredValue(query);

  function handleChange(e) {
    setQuery(e.target.value);                    // urgent: update input
    startTransition(() => {
      setSearchResults(e.target.value);          // non-urgent: update results
    });
  }

  return (
    <div>
      <input value={query} onChange={handleChange} />
      {isPending && <Spinner />}
      <Suspense fallback={<ResultsSkeleton />}>
        <SearchResults query={deferredQuery} />
      </Suspense>
    </div>
  );
}
\`\`\`

\`useTransition\`: marks updates as non-urgent, keeps UI responsive.
\`useDeferredValue\`: defers re-rendering of expensive components.`,

    'actions': `## Actions (React 19)

\`\`\`jsx
import { useActionState, useOptimistic } from 'react';

function TodoForm() {
  const [todos, setTodos] = useState([]);
  const [optimisticTodos, addOptimistic] = useOptimistic(
    todos,
    (state, newTodo) => [...state, { ...newTodo, pending: true }]
  );

  const [state, formAction, isPending] = useActionState(
    async (prevState, formData) => {
      const title = formData.get('title');
      addOptimistic({ title, id: Date.now() });
      const saved = await saveTodo(title);
      setTodos(prev => [...prev, saved]);
      return { success: true };
    },
    { success: false }
  );

  return (
    <form action={formAction}>
      <input name="title" />
      <button disabled={isPending}>Add</button>
      <ul>
        {optimisticTodos.map(t => (
          <li key={t.id} style={{ opacity: t.pending ? 0.5 : 1 }}>{t.title}</li>
        ))}
      </ul>
    </form>
  );
}
\`\`\``,

    'use-api': `## use() API (React 19)

\`\`\`jsx
import { use, Suspense } from 'react';

function UserProfile({ userPromise }) {
  const user = use(userPromise);
  return <h1>{user.name}</h1>;
}

function UserPage({ userId }) {
  const userPromise = fetchUser(userId);  // starts fetch immediately
  return (
    <Suspense fallback={<Skeleton />}>
      <UserProfile userPromise={userPromise} />
    </Suspense>
  );
}

// Also works with context
function ThemedButton() {
  const theme = use(ThemeContext);
  return <button style={{ color: theme.color }}>Click</button>;
}
\`\`\`

\`use()\` can unwrap promises and read context. Can be called conditionally (unlike hooks).`,

    'create-root': `## createRoot API (React 18+)

\`\`\`jsx
// React 18+ — required
import { createRoot } from 'react-dom/client';
const root = createRoot(document.getElementById('root'));
root.render(<App />);

// React 17 and earlier — deprecated
import ReactDOM from 'react-dom';
ReactDOM.render(<App />, document.getElementById('root'));
\`\`\`

\`createRoot\` enables concurrent features. Without it, React 18 runs in legacy mode.`,
  },

  'graphql': {
    'schema': `## Schema Definition

\`\`\`graphql
type Query {
  user(id: ID!): User
  users(limit: Int = 10, offset: Int = 0): UserConnection!
  searchUsers(query: String!): [User!]!
}

type Mutation {
  createUser(input: CreateUserInput!): User!
  updateUser(id: ID!, input: UpdateUserInput!): User!
  deleteUser(id: ID!): Boolean!
}

type Subscription {
  userCreated: User!
  messageReceived(channelId: ID!): Message!
}

type User {
  id: ID!
  name: String!
  email: String!
  posts: [Post!]!
  createdAt: DateTime!
}

input CreateUserInput {
  name: String!
  email: String!
}

enum Status { ACTIVE, INACTIVE, SUSPENDED }

interface Node { id: ID! }

union SearchResult = User | Post | Comment
\`\`\``,

    'queries': `## Queries

\`\`\`graphql
# Basic query
query GetUser {
  user(id: "1") {
    name
    email
  }
}

# With variables
query GetUser($id: ID!) {
  user(id: $id) {
    name
    email
    posts {
      title
      createdAt
    }
  }
}

# Aliases
query {
  admin: user(id: "1") { name }
  viewer: user(id: "2") { name }
}

# Fragments
fragment UserFields on User {
  id
  name
  email
}

query {
  user(id: "1") { ...UserFields }
  users { ...UserFields }
}
\`\`\``,

    'mutations': `## Mutations

\`\`\`graphql
mutation CreateUser($input: CreateUserInput!) {
  createUser(input: $input) {
    id
    name
    email
  }
}

# Variables
{
  "input": {
    "name": "John Doe",
    "email": "john@example.com"
  }
}

# Multiple mutations (executed sequentially)
mutation {
  createUser(input: { name: "A", email: "a@b.com" }) { id }
  updateUser(id: "1", input: { name: "B" }) { name }
}
\`\`\`

Mutations execute sequentially (unlike queries which can run in parallel).`,

    'resolvers': `## Resolvers

\`\`\`javascript
const resolvers = {
  Query: {
    user: (parent, { id }, context) => context.dataSources.users.findById(id),
    users: (parent, { limit, offset }, context) =>
      context.dataSources.users.findAll({ limit, offset }),
  },
  Mutation: {
    createUser: (parent, { input }, context) =>
      context.dataSources.users.create(input),
  },
  User: {
    posts: (user, args, context) =>
      context.dataSources.posts.findByUserId(user.id),
  },
};
\`\`\`

Resolver signature: \`(parent, args, context, info)\`
- **parent**: Result from the parent resolver
- **args**: Arguments passed to the field
- **context**: Shared per-request (auth, dataSources, etc.)
- **info**: Query AST and schema metadata`,

    'key-concepts': `## Key Concepts

- **Type System**: Strongly typed — every field has a defined type
- **Introspection**: Query the schema itself with \`__schema\` and \`__type\`
- **N+1 Problem**: Use **DataLoader** to batch and cache database calls
- **Pagination**: Cursor-based (Relay spec) vs offset-based
- **Error Handling**: Partial responses — data + errors can coexist
- **Caching**: Field-level cache hints, persisted queries for CDN caching
- **Subscriptions**: WebSocket-based real-time updates (graphql-ws protocol)`,
  },

  'docker': {
    'dockerfile': `## Dockerfile

\`\`\`dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
\`\`\`

Key instructions:
- \`FROM\`: Base image
- \`WORKDIR\`: Set working directory
- \`COPY\`: Copy files from host
- \`RUN\`: Execute commands during build
- \`EXPOSE\`: Document which port the app listens on
- \`CMD\`: Default command when container starts
- \`ENTRYPOINT\`: Executable that always runs (CMD becomes arguments)`,

    'multistage': `## Multi-stage Builds

### Java (Maven)
\`\`\`dockerfile
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline
COPY src ./src
RUN mvn package -DskipTests

FROM eclipse-temurin:17-jre-alpine
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
\`\`\`

### Node.js (TypeScript)
\`\`\`dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/index.js"]
\`\`\`

Multi-stage builds keep final image small — build tools stay in the build stage.`,

    'compose': `## Docker Compose

\`\`\`yaml
services:
  api:
    build: ./api
    ports: ["8080:8080"]
    environment:
      SPRING_PROFILES_ACTIVE: docker
      MONGODB_URI: mongodb://db:27017/myapp
    depends_on:
      db:
        condition: service_healthy

  frontend:
    build: ./frontend
    ports: ["3000:3000"]
    depends_on: [api]

  db:
    image: mongo:7
    volumes: [mongo-data:/data/db]
    healthcheck:
      test: mongosh --eval "db.runCommand('ping')"
      interval: 10s
      retries: 5

volumes:
  mongo-data:
\`\`\`

Key features: service dependencies, health checks, named volumes, environment variables, port mapping.`,

    'commands': `## Common Commands

\`\`\`bash
# Build
docker build -t myapp:latest .
docker build -t myapp:latest --no-cache .

# Run
docker run -d -p 3000:3000 --name myapp myapp:latest
docker run -it --rm myapp:latest /bin/sh   # interactive shell

# Inspect
docker ps                    # running containers
docker ps -a                 # all containers
docker logs -f myapp         # follow logs
docker exec -it myapp sh     # shell into running container
docker inspect myapp         # full container details

# Cleanup
docker stop myapp && docker rm myapp
docker system prune -f       # remove unused data
docker image prune -a        # remove all unused images

# Compose
docker compose up -d         # start all services
docker compose down          # stop and remove
docker compose logs -f api   # follow logs for one service
\`\`\``,
  },

  'kubernetes': {
    'deployment': `## Deployment

\`\`\`yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  labels:
    app: myapp
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
      - name: myapp
        image: myapp:1.2.3
        ports:
        - containerPort: 8080
        resources:
          requests: { cpu: "100m", memory: "128Mi" }
          limits:   { cpu: "500m", memory: "256Mi" }
        readinessProbe:
          httpGet: { path: /health, port: 8080 }
          initialDelaySeconds: 5
        livenessProbe:
          httpGet: { path: /health, port: 8080 }
          initialDelaySeconds: 15
        env:
        - name: SPRING_PROFILES_ACTIVE
          value: "k8s"
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef: { name: db-secret, key: password }
\`\`\``,

    'service': `## Service

\`\`\`yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp-service
spec:
  selector:
    app: myapp
  ports:
  - port: 80
    targetPort: 8080
    protocol: TCP
  type: ClusterIP
\`\`\`

Types:
- **ClusterIP** (default): Internal only
- **NodePort**: Exposes on each node's IP at a static port
- **LoadBalancer**: Provisions external load balancer (cloud)
- **ExternalName**: Maps to a DNS name`,

    'config': `## ConfigMap & Secret

\`\`\`yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  application.yml: |
    server:
      port: 8080
    spring:
      profiles:
        active: k8s
---
apiVersion: v1
kind: Secret
metadata:
  name: db-secret
type: Opaque
data:
  password: cGFzc3dvcmQ=    # base64 encoded

---
# Mount in pod spec:
volumes:
- name: config
  configMap: { name: app-config }
containers:
- volumeMounts:
  - name: config
    mountPath: /config
    readOnly: true
  env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef: { name: db-secret, key: password }
\`\`\``,
  },

  'redux': {
    'store': `## Store Setup (Redux Toolkit)

\`\`\`typescript
import { configureStore } from '@reduxjs/toolkit';
import userReducer from './features/userSlice';
import postReducer from './features/postSlice';

export const store = configureStore({
  reducer: {
    users: userReducer,
    posts: postReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Typed hooks
import { useDispatch, useSelector } from 'react-redux';
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
\`\`\``,

    'slices': `## Slices

\`\`\`typescript
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface UserState {
  users: User[];
  loading: boolean;
  error: string | null;
}

const initialState: UserState = { users: [], loading: false, error: null };

const userSlice = createSlice({
  name: 'users',
  initialState,
  reducers: {
    addUser: (state, action: PayloadAction<User>) => {
      state.users.push(action.payload);  // Immer handles immutability
    },
    removeUser: (state, action: PayloadAction<string>) => {
      state.users = state.users.filter(u => u.id !== action.payload);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchUsers.pending, (state) => { state.loading = true; })
      .addCase(fetchUsers.fulfilled, (state, action) => {
        state.loading = false;
        state.users = action.payload;
      })
      .addCase(fetchUsers.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? 'Failed';
      });
  },
});

export const { addUser, removeUser } = userSlice.actions;
export default userSlice.reducer;
\`\`\``,

    'async': `## Async Logic (createAsyncThunk)

\`\`\`typescript
import { createAsyncThunk } from '@reduxjs/toolkit';

export const fetchUsers = createAsyncThunk(
  'users/fetchAll',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/users');
      if (!response.ok) throw new Error('Failed to fetch');
      return await response.json() as User[];
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// Usage in component
function UserList() {
  const dispatch = useAppDispatch();
  const { users, loading, error } = useAppSelector(state => state.users);

  useEffect(() => { dispatch(fetchUsers()); }, [dispatch]);

  if (loading) return <Spinner />;
  if (error) return <Error message={error} />;
  return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>;
}
\`\`\``,
  },

  'mongodb': {
    'crud': `## CRUD Operations

\`\`\`javascript
// Insert
db.users.insertOne({ name: "Alice", email: "alice@example.com", roles: ["user"] });
db.users.insertMany([{ name: "Bob" }, { name: "Charlie" }]);

// Find
db.users.find({ roles: "admin" });
db.users.findOne({ email: "alice@example.com" });
db.users.find({ age: { $gte: 18, $lt: 65 } }).sort({ name: 1 }).limit(10);

// Update
db.users.updateOne({ _id: id }, { $set: { name: "Alice B" } });
db.users.updateMany({ active: false }, { $set: { archived: true } });
db.users.updateOne({ _id: id }, { $push: { roles: "admin" } });
db.users.updateOne({ _id: id }, { $inc: { loginCount: 1 } });

// Delete
db.users.deleteOne({ _id: id });
db.users.deleteMany({ archived: true, updatedAt: { $lt: cutoffDate } });

// Upsert
db.users.updateOne(
  { email: "new@example.com" },
  { $set: { name: "New User" } },
  { upsert: true }
);
\`\`\``,

    'aggregation': `## Aggregation Pipeline

\`\`\`javascript
db.orders.aggregate([
  { $match: { status: "completed", date: { $gte: startDate } } },
  { $group: {
      _id: "$customerId",
      totalSpent: { $sum: "$amount" },
      orderCount: { $count: {} },
      avgOrder: { $avg: "$amount" }
  }},
  { $sort: { totalSpent: -1 } },
  { $limit: 10 },
  { $lookup: {
      from: "customers",
      localField: "_id",
      foreignField: "_id",
      as: "customer"
  }},
  { $unwind: "$customer" },
  { $project: {
      customerName: "$customer.name",
      totalSpent: 1,
      orderCount: 1
  }}
]);
\`\`\`

Common stages: \`$match\`, \`$group\`, \`$project\`, \`$sort\`, \`$limit\`, \`$lookup\` (joins), \`$unwind\`, \`$facet\` (multi-pipeline).`,

    'spring-data': `## Spring Data MongoDB

\`\`\`java
@Document(collection = "users")
public class User {
    @Id
    private String id;

    @Indexed(unique = true)
    private String email;

    private String name;

    @DBRef
    private List<Post> posts;

    @CreatedDate
    private Instant createdAt;
}

public interface UserRepository extends MongoRepository<User, String> {
    List<User> findByName(String name);
    Optional<User> findByEmail(String email);

    @Query("{ 'roles': ?0 }")
    List<User> findByRole(String role);

    @Aggregation(pipeline = {
        "{ $match: { status: 'ACTIVE' } }",
        "{ $group: { _id: '$department', count: { $sum: 1 } } }"
    })
    List<DepartmentCount> countByDepartment();
}
\`\`\``,
  },

  'spring-security': {
    'config:v5': `## Spring Security 5 — Configuration

\`\`\`java
@Configuration
@EnableWebSecurity
public class SecurityConfig extends WebSecurityConfigurerAdapter {

    @Override
    protected void configure(HttpSecurity http) throws Exception {
        http
            .csrf().disable()
            .authorizeRequests()
                .antMatchers("/api/public/**").permitAll()
                .antMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated()
            .and()
            .httpBasic();
    }

    @Override
    protected void configure(AuthenticationManagerBuilder auth) throws Exception {
        auth.userDetailsService(userDetailsService)
            .passwordEncoder(passwordEncoder());
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
\`\`\`

Pattern: extend \`WebSecurityConfigurerAdapter\` and override \`configure()\` methods.`,

    'config:v6': `## Spring Security 6 — Configuration

**NO WebSecurityConfigurerAdapter** — use \`SecurityFilterChain\` @Bean instead.

\`\`\`java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/public/**").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated()
            )
            .httpBasic(Customizer.withDefaults());
        return http.build();
    }

    @Bean
    public UserDetailsService userDetailsService() {
        UserDetails user = User.withDefaultPasswordEncoder()
            .username("user")
            .password("password")
            .roles("USER")
            .build();
        return new InMemoryUserDetailsManager(user);
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
\`\`\`

Key changes from v5:
- Lambda DSL is the default (no chaining with \`.and()\`)
- \`requestMatchers()\` replaces \`antMatchers()\`
- \`Customizer.withDefaults()\` for default configurations`,

    'authorization:v5': `## Spring Security 5 — Authorization Rules

\`\`\`java
@Override
protected void configure(HttpSecurity http) throws Exception {
    http.authorizeRequests()
        .antMatchers(HttpMethod.GET, "/api/items/**").permitAll()
        .antMatchers(HttpMethod.POST, "/api/items/**").hasRole("EDITOR")
        .antMatchers("/api/admin/**").hasRole("ADMIN")
        .antMatchers("/api/user/**").hasAnyRole("USER", "ADMIN")
        .antMatchers("/api/**").authenticated()
        .anyRequest().denyAll();
}
\`\`\`

Methods: \`permitAll()\`, \`authenticated()\`, \`hasRole()\`, \`hasAnyRole()\`, \`hasAuthority()\`, \`denyAll()\`.
Method-level: \`@PreAuthorize("hasRole('ADMIN')")\`, \`@Secured("ROLE_ADMIN")\`.`,

    'authorization:v6': `## Spring Security 6 — Authorization Rules

\`\`\`java
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth
        .requestMatchers(HttpMethod.GET, "/api/items/**").permitAll()
        .requestMatchers(HttpMethod.POST, "/api/items/**").hasRole("EDITOR")
        .requestMatchers("/api/admin/**").hasRole("ADMIN")
        .requestMatchers("/api/user/**").hasAnyRole("USER", "ADMIN")
        .requestMatchers("/api/**").authenticated()
        .anyRequest().denyAll()
    );
    return http.build();
}
\`\`\`

Key differences from v5:
- \`authorizeHttpRequests()\` replaces \`authorizeRequests()\`
- \`requestMatchers()\` replaces \`antMatchers()\` / \`mvcMatchers()\`
- Method-level: \`@PreAuthorize\`, \`@PostAuthorize\` (enable with \`@EnableMethodSecurity\`)`,

    'authentication:v5': `## Spring Security 5 — Authentication

\`\`\`java
@Override
protected void configure(AuthenticationManagerBuilder auth) throws Exception {
    // In-memory
    auth.inMemoryAuthentication()
        .withUser("user").password("{noop}pass").roles("USER");

    // JDBC
    auth.jdbcAuthentication()
        .dataSource(dataSource)
        .usersByUsernameQuery("SELECT username, password, enabled FROM users WHERE username=?")
        .authoritiesByUsernameQuery("SELECT username, authority FROM authorities WHERE username=?");

    // Custom UserDetailsService
    auth.userDetailsService(userDetailsService)
        .passwordEncoder(new BCryptPasswordEncoder());
}
\`\`\``,

    'authentication:v6': `## Spring Security 6 — Authentication

\`\`\`java
@Bean
public UserDetailsService userDetailsService(DataSource dataSource) {
    return new JdbcUserDetailsManager(dataSource);
}

// Or custom implementation
@Bean
public UserDetailsService userDetailsService(UserRepository repo) {
    return username -> repo.findByUsername(username)
        .map(u -> User.builder()
            .username(u.getUsername())
            .password(u.getPassword())
            .authorities(u.getRoles().toArray(new String[0]))
            .build())
        .orElseThrow(() -> new UsernameNotFoundException("User not found: " + username));
}

@Bean
public AuthenticationManager authenticationManager(
        UserDetailsService uds, PasswordEncoder encoder) {
    var provider = new DaoAuthenticationProvider();
    provider.setUserDetailsService(uds);
    provider.setPasswordEncoder(encoder);
    return new ProviderManager(provider);
}
\`\`\`

Everything is a \`@Bean\` — no \`AuthenticationManagerBuilder\` override needed.`,

    'migration': `## Migrating Spring Security 5 → 6

| Change | Before (v5) | After (v6) |
|--------|-------------|-------------|
| Config class | extends \`WebSecurityConfigurerAdapter\` | \`SecurityFilterChain\` @Bean |
| URL matching | \`antMatchers()\` | \`requestMatchers()\` |
| Authorization | \`authorizeRequests()\` | \`authorizeHttpRequests()\` |
| Servlet namespace | \`javax.servlet\` | \`jakarta.servlet\` |
| DSL style | chaining with \`.and()\` | lambda DSL |
| Method security | \`@EnableGlobalMethodSecurity\` | \`@EnableMethodSecurity\` |

### Step-by-step:
1. Remove \`extends WebSecurityConfigurerAdapter\`
2. Create \`@Bean SecurityFilterChain\` method
3. Replace \`antMatchers\` → \`requestMatchers\`
4. Replace \`authorizeRequests\` → \`authorizeHttpRequests\`
5. Switch to lambda DSL (remove \`.and()\` chains)
6. Replace \`javax.servlet\` → \`jakarta.servlet\``,

    'key-points:v5': `## Spring Security 5 — Key Points
- Extends \`WebSecurityConfigurerAdapter\`
- Uses \`javax.servlet\` namespace
- \`antMatchers()\` for URL patterns
- \`.and()\` chaining DSL
- \`@EnableGlobalMethodSecurity\` for method-level security
- Configure via overriding \`configure(HttpSecurity)\` and \`configure(AuthenticationManagerBuilder)\``,

    'key-points:v6': `## Spring Security 6 — Key Points
- \`SecurityFilterChain\` as a \`@Bean\` — no more adapter class
- Uses \`jakarta.servlet\` namespace
- \`requestMatchers()\` replaces \`antMatchers()\`
- Lambda DSL is default (\`.csrf(csrf -> csrf.disable())\`)
- \`@EnableMethodSecurity\` replaces \`@EnableGlobalMethodSecurity\`
- \`Customizer.withDefaults()\` for default configurations
- All configuration via \`@Bean\` declarations`,
  },

  'scala': {
    'basics:v2': `## Scala 2 — Basic Syntax

\`\`\`scala
// Immutable and mutable bindings
val name: String = "hello"
var counter: Int = 0

// Case classes — immutable data containers with auto-generated equals, hashCode, copy
case class User(name: String, age: Int)
val user = User("Alice", 30)
val older = user.copy(age = 31)

// Pattern matching
def describe(x: Any): String = x match {
  case i: Int if i > 0 => s"positive int: \\$i"
  case s: String       => s"string: \\$s"
  case User(name, age) => s"\\$name is \\$age"
  case _               => "unknown"
}

// Higher-order functions
val doubled = List(1, 2, 3).map(_ * 2)
val evens = (1 to 10).filter(_ % 2 == 0)
val sum = List(1, 2, 3).foldLeft(0)(_ + _)

// For-comprehensions (flatMap + map + withFilter sugar)
for {
  x <- List(1, 2, 3)
  y <- List('a', 'b') if x > 1
} yield (x, y)
\`\`\``,

    'basics:v3': `## Scala 3 — Basic Syntax

\`\`\`scala
// Same val/var semantics, but optional braces (indentation syntax)
val name: String = "hello"
var counter: Int = 0

// Case classes — unchanged
case class User(name: String, age: Int)

// Enum keyword (new in Scala 3)
enum Color:
  case Red, Green, Blue

enum Planet(mass: Double, radius: Double):
  case Earth extends Planet(5.976e+24, 6.37814e6)
  case Mars  extends Planet(6.421e+23, 3.3972e6)

// Pattern matching — same syntax, optional braces
def describe(x: Any): String = x match
  case i: Int if i > 0 => s"positive: \\$i"
  case s: String       => s"string: \\$s"
  case _               => "unknown"

// Wildcard imports: * instead of _
import scala.collection.mutable.*
\`\`\``,

    'implicits': `## Scala 2 — Implicits

\`\`\`scala
// Implicit parameters — dependency injection at compile time
def greet(name: String)(implicit greeting: String): String =
  s"\\$greeting, \\$name!"

implicit val defaultGreeting: String = "Hello"
greet("Alice")  // "Hello, Alice!"

// Implicit conversions — automatic type coercion
implicit def intToString(i: Int): String = i.toString

// Implicit classes — extension methods
implicit class RichInt(val n: Int) extends AnyVal {
  def square: Int = n * n
  def isEven: Boolean = n % 2 == 0
}
42.square  // 1764

// Type classes via implicits
trait JsonWriter[T] {
  def write(value: T): String
}
implicit val stringWriter: JsonWriter[String] = (value: String) => s""""\\$value""""
def toJson[T](value: T)(implicit writer: JsonWriter[T]): String = writer.write(value)
\`\`\`

Implicits are powerful but can be confusing — Scala 3 replaces them with \`given\`/\`using\`.`,

    'given-using': `## Scala 3 — given/using (Replaces Implicits)

\`\`\`scala
// given instances replace implicit val/def
trait JsonWriter[T]:
  extension (value: T) def toJson: String

given JsonWriter[String] with
  extension (value: String) def toJson: String = s""""\\$value""""

given JsonWriter[Int] with
  extension (value: Int) def toJson: String = value.toString

// using clauses replace implicit parameters
def serialize[T](value: T)(using writer: JsonWriter[T]): String =
  value.toJson

serialize("hello")  // "hello"
serialize(42)        // 42

// Extension methods — standalone, no implicit class needed
extension (n: Int)
  def square: Int = n * n
  def isEven: Boolean = n % 2 == 0

42.square  // 1764

// Context functions
type Executable[T] = ExecutionContext ?=> T
\`\`\`

Migration: \`implicit val\` → \`given\`, \`implicit parameter\` → \`using\`, \`implicit class\` → \`extension\`.`,

    'enums': `## Scala 3 — Enums

\`\`\`scala
// Simple enum
enum Color:
  case Red, Green, Blue

val c: Color = Color.Red

// Parameterized enum
enum Planet(val mass: Double, val radius: Double):
  case Mercury extends Planet(3.303e+23, 2.4397e6)
  case Venus   extends Planet(4.869e+24, 6.0518e6)
  case Earth   extends Planet(5.976e+24, 6.37814e6)

  def surfaceGravity: Double = 6.67300E-11 * mass / (radius * radius)

// ADT pattern (replaces sealed trait + case objects)
enum Expr:
  case Lit(value: Double)
  case Add(left: Expr, right: Expr)
  case Mul(left: Expr, right: Expr)

def eval(e: Expr): Double = e match
  case Expr.Lit(v)    => v
  case Expr.Add(l, r) => eval(l) + eval(r)
  case Expr.Mul(l, r) => eval(l) * eval(r)
\`\`\`

Replaces the verbose \`sealed trait\` + \`case object\` / \`case class\` pattern from Scala 2.`,

    'traits': `## Scala — Traits & Mixins

\`\`\`scala
trait Logging {
  def log(msg: String): Unit = println(s"[LOG] \\$msg")
}

trait Timestamped {
  def timestamp: Long = System.currentTimeMillis()
}

// Mixin composition
class Service extends Logging with Timestamped {
  def process(): Unit = log(s"Processing at \\$timestamp")
}

// Stackable modifications
trait UpperCase extends Logging {
  abstract override def log(msg: String): Unit = super.log(msg.toUpperCase)
}

trait Prefixed extends Logging {
  abstract override def log(msg: String): Unit = super.log(s"[PREFIX] \\$msg")
}

// Linearization: rightmost trait wins for conflicts
class FancyService extends Service with UpperCase with Prefixed

// Self-types — require dependency
trait UserRepository {
  def findUser(id: String): Option[User]
}

trait UserService { self: UserRepository =>
  def getUser(id: String): User = findUser(id).getOrElse(throw new Exception("Not found"))
}
\`\`\``,

    'collections': `## Scala — Collections

\`\`\`scala
// Immutable (default)
val list = List(1, 2, 3)
val vec = Vector(1, 2, 3)       // indexed, good for random access
val set = Set(1, 2, 3)
val map = Map("a" -> 1, "b" -> 2)

// Transformations
list.map(_ * 2)                  // List(2, 4, 6)
list.filter(_ > 1)               // List(2, 3)
list.flatMap(i => List(i, i*10)) // List(1, 10, 2, 20, 3, 30)
list.foldLeft(0)(_ + _)          // 6
list.reduce(_ + _)               // 6

// For-comprehensions
val pairs = for {
  x <- List(1, 2, 3)
  y <- List("a", "b")
} yield (x, y)  // List((1,a), (1,b), (2,a), (2,b), (3,a), (3,b))

// Grouping & partitioning
List(1,2,3,4,5).groupBy(_ % 2)  // Map(1 -> List(1,3,5), 0 -> List(2,4))
List(1,2,3,4,5).partition(_ > 3) // (List(4,5), List(1,2,3))

// Option as collection
val opt: Option[Int] = Some(42)
opt.map(_ * 2)       // Some(84)
opt.getOrElse(0)     // 42
opt.flatMap(x => if (x > 0) Some(x) else None)
\`\`\``,

    'types': `## Scala 3 — New Type Features

\`\`\`scala
// Union types
def process(input: String | Int): String = input match
  case s: String => s"String: \\$s"
  case i: Int    => s"Int: \\$i"

// Intersection types
trait Resettable:
  def reset(): Unit

trait Closable:
  def close(): Unit

def cleanup(resource: Resettable & Closable): Unit =
  resource.reset()
  resource.close()

// Opaque types — zero-cost type wrappers
object Ids:
  opaque type UserId = String
  object UserId:
    def apply(s: String): UserId = s
  extension (id: UserId)
    def value: String = id

import Ids.*
val id: UserId = UserId("abc")
// id: String  // compile error — type safety without runtime overhead

// Type lambdas
type MapToList = [K, V] =>> Map[K, List[V]]
\`\`\``,

    'migration': `## Migrating Scala 2 → Scala 3

| Feature | Scala 2 | Scala 3 |
|---------|---------|---------|
| Type classes | \`implicit val/def\` | \`given\`/\`using\` |
| Extension methods | \`implicit class\` | \`extension\` |
| Enums | \`sealed trait\` + \`case object\` | \`enum\` keyword |
| Wildcard imports | \`import pkg._\` | \`import pkg.*\` |
| Wildcard type | \`_\` | \`?\` |
| Macro system | \`scala.reflect\` | \`scala.quoted\` |
| Braces | Required | Optional (indentation syntax) |

### Migration steps:
1. Use \`-source:3.0-migration\` flag for warnings
2. Replace \`implicit val\` → \`given\`, \`implicit parameter\` → \`using\`
3. Replace \`implicit class\` → \`extension\`
4. Replace \`sealed trait\` + case objects → \`enum\`
5. Update wildcard imports \`._\` → \`.*\`
6. Rewrite macros using the new \`scala.quoted\` API`,

    'key-points:v2': `## Scala 2 — Key Points
- \`implicit\` for type classes, extension methods, and DI
- \`sealed trait\` + \`case object/class\` for ADTs
- Pattern matching on case classes and extractors
- Immutability by default (\`val\`, immutable collections)
- \`scala.reflect\` macros for metaprogramming
- Rich collection library with \`map\`, \`flatMap\`, \`fold\`
- For-comprehensions as syntactic sugar for monadic operations`,

    'key-points:v3': `## Scala 3 — Key Points
- \`given\`/\`using\` replace \`implicit\` (clearer, more intentional)
- \`enum\` keyword for simple enums and ADTs
- \`extension\` methods without wrapper classes
- Union types (\`A | B\`), intersection types (\`A & B\`)
- Opaque types for zero-cost type wrappers
- Optional braces (indentation syntax)
- New macro system (\`scala.quoted\`)
- Wildcard imports use \`*\` instead of \`_\``,
  },

  'junit': {
    'basics:v4': `## JUnit 4 — Test Basics

\`\`\`java
import org.junit.Test;
import org.junit.Before;
import org.junit.After;
import org.junit.BeforeClass;
import org.junit.AfterClass;
import org.junit.Ignore;
import org.junit.runner.RunWith;

public class UserServiceTest {

    @BeforeClass
    public static void setupAll() { /* once before all tests */ }

    @AfterClass
    public static void teardownAll() { /* once after all tests */ }

    @Before
    public void setup() { /* before each test */ }

    @After
    public void teardown() { /* after each test */ }

    @Test
    public void shouldCreateUser() {
        User user = new User("Alice", 30);
        assertEquals("Alice", user.getName());
    }

    @Test(timeout = 1000)
    public void shouldCompleteQuickly() { /* ... */ }

    @Ignore("Not yet implemented")
    @Test
    public void shouldSendEmail() { /* ... */ }
}
\`\`\`

Extensions: \`@RunWith(MockitoJUnitRunner.class)\`, \`@RunWith(SpringRunner.class)\`.`,

    'basics:v5': `## JUnit 5 — Test Basics

\`\`\`java
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.extension.ExtendWith;

@DisplayName("User Service Tests")
class UserServiceTest {

    @BeforeAll
    static void setupAll() { /* once before all tests */ }

    @AfterAll
    static void teardownAll() { /* once after all tests */ }

    @BeforeEach
    void setup() { /* before each test */ }

    @AfterEach
    void teardown() { /* after each test */ }

    @Test
    @DisplayName("should create user with valid data")
    void shouldCreateUser() {
        User user = new User("Alice", 30);
        assertEquals("Alice", user.getName());
    }

    @Test
    @Timeout(value = 1, unit = TimeUnit.SECONDS)
    void shouldCompleteQuickly() { /* ... */ }

    @Disabled("Not yet implemented")
    @Test
    void shouldSendEmail() { /* ... */ }
}
\`\`\`

Extensions: \`@ExtendWith(MockitoExtension.class)\`, \`@ExtendWith(SpringExtension.class)\`.`,

    'assertions:v4': `## JUnit 4 — Assertions

\`\`\`java
import static org.junit.Assert.*;
import static org.hamcrest.CoreMatchers.*;
import static org.hamcrest.MatcherAssert.assertThat;

@Test
public void testAssertions() {
    assertEquals("expected", "expected");
    assertEquals(3.14, 3.14, 0.001);  // delta for doubles
    assertTrue(true);
    assertFalse(false);
    assertNotNull(new Object());
    assertNull(null);
    assertSame(obj1, obj1);
    assertArrayEquals(new int[]{1, 2}, new int[]{1, 2});

    // Hamcrest matchers
    assertThat("hello", is("hello"));
    assertThat(list, hasItem("item"));
    assertThat(list, hasSize(3));
    assertThat(str, containsString("sub"));
}
\`\`\``,

    'assertions:v5': `## JUnit 5 — Assertions

\`\`\`java
import static org.junit.jupiter.api.Assertions.*;

@Test
void testAssertions() {
    assertEquals("expected", "expected");
    assertEquals(3.14, 3.14, 0.001);
    assertTrue(true);
    assertFalse(false);
    assertNotNull(new Object());

    // assertThrows replaces @Test(expected = ...)
    var ex = assertThrows(IllegalArgumentException.class, () -> {
        throw new IllegalArgumentException("bad");
    });
    assertEquals("bad", ex.getMessage());

    // assertAll — grouped assertions (all run even if some fail)
    assertAll("user",
        () -> assertEquals("Alice", user.getName()),
        () -> assertEquals(30, user.getAge()),
        () -> assertNotNull(user.getId())
    );

    // assertTimeout
    assertTimeout(Duration.ofSeconds(1), () -> {
        // code that should complete in < 1 second
    });
}
\`\`\``,

    'exceptions': `## JUnit 4 — Exception Testing

\`\`\`java
// Method 1: expected attribute
@Test(expected = IllegalArgumentException.class)
public void shouldThrowOnInvalidInput() {
    service.process(null);
}

// Method 2: ExpectedException Rule (more control)
@Rule
public ExpectedException thrown = ExpectedException.none();

@Test
public void shouldThrowWithMessage() {
    thrown.expect(IllegalArgumentException.class);
    thrown.expectMessage("must not be null");
    service.process(null);
}

// Method 3: try-catch (most control)
@Test
public void shouldThrowAndVerify() {
    try {
        service.process(null);
        fail("Expected exception");
    } catch (IllegalArgumentException e) {
        assertEquals("must not be null", e.getMessage());
    }
}
\`\`\`

JUnit 5 simplifies all of this with \`assertThrows()\`.`,

    'parameterized': `## JUnit 5 — Parameterized Tests

\`\`\`java
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.*;

// @ValueSource — simple inline values
@ParameterizedTest
@ValueSource(strings = {"hello", "world", "test"})
void shouldNotBeBlank(String input) {
    assertFalse(input.isBlank());
}

// @CsvSource — comma-separated pairs
@ParameterizedTest
@CsvSource({"1, 1", "2, 4", "3, 9", "4, 16"})
void shouldSquare(int input, int expected) {
    assertEquals(expected, input * input);
}

// @MethodSource — complex objects
@ParameterizedTest
@MethodSource("provideUsers")
void shouldValidateUser(User user, boolean expected) {
    assertEquals(expected, validator.isValid(user));
}

static Stream<Arguments> provideUsers() {
    return Stream.of(
        Arguments.of(new User("Alice", 30), true),
        Arguments.of(new User("", -1), false)
    );
}

// @EnumSource
@ParameterizedTest
@EnumSource(value = Status.class, names = {"ACTIVE", "PENDING"})
void shouldBeProcessable(Status status) {
    assertTrue(service.canProcess(status));
}
\`\`\``,

    'nested': `## JUnit 5 — Nested Tests

\`\`\`java
@DisplayName("Order Service")
class OrderServiceTest {

    @Nested
    @DisplayName("when creating orders")
    class WhenCreating {

        @Test
        @DisplayName("should create with valid items")
        void shouldCreateWithValidItems() {
            Order order = service.create(List.of(item1, item2));
            assertNotNull(order.getId());
            assertEquals(2, order.getItems().size());
        }

        @Test
        @DisplayName("should reject empty items")
        void shouldRejectEmptyItems() {
            assertThrows(IllegalArgumentException.class,
                () -> service.create(List.of()));
        }
    }

    @Nested
    @DisplayName("when cancelling orders")
    class WhenCancelling {

        @Test
        @DisplayName("should cancel pending order")
        void shouldCancelPending() {
            service.cancel(pendingOrder);
            assertEquals(Status.CANCELLED, pendingOrder.getStatus());
        }

        @Test
        @DisplayName("should not cancel shipped order")
        void shouldNotCancelShipped() {
            assertThrows(IllegalStateException.class,
                () -> service.cancel(shippedOrder));
        }
    }
}
\`\`\`

\`@Nested\` classes share the outer class's \`@BeforeEach\`/\`@AfterEach\`.`,

    'migration': `## Migrating JUnit 4 → JUnit 5

| JUnit 4 | JUnit 5 |
|---------|---------|
| \`@Before\` | \`@BeforeEach\` |
| \`@After\` | \`@AfterEach\` |
| \`@BeforeClass\` | \`@BeforeAll\` |
| \`@AfterClass\` | \`@AfterAll\` |
| \`@Ignore\` | \`@Disabled\` |
| \`@RunWith\` | \`@ExtendWith\` |
| \`@Rule\` | \`@ExtendWith\` or \`@RegisterExtension\` |
| \`@Test(expected=...)\` | \`assertThrows()\` |
| \`@Test(timeout=...)\` | \`@Timeout\` or \`assertTimeout()\` |
| \`@Category\` | \`@Tag\` |

### Migration steps:
1. Add \`junit-jupiter\` dependency, keep \`junit-vintage-engine\` for backward compatibility
2. Change imports: \`org.junit.Test\` → \`org.junit.jupiter.api.Test\`
3. Replace lifecycle annotations (\`@Before\` → \`@BeforeEach\`, etc.)
4. Replace \`@RunWith\` → \`@ExtendWith\`
5. Replace \`@Test(expected)\` → \`assertThrows()\`
6. Replace \`@Rule\` → \`@ExtendWith\` or \`@RegisterExtension\`
7. Add \`@DisplayName\` for readable test names`,

    'key-points:v4': `## JUnit 4 — Key Points
- \`@RunWith\` for test runner extensions (Mockito, Spring, Parameterized)
- \`@Rule\` for reusable test fixtures (ExpectedException, TemporaryFolder)
- Hamcrest matchers for expressive assertions
- \`@Test(expected = ...)\` for exception testing
- \`@Before\`/\`@After\` for setup/teardown
- Tests must be \`public\``,

    'key-points:v5': `## JUnit 5 — Key Points
- \`@ExtendWith\` replaces \`@RunWith\` and \`@Rule\`
- \`assertThrows()\` for clean exception testing
- \`assertAll()\` for grouped assertions
- \`@ParameterizedTest\` with multiple source types
- \`@Nested\` for logically grouped tests
- \`@DisplayName\` for human-readable names
- Tests don't need to be \`public\`
- Composed of 3 modules: Jupiter (API), Vintage (backward compat), Platform (launcher)`,
  },

  'akka': {
    'typed-actors': `## Akka Typed Actors

\`\`\`scala
import akka.actor.typed.{ActorRef, ActorSystem, Behavior}
import akka.actor.typed.scaladsl.Behaviors

// Define message protocol
sealed trait Command
case class Greet(name: String, replyTo: ActorRef[Greeting]) extends Command
case class Greeting(message: String)

// Define behavior
object Greeter {
  def apply(): Behavior[Command] = Behaviors.receive { (context, message) =>
    message match {
      case Greet(name, replyTo) =>
        context.log.info("Hello {}!", name)
        replyTo ! Greeting(s"Hello, \\$name!")
        Behaviors.same
    }
  }
}

// Spawn and use
val system = ActorSystem(Greeter(), "greeter-system")
\`\`\`

Key concepts: \`Behavior[T]\` is parameterized by message type, \`ActorRef[T]\` is typed, \`Behaviors.receive\` for message handling, \`Behaviors.same\` / \`Behaviors.stopped\` for lifecycle.`,

    'streams': `## Akka Streams

\`\`\`scala
import akka.stream.scaladsl.{Source, Flow, Sink}
import akka.actor.typed.ActorSystem

implicit val system: ActorSystem[Nothing] = ActorSystem(Behaviors.empty, "streams")

// Basic pipeline: Source -> Flow -> Sink
val result: Future[Done] =
  Source(1 to 100)
    .filter(_ % 2 == 0)
    .map(_ * 2)
    .runWith(Sink.foreach(println))

// Async boundaries for parallelism
Source(files)
  .mapAsync(4)(file => Future(readFile(file)))
  .mapAsync(2)(content => Future(processContent(content)))
  .runWith(Sink.collection)

// Graph DSL for complex topologies
val graph = RunnableGraph.fromGraph(GraphDSL.create() { implicit builder =>
  import GraphDSL.Implicits._
  val bcast = builder.add(Broadcast[Int](2))
  val merge = builder.add(Merge[String](2))

  Source(1 to 10) ~> bcast
  bcast.out(0) ~> Flow[Int].map(i => s"A:\\$i") ~> merge
  bcast.out(1) ~> Flow[Int].map(i => s"B:\\$i") ~> merge
  merge ~> Sink.foreach(println)
  ClosedShape
})
\`\`\`

Backpressure is automatic — downstream signals demand to upstream.`,

    'http': `## Akka HTTP

\`\`\`scala
import akka.http.scaladsl.Http
import akka.http.scaladsl.server.Directives._
import akka.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import spray.json.DefaultJsonProtocol._

case class User(name: String, age: Int)
implicit val userFormat = jsonFormat2(User)

val routes =
  pathPrefix("api" / "users") {
    get {
      path(Segment) { id =>
        complete(getUser(id))
      } ~
      pathEndOrSingleSlash {
        parameter("role".optional) { role =>
          complete(listUsers(role))
        }
      }
    } ~
    post {
      entity(as[User]) { user =>
        onSuccess(createUser(user)) { created =>
          complete(StatusCodes.Created, created)
        }
      }
    }
  }

Http().newServerAt("0.0.0.0", 8080).bind(routes)
\`\`\`

Key directives: \`path\`, \`get/post/put/delete\`, \`entity(as[T])\`, \`complete\`, \`parameter\`, \`onSuccess\`.`,

    'cluster': `## Akka Cluster

\`\`\`scala
// application.conf
akka {
  actor.provider = "cluster"
  remote.artery {
    canonical.hostname = "127.0.0.1"
    canonical.port = 2551
  }
  cluster {
    seed-nodes = [
      "akka://MySystem@127.0.0.1:2551",
      "akka://MySystem@127.0.0.1:2552"
    ]
    downing-provider-class = "akka.cluster.sbr.SplitBrainResolverProvider"
  }
}
\`\`\`

\`\`\`scala
// Cluster Sharding
import akka.cluster.sharding.typed.scaladsl.{ClusterSharding, Entity, EntityTypeKey}

val TypeKey = EntityTypeKey[Command]("MyEntity")

ClusterSharding(system).init(Entity(TypeKey) { entityContext =>
  MyEntity(entityContext.entityId)
})

val entityRef = ClusterSharding(system).entityRefFor(TypeKey, "entity-1")
entityRef ! MyCommand("data")
\`\`\`

Cluster sharding distributes actors across nodes by entity ID — automatic rebalancing and failover.`,

    'persistence': `## Akka Persistence (Event Sourcing)

\`\`\`scala
import akka.persistence.typed.scaladsl.{EventSourcedBehavior, Effect}
import akka.persistence.typed.PersistenceId

// Commands
sealed trait Command
case class AddItem(item: String, replyTo: ActorRef[Confirmation]) extends Command
case class RemoveItem(item: String) extends Command

// Events
sealed trait Event
case class ItemAdded(item: String) extends Event
case class ItemRemoved(item: String) extends Event

// State
case class Cart(items: List[String] = Nil)

def apply(cartId: String): Behavior[Command] =
  EventSourcedBehavior[Command, Event, Cart](
    persistenceId = PersistenceId.ofUniqueId(cartId),
    emptyState = Cart(),
    commandHandler = (state, cmd) => cmd match {
      case AddItem(item, replyTo) =>
        Effect.persist(ItemAdded(item)).thenRun(_ => replyTo ! Confirmed)
      case RemoveItem(item) =>
        Effect.persist(ItemRemoved(item))
    },
    eventHandler = (state, event) => event match {
      case ItemAdded(item)   => state.copy(items = item :: state.items)
      case ItemRemoved(item) => state.copy(items = state.items.filterNot(_ == item))
    }
  ).withRetention(RetentionCriteria.snapshotEvery(numberOfEvents = 100))
\`\`\`

Events are persisted to a journal (Cassandra, JDBC, etc.). Snapshots reduce replay time.`,

    'key-points': `## Akka — Key Points
- **Typed actors** (\`Behavior[T]\`) are the recommended API — classic untyped actors are deprecated
- **Akka Streams** for reactive data processing with automatic backpressure
- **Akka HTTP** for REST APIs with a composable route DSL
- **Cluster** for distributed systems — sharding, replicated data, split-brain resolution
- **Persistence** for event sourcing — commands produce events, events rebuild state
- Uses \`akka-serialization-jackson\` for message serialization
- Configuration via HOCON (\`application.conf\`)
- License: BSL 1.1 since Akka 2.7 (Apache 2.0 for 2.6.x and earlier)`,
  },
};
