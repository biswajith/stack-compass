import { APP_NAME, APP_VERSION } from '../version.js';
import { fetchText, truncate } from './url-fetcher.js';

export async function fetchGitHubReadme(repo: string): Promise<string> {
  const MIN_USEFUL = 100;

  for (const branch of ['main', 'master']) {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/README.md`;
    const text = await fetchText(url);
    if (text.length > MIN_USEFUL) return truncate(text, 30000);
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/readme`, {
      headers: {
        'User-Agent': `${APP_NAME}/${APP_VERSION}`,
        'Accept': 'application/vnd.github.raw+json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const text = await res.text();
      if (text.length > MIN_USEFUL) return truncate(text, 30000);
    }
  } catch { /* rate limited or not found */ }

  return '';
}
