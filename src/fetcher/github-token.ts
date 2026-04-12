import { execFileSync } from 'child_process';

let cachedToken: string | null | undefined;

/**
 * Resolves a GitHub token for authenticated API requests.
 * Checks in order:
 *   1. GH_TOKEN env var (standard for gh CLI and CI)
 *   2. GITHUB_TOKEN env var (GitHub Actions convention)
 *   3. `gh auth token` subprocess (picks up SSO-enabled tokens)
 *
 * Set STACK_COMPASS_NO_GH_CLI=1 to disable the `gh` CLI fallback.
 * The result is cached for the process lifetime.
 * Returns null if no token is available — callers fall back to unauthenticated.
 */
export function resolveGitHubToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;

  cachedToken = fromEnv() ?? fromGhCli();
  return cachedToken;
}

function fromEnv(): string | null {
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const val = process.env[key]?.trim();
    if (val && val.length > 10) return val;
  }
  return null;
}

function fromGhCli(): string | null {
  if (process.env.STACK_COMPASS_NO_GH_CLI === '1') return null;
  try {
    const output = execFileSync('gh', ['auth', 'token'], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const token = output.trim();
    if (token.length > 10) return token;
  } catch { /* gh not installed or not logged in */ }
  return null;
}

const GITHUB_HOSTS = new Set([
  'api.github.com',
  'raw.githubusercontent.com',
  'github.com',
]);

/**
 * Returns auth headers if a token is available, otherwise empty object.
 * When a URL is provided, headers are only returned if the host is a
 * recognized GitHub domain — prevents leaking tokens to third-party sites.
 */
export function gitHubAuthHeaders(url?: string): Record<string, string> {
  if (url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!GITHUB_HOSTS.has(host) && !host.endsWith('.github.com') && !host.endsWith('.githubusercontent.com')) {
        return {};
      }
    } catch { return {}; }
  }
  const token = resolveGitHubToken();
  if (!token) return {};
  return { 'Authorization': `Bearer ${token}` };
}

/** Exposed for testing — clears the cached token so it's re-resolved. */
export function _resetTokenCache(): void {
  cachedToken = undefined;
}
