import { NeedsUrlResult } from '../fetcher/index.js';
import { DocSection } from '../types/index.js';

export function formatNeedsUrl(r: NeedsUrlResult): string {
  let msg = `## Documentation URL needed for \`${r.framework}\``;
  if (r.version) msg += ` v${r.version}`;
  msg += '\n\n';
  msg += `> ${r.description}\n\n`;
  msg += 'I don\'t have a documentation URL for this framework yet.\n\n';
  msg += '**Please call `resolve-doc-url`** with:\n';
  msg += `- \`framework\`: \`"${r.framework}"\`\n`;
  if (r.version) msg += `- \`version\`: \`"${r.version}"\`\n`;
  msg += '- `url`: the most relevant official documentation URL for this framework and version\n\n';
  msg += 'The URL should point to the main reference/guide page (HTML or Markdown). ';
  msg += 'Examples of good URLs:\n';
  msg += '- `https://docs.spring.io/spring-boot/reference/` (Spring Boot 3.x)\n';
  msg += '- `https://react.dev/learn` (React 18+)\n';
  msg += '- `https://docs.docker.com/reference/dockerfile/` (Docker)\n';
  return msg;
}

export function formatTreeIndex(sections: DocSection[], indent = 0): string {
  let out = '';
  for (const s of sections) {
    const pad = '  '.repeat(indent);
    out += `${pad}- **${s.title}** [\`${s.id}\`]\n`;
    out += `${pad}  ${s.summary}\n`;
    if (s.children) out += formatTreeIndex(s.children, indent + 1);
  }
  return out;
}
