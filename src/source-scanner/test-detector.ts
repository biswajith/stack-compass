import * as fs from 'fs';
import * as path from 'path';
import type { ScannedFile, ExtractedSymbol } from './types.js';

/**
 * Markers used to identify test source files, derived from
 * the project's actual build-file test dependencies.
 */
export interface TestMarkers {
  importPrefixes: string[];
  annotations: string[];
  supertypes: string[];
  detectedFrameworks: string[];
}

// Maps Maven/npm/SBT artifact names → import prefixes they contribute
const ARTIFACT_TO_IMPORTS: Record<string, { imports: string[]; annotations?: string[]; supertypes?: string[] }> = {
  // Java / JVM — JUnit 5
  'junit-jupiter':            { imports: ['org.junit.jupiter'], annotations: ['@Test', '@ParameterizedTest', '@RepeatedTest', '@TestFactory', '@TestInstance', '@Nested', '@ExtendWith'] },
  'junit-jupiter-api':        { imports: ['org.junit.jupiter'], annotations: ['@Test', '@ParameterizedTest', '@RepeatedTest', '@TestFactory', '@TestInstance', '@Nested', '@ExtendWith'] },
  'junit-jupiter-engine':     { imports: ['org.junit.jupiter'] },
  'junit-jupiter-params':     { imports: ['org.junit.jupiter.params'], annotations: ['@ParameterizedTest'] },
  // JUnit 4
  'junit':                    { imports: ['org.junit'], annotations: ['@Test', '@RunWith', '@Before', '@After'] },
  // TestNG
  'testng':                   { imports: ['org.testng'], annotations: ['@Test', '@BeforeClass', '@AfterClass'] },
  // Mockito
  'mockito-core':             { imports: ['org.mockito'], annotations: ['@Mock', '@InjectMocks', '@Spy', '@Captor'] },
  'mockito-junit-jupiter':    { imports: ['org.mockito'], annotations: ['@ExtendWith'] },
  'mockito-inline':           { imports: ['org.mockito'] },
  // AssertJ
  'assertj-core':             { imports: ['org.assertj'] },
  // Hamcrest
  'hamcrest':                 { imports: ['org.hamcrest'] },
  'hamcrest-core':            { imports: ['org.hamcrest'] },
  'hamcrest-all':             { imports: ['org.hamcrest'] },
  // Spring Test
  'spring-boot-starter-test': { imports: ['org.springframework.boot.test', 'org.springframework.test'], annotations: ['@SpringBootTest', '@DataJpaTest', '@WebMvcTest', '@WebFluxTest', '@MockBean', '@SpyBean'] },
  'spring-boot-test':         { imports: ['org.springframework.boot.test'], annotations: ['@SpringBootTest'] },
  'spring-test':              { imports: ['org.springframework.test'], annotations: ['@ContextConfiguration'] },
  // Quarkus Test
  'quarkus-junit5':           { imports: ['io.quarkus.test'], annotations: ['@QuarkusTest'] },
  // Arquillian
  'arquillian-junit':         { imports: ['org.jboss.arquillian'] },
  // REST Assured
  'rest-assured':             { imports: ['io.restassured'] },
  // WireMock
  'wiremock':                 { imports: ['com.github.tomakehurst.wiremock'] },

  // TypeScript / JavaScript
  'jest':                     { imports: ['jest', '@jest'] },
  '@jest/globals':            { imports: ['@jest/globals', 'jest'] },
  'vitest':                   { imports: ['vitest'] },
  'mocha':                    { imports: ['mocha'] },
  'chai':                     { imports: ['chai'] },
  'sinon':                    { imports: ['sinon'] },
  'jasmine':                  { imports: ['jasmine'] },
  'jasmine-core':             { imports: ['jasmine'] },
  '@testing-library/react':   { imports: ['@testing-library'] },
  '@testing-library/jest-dom': { imports: ['@testing-library'] },
  '@testing-library/dom':     { imports: ['@testing-library'] },
  '@testing-library/vue':     { imports: ['@testing-library'] },
  '@testing-library/angular': { imports: ['@testing-library'] },
  'supertest':                { imports: ['supertest'] },
  'nock':                     { imports: ['nock'] },
  'msw':                      { imports: ['msw'] },
  'enzyme':                   { imports: ['enzyme'] },
  'react-test-renderer':      { imports: ['react-test-renderer'] },
  '@playwright/test':         { imports: ['@playwright'] },
  'playwright':               { imports: ['@playwright'] },
  'cypress':                  { imports: ['cypress'] },
  'ava':                      { imports: ['ava'] },
  'tap':                      { imports: ['tap'] },
  'uvu':                      { imports: ['uvu'] },

  // Scala
  'scalatest':                { imports: ['org.scalatest'], supertypes: ['AnyFunSuite', 'AnyFlatSpec', 'AnyWordSpec', 'AnyFreeSpec', 'AnyFunSpec', 'AnyPropSpec', 'AnyFeatureSpec', 'FunSuite', 'FlatSpec', 'WordSpec', 'FreeSpec', 'FunSpec', 'PropSpec', 'Suite'] },
  'specs2-core':              { imports: ['org.specs2'], supertypes: ['Specification', 'MutableSpecification'] },
  'specs2':                   { imports: ['org.specs2'], supertypes: ['Specification', 'MutableSpecification'] },
  'munit':                    { imports: ['munit'], supertypes: ['FunSuite'] },
  'zio-test':                 { imports: ['zio.test'] },
  'weaver-cats':              { imports: ['weaver'] },
  'utest':                    { imports: ['utest'] },
  'scalacheck':               { imports: ['org.scalacheck'] },
  'scalamock':                { imports: ['org.scalamock'] },
};

