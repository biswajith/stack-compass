import * as fs from 'fs';
import * as path from 'path';
import { DetectedFramework, MonorepoModule, ProjectStack, MonorepoConfig } from '../types/index.js';
import { parseGradle } from './gradle-parser.js';
import { detectGraphQLFiles, detectInfraFrameworks } from './infra-detector.js';
import { parsePackageJson } from './package-json-parser.js';
import { parsePomXml } from './pom-parser.js';
import { parseSbt } from './sbt-parser.js';

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
      frameworks.push(...parsePackageJson(path.join(dir, 'package.json')));

    if (fs.existsSync(path.join(dir, 'pom.xml')))
      frameworks.push(...parsePomXml(path.join(dir, 'pom.xml')));

    const gradleFile = ['build.gradle.kts', 'build.gradle'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
    if (gradleFile) frameworks.push(...parseGradle(gradleFile));

    if (fs.existsSync(path.join(dir, 'build.sbt')))
      frameworks.push(...parseSbt(path.join(dir, 'build.sbt')));

    frameworks.push(...detectInfraFrameworks(dir));

    detectGraphQLFiles(dir, frameworks);

    return this.dedup(frameworks);
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
    const summary: ProjectStack['summary'] = { frontend: [], backend: [], databases: [], containers: [], orchestration: [], apis: [], build: [], testing: [], other: [] };
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
          f.category === 'testing' ? summary.testing :
          summary.other;
        if (!bucket.includes(entry)) bucket.push(entry);
      }
    }
    return summary;
  }
}
