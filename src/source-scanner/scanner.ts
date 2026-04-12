import * as fs from 'fs';
import * as path from 'path';
import { parseSource, detectLanguage, initParser } from './parser.js';
import { extractJavaSymbols } from './java-extractor.js';
import { extractTypeScriptSymbols } from './typescript-extractor.js';
import { extractScalaSymbols } from './scala-extractor.js';
import { extractGraphQLSymbols } from './graphql-extractor.js';
import { isTestSource, detectTestFrameworks } from './test-detector.js';
import type { TestMarkers } from './test-detector.js';
import type { ScannedFile, ScannedModule, ModuleSummary, ExtractedSymbol, SupportedLanguage, RestEndpoint } from './types.js';

/**
 * Directories skipped entirely during file discovery.
 * Test directories are skipped at the filesystem level for performance.
 * Files in non-test directories are still filtered by content-based test
 * detection (isTestSource) which checks imports, annotations, and supertypes.
 */
const SKIP_DIRS = new Set([
  'node_modules', 'target', 'build', 'dist', '.git', '.gradle', '.idea',
  '.settings', 'bin', 'out', '__pycache__', '.next', '.nuxt', 'coverage',
  'test', 'tests', '__tests__', 'spec', 'specs',
  'e2e', 'integration-test', 'integration-tests',
  'test-fixtures', 'testFixtures', 'fixtures',
]);

const MAX_FILE_SIZE = 500_000; // 500KB
const MAX_FILES_PER_MODULE = 2_000;

export class SourceScanner {
  private initialized = false;
  readonly warnings: string[] = [];

  async init(): Promise<void> {
    if (this.initialized) return;
    await initParser();
    this.initialized = true;
  }

