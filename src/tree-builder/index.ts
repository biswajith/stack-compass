import { DocSection } from '../types/index.js';

/**
 * Parsed section: a heading-delimited chunk of markdown content.
 */
export interface ParsedSection {
  id: string;
  title: string;
  level: number;
  content: string;
  children: ParsedSection[];
}

/**
 * Parse markdown (or AsciiDoc) text into a tree of sections based on headings.
 * Recognizes both markdown (`# Title`) and AsciiDoc (`= Title`) heading syntax.
 */
export function parseMarkdownSections(markdown: string): ParsedSection[] {
  const lines = markdown.split('\n');
  const flatSections: { level: number; title: string; id: string; startLine: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Markdown headings: # h1, ## h2, ### h3, #### h4
    const mdMatch = lines[i].match(/^(#{1,4})\s+(.+)/);
    if (mdMatch) {
      const level = mdMatch[1].length;
      const title = mdMatch[2].replace(/[*_`#]/g, '').trim();
      const id = slugify(title);
      flatSections.push({ level, title, id, startLine: i });
      continue;
    }

    // AsciiDoc headings: = h1, == h2, === h3, ==== h4
    const adocMatch = lines[i].match(/^(={1,4})\s+(.+)/);
    if (adocMatch) {
      const level = adocMatch[1].length;
      const title = adocMatch[2].replace(/[*_`]/g, '').trim();
      const id = slugify(title);
      flatSections.push({ level, title, id, startLine: i });
    }
  }

  if (flatSections.length === 0) {
    return [{
      id: 'overview',
      title: 'Overview',
      level: 1,
      content: markdown.trim(),
      children: [],
    }];
  }

  const parsed: ParsedSection[] = [];
  for (let i = 0; i < flatSections.length; i++) {
    const cur = flatSections[i];
    const nextStart = i + 1 < flatSections.length ? flatSections[i + 1].startLine : lines.length;
    const content = lines.slice(cur.startLine, nextStart).join('\n').trim();
    parsed.push({
      id: cur.id,
      title: cur.title,
      level: cur.level,
      content,
      children: [],
    });
  }

  return nestSections(parsed);
}

/**
 * Convert a flat list of sections (with levels) into a nested tree.
 * h2s become top-level, h3s nest under the preceding h2, etc.
 */
function nestSections(flat: ParsedSection[]): ParsedSection[] {
  const root: ParsedSection[] = [];
  const stack: ParsedSection[] = [];

  for (const sec of flat) {
    while (stack.length > 0 && stack[stack.length - 1].level >= sec.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      root.push(sec);
    } else {
      stack[stack.length - 1].children.push(sec);
    }
    stack.push(sec);
  }

  return root;
}

/**
 * Convert parsed sections into lightweight DocSection[] for the index
 * (no content, just id/title/summary/children).
 */
export function toDocSections(parsed: ParsedSection[]): DocSection[] {
  return parsed.map(s => {
    const summary = extractSummary(s.content, 200);
    const result: DocSection = { id: s.id, title: s.title, summary };
    if (s.children.length > 0) {
      result.children = toDocSections(s.children);
    }
    return result;
  });
}

/**
 * Build a flat map of sectionId → content from parsed sections.
 */
export function buildSectionMap(parsed: ParsedSection[]): Map<string, string> {
  const map = new Map<string, string>();
  function walk(sections: ParsedSection[]) {
    for (const s of sections) {
      map.set(s.id, s.content);
      walk(s.children);
    }
  }
  walk(parsed);
  return map;
}

function extractSummary(content: string, maxLen: number): string {
  const withoutHeading = content.replace(/^[#=]{1,4}\s+.+\n*/, '');
  const firstParagraph = withoutHeading.split(/\n\n/)[0]?.trim() ?? '';
  const cleaned = firstParagraph
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`[^`]+`/g, (m) => m)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen - 3).trimEnd() + '...';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}
