import { SourceScanner, moduleToDocSections, formatModuleMarkdown, detectLanguage, isTestSource, detectTestFrameworks } from '../../src/source-scanner/index.js';
import type { ScannedFile, TestMarkers } from '../../src/source-scanner/index.js';
import { assert, assertIncludes } from '../helpers.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

export async function testSourceScanner() {
  console.log('\n--- Unit: Source Scanner ---');

  await testTestDetection();

  // detectLanguage
  assert('detectLanguage .java', detectLanguage('Foo.java') === 'java');
  assert('detectLanguage .ts', detectLanguage('bar.ts') === 'typescript');
  assert('detectLanguage .tsx', detectLanguage('Comp.tsx') === 'tsx');
  assert('detectLanguage .scala', detectLanguage('Actor.scala') === 'scala');
  assert('detectLanguage .graphql', detectLanguage('schema.graphql') === 'graphql');
  assert('detectLanguage .gql', detectLanguage('ops.gql') === 'graphql');
  assert('detectLanguage .js', detectLanguage('index.js') === 'javascript');
  assert('detectLanguage unknown', detectLanguage('notes.txt') === null);

  // Scan this repo's src/
  const scanner = new SourceScanner();
  const srcModule = await scanner.scanModule(path.join(PROJECT_ROOT, 'src'), 'stack-compass-src');

  assert('scanned files > 20', srcModule.summary.totalFiles > 20, `got ${srcModule.summary.totalFiles}`);
  assert('total symbols > 100', srcModule.summary.totalSymbols > 100, `got ${srcModule.summary.totalSymbols}`);
  assert('detects ProjectAnalyzer class', srcModule.summary.publicClasses.includes('ProjectAnalyzer'));
  assert('detects DocFetcher class', srcModule.summary.publicClasses.includes('DocFetcher'));
  assert('detects SourceScanner class', srcModule.summary.publicClasses.includes('SourceScanner'));
  assert('detects InternalDepsDetector class', srcModule.summary.publicClasses.includes('InternalDepsDetector'));
  assert('detects MemoryCache class', srcModule.summary.publicClasses.includes('MemoryCache'));

  assert('detects DetectedFramework interface', srcModule.summary.publicInterfaces.includes('DetectedFramework'));
  assert('detects DocSection interface', srcModule.summary.publicInterfaces.includes('DocSection'));
  assert('detects ServerContext interface', srcModule.summary.publicInterfaces.includes('ServerContext'));
  assert('detects ExtractedSymbol interface', srcModule.summary.publicInterfaces.includes('ExtractedSymbol'));

  assert('public methods > 15', srcModule.summary.publicMethods > 15, `got ${srcModule.summary.publicMethods}`);
  assert('language is typescript', srcModule.language === 'typescript');

  // Check specific files were found
  const filePaths = srcModule.files.map(f => path.relative(PROJECT_ROOT, f.filePath));
  assert('found analyzer/index.ts', filePaths.some(f => f.includes('analyzer/index.ts')));
  assert('found fetcher/index.ts', filePaths.some(f => f.includes('fetcher/index.ts')));
  assert('found server/index.ts', filePaths.some(f => f.includes('server/index.ts')));
  assert('found source-scanner/scanner.ts', filePaths.some(f => f.includes('source-scanner/scanner.ts')));

  // Check method signatures were extracted
  const analyzerFile = srcModule.files.find(f => f.filePath.includes('analyzer/index.ts'));
  assert('analyzer file found', !!analyzerFile);
  if (analyzerFile) {
    const analyzerClass = analyzerFile.symbols.find(s => s.name === 'ProjectAnalyzer');
    assert('ProjectAnalyzer has children', !!analyzerClass?.children);
    const analyzeMethod = analyzerClass?.children?.find(c => c.name === 'analyze');
    assert('analyze method found', !!analyzeMethod);
    assert('analyze has signature', !!analyzeMethod?.signature);
    if (analyzeMethod?.signature) {
      assertIncludes('analyze signature contains Promise', analyzeMethod.signature, 'Promise');
    }
  }

  // Check DocFetcher methods
  const fetcherFile = srcModule.files.find(f => f.filePath.endsWith('fetcher/index.ts'));
  assert('fetcher file found', !!fetcherFile);
  if (fetcherFile) {
    const docFetcher = fetcherFile.symbols.find(s => s.name === 'DocFetcher');
    assert('DocFetcher has children', !!docFetcher?.children);
    const methodNames = docFetcher?.children?.map(c => c.name) ?? [];
    assert('DocFetcher.addFramework', methodNames.includes('addFramework'));
    assert('DocFetcher.getDocIndex', methodNames.includes('getDocIndex'));
    assert('DocFetcher.supplyDocUrl', methodNames.includes('supplyDocUrl'));
    assert('DocFetcher.getSectionContent', methodNames.includes('getSectionContent'));
  }

  // moduleToDocSections
  const sections = moduleToDocSections(srcModule);
  assert('doc sections > 5', sections.length > 5, `got ${sections.length}`);
  const overviewSection = sections.find(s => s.id.includes('overview'));
  assert('overview section exists', !!overviewSection);
  if (overviewSection) {
    assertIncludes('overview mentions files', overviewSection.summary, 'files');
    assertIncludes('overview mentions symbols', overviewSection.summary, 'symbols');
  }

  // formatModuleMarkdown
  const markdown = formatModuleMarkdown(srcModule);
  assert('markdown length > 5000', markdown.length > 5000, `got ${markdown.length}`);
  assertIncludes('markdown has title', markdown, '# stack-compass-src');
  assertIncludes('markdown lists classes', markdown, 'ProjectAnalyzer');
  assertIncludes('markdown lists interfaces', markdown, 'DetectedFramework');

  // Scan individual file
  const singleFile = await scanner.scanFile(path.join(PROJECT_ROOT, 'src/types/index.ts'));
  assert('single file scan works', !!singleFile);
  assert('single file has symbols', (singleFile?.symbols.length ?? 0) > 5);

  // Test with synthetic Java source
  await testJavaExtraction(scanner);

  // Test with synthetic Scala source
  await testScalaExtraction(scanner);

  // Test with synthetic GraphQL source
  await testGraphQLExtraction(scanner);
}

