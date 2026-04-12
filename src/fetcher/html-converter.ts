import TurndownService from 'turndown';
import { truncate } from './url-fetcher.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

export function htmlToMarkdown(html: string): string {
  try {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const content = bodyMatch ? bodyMatch[1] : html;

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
