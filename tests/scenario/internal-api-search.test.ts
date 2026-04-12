import { setupClient, getText, assert, assertIncludes } from '../helpers.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Simulates a developer searching internally scanned source code.
 *
 * "I just joined this monorepo. I need to understand how the modules
 * connect, what public APIs exist, and find specific functionality."
 *
 * These tests exercise the search/query path — not just generation.
 */
export async function testInternalApiSearch() {
  console.log('\n── Scenario: internal API search ───────────────────\n');

  // ── Part 1: Search this repo's own source ──────────────────────────────
  await testSearchOwnSource();

  // ── Part 2: Search a synthetic Java monorepo ───────────────────────────
  await testSearchJavaMonorepo();

  // ── Part 3: Search a synthetic TS + GraphQL monorepo ───────────────────
  await testSearchTsGqlMonorepo();
}

async function testSearchOwnSource() {
  console.log('  [self-scan] Searching this repo\'s scanned API...');
  const client = await setupClient();

  // Scan our own src/
  await client.callTool({
    name: 'scan-internal-source',
    arguments: { projectPath: PROJECT_ROOT, modulePaths: ['src'] },
  });

  // ── Search by class name ───────────────────────────────────────────────
  {
    const full = getText(await client.callTool({
      name: 'get-internal-api', arguments: { moduleName: 'src', format: 'full' },
    }));

    assertIncludes('search: find ProjectAnalyzer', full, 'ProjectAnalyzer');
    assertIncludes('search: find DocFetcher', full, 'DocFetcher');
    assertIncludes('search: find SourceScanner', full, 'SourceScanner');
    assertIncludes('search: find MemoryCache', full, 'MemoryCache');
    assertIncludes('search: find InternalDepsDetector', full, 'InternalDepsDetector');
  }

  // ── Search by method name ──────────────────────────────────────────────
  {
    const full = getText(await client.callTool({
      name: 'get-internal-api', arguments: { moduleName: 'src', format: 'full' },
    }));

    assertIncludes('search: find analyze()', full, 'analyze');
    assertIncludes('search: find parseGradle', full, 'parseGradle');
    assertIncludes('search: find parsePomXml', full, 'parsePomXml');
    assertIncludes('search: find fetchGitHubReadme', full, 'fetchGitHubReadme');
    assertIncludes('search: find htmlToMarkdown', full, 'htmlToMarkdown');
    assertIncludes('search: find supplyDocUrl', full, 'supplyDocUrl');
    assertIncludes('search: find createServer', full, 'createServer');
    assertIncludes('search: find readCache', full, 'readCache');
    assertIncludes('search: find writeCache', full, 'writeCache');
  }

  // ── Search by interface / type name ────────────────────────────────────
  {
    const full = getText(await client.callTool({
      name: 'get-internal-api', arguments: { moduleName: 'src', format: 'full' },
    }));

    assertIncludes('search: find DetectedFramework', full, 'DetectedFramework');
    assertIncludes('search: find DocSection', full, 'DocSection');
    assertIncludes('search: find DocTreeIndex', full, 'DocTreeIndex');
    assertIncludes('search: find ProjectStack', full, 'ProjectStack');
    assertIncludes('search: find MonorepoConfig', full, 'MonorepoConfig');
    assertIncludes('search: find NeedsUrlResult', full, 'NeedsUrlResult');
    assertIncludes('search: find ExtractedSymbol', full, 'ExtractedSymbol');
    assertIncludes('search: find ScannedModule', full, 'ScannedModule');
  }

  // ── Search by method signature patterns ────────────────────────────────
  {
    const full = getText(await client.callTool({
      name: 'get-internal-api', arguments: { moduleName: 'src', format: 'full' },
    }));

    assertIncludes('search: Promise return type', full, 'Promise');
    assertIncludes('search: string param', full, 'string');
    assertIncludes('search: void return', full, 'void');
  }

  // ── Search via tree index (section IDs) ────────────────────────────────
  {
    const tree = getText(await client.callTool({
      name: 'get-internal-api', arguments: { moduleName: 'src' },
    }));

    assertIncludes('tree: has section IDs', tree, '[`');
    assertIncludes('tree: analyzer section', tree, 'analyzer');
    assertIncludes('tree: fetcher section', tree, 'fetcher');
    assertIncludes('tree: server section', tree, 'server');
    assertIncludes('tree: cache section', tree, 'cache');
    assertIncludes('tree: source-scanner section', tree, 'source-scanner');
    assertIncludes('tree: internal-deps section', tree, 'internal-deps');

    // Count section IDs to ensure thorough indexing
    const sectionIds = (tree.match(/\[`[a-z0-9-]+`\]/g) || []);
    assert('tree: >= 50 section IDs', sectionIds.length >= 50, `only ${sectionIds.length}`);
  }

  await client.close();
}

