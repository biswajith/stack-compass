import * as fs from 'fs';
import * as path from 'path';
import { DetectedFramework, MonorepoModule, ProjectStack, MonorepoConfig, FrameworkCategory } from './types.js';

export class ProjectAnalyzer {
  private rootPath: string;
  private config: MonorepoConfig | null = null;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  setConfig(config: MonorepoConfig) {
    this.config = config;
  }

  async analyze(): Promise<ProjectStack> {
    const modules: MonorepoModule[] = [];

    if (this.config) {
      for (const [name, moduleConfig] of Object.entries(this.config.structure)) {
        const modulePath = path.join(this.rootPath, moduleConfig.path);
        if (fs.existsSync(modulePath)) {
          const frameworks = await this.detectFrameworks(modulePath);
          modules.push({ name, path: moduleConfig.path, type: moduleConfig.type, frameworks });
        }
      }
    } else {
      const rootFrameworks = await this.detectFrameworks(this.rootPath);
      if (rootFrameworks.length > 0) {
        modules.push({ name: 'root', path: '.', type: this.inferModuleType(rootFrameworks), frameworks: rootFrameworks });
      }

      for (const subdir of this.findProjectDirectories(this.rootPath)) {
        const frameworks = await this.detectFrameworks(subdir);
        if (frameworks.length > 0) {
          const relativePath = path.relative(this.rootPath, subdir);
          modules.push({ name: path.basename(subdir), path: relativePath, type: this.inferModuleType(frameworks), frameworks });
        }
      }
    }

    return { rootPath: this.rootPath, modules, summary: this.buildSummary(modules) };
  }

