import {
  FRAMEWORK_DOCS, FrameworkDocEntry, resolveFrameworkMeta,
  DocTreeIndex,
} from '../types/index.js';
import { readCache, writeCache, invalidateFrameworkCache } from '../cache/index.js';
import { parseMarkdownSections, toDocSections, buildSectionMap, ParsedSection } from '../tree-builder/index.js';
import { fetchText } from './url-fetcher.js';
import { htmlToMarkdown } from './html-converter.js';
import { fetchGitHubReadme } from './github-fetcher.js';
import { offlineFallback } from './offline-fallback.js';

/**
 * Returned by ensureDocs when the framework has no cached documentation
 * and no URL has been supplied yet. The MCP server turns this into a
 * prompt asking the LLM to call resolve-doc-url.
 */
export interface NeedsUrlResult {
  kind: 'needs-url';
  framework: string;
  version?: string;
  description: string;
}

export interface DocsReadyResult {
  kind: 'ready';
  sections: ParsedSection[];
}

export type EnsureDocsResult = NeedsUrlResult | DocsReadyResult;

export class DocFetcher {
  private memCache = new Map<string, { sections: ParsedSection[]; timestamp: number }>();
  private customFrameworks = new Map<string, FrameworkDocEntry>();
  /** URLs supplied at runtime by the LLM via resolve-doc-url */
  private resolvedUrls = new Map<string, string>();
  private memTTL = 1000 * 60 * 30; // 30 min in-memory

  // ─── Runtime framework management ─────────────────────────────────────

  addFramework(key: string, entry: FrameworkDocEntry): void {
    this.customFrameworks.set(key, entry);
    this.memCache.delete(key);
  }

  removeFramework(key: string): boolean {
    const existed = this.customFrameworks.delete(key);
    this.memCache.delete(key);
    this.resolvedUrls.delete(key);
    invalidateFrameworkCache(key);
    return existed;
  }

  listCustomFrameworks(): Map<string, FrameworkDocEntry> {
    return new Map(this.customFrameworks);
  }

  listAvailableFrameworks(): string[] {
    return Array.from(new Set([
      ...Object.keys(FRAMEWORK_DOCS),
      ...this.customFrameworks.keys(),
    ]));
  }

  getFrameworkDescription(key: string, version?: string): string | undefined {
    const entry = this.customFrameworks.get(key) ?? FRAMEWORK_DOCS[key];
    if (!entry) return undefined;
    return resolveFrameworkMeta(entry, version).description;
  }

  // ─── LLM-supplied URL management ──────────────────────────────────────

  /**
   * Called by the resolve-doc-url tool when the LLM provides a URL.
   * Triggers immediate fetch, conversion, and caching.
   */
  async supplyDocUrl(frameworkKey: string, url: string, version?: string): Promise<ParsedSection[]> {
    const cacheKey = `${frameworkKey}:${version ?? 'latest'}`;
    this.resolvedUrls.set(cacheKey, url);

    this.memCache.delete(cacheKey);
    invalidateFrameworkCache(frameworkKey);

    const markdown = await this.fetchAndConvert(frameworkKey, version, url);
    const sections = parseMarkdownSections(markdown);
    const versionTag = version ?? 'latest';

    writeCache(frameworkKey, versionTag, '_full', markdown);
    const sectionMap = buildSectionMap(sections);
    for (const [id, content] of sectionMap) {
      writeCache(frameworkKey, versionTag, id, content);
    }
    this.memCache.set(cacheKey, { sections, timestamp: Date.now() });

    return sections;
  }

  getResolvedUrl(frameworkKey: string, version?: string): string | undefined {
    return this.resolvedUrls.get(`${frameworkKey}:${version ?? 'latest'}`);
  }

  // ─── Core pipeline ────────────────────────────────────────────────────