async function testSearchJavaMonorepo() {
  console.log('  [java-monorepo] Searching scanned Java API...');
  const client = await setupClient();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-search-java-'));

  // ── Build a realistic Java service ─────────────────────────────────────
  const serviceDir = path.join(tmpDir, 'user-service');
  fs.mkdirSync(path.join(serviceDir, 'src/main/java/com/acme/users'), { recursive: true });

  fs.writeFileSync(path.join(serviceDir, 'pom.xml'), '<project></project>');

  fs.writeFileSync(path.join(serviceDir, 'src/main/java/com/acme/users/User.java'), `
package com.acme.users;

import javax.persistence.Entity;
import javax.persistence.Id;

/**
 * Core user entity stored in PostgreSQL.
 * Represents both internal employees and external customers.
 */
@Entity
public class User {
    @Id
    private Long id;
    private String email;
    private String role;

    public Long getId() { return id; }
    public String getEmail() { return email; }
    public String getRole() { return role; }
    public void setEmail(String email) { this.email = email; }
    public void setRole(String role) { this.role = role; }
}
`);

  fs.writeFileSync(path.join(serviceDir, 'src/main/java/com/acme/users/UserRepository.java'), `
package com.acme.users;

import java.util.List;
import java.util.Optional;

/**
 * Data access layer for User entities.
 * Supports pagination and custom queries.
 */
public interface UserRepository {
    Optional<User> findById(Long id);
    List<User> findByRole(String role);
    List<User> findAll(int page, int size);
    User save(User user);
    void deleteById(Long id);
}
`);

  fs.writeFileSync(path.join(serviceDir, 'src/main/java/com/acme/users/UserService.java'), `
package com.acme.users;

import java.util.List;
import java.util.Optional;

/**
 * Business logic for user management.
 * Handles validation, role assignment, and event publishing.
 */
public class UserService {
    private UserRepository repository;

    public UserService(UserRepository repository) {
        this.repository = repository;
    }

    /** Creates a new user with default VIEWER role. */
    public User createUser(String email) { return null; }

    /** Promotes a user to ADMIN role. Requires current user to be ADMIN. */
    public User promoteToAdmin(Long userId) { return null; }

    /** Searches users by role with pagination. */
    public List<User> findByRole(String role, int page, int size) { return List.of(); }

    /** Deactivates a user account. Does NOT delete from database. */
    public void deactivateUser(Long userId) {}

    private void publishUserEvent(String eventType, Long userId) {}
    private void validateEmail(String email) {}
}
`);

  fs.writeFileSync(path.join(serviceDir, 'src/main/java/com/acme/users/UserController.java'), `
package com.acme.users;

import org.springframework.web.bind.annotation.*;
import java.util.List;

/**
 * REST API for user operations.
 */
@RestController
@RequestMapping("/api/v1/users")
public class UserController {

    @GetMapping("/")
    public List<User> listUsers() { return List.of(); }

    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) { return null; }

    @PostMapping("/")
    public User createUser(@RequestBody User user) { return null; }

    @PutMapping("/{id}")
    public User updateUser(@PathVariable Long id, @RequestBody User user) { return null; }

    @DeleteMapping("/{id}")
    public void deleteUser(@PathVariable Long id) {}
}
`);

  // Scan
  await client.callTool({
    name: 'scan-internal-source',
    arguments: { projectPath: tmpDir, modulePaths: ['user-service'] },
  });

  const full = getText(await client.callTool({
    name: 'get-internal-api', arguments: { moduleName: 'user-service', format: 'full' },
  }));

  // ── Search for domain entities ─────────────────────────────────────────
  assertIncludes('java-search: User entity', full, 'User');
  assertIncludes('java-search: @Entity annotation', full, '@Entity');
  assertIncludes('java-search: doc comment about PostgreSQL', full, 'PostgreSQL');

  // ── Search for repository methods ──────────────────────────────────────
  assertIncludes('java-search: findById method', full, 'findById');
  assertIncludes('java-search: findByRole method', full, 'findByRole');
  assertIncludes('java-search: save method', full, 'save');
  assertIncludes('java-search: deleteById method', full, 'deleteById');

  // ── Search for service business logic ──────────────────────────────────
  assertIncludes('java-search: createUser method', full, 'createUser');
  assertIncludes('java-search: promoteToAdmin method', full, 'promoteToAdmin');
  assertIncludes('java-search: deactivateUser method', full, 'deactivateUser');
  assertIncludes('java-search: doc: default VIEWER role', full, 'VIEWER');
  assertIncludes('java-search: doc: ADMIN requirement', full, 'ADMIN');

  // ── Verify private methods are NOT exposed ─────────────────────────────
  assert('java-search: publishUserEvent filtered', !full.includes('publishUserEvent'), 'private method leaked');
  assert('java-search: validateEmail filtered', !full.includes('validateEmail'), 'private method leaked');

  // ── Search for REST endpoints ──────────────────────────────────────────
  assertIncludes('java-search: @RestController', full, '@RestController');
  assertIncludes('java-search: @GetMapping', full, '@GetMapping');
  assertIncludes('java-search: @PostMapping', full, '@PostMapping');
  assertIncludes('java-search: @DeleteMapping', full, '@DeleteMapping');
  assertIncludes('java-search: listUsers handler', full, 'listUsers');
  assertIncludes('java-search: updateUser handler', full, 'updateUser');

  // ── Search the tree index ──────────────────────────────────────────────
  const tree = getText(await client.callTool({
    name: 'get-internal-api', arguments: { moduleName: 'user-service' },
  }));

  assertIncludes('java-tree: User class in index', tree, 'User');
  assertIncludes('java-tree: UserRepository in index', tree, 'UserRepository');
  assertIncludes('java-tree: UserService in index', tree, 'UserService');
  assertIncludes('java-tree: UserController in index', tree, 'UserController');
  assertIncludes('java-tree: has section IDs', tree, '[`');

  // ── Cross-class search: "How does authentication/role work?" ───────────
  const roleRelated = full.toLowerCase();
  assert('java-search: role appears in entity', roleRelated.includes('getrole'));
  assert('java-search: role appears in service', roleRelated.includes('findbyrol'));
  assert('java-search: role in promoteToAdmin doc', roleRelated.includes('admin'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  await client.close();
}

async function testSearchTsGqlMonorepo() {
  console.log('  [ts-gql-monorepo] Searching scanned TS + GraphQL API...');
  const client = await setupClient();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-search-ts-'));

  // ── Build a realistic TS + GQL frontend ────────────────────────────────
  const feDir = path.join(tmpDir, 'frontend');
  fs.mkdirSync(path.join(feDir, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(feDir, 'src/hooks'), { recursive: true });
  fs.mkdirSync(path.join(feDir, 'src/graphql'), { recursive: true });
  fs.mkdirSync(path.join(feDir, 'src/store'), { recursive: true });

  fs.writeFileSync(path.join(feDir, 'package.json'), '{}');

  fs.writeFileSync(path.join(feDir, 'src/components/UserProfile.tsx'), `
/** Displays user profile with avatar, name, and role badge. */
export const UserProfile = ({ userId }: { userId: string }) => {
  return null;
};

/** Editable form for user settings like email and notification preferences. */
export const UserSettings = ({ userId }: { userId: string }) => {
  return null;
};

/** Admin-only component to manage user roles and permissions. */
export const RoleManager = ({ userId }: { userId: string }) => {
  return null;
};
`);

  fs.writeFileSync(path.join(feDir, 'src/components/Dashboard.tsx'), `
export interface DashboardProps {
  userId: string;
  showAnalytics: boolean;
}

/** Main dashboard with analytics widgets and recent activity feed. */
export const Dashboard = (props: DashboardProps) => {
  return null;
};

/** Sidebar navigation with links to all major sections. */
export const Sidebar = () => {
  return null;
};
`);

  fs.writeFileSync(path.join(feDir, 'src/hooks/useAuth.ts'), `
export interface AuthState {
  user: { id: string; email: string; role: string } | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

/** Manages authentication state, login, logout, and token refresh. */
export function useAuth(): AuthState & { login: (email: string, password: string) => Promise<void>; logout: () => void } {
  return {} as any;
}

/** Checks if the current user has a specific permission. */
export function usePermission(permission: string): boolean {
  return false;
}
`);

  fs.writeFileSync(path.join(feDir, 'src/hooks/useUsers.ts'), `
/** Fetches and caches user list with pagination and search. */
export function useUsers(page: number, search?: string) {
  return { users: [], total: 0, isLoading: false };
}

/** Fetches a single user by ID with real-time subscription. */
export function useUser(userId: string) {
  return { user: null, isLoading: false };
}
`);

  fs.writeFileSync(path.join(feDir, 'src/store/userStore.ts'), `
export interface UserState {
  currentUser: { id: string; name: string; role: string } | null;
  preferences: Record<string, string>;
}

export interface UserActions {
  setCurrentUser: (user: UserState['currentUser']) => void;
  updatePreference: (key: string, value: string) => void;
  clearSession: () => void;
}

/** Global user state store using Zustand pattern. */
export const useUserStore = (): UserState & UserActions => {
  return {} as any;
};
`);

  fs.writeFileSync(path.join(feDir, 'src/graphql/schema.graphql'), `
type User {
  id: ID!
  email: String!
  name: String!
  role: Role!
  createdAt: String!
}

enum Role {
  ADMIN
  EDITOR
  VIEWER
}

input CreateUserInput {
  email: String!
  name: String!
  role: Role
}

input UpdateUserInput {
  name: String
  role: Role
}

type Query {
  me: User!
  user(id: ID!): User
  users(page: Int, search: String): [User!]!
}

type Mutation {
  createUser(input: CreateUserInput!): User!
  updateUser(id: ID!, input: UpdateUserInput!): User!
  deleteUser(id: ID!): Boolean!
  assignRole(userId: ID!, role: Role!): User!
}

type Subscription {
  userUpdated(id: ID!): User!
}
`);

  // Scan
  await client.callTool({
    name: 'scan-internal-source',
    arguments: { projectPath: tmpDir, modulePaths: ['frontend'] },
  });

  const full = getText(await client.callTool({
    name: 'get-internal-api', arguments: { moduleName: 'frontend', format: 'full' },
  }));

  // ── Search for React components ────────────────────────────────────────
  assertIncludes('ts-search: UserProfile component', full, 'UserProfile');
  assertIncludes('ts-search: UserSettings component', full, 'UserSettings');
  assertIncludes('ts-search: RoleManager component', full, 'RoleManager');
  assertIncludes('ts-search: Dashboard component', full, 'Dashboard');
  assertIncludes('ts-search: Sidebar component', full, 'Sidebar');

  // ── Search for React hooks ─────────────────────────────────────────────
  assertIncludes('ts-search: useAuth hook', full, 'useAuth');
  assertIncludes('ts-search: usePermission hook', full, 'usePermission');
  assertIncludes('ts-search: useUsers hook', full, 'useUsers');
  assertIncludes('ts-search: useUser hook', full, 'useUser');
  assertIncludes('ts-search: useUserStore hook', full, 'useUserStore');

  // ── Search for interfaces / types ──────────────────────────────────────
  assertIncludes('ts-search: AuthState interface', full, 'AuthState');
  assertIncludes('ts-search: DashboardProps interface', full, 'DashboardProps');
  assertIncludes('ts-search: UserState interface', full, 'UserState');
  assertIncludes('ts-search: UserActions interface', full, 'UserActions');

  // ── Search for doc comments (the "why") ────────────────────────────────
  assertIncludes('ts-search: doc: avatar', full, 'avatar');
  assertIncludes('ts-search: doc: analytics widgets', full, 'analytics');
  assertIncludes('ts-search: doc: authentication state', full, 'authentication');
  assertIncludes('ts-search: doc: pagination', full, 'pagination');
  assertIncludes('ts-search: doc: Zustand pattern', full, 'Zustand');

  // ── Search GraphQL operations ──────────────────────────────────────────
  assertIncludes('gql-search: Query me', full, 'me');
  assertIncludes('gql-search: Query users', full, 'users');
  assertIncludes('gql-search: Mutation createUser', full, 'createUser');
  assertIncludes('gql-search: Mutation updateUser', full, 'updateUser');
  assertIncludes('gql-search: Mutation deleteUser', full, 'deleteUser');
  assertIncludes('gql-search: Mutation assignRole', full, 'assignRole');
  assertIncludes('gql-search: Subscription userUpdated', full, 'userUpdated');

  // ── Search GraphQL types ───────────────────────────────────────────────
  assertIncludes('gql-search: User type', full, 'User');
  assertIncludes('gql-search: Role enum', full, 'Role');
  assertIncludes('gql-search: CreateUserInput', full, 'CreateUserInput');
  assertIncludes('gql-search: UpdateUserInput', full, 'UpdateUserInput');

  // ── Cross-cutting search: "How do roles work?" ─────────────────────────
  // A developer asks about roles — it should surface across multiple files
  const roleMentions: string[] = [];
  if (full.includes('RoleManager')) roleMentions.push('RoleManager component');
  if (full.includes('usePermission')) roleMentions.push('usePermission hook');
  if (full.includes('assignRole')) roleMentions.push('assignRole mutation');
  if (full.toLowerCase().includes('role')) roleMentions.push('role field/type');
  assert('cross-search: roles found in >= 3 contexts', roleMentions.length >= 3,
    `only found: ${roleMentions.join(', ')}`);

  // ── Cross-cutting search: "How does user creation flow?" ───────────────
  const createMentions: string[] = [];
  if (full.includes('createUser')) createMentions.push('createUser mutation/method');
  if (full.includes('CreateUserInput')) createMentions.push('CreateUserInput type');
  if (full.includes('useUsers')) createMentions.push('useUsers hook for listing');
  assert('cross-search: creation flow in >= 2 contexts', createMentions.length >= 2,
    `only found: ${createMentions.join(', ')}`);

  // ── Tree index search ─────────────────────────────────────────────────
  const tree = getText(await client.callTool({
    name: 'get-internal-api', arguments: { moduleName: 'frontend' },
  }));

  assertIncludes('ts-tree: components section', tree, 'component');
  assertIncludes('ts-tree: hooks section', tree, 'hook');
  assertIncludes('ts-tree: graphql section', tree, 'graphql');
  assertIncludes('ts-tree: store section', tree, 'store');

  const sectionIds = (tree.match(/\[`[a-z0-9-]+`\]/g) || []);
  assert('ts-tree: >= 20 section IDs', sectionIds.length >= 20, `only ${sectionIds.length}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  await client.close();
}
