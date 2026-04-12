import { APP_NAME, APP_VERSION } from '../version.js';

/**
 * Domain allowlist — only these hosts (and their subdomains) may be fetched.
 * This eliminates entire classes of SSRF bypass (IPv4-mapped IPv6, DNS rebinding,
 * nip.io, etc.) because we never resolve arbitrary hostnames — we just string-match
 * against known documentation hosts.
 *
 * This list is intentionally closed. For internal/private documentation, check the
 * source code into the monorepo and use scan-internal-source instead.
 */
const ALLOWED_DOMAINS = new Set([
  // GitHub
  'github.com',
  'raw.githubusercontent.com',
  'api.github.com',
  'objects.githubusercontent.com',

  // Major documentation sites
  'docs.spring.io',
  'spring.io',
  'hibernate.org',
  'react.dev',
  'nextjs.org',
  'tailwindcss.com',
  'graphql.org',
  'docs.docker.com',
  'kubernetes.io',
  'www.postgresql.org',
  'dev.mysql.com',
  'www.mongodb.com',
  'docs.mongodb.com',
  'redis.io',
  'typescriptlang.org',
  'www.typescriptlang.org',
  'docs.scala-lang.org',
  'www.scala-lang.org',
  'docs.gradle.org',
  'gradle.org',
  'maven.apache.org',
  'sbt-scala.org',
  'www.scala-sbt.org',
  'junit.org',
]);

/**
 * Returns true if the URL targets a known documentation domain.
 * Rejects everything else — no IP addresses, no arbitrary hostnames.
 */
export function isAllowedUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();

  for (const allowed of ALLOWED_DOMAINS) {
    if (host === allowed || host.endsWith('.' + allowed)) return true;
  }
  return false;
}

/**
 * Combine multiple AbortSignals. Uses AbortSignal.any when available (Node 20+),
 * falls back to manual listener wiring for Node 18.
 */
export function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);

  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ac.abort(s.reason); return ac.signal; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

export async function fetchText(
  url: string,
  extraHeaders?: Record<string, string>,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
  if (!isAllowedUrl(url)) return '';
  try {
    const timeoutMs = options?.timeoutMs ?? 15000;
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (options?.signal) signals.push(options.signal);

    const res = await fetch(url, {
      headers: { 'User-Agent': `${APP_NAME}/${APP_VERSION}`, ...extraHeaders },
      redirect: 'follow',
      signal: combineSignals(signals),
    });
    if (res.ok) return await res.text();
  } catch { /* network error or abort */ }
  return '';
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.substring(0, max);
  const nl = cut.lastIndexOf('\n');
  return cut.substring(0, nl > 0 ? nl : max) + '\n\n... (content truncated)';
}
