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

/**
 * Writes content to disk cache atomically (write tmp then rename).
 * Returns true on success, false on failure (disk full, permission error, etc.).
 */
export function writeCache(framework: string, version: string, section: string, content: string): boolean {
  const p = entryPath(framework, version, section);
  const dir = path.dirname(p);
  const tmp = p + '.tmp.' + process.pid;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const entry: CacheEntry = { content, fetchedAt: Date.now() };
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    fs.renameSync(tmp, p);
    return true;
  } catch (err) {
    console.warn(`[stack-compass] cache write failed for ${sanitize(framework)}/${sanitize(section)}: ${err instanceof Error ? err.message : String(err)}`);
    try { fs.unlinkSync(tmp); } catch { /* cleanup best-effort */ }
    return false;
  }
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
