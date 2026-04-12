const OFFLINE_FALLBACK: Record<string, string> = {
  'spring-boot': 'Spring Boot is an opinionated Java framework for building production-ready applications. Use @SpringBootApplication as the entry point. Boot 2.x uses javax.*, Boot 3.x migrated to jakarta.* and requires Java 17+.',
  'hibernate': 'Hibernate is the most popular JPA implementation. Version 5 uses javax.persistence, version 6 migrated to jakarta.persistence with a new Semantic Query Model (SQM).',
  'react': 'React is a JavaScript UI library. v16 used class components, v17 added new JSX transform, v18 introduced concurrent rendering, v19 added Actions and the React Compiler.',
  'graphql': 'GraphQL is a query language for APIs. Define a schema with types, write queries/mutations/subscriptions, and implement resolvers on the server.',
  'docker': 'Docker containerizes applications. Write a Dockerfile (FROM, COPY, RUN, CMD), use multi-stage builds to keep images small, orchestrate with docker-compose.',
  'kubernetes': 'Kubernetes orchestrates containers. Core resources: Deployment (pod replicas), Service (networking), Ingress (HTTP routing), ConfigMap/Secret (configuration).',
  'redux': 'Redux is a predictable state container. Use Redux Toolkit: configureStore for setup, createSlice for reducers+actions, createAsyncThunk for async logic.',
  'mongodb': 'MongoDB is a document-oriented NoSQL database. CRUD with insertOne/find/updateOne/deleteOne, aggregation pipeline for analytics, Spring Data MongoDB for JPA-like abstractions.',
  'scala': 'Scala is a JVM language blending OOP and FP. Scala 2 uses implicits for type classes; Scala 3 replaces them with given/using, adds enum keyword and union types.',
  'spring-security': 'Spring Security handles authentication and authorization. v5 uses WebSecurityConfigurerAdapter + antMatchers; v6 uses SecurityFilterChain beans + requestMatchers with lambda DSL.',
  'junit': 'JUnit is the standard Java testing framework. JUnit 4 uses @Before/@After and @RunWith; JUnit 5 uses @BeforeEach/@AfterEach, @ExtendWith, and @ParameterizedTest.',
  'akka': 'Akka is a toolkit for building concurrent, distributed JVM applications with typed actors, streams (Source/Flow/Sink with backpressure), HTTP routing, and cluster sharding.',
};

export function offlineFallback(frameworkKey: string): string {
  const fallback = OFFLINE_FALLBACK[frameworkKey];
  if (fallback) return `## ${frameworkKey}\n\n${fallback}\n\n*Offline fallback — call \`resolve-doc-url\` with the correct documentation URL to fetch full docs.*`;
  return `## ${frameworkKey}\n\nNo documentation available. Call \`resolve-doc-url\` to supply the documentation URL for this framework.`;
}
