import { InternalDepsDetector, DEFAULT_PATTERNS } from '../../src/internal-deps/index.js';
import { assert } from '../helpers.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export async function testInternalDeps() {
  console.log('\n--- Unit: Internal Dependencies Detector ---');

  testMavenInternalDeps();
  testMavenMultilinePom();
  testMavenReversedTagOrder();
  testMavenDependencyManagementExcluded();
  testNpmInternalDeps();
  testSbtInternalDeps();
  testGradleInternalDeps();
  testMixedMonorepo();
  testNoPatterns();
  testSourcePathResolution();
}

function testMavenInternalDeps() {
  console.log('  Maven internal deps...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mvn-'));

  fs.writeFileSync(path.join(tmpDir, 'pom.xml'), `
<project>
  <dependencies>
    <dependency>
      <groupId>com.company.shared</groupId>
      <artifactId>auth-lib</artifactId>
      <version>2.1.0</version>
    </dependency>
    <dependency>
      <groupId>com.company.events</groupId>
      <artifactId>event-bus</artifactId>
      <version>1.0.0</version>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter</artifactId>
      <version>3.2.0</version>
    </dependency>
  </dependencies>
</project>`);

  const detector = new InternalDepsDetector({
    ...DEFAULT_PATTERNS,
    mavenGroupPrefixes: ['com.company'],
  });

  const deps = detector.detect(tmpDir);
  assert('maven: found 2 internal deps', deps.length === 2, `got ${deps.length}`);
  assert('maven: auth-lib detected', deps.some(d => d.artifact.includes('auth-lib')));
  assert('maven: event-bus detected', deps.some(d => d.artifact.includes('event-bus')));
  assert('maven: spring-boot NOT internal', !deps.some(d => d.artifact.includes('spring-boot')));

  const authDep = deps.find(d => d.artifact.includes('auth-lib'));
  assert('maven: version captured', authDep?.version === '2.1.0');
  assert('maven: ecosystem is maven', authDep?.ecosystem === 'maven');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testMavenMultilinePom() {
  console.log('  Maven multiline pom.xml...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mvn-ml-'));

  fs.writeFileSync(path.join(tmpDir, 'pom.xml'), `
<project>
  <dependencies>
    <dependency>
      <groupId>
        com.company.shared
      </groupId>
      <artifactId>
        auth-lib
      </artifactId>
      <version>
        2.1.0
      </version>
    </dependency>
  </dependencies>
</project>`);

  const detector = new InternalDepsDetector({
    ...DEFAULT_PATTERNS,
    mavenGroupPrefixes: ['com.company'],
  });

  const deps = detector.detect(tmpDir);
  assert('maven-multiline: found 1 dep', deps.length === 1, `got ${deps.length}`);
  assert('maven-multiline: auth-lib detected', deps.some(d => d.artifact.includes('auth-lib')));
  const dep = deps[0];
  assert('maven-multiline: version trimmed', dep?.version === '2.1.0');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testMavenReversedTagOrder() {
  console.log('  Maven reversed tag order...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mvn-rev-'));

  fs.writeFileSync(path.join(tmpDir, 'pom.xml'), `
<project>
  <dependencies>
    <dependency>
      <artifactId>event-bus</artifactId>
      <groupId>com.company.events</groupId>
      <version>1.0.0</version>
    </dependency>
    <dependency>
      <version>3.0.0</version>
      <artifactId>config-lib</artifactId>
      <groupId>com.company.infra</groupId>
    </dependency>
  </dependencies>
</project>`);

  const detector = new InternalDepsDetector({
    ...DEFAULT_PATTERNS,
    mavenGroupPrefixes: ['com.company'],
  });

  const deps = detector.detect(tmpDir);
  assert('maven-reversed: found 2 deps', deps.length === 2, `got ${deps.length}`);
  assert('maven-reversed: event-bus detected', deps.some(d => d.artifact.includes('event-bus')));
  assert('maven-reversed: config-lib detected', deps.some(d => d.artifact.includes('config-lib')));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testMavenDependencyManagementExcluded() {
  console.log('  Maven dependencyManagement excluded...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mvn-dm-'));

  fs.writeFileSync(path.join(tmpDir, 'pom.xml'), `
<project>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.company.shared</groupId>
        <artifactId>managed-only-lib</artifactId>
        <version>3.0.0</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.company.shared</groupId>
      <artifactId>auth-lib</artifactId>
      <version>2.1.0</version>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter</artifactId>
      <version>3.2.0</version>
    </dependency>
  </dependencies>
</project>`);

  const detector = new InternalDepsDetector({
    ...DEFAULT_PATTERNS,
    mavenGroupPrefixes: ['com.company'],
  });

  const deps = detector.detect(tmpDir);
  assert('maven-dm: found 1 real dep (not managed)', deps.length === 1, `got ${deps.length}`);
  assert('maven-dm: auth-lib detected', deps.some(d => d.artifact.includes('auth-lib')));
  assert('maven-dm: managed-only-lib excluded', !deps.some(d => d.artifact.includes('managed-only-lib')));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testNpmInternalDeps() {
  console.log('  npm internal deps...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-npm-'));

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'frontend',
    dependencies: {
      '@company/ui-kit': '^3.0.0',
      '@company/shared-utils': '~1.5.0',
      'react': '^18.2.0',
      'lodash': '^4.17.21',
    },
    devDependencies: {
      '@company/test-helpers': '2.0.0',
    },
  }));

  const detector = new InternalDepsDetector({
    ...DEFAULT_PATTERNS,
    npmScopes: ['@company'],
  });

  const deps = detector.detect(tmpDir);
  assert('npm: found 3 internal deps', deps.length === 3, `got ${deps.length}`);
  assert('npm: ui-kit detected', deps.some(d => d.artifact === '@company/ui-kit'));
  assert('npm: shared-utils detected', deps.some(d => d.artifact === '@company/shared-utils'));
  assert('npm: test-helpers detected', deps.some(d => d.artifact === '@company/test-helpers'));
  assert('npm: react NOT internal', !deps.some(d => d.artifact === 'react'));

  const uiKit = deps.find(d => d.artifact === '@company/ui-kit');
  assert('npm: version cleaned', uiKit?.version === '3.0.0');
  assert('npm: ecosystem is npm', uiKit?.ecosystem === 'npm');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testSbtInternalDeps() {
  console.log('  SBT internal deps...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-sbt-'));

  fs.writeFileSync(path.join(tmpDir, 'build.sbt'), `
name := "my-service"

libraryDependencies ++= Seq(
  "com.company" %% "shared-models" % "1.0.0",
  "com.company.platform" %% "event-store" % "2.3.0",
  "com.typesafe.akka" %% "akka-actor" % "2.6.20"
)
`);

  const detector = new InternalDepsDetector({
    ...DEFAULT_PATTERNS,
    sbtOrgPrefixes: ['com.company'],
  });

  const deps = detector.detect(tmpDir);
  assert('sbt: found 2 internal deps', deps.length === 2, `got ${deps.length}`);
  assert('sbt: shared-models detected', deps.some(d => d.artifact.includes('shared-models')));
  assert('sbt: event-store detected', deps.some(d => d.artifact.includes('event-store')));
  assert('sbt: akka NOT internal', !deps.some(d => d.artifact.includes('akka')));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testGradleInternalDeps() {
  console.log('  Gradle internal deps...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-gradle-'));

  fs.writeFileSync(path.join(tmpDir, 'build.gradle'), `
dependencies {
    implementation 'com.company.core:data-access:1.0.0'
    implementation 'com.company.shared:common-utils:2.0.0'
    implementation 'org.springframework:spring-web:6.0.0'
    testImplementation 'com.company.testing:test-utils:1.0.0'
}
`);

  const detector = new InternalDepsDetector({
    ...DEFAULT_PATTERNS,
    mavenGroupPrefixes: ['com.company'],
  });

  const deps = detector.detect(tmpDir);
  assert('gradle: found 3 internal deps', deps.length === 3, `got ${deps.length}`);
  assert('gradle: data-access detected', deps.some(d => d.artifact.includes('data-access')));
  assert('gradle: common-utils detected', deps.some(d => d.artifact.includes('common-utils')));
  assert('gradle: test-utils detected', deps.some(d => d.artifact.includes('test-utils')));
  assert('gradle: spring-web NOT internal', !deps.some(d => d.artifact.includes('spring-web')));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testMixedMonorepo() {
  console.log('  Mixed monorepo...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mixed-'));

  fs.mkdirSync(path.join(tmpDir, 'api'));
  fs.writeFileSync(path.join(tmpDir, 'api', 'pom.xml'), `
<project>
  <dependencies>
    <dependency>
      <groupId>com.acme.shared</groupId>
      <artifactId>models</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`);

  fs.mkdirSync(path.join(tmpDir, 'frontend'));
  fs.writeFileSync(path.join(tmpDir, 'frontend', 'package.json'), JSON.stringify({
    dependencies: { '@acme/design-system': '^2.0.0' },
  }));

  const detector = new InternalDepsDetector({
    ...DEFAULT_PATTERNS,
    mavenGroupPrefixes: ['com.acme'],
    npmScopes: ['@acme'],
  });

  const deps = detector.detect(tmpDir);
  assert('mixed: found 2 deps across ecosystems', deps.length === 2, `got ${deps.length}`);
  assert('mixed: maven dep found', deps.some(d => d.ecosystem === 'maven'));
  assert('mixed: npm dep found', deps.some(d => d.ecosystem === 'npm'));

  const mavenDep = deps.find(d => d.ecosystem === 'maven');
  assert('mixed: maven declared in api', mavenDep?.declaredIn === 'api');

  const npmDep = deps.find(d => d.ecosystem === 'npm');
  assert('mixed: npm declared in frontend', npmDep?.declaredIn === 'frontend');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testNoPatterns() {
  console.log('  No patterns configured...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-none-'));

  fs.writeFileSync(path.join(tmpDir, 'pom.xml'), `
<project>
  <dependencies>
    <dependency>
      <groupId>com.company</groupId>
      <artifactId>some-lib</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`);

  const detector = new InternalDepsDetector(DEFAULT_PATTERNS);
  const deps = detector.detect(tmpDir);
  assert('no patterns: returns empty', deps.length === 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testSourcePathResolution() {
  console.log('  Source path resolution...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-resolve-'));

  fs.mkdirSync(path.join(tmpDir, 'auth-lib'));
  fs.writeFileSync(path.join(tmpDir, 'auth-lib', 'pom.xml'), '<project></project>');

  fs.mkdirSync(path.join(tmpDir, 'api'));
  fs.writeFileSync(path.join(tmpDir, 'api', 'pom.xml'), `
<project>
  <dependencies>
    <dependency>
      <groupId>com.company</groupId>
      <artifactId>auth-lib</artifactId>
      <version>1.0.0</version>
    </dependency>
    <dependency>
      <groupId>com.company</groupId>
      <artifactId>missing-lib</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`);

  const detector = new InternalDepsDetector({
    ...DEFAULT_PATTERNS,
    mavenGroupPrefixes: ['com.company'],
  });

  const deps = detector.detect(tmpDir);
  const resolved = detector.resolveSourcePaths(tmpDir, deps);

  const authDep = resolved.find(d => d.artifact.includes('auth-lib'));
  assert('resolve: auth-lib has sourcePath', !!authDep?.sourcePath);
  assert('resolve: auth-lib points to correct dir', authDep?.sourcePath?.endsWith('auth-lib') ?? false);

  const missingDep = resolved.find(d => d.artifact.includes('missing-lib'));
  assert('resolve: missing-lib has no sourcePath', !missingDep?.sourcePath);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}
