export interface DetectedFramework {
  name: string;
  version?: string;
  category: FrameworkCategory;
  source: string;
  docKey?: string;
}

export type FrameworkCategory = 'frontend' | 'backend' | 'database' | 'build' | 'container' | 'orchestration' | 'api' | 'testing' | 'other';

// ─────────────────────────────────────────────────────────────────────────
// PageIndex-style tree index for LLM-friendly doc retrieval
// ─────────────────────────────────────────────────────────────────────────

export interface DocSection {
  id: string;
  title: string;
  summary: string;
  children?: DocSection[];
}

export interface DocTreeIndex {
  framework: string;
  version?: string;
  description: string;
  officialDocs?: string;
  github?: string;
  sections: DocSection[];
}

export interface MonorepoModule {
  name: string;
  path: string;
  type: 'frontend' | 'backend' | 'service' | 'shared' | 'infra' | 'unknown';
  frameworks: DetectedFramework[];
}

export interface ProjectStack {
  rootPath: string;
  modules: MonorepoModule[];
  summary: {
    frontend: string[];
    backend: string[];
    databases: string[];
    containers: string[];
    orchestration: string[];
    apis: string[];
    build: string[];
    testing: string[];
  };
}

export interface MonorepoConfig {
  structure: {
    [moduleName: string]: {
      path: string;
      type: MonorepoModule['type'];
      description?: string;
    };
  };
}

export interface DocSource {
  llmsTxt?: string;
  github?: string;
  officialDocs?: string;
  description: string;
}

/**
 * Version-ranged doc source: applies when the detected version falls
 * within [minVersion, maxVersion). Both bounds use semver-major comparison.
 * If minVersion is omitted the entry is a fallback / "latest" entry.
 */
export interface VersionedDocSource extends DocSource {
  minMajor?: number;
  maxMajor?: number;  // exclusive upper bound
}

/**
 * Top-level registry entry for a framework.
 * `versions` is ordered from oldest to newest; resolution picks the last
 * entry whose range contains the detected major version.
 */
export interface FrameworkDocEntry {
  versions: VersionedDocSource[];
}

