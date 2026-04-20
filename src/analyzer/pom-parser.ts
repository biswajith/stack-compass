import * as fs from 'fs';
import { DetectedFramework, FrameworkCategory } from '../types/index.js';
import { cleanVersion } from './helpers.js';

export function extractMavenProperties(xml: string): Record<string, string> {
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

export function extractVersionFromDependencyBlock(xml: string, artifactPattern: RegExp): string | undefined {
  const cleaned = xml.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');
  const depBlocks = cleaned.match(/<dependency>[\s\S]*?<\/dependency>/g) || [];
  for (const block of depBlocks) {
    if (artifactPattern.test(block)) {
      const versionMatch = block.match(/<version>([^<$]+)<\/version>/);
      if (versionMatch) return cleanVersion(versionMatch[1]);
    }
  }
  return undefined;
}

export function parsePomXml(filePath: string): DetectedFramework[] {
  const frameworks: DetectedFramework[] = [];
  try {
    const xml = fs.readFileSync(filePath, 'utf-8');

    frameworks.push({ name: 'maven', category: 'build', source: 'pom.xml', docKey: 'maven' });

    const props = extractMavenProperties(xml);

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
      { pattern: /com\.google\.adk|google-adk/i, name: 'google-adk', category: 'backend', docKey: 'google-adk' },
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
        version = extractVersionFromDependencyBlock(xml, dep.pattern);
      }

      // Spring Boot parent version — very common pattern
      if (dep.name === 'spring-boot' && !version) {
        const parentMatch = xml.match(/<parent>[\s\S]*?spring-boot-starter-parent[\s\S]*?<version>([^<]+)<\/version>/);
        if (parentMatch) version = cleanVersion(parentMatch[1]);
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