  async ensureDocs(frameworkKey: string, version?: string): Promise<EnsureDocsResult> {
    const cacheKey = `${frameworkKey}:${version ?? 'latest'}`;
    const versionTag = version ?? 'latest';
    const entry = this.customFrameworks.get(frameworkKey) ?? FRAMEWORK_DOCS[frameworkKey];

    // 1. In-memory cache
    const mem = this.memCache.get(cacheKey);
    if (mem && Date.now() - mem.timestamp < this.memTTL) {
      return { kind: 'ready', sections: mem.sections };
    }

    // 2. Disk cache
    const diskMd = readCache(frameworkKey, versionTag, '_full');
    if (diskMd) {
      const sections = parseMarkdownSections(diskMd);
      this.memCache.set(cacheKey, { sections, timestamp: Date.now() });
      return { kind: 'ready', sections };
    }

    // 3. Try llms.txt if the framework publishes one
    const meta = entry ? resolveFrameworkMeta(entry, version) : undefined;
    if (meta?.llmsTxt) {
      const text = await fetchText(meta.llmsTxt);
      if (text.length > 1000) {
        const sections = parseMarkdownSections(text);
        writeCache(frameworkKey, versionTag, '_full', text);
        for (const [id, content] of buildSectionMap(sections)) {
          writeCache(frameworkKey, versionTag, id, content);
        }
        this.memCache.set(cacheKey, { sections, timestamp: Date.now() });
        return { kind: 'ready', sections };
      }
    }

    // 4. Try GitHub README as a lightweight fallback
    if (meta?.github) {
      const readme = await fetchGitHubReadme(meta.github);
      if (readme.length > 500) {
        const sections = parseMarkdownSections(readme);
        writeCache(frameworkKey, versionTag, '_full', readme);
        for (const [id, content] of buildSectionMap(sections)) {
          writeCache(frameworkKey, versionTag, id, content);
        }
        this.memCache.set(cacheKey, { sections, timestamp: Date.now() });
        return { kind: 'ready', sections };
      }
    }

    // 5. If a URL was previously supplied by the LLM, fetch it
    const resolvedUrl = this.resolvedUrls.get(cacheKey);
    if (resolvedUrl) {
      const sections = await this.supplyDocUrl(frameworkKey, resolvedUrl, version);
      return { kind: 'ready', sections };
    }

    // 6. No URL available — signal the LLM to provide one
    const description = meta?.description ?? `${frameworkKey} documentation`;
    return { kind: 'needs-url', framework: frameworkKey, version, description };
  }

  // ─── Phase 1: Tree index ──────────────────────────────────────────────

  async getDocIndex(frameworkKey: string, version?: string): Promise<DocTreeIndex | NeedsUrlResult | null> {
    const entry = this.customFrameworks.get(frameworkKey) ?? FRAMEWORK_DOCS[frameworkKey];
    if (!entry) return null;

    const result = await this.ensureDocs(frameworkKey, version);
    if (result.kind === 'needs-url') return result;

    const meta = resolveFrameworkMeta(entry, version);
    return {
      framework: frameworkKey,
      version,
      description: meta.description,
      docUrl: this.getResolvedUrl(frameworkKey, version),
      github: meta.github ? `https://github.com/${meta.github}` : undefined,
      sections: toDocSections(result.sections),
    };
  }

  // ─── Phase 2: Section content ─────────────────────────────────────────

  async getSectionContent(frameworkKey: string, sectionId: string, version?: string): Promise<string | NeedsUrlResult | null> {
    const versionTag = version ?? 'latest';

    const cached = readCache(frameworkKey, versionTag, sectionId);
    if (cached) return cached;

    const result = await this.ensureDocs(frameworkKey, version);
    if (result.kind === 'needs-url') return result;

    const sectionMap = buildSectionMap(result.sections);
    return sectionMap.get(sectionId) ?? null;
  }

  async listSectionIds(frameworkKey: string, version?: string): Promise<string[]> {
    const result = await this.ensureDocs(frameworkKey, version);
    if (result.kind === 'needs-url') return [];
    const map = buildSectionMap(result.sections);
    return Array.from(map.keys());
  }

  // ─── Fetch-external-docs (full assembled markdown) ────────────────────

  async fetchExternalDocs(frameworkKey: string, version?: string): Promise<string | NeedsUrlResult> {
    const entry = this.customFrameworks.get(frameworkKey) ?? FRAMEWORK_DOCS[frameworkKey];
    if (!entry) return `No documentation source configured for "${frameworkKey}". Use \`add-framework\` to register it.`;

    const result = await this.ensureDocs(frameworkKey, version);
    if (result.kind === 'needs-url') return result;

    const meta = resolveFrameworkMeta(entry, version);
    const sectionMap = buildSectionMap(result.sections);
    const parts = Array.from(sectionMap.values());
    const banner = `# ${frameworkKey}${version ? ` v${version}` : ''}\n\n> ${meta.description}\n`;
    return banner + '\n---\n\n' + parts.join('\n\n---\n\n');
  }

  // ─── Network fetching and conversion ──────────────────────────────────

  private async fetchAndConvert(frameworkKey: string, version?: string, suppliedUrl?: string): Promise<string> {
    const entry = this.customFrameworks.get(frameworkKey) ?? FRAMEWORK_DOCS[frameworkKey];
    const meta = entry ? resolveFrameworkMeta(entry, version) : undefined;
    const MIN_USEFUL = 500;

    // Priority 1: LLM-supplied URL
    if (suppliedUrl) {
      const text = await fetchText(suppliedUrl);
      if (text.length > MIN_USEFUL) {
        if (text.includes('<')) {
          const md = htmlToMarkdown(text);
          if (md.length > MIN_USEFUL) return md;
        }
        return text;
      }
    }

    // Priority 2: llms.txt
    if (meta?.llmsTxt) {
      const text = await fetchText(meta.llmsTxt);
      if (text.length > MIN_USEFUL) return text;
    }

    // Priority 3: GitHub README
    if (meta?.github) {
      const readme = await fetchGitHubReadme(meta.github);
      if (readme.length > MIN_USEFUL) return readme;
    }

    return offlineFallback(frameworkKey);
  }
}
