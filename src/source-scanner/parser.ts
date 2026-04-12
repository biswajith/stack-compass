import { Parser, Language, Tree, Node } from 'web-tree-sitter';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import type { SupportedLanguage } from './types.js';

export type { Tree, Language, Node };

let parserReady = false;
const languageCache = new Map<string, Language>();

export async function initParser(): Promise<void> {
  if (parserReady) return;
  await Parser.init();
  parserReady = true;
}

/**
 * Resolves the path to a WASM file from a grammar package.
 * Uses Node's module resolution (via createRequire) so it works with
 * hoisted node_modules, pnpm, and yarn PnP layouts.
 * Falls back to the legacy hardcoded path if resolution fails.
 */
function resolveWasmPath(grammarPkg: string, wasmFile: string): string {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve(`${grammarPkg}/package.json`);
    const pkgDir = path.dirname(pkgJsonPath);
    const candidate = path.join(pkgDir, wasmFile);
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* resolution failed, use fallback */ }

  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(thisDir, '..', '..');
  return path.join(projectRoot, 'node_modules', grammarPkg, wasmFile);
}

const GRAMMAR_MAP: Partial<Record<SupportedLanguage, { pkg: string; wasm: string }>> = {
  java:       { pkg: 'tree-sitter-java',       wasm: 'tree-sitter-java.wasm' },
  typescript: { pkg: 'tree-sitter-typescript',  wasm: 'tree-sitter-typescript.wasm' },
  tsx:        { pkg: 'tree-sitter-typescript',  wasm: 'tree-sitter-tsx.wasm' },
  javascript: { pkg: 'tree-sitter-javascript',  wasm: 'tree-sitter-javascript.wasm' },
  scala:      { pkg: 'tree-sitter-scala',       wasm: 'tree-sitter-scala.wasm' },
};

async function getLanguage(lang: SupportedLanguage): Promise<Language> {
  if (lang === 'graphql') throw new Error('GraphQL uses regex-based extraction, not tree-sitter WASM');

  const cached = languageCache.get(lang);
  if (cached) return cached;

  const spec = GRAMMAR_MAP[lang];
  if (!spec) throw new Error(`No tree-sitter WASM grammar for: ${lang}`);

  const wasmPath = resolveWasmPath(spec.pkg, spec.wasm);
  const language = await Language.load(wasmPath);
  languageCache.set(lang, language);
  return language;
}

const parserCache = new Map<string, Parser>();

export async function parseSource(source: string, lang: SupportedLanguage): Promise<Tree> {
  await initParser();
  const language = await getLanguage(lang);

  let parser = parserCache.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parserCache.set(lang, parser);
  }

  const tree = parser.parse(source);
  if (!tree) throw new Error(`Failed to parse source as ${lang}`);
  return tree;
}

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  '.java': 'java',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.scala': 'scala',
  '.sc': 'scala',
  '.graphql': 'graphql',
  '.gql': 'graphql',
};

export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}
