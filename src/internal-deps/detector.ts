import * as fs from 'fs';
import * as path from 'path';
import type { InternalDependency, InternalPatternConfig } from './types.js';

export class InternalDepsDetector {
  private patterns: InternalPatternConfig;
  readonly warnings: string[] = [];

  constructor(patterns: InternalPatternConfig) {
    this.patterns = patterns;
  }

  setPatterns(patterns: InternalPatternConfig): void {
    this.patterns = patterns;
  }

  /**
   * Scans a project directory for internal dependencies.
   * Checks pom.xml, package.json, build.sbt in the directory and subdirectories.
   */
  detect(projectRoot: string): InternalDependency[] {
    this.warnings.length = 0;
    let realRoot: string;
    try { realRoot = fs.realpathSync(projectRoot); } catch { realRoot = projectRoot; }
    const deps: InternalDependency[] = [];
    this.scanDir(realRoot, realRoot, deps, 0);
    return this.dedup(deps);
  }

  private maxDepth = 3;

  setMaxDepth(depth: number): void {
    this.maxDepth = depth;
  }

  private scanDir(dir: string, projectRoot: string, deps: InternalDependency[], depth: number): void {
    if (depth > this.maxDepth) return;
    const skip = new Set(['node_modules', 'target', 'build', 'dist', '.git', '.gradle']);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(projectRoot, dir);
          if (entry.name === 'pom.xml') deps.push(...this.parsePomInternalDeps(full, rel));
          if (entry.name === 'package.json') deps.push(...this.parsePackageJsonInternalDeps(full, rel));
          if (entry.name === 'build.sbt') deps.push(...this.parseSbtInternalDeps(full, rel));
          if (entry.name === 'build.gradle' || entry.name === 'build.gradle.kts') deps.push(...this.parseGradleInternalDeps(full, rel));
        }
        if (entry.isDirectory() && !skip.has(entry.name) && !entry.name.startsWith('.')) {
          const childPath = path.join(dir, entry.name);
          try {
            const realChild = fs.realpathSync(childPath);
            const rel = path.relative(projectRoot, realChild);
            if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
          } catch { continue; }
          this.scanDir(childPath, projectRoot, deps, depth + 1);
        }
      }
    } catch (err) {
      this.warnings.push(`Could not read directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Extracts internal deps from a pom.xml by matching <dependency> blocks.
   * Handles multiline tags and any tag ordering within each block.
   * Strips <dependencyManagement> sections first to avoid false positives
   * from version-only declarations.
   * Limitation: if a block contains multiple <version> elements, the first is used.
   */
  private parsePomInternalDeps(pomPath: string, module: string): InternalDependency[] {
    const deps: InternalDependency[] = [];
    if (this.patterns.mavenGroupPrefixes.length === 0) return deps;

    try {
      const raw = fs.readFileSync(pomPath, 'utf-8');
      const content = raw.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');
      const depBlockRegex = /<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g;
      let block: RegExpExecArray | null;
      while ((block = depBlockRegex.exec(content)) !== null) {
        const body = block[1];
        const groupId = body.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/)?.[1];
        const artifactId = body.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1];
        const version = body.match(/<version>\s*([^<]+?)\s*<\/version>/)?.[1];
        if (groupId && artifactId && this.isInternalMaven(groupId)) {
          deps.push({
            artifact: `${groupId}:${artifactId}`,
            version: version?.startsWith('$') ? undefined : version,
            declaredIn: module || 'root',
            ecosystem: 'maven',
          });
        }
      }
    } catch { /* */ }
    return deps;
  }

  private parsePackageJsonInternalDeps(pkgPath: string, module: string): InternalDependency[] {
    const deps: InternalDependency[] = [];
    if (this.patterns.npmScopes.length === 0) return deps;

    try {
      const content = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...content.dependencies, ...content.devDependencies };
      for (const [name, version] of Object.entries(allDeps)) {
        if (this.isInternalNpm(name)) {
          deps.push({
            artifact: name,
            version: typeof version === 'string' ? version.replace(/^[\^~]/, '') : undefined,
            declaredIn: module || 'root',
            ecosystem: 'npm',
          });
        }
      }
    } catch { /* */ }
    return deps;
  }

  private parseSbtInternalDeps(sbtPath: string, module: string): InternalDependency[] {
    const deps: InternalDependency[] = [];
    if (this.patterns.sbtOrgPrefixes.length === 0) return deps;

    try {
      const content = fs.readFileSync(sbtPath, 'utf-8');
      const depRegex = /"([^"]+)"\s*%%?\s*"([^"]+)"\s*%\s*"([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = depRegex.exec(content)) !== null) {
        const [, org, artifact, version] = match;
        if (this.isInternalSbt(org)) {
          deps.push({
            artifact: `${org}:${artifact}`,
            version,
            declaredIn: module || 'root',
            ecosystem: 'sbt',
          });
        }
      }
    } catch { /* */ }
    return deps;
  }

  /**
   * Extracts internal deps from build.gradle / build.gradle.kts.
   * Matches standard `implementation 'group:artifact:version'` notation.
   * Limitation: Kotlin DSL platform(), version catalogs, and non-string
   * dependency declarations are not detected.
   */
  private parseGradleInternalDeps(gradlePath: string, module: string): InternalDependency[] {
    const deps: InternalDependency[] = [];
    if (this.patterns.mavenGroupPrefixes.length === 0) return deps;

    try {
      const content = fs.readFileSync(gradlePath, 'utf-8');
      // implementation 'group:artifact:version' or implementation("group:artifact:version")
      const depRegex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?['"]([^'"]+)['"]\)?/g;
      let match: RegExpExecArray | null;
      while ((match = depRegex.exec(content)) !== null) {
        const parts = match[1].split(':');
        if (parts.length >= 2) {
          const [groupId, artifactId, version] = parts;
          if (this.isInternalMaven(groupId)) {
            deps.push({
              artifact: `${groupId}:${artifactId}`,
              version,
              declaredIn: module || 'root',
              ecosystem: 'gradle',
            });
          }
        }
      }
    } catch { /* */ }
    return deps;
  }

  private isInternalMaven(groupId: string): boolean {
    return this.patterns.mavenGroupPrefixes.some(p => groupId.startsWith(p)) ||
      this.matchesCustom(groupId);
  }

  private isInternalNpm(name: string): boolean {
    return this.patterns.npmScopes.some(s => name.startsWith(s)) ||
      this.matchesCustom(name);
  }

  private isInternalSbt(org: string): boolean {
    return this.patterns.sbtOrgPrefixes.some(p => org.startsWith(p)) ||
      this.matchesCustom(org);
  }

  private matchesCustom(value: string): boolean {
    if (value.length > 500) return false;
    return this.patterns.customPatterns.some(p => {
      if (p.length > 200) return false;
      try { return new RegExp(p).test(value); } catch { return false; }
    });
  }

  /**
   * Given detected internal deps, tries to find their source paths
   * within the monorepo by matching artifact names to directory names.
   */
  resolveSourcePaths(projectRoot: string, deps: InternalDependency[]): InternalDependency[] {
    const dirMap = this.buildDirMap(projectRoot);
    return deps.map(dep => {
      const artifactName = dep.artifact.split(':').pop() ?? dep.artifact.split('/').pop() ?? dep.artifact;
      const sourcePath = dirMap.get(artifactName) ?? dirMap.get(artifactName.replace(/-/g, ''));
      return sourcePath ? { ...dep, sourcePath } : dep;
    });
  }

  private buildDirMap(root: string, depth = 0): Map<string, string> {
    const map = new Map<string, string>();
    if (depth > this.maxDepth) return map;
    const skip = new Set(['node_modules', 'target', 'build', 'dist', '.git']);

    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || skip.has(entry.name) || entry.name.startsWith('.')) continue;
        const full = path.join(root, entry.name);
        const hasMarker = ['pom.xml', 'package.json', 'build.sbt', 'build.gradle', 'build.gradle.kts']
          .some(m => fs.existsSync(path.join(full, m)));
        if (hasMarker) {
          if (!map.has(entry.name)) map.set(entry.name, full);
          const normalized = entry.name.replace(/-/g, '');
          if (!map.has(normalized)) map.set(normalized, full);
        }
        const sub = this.buildDirMap(full, depth + 1);
        for (const [k, v] of sub) {
          if (!map.has(k)) map.set(k, v);
        }
      }
    } catch { /* */ }
    return map;
  }

  private dedup(deps: InternalDependency[]): InternalDependency[] {
    const seen = new Map<string, InternalDependency>();
    for (const dep of deps) {
      const key = `${dep.artifact}@${dep.declaredIn}`;
      if (!seen.has(key)) seen.set(key, dep);
    }
    return Array.from(seen.values());
  }
}