/**
 * Pre-scans a module directory for build files (pom.xml, package.json,
 * build.sbt, build.gradle) and extracts test-scoped dependencies.
 * Returns markers that isTestSource uses to identify test files.
 */
export function detectTestFrameworks(modulePath: string): TestMarkers {
  const markers: TestMarkers = {
    importPrefixes: [],
    annotations: [],
    supertypes: [],
    detectedFrameworks: [],
  };

  const importSet = new Set<string>();
  const annotationSet = new Set<string>();
  const supertypeSet = new Set<string>();

  const detectors = [
    { file: 'pom.xml', parse: parsePomTestDeps },
    { file: 'package.json', parse: parsePackageJsonTestDeps },
    { file: 'build.sbt', parse: parseSbtTestDeps },
    { file: 'build.gradle', parse: parseGradleTestDeps },
    { file: 'build.gradle.kts', parse: parseGradleTestDeps },
  ];

  for (const { file, parse } of detectors) {
    const filePath = path.join(modulePath, file);
    if (fs.existsSync(filePath)) {
      const artifacts = parse(filePath);
      for (const artifact of artifacts) {
        const mapping = findArtifactMapping(artifact);
        if (mapping) {
          markers.detectedFrameworks.push(artifact);
          for (const imp of mapping.imports) importSet.add(imp);
          if (mapping.annotations) for (const ann of mapping.annotations) annotationSet.add(ann);
          if (mapping.supertypes) for (const st of mapping.supertypes) supertypeSet.add(st);
        }
      }
    }
  }

  markers.importPrefixes = Array.from(importSet);
  markers.annotations = Array.from(annotationSet);
  markers.supertypes = Array.from(supertypeSet);

  return markers;
}

function findArtifactMapping(artifact: string): { imports: string[]; annotations?: string[]; supertypes?: string[] } | undefined {
  const lower = artifact.toLowerCase();
  // Direct match
  if (ARTIFACT_TO_IMPORTS[lower]) return ARTIFACT_TO_IMPORTS[lower];
  // Partial match: artifact may be "org.mockito:mockito-core" — try the artifactId part
  const lastPart = lower.split(':').pop() ?? lower;
  if (ARTIFACT_TO_IMPORTS[lastPart]) return ARTIFACT_TO_IMPORTS[lastPart];
  // Scoped npm: "@testing-library/react"
  const slashPart = lower.split('/');
  if (slashPart.length === 2 && ARTIFACT_TO_IMPORTS[lower]) return ARTIFACT_TO_IMPORTS[lower];
  return undefined;
}

function parsePomTestDeps(pomPath: string): string[] {
  const artifacts: string[] = [];
  try {
    const content = fs.readFileSync(pomPath, 'utf-8');
    // Strip dependencyManagement to avoid version-only declarations
    const cleaned = content.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');
    const depBlockRegex = /<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g;
    let block: RegExpExecArray | null;
    while ((block = depBlockRegex.exec(cleaned)) !== null) {
      const body = block[1];
      const scope = body.match(/<scope>\s*([^<]+?)\s*<\/scope>/)?.[1]?.trim();
      if (scope !== 'test') continue;
      const artifactId = body.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1]?.trim();
      if (artifactId) artifacts.push(artifactId);
    }
  } catch { /* */ }
  return artifacts;
}

