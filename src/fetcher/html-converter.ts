import TurndownService from 'turndown';
import { truncate } from './url-fetcher.js';

const STRIP_ELEMENTS = ['nav', 'header', 'footer', 'script', 'style', 'noscript', 'aside', 'svg'];

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

turndown.remove(STRIP_ELEMENTS as TurndownService.Filter);

const MAX_HTML_INPUT = 100_000;

export function htmlToMarkdown(html: string): string {
  try {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let content = bodyMatch ? bodyMatch[1] : html;

    if (content.length > MAX_HTML_INPUT) {
      content = content.substring(0, MAX_HTML_INPUT);
    }

    let md = turndown.turndown(content);
    md = md.replace(/\n{4,}/g, '\n\n\n');
    md = md.replace(/^[\s\n]+/, '');

    return truncate(md, 200000);
  } catch {
    return '';
  }
}