async function testJavaExtraction(scanner: SourceScanner) {
  console.log('  Java extraction...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-java-'));
  const javaFile = path.join(tmpDir, 'UserController.java');
  fs.writeFileSync(javaFile, `
package com.example.api;

import org.springframework.web.bind.annotation.*;
import java.util.List;

/**
 * Handles user-related REST endpoints.
 */
@RestController
@RequestMapping("/api/users")
public class UserController {

    /** Get all users */
    @GetMapping("/")
    public List<User> getAll() {
        return List.of();
    }

    @PostMapping("/")
    public User create(@RequestBody User user) {
        return user;
    }

    private void internalHelper() {}
}
`);

  const result = await scanner.scanFile(javaFile);
  assert('java: file scanned', !!result);
  assert('java: language is java', result?.language === 'java');
  assert('java: package detected', result?.packageName === 'com.example.api');

  const controller = result?.symbols.find(s => s.name === 'UserController');
  assert('java: UserController found', !!controller);
  assert('java: has annotations', (controller?.annotations?.length ?? 0) > 0);
  assert('java: has doc comment', !!controller?.docComment);
  assertIncludes('java: doc comment content', controller?.docComment ?? '', 'REST endpoints');

  const methods = controller?.children?.filter(c => c.kind === 'method') ?? [];
  assert('java: public methods extracted', methods.length >= 2, `got ${methods.length}`);
  const privateFiltered = methods.filter(m => m.name === 'internalHelper');
  assert('java: private methods filtered out', privateFiltered.length === 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function testScalaExtraction(scanner: SourceScanner) {
  console.log('  Scala extraction...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-scala-'));
  const scalaFile = path.join(tmpDir, 'EventBus.scala');
  fs.writeFileSync(scalaFile, `
package com.example.events

case class Event(id: String, payload: String)

trait EventHandler {
  def handle(event: Event): Unit
}

object EventBus {
  def publish(event: Event): Unit = {}
  def subscribe(handler: EventHandler): Unit = {}
  private def internalRoute(e: Event): Unit = {}
}
`);

  const result = await scanner.scanFile(scalaFile);
  assert('scala: file scanned', !!result);
  assert('scala: language is scala', result?.language === 'scala');
  assert('scala: package detected', result?.packageName === 'com.example.events');

  const event = result?.symbols.find(s => s.name === 'Event');
  assert('scala: Event case class found', !!event);
  assert('scala: Event is case-class', event?.kind === 'case-class');

  const handler = result?.symbols.find(s => s.name === 'EventHandler');
  assert('scala: EventHandler trait found', !!handler);
  assert('scala: EventHandler is trait', handler?.kind === 'trait');

  const bus = result?.symbols.find(s => s.name === 'EventBus');
  assert('scala: EventBus object found', !!bus);
  const busMethods = bus?.children?.filter(c => c.kind === 'method') ?? [];
  assert('scala: public methods extracted', busMethods.length >= 2, `got ${busMethods.length}`);
  const privateFiltered = busMethods.filter(m => m.name === 'internalRoute');
  assert('scala: private methods filtered out', privateFiltered.length === 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function testGraphQLExtraction(scanner: SourceScanner) {
  console.log('  GraphQL extraction...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-gql-'));
  const gqlFile = path.join(tmpDir, 'schema.graphql');
  fs.writeFileSync(gqlFile, `
type User {
  id: ID!
  name: String!
  email: String
}

input CreateUserInput {
  name: String!
  email: String!
}

enum Role {
  ADMIN
  USER
  GUEST
}

type Query {
  users: [User!]!
  user(id: ID!): User
}

type Mutation {
  createUser(input: CreateUserInput!): User!
  deleteUser(id: ID!): Boolean!
}
`);

  const result = await scanner.scanFile(gqlFile);
  assert('graphql: file scanned', !!result);
  assert('graphql: language is graphql', result?.language === 'graphql');

  const userType = result?.symbols.find(s => s.name === 'User');
  assert('graphql: User type found', !!userType);
  assert('graphql: User has fields', (userType?.children?.length ?? 0) >= 2);

  const input = result?.symbols.find(s => s.name === 'CreateUserInput');
  assert('graphql: CreateUserInput found', !!input);
  assert('graphql: input kind is graphql-input', input?.kind === 'graphql-input');

  const role = result?.symbols.find(s => s.name === 'Role');
  assert('graphql: Role enum found', !!role);
  assert('graphql: Role kind is graphql-enum', role?.kind === 'graphql-enum');

  const queries = result?.symbols.filter(s => s.kind === 'query') ?? [];
  assert('graphql: queries extracted', queries.length >= 2, `got ${queries.length}`);

  const mutations = result?.symbols.filter(s => s.kind === 'mutation') ?? [];
  assert('graphql: mutations extracted', mutations.length >= 2, `got ${mutations.length}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function testTestDetection() {
  console.log('  Test file detection (content-based)...');
  const scanner = new SourceScanner();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-testdet-'));

  // --- Java: production file ---
  const javaProd = path.join(tmpDir, 'UserService.java');
  fs.writeFileSync(javaProd, `
package com.company.service;

import org.springframework.stereotype.Service;
import com.company.model.User;

@Service
public class UserService {
    public User findById(long id) {
        return null;
    }
}
`);

  // --- Java: JUnit test ---
  fs.mkdirSync(path.join(tmpDir, 'java-tests'));
  const javaTestFile = path.join(tmpDir, 'java-tests', 'UserServiceTest.java');
  fs.writeFileSync(javaTestFile, `
package com.company.service;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;

class UserServiceTest {
    @Test
    void findById_shouldReturnUser() {
        assertThat(true).isTrue();
    }
}
`);

  // --- Java: "TestResult" is NOT a test (false positive guard) ---
  const javaFalsePos = path.join(tmpDir, 'TestResult.java');
  fs.writeFileSync(javaFalsePos, `
package com.company.model;

public class TestResult {
    private String name;
    private boolean passed;
    public String getName() { return name; }
}
`);

  // --- Java: Mockito-only file IS test ---
  const javaMockito = path.join(tmpDir, 'ServiceMock.java');
  fs.writeFileSync(javaMockito, `
package com.company.service;

import org.mockito.Mock;
import org.mockito.InjectMocks;

class ServiceMock {
    @Mock
    private UserService service;
    @InjectMocks
    private OrderService orderService;
}
`);

  // --- Java: @SpringBootTest ---
  const javaSpringTest = path.join(tmpDir, 'IntegrationTest.java');
  fs.writeFileSync(javaSpringTest, `
package com.company;

import org.springframework.boot.test.context.SpringBootTest;
import org.junit.jupiter.api.Test;

@SpringBootTest
class IntegrationTest {
    @Test
    void contextLoads() { }
}
`);

  const prodResult = await scanner.scanFile(javaProd);
  assert('java-prod: scanned', !!prodResult);
  assert('java-prod: NOT test', !isTestSource(prodResult!));

  const testResult = await scanner.scanFile(javaTestFile);
  assert('java-test: scanned', !!testResult);
  assert('java-test: IS test (junit import)', isTestSource(testResult!));

  const falsePosResult = await scanner.scanFile(javaFalsePos);
  assert('java-TestResult: scanned', !!falsePosResult);
  assert('java-TestResult: NOT test (no test imports)', !isTestSource(falsePosResult!));

  const mockitoResult = await scanner.scanFile(javaMockito);
  assert('java-mockito: scanned', !!mockitoResult);
  assert('java-mockito: IS test (mockito import)', isTestSource(mockitoResult!));

  const springTestResult = await scanner.scanFile(javaSpringTest);
  assert('java-springboot-test: scanned', !!springTestResult);
  assert('java-springboot-test: IS test', isTestSource(springTestResult!));

  // --- TypeScript: production file ---
  const tsProd = path.join(tmpDir, 'utils.ts');
  fs.writeFileSync(tsProd, `
import { format } from 'date-fns';

export function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

export class DateHelper {
  static now(): string { return formatDate(new Date()); }
}
`);

  // --- TypeScript: vitest test ---
  const tsTest = path.join(tmpDir, 'utils.test.ts');
  fs.writeFileSync(tsTest, `
import { describe, it, expect } from 'vitest';
import { formatDate } from './utils';

describe('formatDate', () => {
  it('formats correctly', () => {
    expect(formatDate(new Date(2024, 0, 1))).toBe('2024-01-01');
  });
});
`);

  // --- TypeScript: jest test ---
  const tsJestTest = path.join(tmpDir, 'service.spec.ts');
  fs.writeFileSync(tsJestTest, `
import { jest } from '@jest/globals';
import { UserService } from './service';

const mockFetch = jest.fn();
`);

  // --- TSX: @testing-library test ---
  const tsTestingLib = path.join(tmpDir, 'Component.test.tsx');
  fs.writeFileSync(tsTestingLib, `
import { render, screen } from '@testing-library/react';
import { Button } from './Button';

test('renders button', () => {
  render(<Button>Click</Button>);
  screen.getByText('Click');
});
`);

  // --- TypeScript: "ContestService" is NOT a test ---
  const tsFalsePos = path.join(tmpDir, 'contest.ts');
  fs.writeFileSync(tsFalsePos, `
import { EventEmitter } from 'events';

export class ContestService {
  run(): void { console.log('running contest'); }
}
`);

  const tsProdResult = await scanner.scanFile(tsProd);
  assert('ts-prod: scanned', !!tsProdResult);
  assert('ts-prod: NOT test', !isTestSource(tsProdResult!));

  const tsTestResult = await scanner.scanFile(tsTest);
  assert('ts-vitest: scanned', !!tsTestResult);
  assert('ts-vitest: IS test', isTestSource(tsTestResult!));

  const tsJestResult = await scanner.scanFile(tsJestTest);
  assert('ts-jest: scanned', !!tsJestResult);
  assert('ts-jest: IS test', isTestSource(tsJestResult!));

  const tsTestingLibResult = await scanner.scanFile(tsTestingLib);
  assert('tsx-testing-library: scanned', !!tsTestingLibResult);
  assert('tsx-testing-library: IS test', isTestSource(tsTestingLibResult!));

  const tsFalsePosResult = await scanner.scanFile(tsFalsePos);
  assert('ts-contest: scanned', !!tsFalsePosResult);
  assert('ts-contest: NOT test', !isTestSource(tsFalsePosResult!));

  // --- Scala: production file ---
  const scalaProd = path.join(tmpDir, 'UserActor.scala');
  fs.writeFileSync(scalaProd, `
package com.company.actors

import akka.actor.Actor

class UserActor extends Actor {
  def receive: Receive = {
    case msg: String => println(msg)
  }
}
`);

  // --- Scala: scalatest ---
  const scalaTest = path.join(tmpDir, 'UserActorSpec.scala');
  fs.writeFileSync(scalaTest, `
package com.company.actors

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class UserActorSpec extends AnyFlatSpec with Matchers {
  "UserActor" should "handle messages" in {
    true shouldBe true
  }
}
`);

  // --- Scala: munit ---
  const scalaMunit = path.join(tmpDir, 'ServiceSuite.scala');
  fs.writeFileSync(scalaMunit, `
package com.company.service

import munit.FunSuite

class ServiceSuite extends FunSuite {
  test("example") {
    assertEquals(1 + 1, 2)
  }
}
`);

  const scalaProdResult = await scanner.scanFile(scalaProd);
  assert('scala-prod: scanned', !!scalaProdResult);
  assert('scala-prod: NOT test', !isTestSource(scalaProdResult!));

  const scalaTestResult = await scanner.scanFile(scalaTest);
  assert('scala-scalatest: scanned', !!scalaTestResult);
  assert('scala-scalatest: IS test', isTestSource(scalaTestResult!));

  const scalaMunitResult = await scanner.scanFile(scalaMunit);
  assert('scala-munit: scanned', !!scalaMunitResult);
  assert('scala-munit: IS test', isTestSource(scalaMunitResult!));

  // --- Module-level: verify test files excluded from summary ---
  const moduleDir = path.join(tmpDir, 'module');
  fs.mkdirSync(moduleDir);

  fs.writeFileSync(path.join(moduleDir, 'App.java'), `
package com.company;

import org.springframework.stereotype.Service;

@Service
public class App {
    public String run() { return "running"; }
}
`);

  fs.writeFileSync(path.join(moduleDir, 'AppTest.java'), `
package com.company;

import org.junit.jupiter.api.Test;

class AppTest {
    @Test
    void testRun() { }
}
`);

  const mod = await scanner.scanModule(moduleDir, 'test-module');
  assert('module: App included', mod.summary.publicClasses.includes('App'));
  assert('module: AppTest excluded', !mod.summary.publicClasses.includes('AppTest'));
  assert('module: only 1 file (test excluded)', mod.files.length === 1, `got ${mod.files.length}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  // --- Build-file pre-scan tests ---
  console.log('  Build-file-driven test framework detection...');

  // Maven pom.xml with test-scoped deps
  const pomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-prescan-pom-'));
  fs.writeFileSync(path.join(pomDir, 'pom.xml'), `
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.2.0</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.0</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.mockito</groupId>
      <artifactId>mockito-core</artifactId>
      <version>5.8.0</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.assertj</groupId>
      <artifactId>assertj-core</artifactId>
      <version>3.25.0</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>`);

  const pomMarkers = detectTestFrameworks(pomDir);
  assert('pom: detected 3 test frameworks', pomMarkers.detectedFrameworks.length === 3, `got ${pomMarkers.detectedFrameworks.length}`);
  assert('pom: junit-jupiter detected', pomMarkers.detectedFrameworks.includes('junit-jupiter'));
  assert('pom: mockito-core detected', pomMarkers.detectedFrameworks.includes('mockito-core'));
  assert('pom: assertj-core detected', pomMarkers.detectedFrameworks.includes('assertj-core'));
  assert('pom: has junit import prefix', pomMarkers.importPrefixes.some(p => p.includes('org.junit')));
  assert('pom: has mockito import prefix', pomMarkers.importPrefixes.some(p => p.includes('org.mockito')));
  assert('pom: has @Test annotation', pomMarkers.annotations.includes('@Test'));
  assert('pom: has @Mock annotation', pomMarkers.annotations.includes('@Mock'));
  assert('pom: spring-boot-starter-web NOT detected (not test scope)', !pomMarkers.detectedFrameworks.includes('spring-boot-starter-web'));
  fs.rmSync(pomDir, { recursive: true, force: true });

  // package.json with devDependencies
  const npmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-prescan-npm-'));
  fs.writeFileSync(path.join(npmDir, 'package.json'), JSON.stringify({
    dependencies: { 'react': '^18.2.0', 'next': '^14.0.0' },
    devDependencies: { 'vitest': '^1.0.0', '@testing-library/react': '^14.0.0', 'msw': '^2.0.0' },
  }));

  const npmMarkers = detectTestFrameworks(npmDir);
  assert('npm: detected vitest', npmMarkers.detectedFrameworks.includes('vitest'));
  assert('npm: detected @testing-library/react', npmMarkers.detectedFrameworks.includes('@testing-library/react'));
  assert('npm: detected msw', npmMarkers.detectedFrameworks.includes('msw'));
  assert('npm: has vitest import prefix', npmMarkers.importPrefixes.some(p => p === 'vitest'));
  assert('npm: has @testing-library import prefix', npmMarkers.importPrefixes.some(p => p === '@testing-library'));
  fs.rmSync(npmDir, { recursive: true, force: true });

  // build.gradle with testImplementation
  const gradleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-prescan-gradle-'));
  fs.writeFileSync(path.join(gradleDir, 'build.gradle'), `
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web:3.2.0'
    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'
    testImplementation 'org.mockito:mockito-core:5.8.0'
}
`);

  const gradleMarkers = detectTestFrameworks(gradleDir);
  assert('gradle: detected junit-jupiter', gradleMarkers.detectedFrameworks.includes('junit-jupiter'));
  assert('gradle: detected mockito-core', gradleMarkers.detectedFrameworks.includes('mockito-core'));
  assert('gradle: spring-boot NOT detected (not testImpl)', !gradleMarkers.detectedFrameworks.includes('spring-boot-starter-web'));
  fs.rmSync(gradleDir, { recursive: true, force: true });

  // build.sbt with % Test
  const sbtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-prescan-sbt-'));
  fs.writeFileSync(path.join(sbtDir, 'build.sbt'), `
name := "my-service"
libraryDependencies ++= Seq(
  "com.typesafe.akka" %% "akka-actor" % "2.6.20",
  "org.scalatest" %% "scalatest" % "3.2.17" % Test,
  "org.scalamock" %% "scalamock" % "5.2.0" % Test
)
`);

  const sbtMarkers = detectTestFrameworks(sbtDir);
  assert('sbt: detected scalatest', sbtMarkers.detectedFrameworks.includes('scalatest'));
  assert('sbt: detected scalamock', sbtMarkers.detectedFrameworks.includes('scalamock'));
  assert('sbt: has scalatest import prefix', sbtMarkers.importPrefixes.some(p => p.includes('org.scalatest')));
  assert('sbt: has scalatest supertypes', sbtMarkers.supertypes.length > 0);
  assert('sbt: akka NOT detected (not Test scope)', !sbtMarkers.detectedFrameworks.includes('akka-actor'));
  fs.rmSync(sbtDir, { recursive: true, force: true });

  // No build file — fallback
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-prescan-empty-'));
  const emptyMarkers = detectTestFrameworks(emptyDir);
  assert('no-build-file: no detected frameworks', emptyMarkers.detectedFrameworks.length === 0);
  fs.rmSync(emptyDir, { recursive: true, force: true });

  // --- Module-level with build file: only test deps from pom drive filtering ---
  console.log('  Module with pom.xml test dep detection...');
  const pomModuleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-pommod-'));

  fs.writeFileSync(path.join(pomModuleDir, 'pom.xml'), `
<project>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.0</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>`);

  fs.writeFileSync(path.join(pomModuleDir, 'UserController.java'), `
package com.company.web;

import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;

@RestController
public class UserController {
    @GetMapping("/users")
    public String getUsers() { return "[]"; }
}
`);

  fs.writeFileSync(path.join(pomModuleDir, 'UserControllerTest.java'), `
package com.company.web;

import org.junit.jupiter.api.Test;

class UserControllerTest {
    @Test
    void testGetUsers() { }
}
`);

  const pomMod = await scanner.scanModule(pomModuleDir, 'pom-module');
  assert('pom-module: UserController included', pomMod.summary.publicClasses.includes('UserController'));
  assert('pom-module: UserControllerTest excluded', !pomMod.summary.publicClasses.includes('UserControllerTest'));
  assert('pom-module: 1 file only', pomMod.files.length === 1, `got ${pomMod.files.length}`);
  fs.rmSync(pomModuleDir, { recursive: true, force: true });

  // --- Module-level with package.json: vitest test excluded ---
  console.log('  Module with package.json test dep detection...');
  const npmModuleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-npmmod-'));

  fs.writeFileSync(path.join(npmModuleDir, 'package.json'), JSON.stringify({
    dependencies: { 'react': '^18.0.0' },
    devDependencies: { 'vitest': '^1.0.0' },
  }));

  fs.writeFileSync(path.join(npmModuleDir, 'Button.tsx'), `
import React from 'react';

export const Button = ({ label }: { label: string }) => {
  return <button>{label}</button>;
};
`);

  fs.writeFileSync(path.join(npmModuleDir, 'Button.test.tsx'), `
import { describe, it, expect } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders', () => {
    expect(true).toBe(true);
  });
});
`);

  const npmMod = await scanner.scanModule(npmModuleDir, 'npm-module');
  const hasButton = npmMod.files.some(f => f.symbols.some(s => s.name === 'Button'));
  assert('npm-module: Button component included', hasButton);
  const hasTestFile = npmMod.files.some(f => f.filePath.includes('Button.test'));
  assert('npm-module: Button.test.tsx excluded', !hasTestFile);
  assert('npm-module: 1 file only', npmMod.files.length === 1, `got ${npmMod.files.length}`);
  fs.rmSync(npmModuleDir, { recursive: true, force: true });
}
