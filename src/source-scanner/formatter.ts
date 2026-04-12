import * as path from 'path';
import type { ScannedModule, ScannedFile, ExtractedSymbol, ModuleSummary } from './types.js';
import type { DocSection } from '../types/index.js';

/**
 * Converts scanned module data into the DocSection tree format
 * used by the rest of the MCP for consistent LLM consumption.
 */
export function moduleToDocSections(mod: ScannedModule): DocSection[] {
  const sections: DocSection[] = [];

  sections.push({
    id: `${mod.name}-overview`,
    title: `${mod.name} — Overview`,
    summary: formatOverviewSummary(mod),
  });

  if (mod.summary.restEndpoints.length > 0) {
    sections.push({
      id: `${mod.name}-rest-api`,
      title: 'REST API Endpoints',
      summary: `${mod.summary.restEndpoints.length} endpoint(s) detected`,
      children: mod.summary.restEndpoints.map((ep, idx) => ({
        id: `${mod.name}-endpoint-${idx}`,
        title: `${ep.method} ${ep.path}`,
        summary: `Handler: ${ep.handler}`,
      })),
    });
  }

  const filesByDir = groupFilesByDirectory(mod.files);
  for (const [dir, files] of filesByDir) {
    const dirId = sanitizeId(`${mod.name}-${dir}`);
    const children: DocSection[] = [];

    for (const file of files) {
      const fileId = sanitizeId(`${mod.name}-${shortPath(file.filePath)}`);
      const fileChildren = file.symbols.map(sym => symbolToSection(sym, fileId));

      children.push({
        id: fileId,
        title: shortPath(file.filePath),
        summary: `${file.symbols.length} exported symbol(s) — ${file.language}`,
        children: fileChildren.length > 0 ? fileChildren : undefined,
      });
    }

    sections.push({
      id: dirId,
      title: dir || 'root',
      summary: `${files.length} file(s)`,
      children,
    });
  }

  return sections;
}

export function formatModuleMarkdown(mod: ScannedModule): string {
  let out = `# ${mod.name}\n\n`;
  out += `> Language: ${mod.language} | Files: ${mod.summary.totalFiles} | Symbols: ${mod.summary.totalSymbols}\n\n`;

  if (mod.summary.publicClasses.length > 0) {
    out += `## Public Classes\n`;
    for (const c of mod.summary.publicClasses) out += `- ${c}\n`;
    out += '\n';
  }

  if (mod.summary.publicInterfaces.length > 0) {
    out += `## Interfaces / Traits\n`;
    for (const i of mod.summary.publicInterfaces) out += `- ${i}\n`;
    out += '\n';
  }

  if (mod.summary.restEndpoints.length > 0) {
    out += `## REST Endpoints\n`;
    for (const ep of mod.summary.restEndpoints) {
      out += `- \`${ep.method} ${ep.path}\` → ${ep.handler}\n`;
    }
    out += '\n';
  }

  if (mod.summary.entities.length > 0) {
    out += `## Entities / Documents\n`;
    for (const e of mod.summary.entities) out += `- ${e}\n`;
    out += '\n';
  }

  out += `## Files\n\n`;
  for (const file of mod.files) {
    out += `### ${shortPath(file.filePath)}\n`;
    if (file.packageName) out += `Package: \`${file.packageName}\`\n\n`;
    for (const sym of file.symbols) {
      out += formatSymbol(sym, 0);
    }
    out += '\n';
  }

  return out;
}

function formatSymbol(sym: ExtractedSymbol, indent: number): string {
  const pad = '  '.repeat(indent);
  let line = `${pad}- **${sym.kind}** \`${sym.name}\``;
  if (sym.visibility !== 'public') line += ` (${sym.visibility})`;
  if (sym.annotations?.length) line += ` ${sym.annotations.join(' ')}`;
  line += '\n';

  if (sym.signature) {
    line += `${pad}  \`${sym.signature}\`\n`;
  }
  if (sym.docComment) {
    const first = sym.docComment.split('\n')[0];
    line += `${pad}  > ${first}\n`;
  }

  if (sym.children) {
    for (const child of sym.children) {
      line += formatSymbol(child, indent + 1);
    }
  }
  return line;
}

function formatOverviewSummary(mod: ModuleSummary | ScannedModule): string {
  const s = 'summary' in mod ? mod.summary : mod;
  const parts: string[] = [];
  parts.push(`${s.totalFiles} files, ${s.totalSymbols} symbols`);
  if (s.publicClasses.length) parts.push(`${s.publicClasses.length} classes`);
  if (s.publicInterfaces.length) parts.push(`${s.publicInterfaces.length} interfaces`);
  if (s.publicMethods) parts.push(`${s.publicMethods} public methods`);
  if (s.restEndpoints.length) parts.push(`${s.restEndpoints.length} REST endpoints`);
  if (s.entities.length) parts.push(`${s.entities.length} entities`);
  return parts.join(' | ');
}

function symbolToSection(sym: ExtractedSymbol, parentId: string): DocSection {
  const id = sanitizeId(`${parentId}-${sym.kind}-${sym.name}`);
  let summary: string = sym.kind;
  if (sym.signature) summary = sym.signature.substring(0, 120);
  if (sym.docComment) summary = sym.docComment.split('\n')[0].substring(0, 120);

  return {
    id,
    title: `${sym.kind}: ${sym.name}`,
    summary,
    children: sym.children?.map(c => symbolToSection(c, id)),
  };
}

function groupFilesByDirectory(files: ScannedFile[]): Map<string, ScannedFile[]> {
  const map = new Map<string, ScannedFile[]>();
  for (const file of files) {
    const parsed = path.parse(file.filePath);
    const segments = parsed.dir.split(path.sep);
    const dir = segments.length > 2
      ? segments.slice(-2).join(path.sep)
      : parsed.dir;
    const list = map.get(dir) ?? [];
    list.push(file);
    map.set(dir, list);
  }
  return map;
}

function shortPath(filePath: string): string {
  const segments = filePath.split(path.sep);
  return segments.slice(-3).join(path.sep);
}

function sanitizeId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}
