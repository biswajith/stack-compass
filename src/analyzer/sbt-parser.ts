import * as fs from 'fs';
import { DetectedFramework, FrameworkCategory } from '../types/index.js';

export function parseSbt(filePath: string): DetectedFramework[] {
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
