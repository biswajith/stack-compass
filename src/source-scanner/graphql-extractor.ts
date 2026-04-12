import type { ExtractedSymbol, SymbolKind } from './types.js';

/**
 * GraphQL doesn't have a tree-sitter grammar in our set,
 * so we use a lightweight regex-based parser for .graphql/.gql files.
 * This extracts types, inputs, enums, queries, mutations, subscriptions.
 */
export function extractGraphQLSymbols(source: string): { symbols: ExtractedSymbol[] } {
  const symbols: ExtractedSymbol[] = [];
  const lines = source.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    const typeMatch = line.match(/^(type|input|interface|union|scalar|enum)\s+(\w+)/);
    if (typeMatch) {
      const [, gqlKind, name] = typeMatch;
      if (name === 'Query' || name === 'Mutation' || name === 'Subscription') {
        const { fields, endLine } = extractBlockFields(lines, i);
        const opKind = name.toLowerCase() as 'query' | 'mutation' | 'subscription';
        for (const field of fields) {
          symbols.push({
            name: field.name,
            kind: opKind,
            visibility: 'public',
            signature: field.signature,
            docComment: field.description,
            location: { startLine: field.line, endLine: field.line },
          });
        }
        i = endLine + 1;
        continue;
      }

      const kind = mapGqlKind(gqlKind);
      const docComment = extractGqlDescription(lines, i);
      const { fields, endLine } = extractBlockFields(lines, i);

      const children: ExtractedSymbol[] = fields.map(f => ({
        name: f.name,
        kind: 'field' as SymbolKind,
        visibility: 'public' as const,
        signature: f.signature,
        docComment: f.description,
        location: { startLine: f.line, endLine: f.line },
      }));

      symbols.push({
        name,
        kind,
        visibility: 'public',
        docComment,
        location: { startLine: i + 1, endLine: endLine + 1 },
        children: children.length > 0 ? children : undefined,
      });

      i = endLine + 1;
      continue;
    }

    i++;
  }

  return { symbols };
}

interface GqlField {
  name: string;
  signature: string;
  description?: string;
  line: number;
}

function extractBlockFields(lines: string[], startIdx: number): { fields: GqlField[]; endLine: number } {
  const fields: GqlField[] = [];
  let i = startIdx;

  while (i < lines.length && !lines[i].includes('{')) i++;
  i++; // skip opening brace

  let pendingDescription: string | undefined;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '}') break;

    if (line.startsWith('#') || line.startsWith('"')) {
      pendingDescription = line.replace(/^[#"]+\s*/, '').replace(/"$/, '');
      i++;
      continue;
    }

    const fieldMatch = line.match(/^(\w+)(\([^)]*\))?\s*:\s*(.+)/);
    if (fieldMatch) {
      const [, name, args, returnType] = fieldMatch;
      fields.push({
        name,
        signature: `${name}${args ?? ''}: ${returnType.replace(/\s*@.*$/, '').trim()}`,
        description: pendingDescription,
        line: i + 1,
      });
      pendingDescription = undefined;
    }
    i++;
  }

  return { fields, endLine: i };
}

function extractGqlDescription(lines: string[], typeLineIdx: number): string | undefined {
  if (typeLineIdx > 0) {
    const prev = lines[typeLineIdx - 1].trim();
    if (prev.startsWith('#') || prev.startsWith('"')) {
      return prev.replace(/^[#"]+\s*/, '').replace(/"$/, '');
    }
  }
  return undefined;
}

function mapGqlKind(gqlKind: string): SymbolKind {
  switch (gqlKind) {
    case 'type':      return 'graphql-type';
    case 'input':     return 'graphql-input';
    case 'enum':      return 'graphql-enum';
    case 'interface': return 'interface';
    default:          return 'graphql-type';
  }
}
