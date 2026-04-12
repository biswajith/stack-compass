import { APP_NAME, APP_VERSION } from '../version.js';
import { fetchText, truncate, combineSignals } from './url-fetcher.js';
import { gitHubAuthHeaders } from './github-token.js';

const MIN_USEFUL = 100;

const README_FILENAMES = [
  'README.md',
  'readme.md',
  'Readme.md',
  'README.adoc',
  'readme.adoc',
  'README.rst',
  'readme.rst',
  'README.markdown',
  'readme.markdown',
  'README.txt',
  'README',
];

const BRANCHES = ['main', 'master'];

const GLOBAL_TIMEOUT_MS = 30_000;
const PER_REQUEST_TIMEOUT_MS = 5_000;

export async function fetchGitHubReadme(repo: string): Promise<string> {
  const auth = gitHubAuthHeaders('https://raw.githubusercontent.com/');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GLOBAL_TIMEOUT_MS);
  const opts = { timeoutMs: PER_REQUEST_TIMEOUT_MS, signal: ac.signal };

  try {
    // Phase 1: brute-force filename × branch via raw.githubusercontent.com
    for (const branch of BRANCHES) {
      if (ac.signal.aborted) break;
      for (const filename of README_FILENAMES) {
        if (ac.signal.aborted) break;
        const url = `https://raw.githubusercontent.com/${repo}/${branch}/${filename}`;
        const text = await fetchText(url, auth, opts);
        if (text.length === 0) continue;

        const followed = await followPointerIfNeeded(text, repo, branch, auth, opts);
        if (followed !== text && followed.length > MIN_USEFUL) {
          return truncate(followed, 30000);
        }
        if (text.length > MIN_USEFUL) {
          return truncate(text, 30000);
        }
      }
    }

    // Phase 2: GitHub API — works regardless of filename/case/location
    if (!ac.signal.aborted) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/readme`, {
          headers: {
            'User-Agent': `${APP_NAME}/${APP_VERSION}`,
            'Accept': 'application/vnd.github.raw+json',
            ...auth,
          },
          signal: combineSignals([AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS), ac.signal]),
        });
        if (res.ok) {
          const text = await res.text();
          if (text.length === 0) return '';
          const followed = await followPointerIfNeeded(text, repo, 'main', auth, opts);
          if (followed !== text && followed.length > MIN_USEFUL) {
            return truncate(followed, 30000);
          }
          if (text.length > MIN_USEFUL) {
            return truncate(text, 30000);
          }
        }
      } catch { /* rate limited, not found, or aborted */ }
    }

    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Monorepo pointer detection: if a README is very short and its content
 * looks like a path to another README (e.g. "packages/zod/README.md"),
 * fetch that nested file instead. Returns original text if no pointer found.
 */
async function followPointerIfNeeded(
  text: string, repo: string, branch: string, auth: Record<string, string>,
  fetchOpts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
  const trimmed = text.trim();
  if (trimmed.length > 300) return text;

  const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length > 5) return text;

  for (const line of lines) {
    const pathMatch = line.match(
      /^(?:\[.*?\]\()?\s*([a-zA-Z0-9_.\-/]+(?:readme|README|Readme)\.[a-zA-Z]+)\s*\)?$/i
    );
    if (pathMatch) {
      const nestedPath = pathMatch[1];
      for (const b of [branch, ...BRANCHES.filter(br => br !== branch)]) {
        const url = `https://raw.githubusercontent.com/${repo}/${b}/${nestedPath}`;
        const nested = await fetchText(url, auth, fetchOpts);
        if (nested.length > MIN_USEFUL) return nested;
      }
    }
  }

  return text;
}