export function parseMajor(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const match = version.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

export function resolveDocSource(entry: FrameworkDocEntry, version?: string): VersionedDocSource {
  const major = parseMajor(version);
  if (major !== undefined) {
    for (let i = entry.versions.length - 1; i >= 0; i--) {
      const v = entry.versions[i];
      const lo = v.minMajor ?? 0;
      const hi = v.maxMajor ?? Infinity;
      if (major >= lo && major < hi) return v;
    }
  }
  return entry.versions[entry.versions.length - 1];
}

// ─────────────────────────────────────────────────────────────────────────
// Framework documentation registry — version-aware
// ─────────────────────────────────────────────────────────────────────────

export const FRAMEWORK_DOCS: Record<string, FrameworkDocEntry> = {

  // ── Frontend ──────────────────────────────────────────────────────────

  'react': { versions: [
    {
      minMajor: 0, maxMajor: 17,
      github: 'facebook/react',
      officialDocs: 'https://legacy.reactjs.org/docs/getting-started.html',
      description: 'React <=16 — class components, lifecycle methods, legacy context API',
    },
    {
      minMajor: 17, maxMajor: 18,
      github: 'facebook/react',
      officialDocs: 'https://legacy.reactjs.org/docs/getting-started.html',
      description: 'React 17 — no new features, gradual upgrade stepping-stone, new JSX transform',
    },
    {
      minMajor: 18, maxMajor: 19,
      github: 'facebook/react',
      officialDocs: 'https://react.dev',
      description: 'React 18 — concurrent rendering, useTransition, useDeferredValue, Suspense for data fetching, automatic batching',
    },
    {
      minMajor: 19,
      github: 'facebook/react',
      officialDocs: 'https://react.dev',
      description: 'React 19 — React Compiler, Actions, useActionState, useOptimistic, use() API, server components stable',
    },
  ]},

  'redux': { versions: [
    { github: 'reduxjs/redux', officialDocs: 'https://redux.js.org', description: 'Predictable state container for JavaScript apps' },
  ]},

  '@reduxjs/toolkit': { versions: [
    { github: 'reduxjs/redux-toolkit', officialDocs: 'https://redux-toolkit.js.org', description: 'Official, batteries-included toolset for Redux' },
  ]},

  'graphql': { versions: [
    { github: 'graphql/graphql-js', officialDocs: 'https://graphql.org/learn/', description: 'A query language for APIs and runtime for fulfilling queries' },
  ]},

  '@apollo/client': { versions: [
    {
      minMajor: 2, maxMajor: 3,
      github: 'apollographql/apollo-client',
      officialDocs: 'https://www.apollographql.com/docs/react/v2/',
      description: 'Apollo Client 2 — HOC-based, render props, older cache API',
    },
    {
      minMajor: 3,
      github: 'apollographql/apollo-client',
      officialDocs: 'https://www.apollographql.com/docs/react/',
      description: 'Apollo Client 3 — hooks-first, InMemoryCache with type policies, reactive variables',
    },
  ]},

  'next': { versions: [
    {
      minMajor: 0, maxMajor: 13,
      github: 'vercel/next.js',
      officialDocs: 'https://nextjs.org/docs',
      description: 'Next.js <=12 — pages/ router, getServerSideProps, getStaticProps',
    },
    {
      minMajor: 13, maxMajor: 15,
      llmsTxt: 'https://nextjs.org/llms.txt',
      github: 'vercel/next.js',
      officialDocs: 'https://nextjs.org/docs',
      description: 'Next.js 13-14 — app/ router, React Server Components, route handlers, server actions (experimental in 13, stable in 14)',
    },
    {
      minMajor: 15,
      llmsTxt: 'https://nextjs.org/llms.txt',
      github: 'vercel/next.js',
      officialDocs: 'https://nextjs.org/docs',
      description: 'Next.js 15 — Partial Prerendering, async request APIs, React 19 support',
    },
  ]},

  'vue': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'vuejs/vue', officialDocs: 'https://v2.vuejs.org/v2/guide/', description: 'Vue 2 — Options API, mixins, filters' },
    { minMajor: 3, github: 'vuejs/core', officialDocs: 'https://vuejs.org/guide/', description: 'Vue 3 — Composition API, <script setup>, Teleport, Suspense' },
  ]},

  'angular': { versions: [
    { github: 'angular/angular', officialDocs: 'https://angular.dev/', description: 'Platform for building mobile and desktop web apps' },
  ]},

  'vite': { versions: [
    { github: 'vitejs/vite', officialDocs: 'https://vitejs.dev/guide/', description: 'Next generation frontend tooling' },
  ]},

  'typescript': { versions: [
    { github: 'microsoft/TypeScript', officialDocs: 'https://www.typescriptlang.org/docs/', description: 'Typed superset of JavaScript' },
  ]},

  'tailwindcss': { versions: [
    { minMajor: 0, maxMajor: 4, llmsTxt: 'https://tailwindcss.com/llms.txt', github: 'tailwindlabs/tailwindcss', officialDocs: 'https://tailwindcss.com/docs', description: 'Tailwind CSS <=3 — config-based, JIT mode, purge' },
    { minMajor: 4, llmsTxt: 'https://tailwindcss.com/llms.txt', github: 'tailwindlabs/tailwindcss', officialDocs: 'https://tailwindcss.com/docs', description: 'Tailwind CSS 4 — CSS-first config, Oxide engine, automatic content detection' },
  ]},

  // ── Backend — Java / Spring ──────────────────────────────────────────

  'spring-boot': { versions: [
    {
      minMajor: 1, maxMajor: 2,
      github: 'spring-projects/spring-boot',
      officialDocs: 'https://docs.spring.io/spring-boot/docs/1.5.x/reference/html/',
      description: 'Spring Boot 1.x — Spring 4, javax.*, XML config common, Spring MVC',
    },
    {
      minMajor: 2, maxMajor: 3,
      github: 'spring-projects/spring-boot',
      officialDocs: 'https://docs.spring.io/spring-boot/docs/2.7.x/reference/html/',
      description: 'Spring Boot 2.x — Spring 5, javax.*, WebFlux introduced, Java 8-17, JUnit 5 default',
    },
    {
      minMajor: 3,
      github: 'spring-projects/spring-boot',
      officialDocs: 'https://docs.spring.io/spring-boot/docs/current/reference/html/',
      description: 'Spring Boot 3.x — Spring 6, jakarta.* namespace, Java 17+ required, GraalVM native support, observability with Micrometer',
    },
  ]},

  'spring-framework': { versions: [
    {
      minMajor: 4, maxMajor: 5,
      github: 'spring-projects/spring-framework',
      officialDocs: 'https://docs.spring.io/spring-framework/docs/4.3.x/spring-framework-reference/html/',
      description: 'Spring Framework 4 — javax.*, Java 6+, XML/annotation config',
    },
    {
      minMajor: 5, maxMajor: 6,
      github: 'spring-projects/spring-framework',
      officialDocs: 'https://docs.spring.io/spring-framework/docs/5.3.x/reference/html/',
      description: 'Spring Framework 5 — javax.*, reactive WebFlux, Kotlin support, Java 8+',
    },
    {
      minMajor: 6,
      github: 'spring-projects/spring-framework',
      officialDocs: 'https://docs.spring.io/spring-framework/reference/',
      description: 'Spring Framework 6 — jakarta.* namespace migration, Java 17+, virtual threads support, AOT compilation',
    },
  ]},

  'spring-data-jpa': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'spring-projects/spring-data-jpa', officialDocs: 'https://docs.spring.io/spring-data/jpa/docs/2.7.x/reference/html/', description: 'Spring Data JPA 2.x — javax.persistence, Spring Boot 2 compatible' },
    { minMajor: 3, github: 'spring-projects/spring-data-jpa', officialDocs: 'https://docs.spring.io/spring-data/jpa/reference/html/', description: 'Spring Data JPA 3.x — jakarta.persistence, Spring Boot 3 compatible' },
  ]},

  'spring-data-mongodb': { versions: [
    { github: 'spring-projects/spring-data-mongodb', officialDocs: 'https://docs.spring.io/spring-data/mongodb/reference/html/', description: 'Spring Data module for MongoDB' },
  ]},

  'spring-security': { versions: [
    {
      minMajor: 5, maxMajor: 6,
      github: 'spring-projects/spring-security',
      officialDocs: 'https://docs.spring.io/spring-security/site/docs/5.8.x/reference/html5/',
      description: 'Spring Security 5.x — javax.servlet, WebSecurityConfigurerAdapter (deprecated late 5.x)',
    },
    {
      minMajor: 6,
      github: 'spring-projects/spring-security',
      officialDocs: 'https://docs.spring.io/spring-security/reference/',
      description: 'Spring Security 6.x — jakarta.servlet, SecurityFilterChain bean config, no more WebSecurityConfigurerAdapter',
    },
  ]},

  'hibernate': { versions: [
    {
      minMajor: 4, maxMajor: 5,
      github: 'hibernate/hibernate-orm',
      officialDocs: 'https://hibernate.org/orm/documentation/4.3/',
      description: 'Hibernate 4 — javax.persistence, Session-based, XML mapping common',
    },
    {
      minMajor: 5, maxMajor: 6,
      github: 'hibernate/hibernate-orm',
      officialDocs: 'https://hibernate.org/orm/documentation/5.6/',
      description: 'Hibernate 5 — javax.persistence, JPA 2.1/2.2, improved boot, bytecode enhancement',
    },
    {
      minMajor: 6,
      github: 'hibernate/hibernate-orm',
      officialDocs: 'https://hibernate.org/orm/documentation/6.6/',
      description: 'Hibernate 6 — jakarta.persistence, JPA 3.1, new query model (SQM), improved type system',
    },
  ]},

  'junit': { versions: [
    { minMajor: 4, maxMajor: 5, github: 'junit-team/junit4', officialDocs: 'https://junit.org/junit4/', description: 'JUnit 4 — @Test, @Before/@After, @RunWith, Hamcrest matchers' },
    { minMajor: 5, github: 'junit-team/junit5', officialDocs: 'https://junit.org/junit5/docs/current/user-guide/', description: 'JUnit 5 — @Test, @BeforeEach/@AfterEach, @ExtendWith, parameterized tests, nested tests' },
  ]},

  'mockito': { versions: [
    { github: 'mockito/mockito', officialDocs: 'https://site.mockito.org/', description: 'Mocking framework for unit tests in Java' },
  ]},

  'lombok': { versions: [
    { github: 'projectlombok/lombok', officialDocs: 'https://projectlombok.org/features/', description: 'Java library to reduce boilerplate code' },
  ]},

  'graphql-java': { versions: [
    { github: 'graphql-java/graphql-java', officialDocs: 'https://www.graphql-java.com/documentation/getting-started', description: 'GraphQL implementation for Java' },
  ]},

  'netflix-dgs': { versions: [
    { github: 'Netflix/dgs-framework', officialDocs: 'https://netflix.github.io/dgs/', description: 'Netflix Domain Graph Service framework for Spring Boot' },
  ]},

  // ── Backend — Scala ──────────────────────────────────────────────────

  'akka': { versions: [
    {
      minMajor: 2, maxMajor: 3,
      github: 'akka/akka',
      officialDocs: 'https://doc.akka.io/docs/akka/2.6/',
      description: 'Akka 2.x (Classic + Typed) — actors, streams, clustering, persistence',
    },
    {
      minMajor: 3,
      github: 'akka/akka',
      officialDocs: 'https://doc.akka.io/docs/akka/current/',
      description: 'Akka 3+ / Pekko — BSL licensed from 2.7+; community fork is Apache Pekko',
    },
  ]},

  'play': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'playframework/playframework', officialDocs: 'https://www.playframework.com/documentation/2.8.x/Home', description: 'Play Framework 2.x — Akka HTTP backend, Twirl templates, sbt build' },
    { minMajor: 3, github: 'playframework/playframework', officialDocs: 'https://www.playframework.com/documentation/latest/Home', description: 'Play Framework 3.x — Pekko backend, jakarta.*, cross-build Scala 2.13 / 3' },
  ]},

  'scala': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'scala/scala', officialDocs: 'https://docs.scala-lang.org/overviews/', description: 'Scala 2 — implicits, type classes, macros, sbt ecosystem' },
    { minMajor: 3, github: 'scala/scala3', officialDocs: 'https://docs.scala-lang.org/scala3/', description: 'Scala 3 — given/using instead of implicits, enum, union types, opaque types, new macro system' },
  ]},

  'sbt': { versions: [
    { github: 'sbt/sbt', officialDocs: 'https://www.scala-sbt.org/1.x/docs/', description: 'Build tool for Scala and Java projects' },
  ]},

  'cats': { versions: [
    { github: 'typelevel/cats', officialDocs: 'https://typelevel.org/cats/', description: 'Lightweight, modular functional programming library' },
  ]},

  'zio': { versions: [
    { minMajor: 1, maxMajor: 2, github: 'zio/zio', officialDocs: 'https://zio.dev/version-1.x/', description: 'ZIO 1 — ZIO[R, E, A], ZManaged, ZLayer' },
    { minMajor: 2, github: 'zio/zio', officialDocs: 'https://zio.dev/overview/', description: 'ZIO 2 — simplified ZLayer, ZIO.scoped replaces ZManaged, improved performance' },
  ]},

  'sangria': { versions: [
    { github: 'sangria-graphql/sangria', officialDocs: 'https://sangria-graphql.github.io/learn/', description: 'Scala GraphQL implementation' },
  ]},

  // ── Databases ─────────────────────────────────────────────────────────

  'mongodb': { versions: [
    { github: 'mongodb/mongo', officialDocs: 'https://www.mongodb.com/docs/manual/', description: 'Document-oriented NoSQL database' },
  ]},

  'mysql': { versions: [
    { minMajor: 5, maxMajor: 8, officialDocs: 'https://dev.mysql.com/doc/refman/5.7/en/', description: 'MySQL 5.x — InnoDB default, JSON support (5.7), replication' },
    { minMajor: 8, officialDocs: 'https://dev.mysql.com/doc/refman/8.0/en/', description: 'MySQL 8 — window functions, CTEs, roles, invisible indexes, descending indexes' },
  ]},

  'postgresql': { versions: [
    { officialDocs: 'https://www.postgresql.org/docs/current/', description: 'Advanced open-source relational database' },
  ]},

  'redis': { versions: [
    { github: 'redis/redis', officialDocs: 'https://redis.io/docs/', description: 'In-memory data structure store' },
  ]},

  // ── Containers & Orchestration ────────────────────────────────────────

  'docker': { versions: [
    { github: 'docker/docs', officialDocs: 'https://docs.docker.com/', description: 'Platform for developing, shipping, and running applications in containers' },
  ]},

  'kubernetes': { versions: [
    { github: 'kubernetes/kubernetes', officialDocs: 'https://kubernetes.io/docs/home/', description: 'Container orchestration platform' },
  ]},

  'helm': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'helm/helm', officialDocs: 'https://v2.helm.sh/docs/', description: 'Helm 2 — Tiller server-side component, chart v1 format' },
    { minMajor: 3, github: 'helm/helm', officialDocs: 'https://helm.sh/docs/', description: 'Helm 3 — no Tiller, chart v2, OCI registry support, JSON schema validation' },
  ]},

  // ── Build Tools ───────────────────────────────────────────────────────

  'maven': { versions: [
    { github: 'apache/maven', officialDocs: 'https://maven.apache.org/guides/', description: 'Build automation and dependency management for Java' },
  ]},

  'gradle': { versions: [
    { minMajor: 7, maxMajor: 8, github: 'gradle/gradle', officialDocs: 'https://docs.gradle.org/7.6.4/userguide/userguide.html', description: 'Gradle 7 — version catalogs (preview), configuration cache, JDK 17 support' },
    { minMajor: 8, github: 'gradle/gradle', officialDocs: 'https://docs.gradle.org/current/userguide/userguide.html', description: 'Gradle 8 — Kotlin DSL default, stable configuration cache, version catalogs stable' },
  ]},

  'yarn': { versions: [
    { minMajor: 1, maxMajor: 2, github: 'yarnpkg/yarn', officialDocs: 'https://classic.yarnpkg.com/en/docs', description: 'Yarn 1 (Classic) — node_modules, yarn.lock, workspaces' },
    { minMajor: 2, github: 'yarnpkg/berry', officialDocs: 'https://yarnpkg.com/getting-started', description: 'Yarn 2+ (Berry) — Plug\'n\'Play, zero-installs, constraints, corepack' },
  ]},

  'npm': { versions: [
    { officialDocs: 'https://docs.npmjs.com/', description: 'Package manager for Node.js' },
  ]},
};
