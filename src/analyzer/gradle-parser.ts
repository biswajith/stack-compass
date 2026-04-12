import * as fs from 'fs';
import * as path from 'path';
import { DetectedFramework, FrameworkCategory } from '../types/index.js';
import { cleanVersion } from './helpers.js';

export function parseGradle(filePath: string): DetectedFramework[] {
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
        if (vMatch) version = cleanVersion(vMatch[1]);
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
