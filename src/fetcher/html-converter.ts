import TurndownService from 'turndown';
import { truncate } from './url-fetcher.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

const MAX_HTML_INPUT = 100_000;

export function htmlToMarkdown(html: string): string {
  try {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let content = bodyMatch ? bodyMatch[1] : html;

    if (content.length > MAX_HTML_INPUT) {
      content = content.substring(0, MAX_HTML_INPUT);
    }

    const cleaned = content
      .replace(/<(nav|header|footer|script|style|noscript|aside)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    let md = turndown.turndown(cleaned);
    md = md.replace(/\n{4,}/g, '\n\n\n');
    md = md.replace(/^[\s\n]+/, '');

    return truncate(md, 200000);
  } catch {
    return '';
  }
}
