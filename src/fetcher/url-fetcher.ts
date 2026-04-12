import { APP_NAME, APP_VERSION } from '../version.js';

export async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': `${APP_NAME}/${APP_VERSION}` },
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) return await res.text();
  } catch { /* network error */ }
  return '';
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.substring(0, max);
  const nl = cut.lastIndexOf('\n');
  return cut.substring(0, nl > 0 ? nl : max) + '\n\n... (content truncated)';
}
