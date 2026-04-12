import type { FrameworkDocEntry, VersionedMeta } from './index.js';

export function parseMajor(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const match = version.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

export function resolveFrameworkMeta(entry: FrameworkDocEntry, version?: string): VersionedMeta {
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

export const FRAMEWORK_DOCS: Record<string, FrameworkDocEntry> = {

  'react': { versions: [
    { minMajor: 0, maxMajor: 17, github: 'facebook/react', description: 'React <=16 — class components, lifecycle methods, legacy context API' },
    { minMajor: 17, maxMajor: 18, github: 'facebook/react', description: 'React 17 — no new features, gradual upgrade stepping-stone, new JSX transform' },
    { minMajor: 18, maxMajor: 19, github: 'facebook/react', description: 'React 18 — concurrent rendering, useTransition, useDeferredValue, Suspense, automatic batching' },
    { minMajor: 19, github: 'facebook/react', description: 'React 19 — React Compiler, Actions, useActionState, useOptimistic, use() API, server components stable' },
  ]},

  'redux': { versions: [{ github: 'reduxjs/redux', description: 'Predictable state container for JavaScript apps' }] },
  '@reduxjs/toolkit': { versions: [{ github: 'reduxjs/redux-toolkit', description: 'Official, batteries-included toolset for Redux' }] },
  'graphql': { versions: [{ github: 'graphql/graphql-js', description: 'A query language for APIs and runtime for fulfilling queries' }] },

  '@apollo/client': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'apollographql/apollo-client', description: 'Apollo Client 2 — HOC-based, render props, older cache API' },
    { minMajor: 3, github: 'apollographql/apollo-client', description: 'Apollo Client 3 — hooks-first, InMemoryCache with type policies, reactive variables' },
  ]},

  'next': { versions: [
    { minMajor: 0, maxMajor: 13, github: 'vercel/next.js', description: 'Next.js <=12 — pages/ router, getServerSideProps, getStaticProps' },
    { minMajor: 13, maxMajor: 15, llmsTxt: 'https://nextjs.org/llms.txt', github: 'vercel/next.js', description: 'Next.js 13-14 — app/ router, React Server Components, route handlers, server actions' },
    { minMajor: 15, llmsTxt: 'https://nextjs.org/llms.txt', github: 'vercel/next.js', description: 'Next.js 15 — Partial Prerendering, async request APIs, React 19 support' },
  ]},

  'vue': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'vuejs/vue', description: 'Vue 2 — Options API, mixins, filters' },
    { minMajor: 3, github: 'vuejs/core', description: 'Vue 3 — Composition API, <script setup>, Teleport, Suspense' },
  ]},

  'angular': { versions: [{ github: 'angular/angular', description: 'Platform for building mobile and desktop web apps' }] },
  'vite': { versions: [{ github: 'vitejs/vite', description: 'Next generation frontend tooling' }] },
  'typescript': { versions: [{ github: 'microsoft/TypeScript', description: 'Typed superset of JavaScript' }] },

  'tailwindcss': { versions: [
    { minMajor: 0, maxMajor: 4, llmsTxt: 'https://tailwindcss.com/llms.txt', github: 'tailwindlabs/tailwindcss', description: 'Tailwind CSS <=3 — config-based, JIT mode, purge' },
    { minMajor: 4, llmsTxt: 'https://tailwindcss.com/llms.txt', github: 'tailwindlabs/tailwindcss', description: 'Tailwind CSS 4 — CSS-first config, Oxide engine, automatic content detection' },
  ]},

  'spring-boot': { versions: [
    { minMajor: 1, maxMajor: 2, github: 'spring-projects/spring-boot', description: 'Spring Boot 1.x — Spring 4, javax.*, XML config common' },
    { minMajor: 2, maxMajor: 3, github: 'spring-projects/spring-boot', description: 'Spring Boot 2.x — Spring 5, javax.*, WebFlux, Java 8-17' },
    { minMajor: 3, github: 'spring-projects/spring-boot', description: 'Spring Boot 3.x — Spring 6, jakarta.* namespace, Java 17+, GraalVM native, observability' },
  ]},

  'spring-framework': { versions: [
    { minMajor: 4, maxMajor: 5, github: 'spring-projects/spring-framework', description: 'Spring Framework 4 — javax.*, Java 6+, XML/annotation config' },
    { minMajor: 5, maxMajor: 6, github: 'spring-projects/spring-framework', description: 'Spring Framework 5 — javax.*, reactive WebFlux, Kotlin, Java 8+' },
    { minMajor: 6, github: 'spring-projects/spring-framework', description: 'Spring Framework 6 — jakarta.*, Java 17+, virtual threads, AOT' },
  ]},

  'spring-data-jpa': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'spring-projects/spring-data-jpa', description: 'Spring Data JPA 2.x — javax.persistence' },
    { minMajor: 3, github: 'spring-projects/spring-data-jpa', description: 'Spring Data JPA 3.x — jakarta.persistence' },
  ]},

  'spring-data-mongodb': { versions: [{ github: 'spring-projects/spring-data-mongodb', description: 'Spring Data module for MongoDB' }] },

  'spring-security': { versions: [
    { minMajor: 5, maxMajor: 6, github: 'spring-projects/spring-security', description: 'Spring Security 5.x — WebSecurityConfigurerAdapter, antMatchers()' },
    { minMajor: 6, github: 'spring-projects/spring-security', description: 'Spring Security 6.x — SecurityFilterChain bean, requestMatchers(), lambda DSL' },
  ]},

  'hibernate': { versions: [
    { minMajor: 4, maxMajor: 5, github: 'hibernate/hibernate-orm', description: 'Hibernate 4 — javax.persistence, Session-based' },
    { minMajor: 5, maxMajor: 6, github: 'hibernate/hibernate-orm', description: 'Hibernate 5 — javax.persistence, JPA 2.1/2.2' },
    { minMajor: 6, github: 'hibernate/hibernate-orm', description: 'Hibernate 6 — jakarta.persistence, JPA 3.1, SQM query model' },
  ]},

  'junit': { versions: [
    { minMajor: 4, maxMajor: 5, github: 'junit-team/junit4', description: 'JUnit 4 — @Test, @Before/@After, @RunWith' },
    { minMajor: 5, github: 'junit-team/junit5', description: 'JUnit 5 — @BeforeEach/@AfterEach, @ExtendWith, parameterized tests' },
  ]},

  'mockito': { versions: [{ github: 'mockito/mockito', description: 'Mocking framework for unit tests in Java' }] },
  'lombok': { versions: [{ github: 'projectlombok/lombok', description: 'Java library to reduce boilerplate code' }] },
  'graphql-java': { versions: [{ github: 'graphql-java/graphql-java', description: 'GraphQL implementation for Java' }] },
  'netflix-dgs': { versions: [{ github: 'Netflix/dgs-framework', description: 'Netflix Domain Graph Service framework for Spring Boot' }] },

  'akka': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'akka/akka', description: 'Akka 2.x — typed actors, streams, clustering, persistence' },
    { minMajor: 3, github: 'akka/akka', description: 'Akka 3+ / Pekko — BSL licensed from 2.7+; community fork is Apache Pekko' },
  ]},

  'play': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'playframework/playframework', description: 'Play Framework 2.x — Akka HTTP backend, Twirl templates' },
    { minMajor: 3, github: 'playframework/playframework', description: 'Play Framework 3.x — Pekko backend, jakarta.*' },
  ]},

  'scala': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'scala/scala', description: 'Scala 2 — implicits, type classes, macros' },
    { minMajor: 3, github: 'scala/scala3', description: 'Scala 3 — given/using, enum, union types, opaque types' },
  ]},

  'sbt': { versions: [{ github: 'sbt/sbt', description: 'Build tool for Scala and Java projects' }] },
  'cats': { versions: [{ github: 'typelevel/cats', description: 'Lightweight, modular functional programming library' }] },

  'zio': { versions: [
    { minMajor: 1, maxMajor: 2, github: 'zio/zio', description: 'ZIO 1 — ZIO[R, E, A], ZManaged, ZLayer' },
    { minMajor: 2, github: 'zio/zio', description: 'ZIO 2 — simplified ZLayer, ZIO.scoped replaces ZManaged' },
  ]},

  'sangria': { versions: [{ github: 'sangria-graphql/sangria', description: 'Scala GraphQL implementation' }] },

  'mongodb': { versions: [{ github: 'mongodb/mongo', description: 'Document-oriented NoSQL database' }] },
  'mysql': { versions: [
    { minMajor: 5, maxMajor: 8, description: 'MySQL 5.x — InnoDB default, JSON support (5.7)' },
    { minMajor: 8, description: 'MySQL 8 — window functions, CTEs, roles' },
  ]},
  'postgresql': { versions: [{ description: 'Advanced open-source relational database' }] },
  'redis': { versions: [{ github: 'redis/redis', description: 'In-memory data structure store' }] },

  'docker': { versions: [{ github: 'docker/docs', description: 'Platform for developing, shipping, and running applications in containers' }] },
  'kubernetes': { versions: [{ github: 'kubernetes/kubernetes', description: 'Container orchestration platform' }] },

  'helm': { versions: [
    { minMajor: 2, maxMajor: 3, github: 'helm/helm', description: 'Helm 2 — Tiller server-side component' },
    { minMajor: 3, github: 'helm/helm', description: 'Helm 3 — no Tiller, OCI registry support' },
  ]},

  'maven': { versions: [{ github: 'apache/maven', description: 'Build automation and dependency management for Java' }] },

  'gradle': { versions: [
    { minMajor: 7, maxMajor: 8, github: 'gradle/gradle', description: 'Gradle 7 — version catalogs (preview), configuration cache' },
    { minMajor: 8, github: 'gradle/gradle', description: 'Gradle 8 — Kotlin DSL default, stable configuration cache' },
  ]},

  'yarn': { versions: [
    { minMajor: 1, maxMajor: 2, github: 'yarnpkg/yarn', description: 'Yarn 1 (Classic) — node_modules, yarn.lock, workspaces' },
    { minMajor: 2, github: 'yarnpkg/berry', description: 'Yarn 2+ (Berry) — Plug\'n\'Play, zero-installs, corepack' },
  ]},

  'npm': { versions: [{ description: 'Package manager for Node.js' }] },
};