function parsePackageJsonTestDeps(pkgPath: string): string[] {
  const artifacts: string[] = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.devDependencies) {
      for (const name of Object.keys(pkg.devDependencies)) {
        if (findArtifactMapping(name)) artifacts.push(name);
      }
    }
  } catch { /* */ }
  return artifacts;
}

function parseSbtTestDeps(sbtPath: string): string[] {
  const artifacts: string[] = [];
  try {
    const content = fs.readFileSync(sbtPath, 'utf-8');
    // Match: "org" %% "artifact" % "version" % Test
    const depRegex = /"([^"]+)"\s*%%?\s*"([^"]+)"\s*%\s*"[^"]+"\s*%\s*(?:Test|"test")/gi;
    let match: RegExpExecArray | null;
    while ((match = depRegex.exec(content)) !== null) {
      artifacts.push(match[2]);
    }
  } catch { /* */ }
  return artifacts;
}

function parseGradleTestDeps(gradlePath: string): string[] {
  const artifacts: string[] = [];
  try {
    const content = fs.readFileSync(gradlePath, 'utf-8');
    const testRegex = /(?:testImplementation|testCompileOnly|testRuntimeOnly|androidTestImplementation)\s*\(?['"]([^'"]+)['"]\)?/g;
    let match: RegExpExecArray | null;
    while ((match = testRegex.exec(content)) !== null) {
      const parts = match[1].split(':');
      if (parts.length >= 2) artifacts.push(parts[1]);
      else artifacts.push(parts[0]);
    }
  } catch { /* */ }
  return artifacts;
}

/**
 * Determines if a scanned file is a test file by checking its
 * parsed imports and annotations against markers derived from
 * the project's build file. Falls back to a minimal built-in
 * set if no build file was found (markers.detectedFrameworks is empty).
 */
export function isTestSource(file: ScannedFile, markers?: TestMarkers): boolean {
  const m = markers && markers.detectedFrameworks.length > 0
    ? markers
    : FALLBACK_MARKERS;

  if (m.importPrefixes.length > 0 && file.imports?.some(imp =>
    m.importPrefixes.some(prefix => imp.includes(prefix))
  )) {
    return true;
  }

  if (m.annotations.length > 0 && hasAnnotationMatch(file.symbols, m.annotations)) {
    return true;
  }

  if (m.supertypes.length > 0 && hasSupertypeMatch(file.symbols, m.supertypes)) {
    return true;
  }

  return false;
}

/** Minimal fallback when no build file is found */
const FALLBACK_MARKERS: TestMarkers = {
  importPrefixes: [
    'org.junit', 'org.testng', 'org.mockito', 'org.assertj', 'org.hamcrest',
    'org.springframework.boot.test', 'org.springframework.test',
    'io.quarkus.test', 'org.jboss.arquillian',
    'jest', 'vitest', 'mocha', 'chai', 'sinon', 'jasmine',
    '@testing-library', '@jest', 'supertest', 'nock', 'msw',
    'enzyme', 'react-test-renderer', '@playwright', 'cypress',
    'org.scalatest', 'org.specs2', 'munit', 'zio.test', 'weaver', 'utest',
  ],
  annotations: [
    '@Test', '@ParameterizedTest', '@RepeatedTest', '@TestFactory',
    '@SpringBootTest', '@DataJpaTest', '@WebMvcTest', '@WebFluxTest',
    '@ExtendWith', '@RunWith', '@TestInstance', '@Nested',
    '@MockBean', '@SpyBean', '@Mock', '@InjectMocks',
  ],
  supertypes: [
    'AnyFunSuite', 'AnyFlatSpec', 'AnyWordSpec', 'AnyFreeSpec',
    'AnyFunSpec', 'AnyPropSpec', 'AnyFeatureSpec',
    'FunSuite', 'FlatSpec', 'WordSpec', 'FreeSpec', 'FunSpec', 'PropSpec',
    'Specification', 'Suite', 'MutableSpecification',
  ],
  detectedFrameworks: [],
};

function hasAnnotationMatch(symbols: ExtractedSymbol[], markers: string[]): boolean {
  for (const sym of symbols) {
    if (sym.annotations?.some(ann => markers.some(m => ann.startsWith(m)))) {
      return true;
    }
    if (sym.children && hasAnnotationMatch(sym.children, markers)) {
      return true;
    }
  }
  return false;
}

function hasSupertypeMatch(symbols: ExtractedSymbol[], supertypes: string[]): boolean {
  for (const sym of symbols) {
    if (sym.signature && supertypes.some(st => sym.signature!.includes(st))) {
      return true;
    }
    if (sym.children && hasSupertypeMatch(sym.children, supertypes)) {
      return true;
    }
  }
  return false;
}
