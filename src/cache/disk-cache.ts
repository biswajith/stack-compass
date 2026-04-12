import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CACHE_ROOT = path.join(os.homedir(), '.stack-compass', 'cache');
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CacheEntry {
  content: string;
  fetchedAt: number;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._@-]/g, '_');
}

function entryPath(framework: string, version: string, section: string): string {
  return path.join(CACHE_ROOT, sanitize(framework), sanitize(version), `${sanitize(section)}.json`);
}

export function readCache(framework: string, version: string, section: string, ttl = DEFAULT_TTL_MS): string | null {
  const p = entryPath(framework, version, section);
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt < ttl) return entry.content;
  } catch { /* miss */ }
  return null;
}

export function writeCache(framework: string, version: string, section: string, content: string): void {
  const p = entryPath(framework, version, section);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const entry: CacheEntry = { content, fetchedAt: Date.now() };
  fs.writeFileSync(p, JSON.stringify(entry), 'utf-8');
}

export function invalidateFrameworkCache(framework: string): void {
  const dir = path.join(CACHE_ROOT, sanitize(framework));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* nothing to remove */ }
}

export function getCacheRoot(): string {
  return CACHE_ROOT;
}