  private findProjectDirectories(dir: string, depth = 0): string[] {
    if (depth > 2) return [];
    const results: string[] = [];
    const markers = ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt'];
    const skip = new Set(['.', '..', 'node_modules', 'target', 'build', 'dist', '.git', '.gradle', '.idea']);

    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || skip.has(entry.name)) continue;
        const subdir = path.join(dir, entry.name);
        if (markers.some(m => fs.existsSync(path.join(subdir, m)))) results.push(subdir);
        results.push(...this.findProjectDirectories(subdir, depth + 1));
      }
    } catch { /* permission errors */ }
    return results;
  }

  // ─── Detect all frameworks in a directory ─────────────────────────────

  private async detectFrameworks(dir: string): Promise<DetectedFramework[]> {
    const frameworks: DetectedFramework[] = [];

    if (fs.existsSync(path.join(dir, 'package.json')))
      frameworks.push(...this.parsePackageJson(path.join(dir, 'package.json')));

    if (fs.existsSync(path.join(dir, 'pom.xml')))
      frameworks.push(...this.parsePomXml(path.join(dir, 'pom.xml')));

    const gradleFile = ['build.gradle.kts', 'build.gradle'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
    if (gradleFile) frameworks.push(...this.parseGradle(gradleFile));

    if (fs.existsSync(path.join(dir, 'build.sbt')))
      frameworks.push(...this.parseSbt(path.join(dir, 'build.sbt')));

    if (fs.existsSync(path.join(dir, 'Dockerfile')))
      frameworks.push({ name: 'docker', category: 'container', source: 'Dockerfile', docKey: 'docker' });

    if (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some(f => fs.existsSync(path.join(dir, f))))
      frameworks.push({ name: 'docker-compose', category: 'container', source: 'docker-compose.yml', docKey: 'docker' });

    if (['k8s', 'kubernetes'].some(d => fs.existsSync(path.join(dir, d))))
      frameworks.push({ name: 'kubernetes', category: 'orchestration', source: 'k8s/', docKey: 'kubernetes' });

    if (fs.existsSync(path.join(dir, 'Chart.yaml')) || fs.existsSync(path.join(dir, 'helm')))
      frameworks.push({ name: 'helm', category: 'orchestration', source: 'helm/', docKey: 'helm' });

    this.detectGraphQLFiles(dir, frameworks);

    return this.dedup(frameworks);
  }

  // ─── package.json ─────────────────────────────────────────────────────

  private parsePackageJson(filePath: string): DetectedFramework[] {
    const frameworks: DetectedFramework[] = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const allDeps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

      const targets: Array<{ names: string[]; category: FrameworkCategory; docKey?: string }> = [
        { names: ['react', 'react-dom'], category: 'frontend' },
        { names: ['redux', '@reduxjs/toolkit'], category: 'frontend' },
        { names: ['vue'], category: 'frontend' },
        { names: ['next'], category: 'frontend' },
        { names: ['angular', '@angular/core'], category: 'frontend', docKey: 'angular' },
        { names: ['svelte'], category: 'frontend' },
        { names: ['graphql'], category: 'api' },
        { names: ['@apollo/client', 'apollo-client'], category: 'api', docKey: '@apollo/client' },
        { names: ['relay-runtime'], category: 'api' },
        { names: ['urql'], category: 'api' },
        { names: ['typescript'], category: 'build' },
        { names: ['vite'], category: 'build' },
        { names: ['webpack'], category: 'build' },
        { names: ['tailwindcss'], category: 'frontend' },
        { names: ['express'], category: 'backend' },
        { names: ['fastify'], category: 'backend' },
        { names: ['@nestjs/core'], category: 'backend', docKey: 'nestjs' },
        { names: ['jest'], category: 'testing' },
        { names: ['vitest'], category: 'testing' },
        { names: ['cypress'], category: 'testing' },
        { names: ['playwright', '@playwright/test'], category: 'testing', docKey: 'playwright' },
        { names: ['mongoose'], category: 'database' },
        { names: ['@prisma/client', 'prisma'], category: 'database', docKey: 'prisma' },
        { names: ['typeorm'], category: 'database' },
        { names: ['sequelize'], category: 'database' },
        { names: ['axios'], category: 'api' },
        { names: ['swr'], category: 'api' },
        { names: ['@tanstack/react-query'], category: 'api' },
      ];

      for (const t of targets) {
        for (const name of t.names) {
          if (allDeps[name]) {
            frameworks.push({
              name,
              version: this.cleanVersion(allDeps[name]),
              category: t.category,
              source: 'package.json',
              docKey: t.docKey ?? name,
            });
          }
        }
      }

      const yarnLockExists = fs.existsSync(path.join(path.dirname(filePath), 'yarn.lock'));
      const pmField = pkg.packageManager as string | undefined;
      let pmName = yarnLockExists ? 'yarn' : 'npm';
      let pmVersion: string | undefined;
      if (pmField) {
        const match = pmField.match(/^(\w+)@(.+)$/);
        if (match) { pmName = match[1]; pmVersion = match[2]; }
      }
      frameworks.push({ name: pmName, version: pmVersion, category: 'build', source: 'package.json', docKey: pmName });

    } catch { /* invalid JSON */ }
    return frameworks;
  }

  // ─── pom.xml ──────────────────────────────────────────────────────────

  private parsePomXml(filePath: string): DetectedFramework[] {
    const frameworks: DetectedFramework[] = [];
    try {
      const xml = fs.readFileSync(filePath, 'utf-8');

      frameworks.push({ name: 'maven', category: 'build', source: 'pom.xml', docKey: 'maven' });

      const props = this.extractMavenProperties(xml);

      const pomDeps: Array<{
        pattern: RegExp;
        name: string;
        category: FrameworkCategory;
        docKey: string;
        versionProperty?: string[];
        versionPattern?: RegExp;
      }> = [
        { pattern: /spring-boot/i, name: 'spring-boot', category: 'backend', docKey: 'spring-boot',
          versionProperty: ['spring-boot.version', 'spring.boot.version'],
          versionPattern: /spring-boot[^<]*?(\d+\.\d+\.\d+)/ },
        { pattern: /spring-data-jpa/i, name: 'spring-data-jpa', category: 'backend', docKey: 'spring-data-jpa' },
        { pattern: /spring-data-mongodb/i, name: 'spring-data-mongodb', category: 'database', docKey: 'spring-data-mongodb' },
        { pattern: /spring-security/i, name: 'spring-security', category: 'backend', docKey: 'spring-security',
          versionProperty: ['spring-security.version'] },
        { pattern: /hibernate-core|hibernate-entitymanager/i, name: 'hibernate', category: 'backend', docKey: 'hibernate',
          versionProperty: ['hibernate.version'],
          versionPattern: /hibernate[^<]*?(\d+\.\d+\.\d+)/ },
        { pattern: /graphql-java(?!-)/i, name: 'graphql-java', category: 'api', docKey: 'graphql-java' },
        { pattern: /dgs-framework|com\.netflix\.graphql\.dgs/i, name: 'netflix-dgs', category: 'api', docKey: 'netflix-dgs' },
        { pattern: /mysql-connector/i, name: 'mysql', category: 'database', docKey: 'mysql' },
        { pattern: /mongodb-driver|mongo-java-driver|spring-data-mongodb/i, name: 'mongodb', category: 'database', docKey: 'mongodb' },
        { pattern: /postgresql|org\.postgresql/i, name: 'postgresql', category: 'database', docKey: 'postgresql' },
        { pattern: /junit-jupiter|junit-bom/i, name: 'junit', category: 'testing', docKey: 'junit',
          versionProperty: ['junit-jupiter.version', 'junit.version'],
          versionPattern: /junit[^<]*?(\d+\.\d+\.\d+)/ },
        { pattern: /mockito/i, name: 'mockito', category: 'testing', docKey: 'mockito' },
        { pattern: /lombok/i, name: 'lombok', category: 'other', docKey: 'lombok' },
        { pattern: /spring-webflux/i, name: 'spring-webflux', category: 'backend', docKey: 'spring-framework' },
        { pattern: /jedis|lettuce|spring-data-redis/i, name: 'redis', category: 'database', docKey: 'redis' },
      ];

      for (const dep of pomDeps) {
        if (!dep.pattern.test(xml)) continue;

        let version: string | undefined;

        if (dep.versionProperty) {
          for (const prop of dep.versionProperty) {
            if (props[prop]) { version = props[prop]; break; }
          }
        }
        if (!version && dep.versionPattern) {
          const m = xml.match(dep.versionPattern);
          if (m) version = m[1];
        }
        if (!version) {
          version = this.extractVersionFromDependencyBlock(xml, dep.pattern);
        }

        // Spring Boot parent version — very common pattern
        if (dep.name === 'spring-boot' && !version) {
          const parentMatch = xml.match(/<parent>[\s\S]*?spring-boot-starter-parent[\s\S]*?<version>([^<]+)<\/version>/);
          if (parentMatch) version = this.cleanVersion(parentMatch[1]);
        }

        frameworks.push({ name: dep.name, version, category: dep.category, source: 'pom.xml', docKey: dep.docKey });
      }

      // Java version detection — affects which Spring/Hibernate is viable
      const javaVersion = props['java.version'] || props['maven.compiler.source'] || props['maven.compiler.target'];
      if (javaVersion) {
        frameworks.push({ name: 'java', version: javaVersion, category: 'build', source: 'pom.xml', docKey: 'java' });
      }

    } catch { /* read error */ }
    return frameworks;
  }

  private extractMavenProperties(xml: string): Record<string, string> {
    const props: Record<string, string> = {};
    const propsBlock = xml.match(/<properties>([\s\S]*?)<\/properties>/);
    if (propsBlock) {
      const propRegex = /<([a-zA-Z0-9._-]+)>([^<]+)<\/\1>/g;
      let m: RegExpExecArray | null;
      while ((m = propRegex.exec(propsBlock[1])) !== null) {
        props[m[1]] = m[2].trim();
      }
    }
    return props;
  }

  private extractVersionFromDependencyBlock(xml: string, artifactPattern: RegExp): string | undefined {
    const depBlocks = xml.match(/<dependency>[\s\S]*?<\/dependency>/g) || [];
    for (const block of depBlocks) {
      if (artifactPattern.test(block)) {
        const versionMatch = block.match(/<version>([^<$]+)<\/version>/);
        if (versionMatch) return this.cleanVersion(versionMatch[1]);
      }
    }
    return undefined;
  }

  // ─── build.gradle / build.gradle.kts ──────────────────────────────────

  private parseGradle(filePath: string): DetectedFramework[] {
    const frameworks: DetectedFramework[] = [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const source = path.basename(filePath);

      frameworks.push({ name: 'gradle', category: 'build', source, docKey: 'gradle' });

      // Gradle wrapper version
      const wrapperProps = path.join(path.dirname(filePath), 'gradle', 'wrapper', 'gradle-wrapper.properties');
      if (fs.existsSync(wrapperProps)) {
        const wrapperContent = fs.readFileSync(wrapperProps, 'utf-8');
        const gradleVersionMatch = wrapperContent.match(/gradle-(\d+\.\d+(?:\.\d+)?)/);
        if (gradleVersionMatch) {
          frameworks[frameworks.length - 1].version = gradleVersionMatch[1];
        }
      }

      const gradleDeps: Array<{
        pattern: RegExp;
        name: string;
        category: FrameworkCategory;
        docKey: string;
        versionPattern?: RegExp;
      }> = [
        { pattern: /org\.springframework\.boot|spring-boot/, name: 'spring-boot', category: 'backend', docKey: 'spring-boot',
          versionPattern: /org\.springframework\.boot['":\s]+version\s*(?:=\s*)?['"]?(\d+\.\d+\.\d+)/ },
        { pattern: /spring-data-jpa/, name: 'spring-data-jpa', category: 'backend', docKey: 'spring-data-jpa' },
        { pattern: /spring-data-mongodb/, name: 'spring-data-mongodb', category: 'database', docKey: 'spring-data-mongodb' },
        { pattern: /spring-security/, name: 'spring-security', category: 'backend', docKey: 'spring-security' },
        { pattern: /hibernate/, name: 'hibernate', category: 'backend', docKey: 'hibernate' },
        { pattern: /graphql-java(?!-)/, name: 'graphql-java', category: 'api', docKey: 'graphql-java' },
        { pattern: /com\.netflix.*dgs|dgs-framework/, name: 'netflix-dgs', category: 'api', docKey: 'netflix-dgs' },
        { pattern: /mysql/, name: 'mysql', category: 'database', docKey: 'mysql' },
        { pattern: /mongodb/, name: 'mongodb', category: 'database', docKey: 'mongodb' },
        { pattern: /org\.postgresql/, name: 'postgresql', category: 'database', docKey: 'postgresql' },
        { pattern: /junit-jupiter|junit-bom/, name: 'junit', category: 'testing', docKey: 'junit' },
        { pattern: /mockito/, name: 'mockito', category: 'testing', docKey: 'mockito' },
        { pattern: /lombok/, name: 'lombok', category: 'other', docKey: 'lombok' },
      ];

      for (const dep of gradleDeps) {
        if (!dep.pattern.test(content)) continue;
        let version: string | undefined;

        // Try version from plugin block or dependency string
        if (dep.versionPattern) {
          const m = content.match(dep.versionPattern);
          if (m) version = m[1];
        }
        if (!version) {
          // "group:artifact:version" pattern
          const vMatch = content.match(new RegExp(`['"].*${dep.pattern.source}.*?:(\\d+\\.\\d+\\.\\d+[^'"]*?)['"]`));
          if (vMatch) version = this.cleanVersion(vMatch[1]);
        }

        frameworks.push({ name: dep.name, version, category: dep.category, source, docKey: dep.docKey });
      }

      // Spring Boot plugin version
      const sbPluginVersion = content.match(/id\s*\(?['"]org\.springframework\.boot['"]\)?\s*version\s*['"](\d+\.\d+\.\d+)/);
      if (sbPluginVersion) {
        const existing = frameworks.find(f => f.name === 'spring-boot');
        if (existing && !existing.version) existing.version = sbPluginVersion[1];
      }

      // Java version
      const javaVersionMatch = content.match(/(?:sourceCompatibility|jvmTarget|java\.toolchain\.languageVersion)\s*(?:=|\.set\()\s*['"]?(?:JavaLanguageVersion\.of\()?(\d+)/);
      if (javaVersionMatch) {
        frameworks.push({ name: 'java', version: javaVersionMatch[1], category: 'build', source, docKey: 'java' });
      }

    } catch { /* read error */ }
    return frameworks;
  }

  // ─── build.sbt ────────────────────────────────────────────────────────

  private parseSbt(filePath: string): DetectedFramework[] {
    const frameworks: DetectedFramework[] = [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      frameworks.push({ name: 'sbt', category: 'build', source: 'build.sbt', docKey: 'sbt' });

      // Scala version
      const scalaVersion = content.match(/scalaVersion\s*:=\s*"(\d+\.\d+\.\d+)"/);
      frameworks.push({
        name: 'scala',
        version: scalaVersion?.[1],
        category: 'backend',
        source: 'build.sbt',
        docKey: 'scala',
      });

      const sbtDeps: Array<{ pattern: RegExp; name: string; category: FrameworkCategory; docKey: string }> = [
        { pattern: /akka/i, name: 'akka', category: 'backend', docKey: 'akka' },
        { pattern: /com\.typesafe\.play|playframework/i, name: 'play', category: 'backend', docKey: 'play' },
        { pattern: /sangria/i, name: 'sangria', category: 'api', docKey: 'sangria' },
        { pattern: /typelevel.*cats|cats-core/i, name: 'cats', category: 'backend', docKey: 'cats' },
        { pattern: /dev\.zio|zio-/i, name: 'zio', category: 'backend', docKey: 'zio' },
        { pattern: /reactivemongo|org\.mongodb/i, name: 'mongodb', category: 'database', docKey: 'mongodb' },
        { pattern: /slick|doobie|quill/i, name: 'slick', category: 'database', docKey: 'slick' },
      ];

      // Parse sbt libraryDependencies: "org" %% "artifact" % "version"
      const depPattern = /"([^"]+)"\s*%%?\s*"([^"]+)"\s*%\s*"([^"]+)"/g;
      let depMatch: RegExpExecArray | null;
      while ((depMatch = depPattern.exec(content)) !== null) {
        const [, org, artifact, version] = depMatch;
        const full = `${org}:${artifact}`;
        for (const dep of sbtDeps) {
          if (dep.pattern.test(full) || dep.pattern.test(artifact)) {
            frameworks.push({ name: dep.name, version, category: dep.category, source: 'build.sbt', docKey: dep.docKey });
          }
        }
      }

      // Catch deps that might not have matched the regex-based extraction
      for (const dep of sbtDeps) {
        if (dep.pattern.test(content) && !frameworks.some(f => f.docKey === dep.docKey)) {
          frameworks.push({ name: dep.name, category: dep.category, source: 'build.sbt', docKey: dep.docKey });
        }
      }

    } catch { /* read error */ }
    return frameworks;
  }

  // ─── GraphQL files ────────────────────────────────────────────────────

  private detectGraphQLFiles(dir: string, frameworks: DetectedFramework[]) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.graphql') || entry.name.endsWith('.gql'))) {
          if (!frameworks.some(f => f.docKey === 'graphql' || f.docKey === 'graphql-java' || f.docKey === '@apollo/client')) {
            frameworks.push({ name: 'graphql', category: 'api', source: entry.name, docKey: 'graphql' });
          }
          break;
        }
      }
    } catch { /* ignore */ }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private cleanVersion(raw: string): string {
    return raw.replace(/^[\^~>=<\s]+/, '').trim();
  }

  private inferModuleType(frameworks: DetectedFramework[]): MonorepoModule['type'] {
    const cats = new Set(frameworks.map(f => f.category));
    const names = new Set(frameworks.map(f => f.name));
    if (cats.has('frontend') || ['react', 'vue', 'angular', 'next', 'svelte'].some(n => names.has(n))) return 'frontend';
    if (cats.has('orchestration') || cats.has('container')) return 'infra';
    if (cats.has('backend')) return 'backend';
    return 'unknown';
  }

  private dedup(frameworks: DetectedFramework[]): DetectedFramework[] {
    const seen = new Map<string, DetectedFramework>();
    for (const f of frameworks) {
      const key = f.docKey ?? f.name;
      const existing = seen.get(key);
      if (!existing || (f.version && !existing.version)) seen.set(key, f);
    }
    return Array.from(seen.values());
  }

  private buildSummary(modules: MonorepoModule[]): ProjectStack['summary'] {
    const summary: ProjectStack['summary'] = { frontend: [], backend: [], databases: [], containers: [], orchestration: [], apis: [], build: [], testing: [] };
    for (const mod of modules) {
      for (const f of mod.frameworks) {
        const entry = f.version ? `${f.name}@${f.version}` : f.name;
        const bucket =
          f.category === 'frontend' ? summary.frontend :
          f.category === 'backend' ? summary.backend :
          f.category === 'database' ? summary.databases :
          f.category === 'container' ? summary.containers :
          f.category === 'orchestration' ? summary.orchestration :
          f.category === 'api' ? summary.apis :
          f.category === 'build' ? summary.build :
          f.category === 'testing' ? summary.testing : null;
        if (bucket && !bucket.includes(entry)) bucket.push(entry);
      }
    }
    return summary;
  }
}