  async scanModule(modulePath: string, moduleName: string): Promise<ScannedModule> {
    await this.init();
    this.warnings.length = 0;

    let resolvedPath: string;
    try { resolvedPath = fs.realpathSync(modulePath); } catch { resolvedPath = modulePath; }

    const testMarkers = detectTestFrameworks(resolvedPath);
    if (testMarkers.detectedFrameworks.length > 0) {
      this.warnings.push(`Test frameworks detected from build file: ${testMarkers.detectedFrameworks.join(', ')}`);
    }

    const files = this.findSourceFiles(resolvedPath);
    if (files.length > MAX_FILES_PER_MODULE) {
      this.warnings.push(`Module ${moduleName}: ${files.length} files found, capped to ${MAX_FILES_PER_MODULE}`);
      files.length = MAX_FILES_PER_MODULE;
    }
    const scannedFiles: ScannedFile[] = [];

    let testFilesSkipped = 0;
    for (const filePath of files) {
      try {
        const scanned = await this.scanFile(filePath);
        if (scanned && scanned.symbols.length > 0) {
          if (isTestSource(scanned, testMarkers)) {
            testFilesSkipped++;
            continue;
          }
          scannedFiles.push(scanned);
        }
      } catch (err) {
        this.warnings.push(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (testFilesSkipped > 0) {
      this.warnings.push(`Skipped ${testFilesSkipped} test file(s) detected by imports/annotations`);
    }

    const detectedLang = this.inferLanguage(scannedFiles);

    return {
      name: moduleName,
      path: modulePath,
      language: detectedLang,
      files: scannedFiles,
      summary: this.buildSummary(scannedFiles),
    };
  }

  async scanFile(filePath: string): Promise<ScannedFile | null> {
    const lang = detectLanguage(filePath);
    if (!lang) return null;

    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;

    const source = fs.readFileSync(filePath, 'utf-8');
    if (!source.trim()) return null;

    if (lang === 'graphql') {
      const { symbols } = extractGraphQLSymbols(source);
      return { filePath, language: lang, symbols };
    }

    await this.init();
    const tree = await parseSource(source, lang);

    switch (lang) {
      case 'java': {
        const result = extractJavaSymbols(tree, source);
        return {
          filePath,
          language: lang,
          symbols: result.symbols,
          packageName: result.packageName,
          imports: result.imports,
        };
      }
      case 'typescript':
      case 'tsx':
      case 'javascript': {
        const result = extractTypeScriptSymbols(tree, source);
        return {
          filePath,
          language: lang,
          symbols: result.symbols,
          imports: result.imports,
        };
      }
      case 'scala': {
        const result = extractScalaSymbols(tree, source);
        return {
          filePath,
          language: lang,
          symbols: result.symbols,
          packageName: result.packageName,
          imports: result.imports,
        };
      }
      default:
        return null;
    }
  }

  private findSourceFiles(dir: string, depth = 0, rootDir?: string): string[] {
    if (depth > 8) return [];
    const root = rootDir ?? dir;
    const results: string[] = [];
    const exts = new Set(['.java', '.ts', '.tsx', '.js', '.jsx', '.scala', '.sc', '.graphql', '.gql']);

    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          const childPath = path.join(dir, entry.name);
          try {
            const realChild = fs.realpathSync(childPath);
            const rel = path.relative(root, realChild);
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
              this.warnings.push(`Symlink escape skipped: ${childPath} → ${realChild}`);
              continue;
            }
          } catch { /* non-resolvable, skip silently */ continue; }
          results.push(...this.findSourceFiles(childPath, depth + 1, root));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (exts.has(ext)) results.push(path.join(dir, entry.name));
        }
      }
    } catch (err) {
      this.warnings.push(`Cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return results;
  }

  private inferLanguage(files: ScannedFile[]): string {
    const counts: Record<string, number> = {};
    for (const f of files) {
      counts[f.language] = (counts[f.language] ?? 0) + 1;
    }
    let maxLang = 'unknown';
    let maxCount = 0;
    for (const [lang, count] of Object.entries(counts)) {
      if (count > maxCount) { maxLang = lang; maxCount = count; }
    }
    return maxLang;
  }

  private buildSummary(files: ScannedFile[]): ModuleSummary {
    const publicClasses: string[] = [];
    const publicInterfaces: string[] = [];
    let publicMethods = 0;
    const annotationSet = new Set<string>();
    const restEndpoints: RestEndpoint[] = [];
    const entities: string[] = [];
    const events: string[] = [];

    for (const file of files) {
      for (const sym of file.symbols) {
        this.collectSummaryFromSymbol(sym, file.filePath, publicClasses, publicInterfaces, annotationSet, restEndpoints, entities, events);
        publicMethods += this.countPublicMethods(sym);
      }
    }

    return {
      totalFiles: files.length,
      totalSymbols: files.reduce((sum, f) => sum + this.countSymbols(f.symbols), 0),
      publicClasses,
      publicInterfaces,
      publicMethods,
      annotations: Array.from(annotationSet),
      restEndpoints,
      entities,
      events,
    };
  }

  private collectSummaryFromSymbol(
    sym: ExtractedSymbol,
    filePath: string,
    publicClasses: string[],
    publicInterfaces: string[],
    annotationSet: Set<string>,
    restEndpoints: RestEndpoint[],
    entities: string[],
    events: string[],
  ): void {
    if (sym.visibility !== 'public' && sym.visibility !== 'default') return;

    if (sym.kind === 'class' || sym.kind === 'case-class') publicClasses.push(sym.name);
    if (sym.kind === 'interface' || sym.kind === 'trait') publicInterfaces.push(sym.name);

    if (sym.annotations) {
      for (const ann of sym.annotations) {
        const stripped = ann.replace(/\(.*\)/, '');
        annotationSet.add(stripped);
        if (stripped === '@Entity' || stripped === '@Document') entities.push(sym.name);
        if (stripped.includes('Event') || stripped.includes('Listener')) events.push(sym.name);
      }
    }

    if (sym.children) {
      for (const child of sym.children) {
        if (child.annotations) {
          for (const ann of child.annotations) {
            annotationSet.add(ann.replace(/\(.*\)/, ''));
          }
        }
      }
      const javaEndpoints = sym.children
        .filter(c => c.annotations?.some(a =>
          a.includes('Mapping') || a.includes('RequestMapping')
        ));
      for (const ep of javaEndpoints) {
        const mapping = ep.annotations?.find(a => a.includes('Mapping'));
        if (mapping) {
          const method = mapping.includes('Get') ? 'GET' : mapping.includes('Post') ? 'POST' :
            mapping.includes('Put') ? 'PUT' : mapping.includes('Delete') ? 'DELETE' : 'GET';
          const pathMatch = mapping.match(/["']([^"']+)["']/);
          restEndpoints.push({
            method,
            path: pathMatch?.[1] ?? '/',
            handler: `${sym.name}.${ep.name}`,
            file: filePath,
          });
        }
      }
    }
  }

  private countPublicMethods(sym: ExtractedSymbol): number {
    let count = 0;
    if (sym.kind === 'method' && (sym.visibility === 'public' || sym.visibility === 'default')) count++;
    if (sym.children) {
      for (const child of sym.children) count += this.countPublicMethods(child);
    }
    return count;
  }

  private countSymbols(symbols: ExtractedSymbol[]): number {
    let count = 0;
    for (const sym of symbols) {
      count++;
      if (sym.children) count += this.countSymbols(sym.children);
    }
    return count;
  }
}
