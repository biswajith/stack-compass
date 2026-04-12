import type { Tree, Node } from './parser.js';
import type { ExtractedSymbol, SymbolKind } from './types.js';

export function extractScalaSymbols(tree: Tree, source: string): { symbols: ExtractedSymbol[]; packageName?: string; imports: string[] } {
  const root = tree.rootNode;
  const symbols: ExtractedSymbol[] = [];
  const imports: string[] = [];
  let packageName: string | undefined;

  for (const child of root.children) {
    if (child.type === 'package_clause') {
      const name = child.children.find(c => c.type === 'package_identifier' || c.type === 'stable_identifier');
      if (name) packageName = name.text;
    }
    if (child.type === 'import_declaration') {
      imports.push(child.text.replace(/^import\s+/, ''));
    }

    const sym = extractTopLevel(child, source);
    if (sym) symbols.push(sym);
  }

  return { symbols, packageName, imports };
}

function extractTopLevel(node: Node, source: string): ExtractedSymbol | null {
  switch (node.type) {
    case 'class_definition':
      return extractClassDef(node, source, 'class');
    case 'trait_definition':
      return extractClassDef(node, source, 'trait');
    case 'object_definition':
      return extractClassDef(node, source, 'object');
    case 'enum_definition':
      return extractClassDef(node, source, 'enum');
    case 'val_definition':
    case 'var_definition':
      return extractValDef(node, source);
    case 'function_definition':
      return extractFuncDef(node, source);
    default:
      return null;
  }
}

function extractClassDef(node: Node, source: string, kind: SymbolKind): ExtractedSymbol {
  const nameNode = node.childForFieldName('name');
  const name = nameNode?.text ?? 'Anonymous';
  const children: ExtractedSymbol[] = [];

  const isCaseClass = node.children.some(c => c.type === 'case');
  const effectiveKind: SymbolKind = isCaseClass ? 'case-class' : kind;

  const body = node.childForFieldName('body') ?? node.children.find(c => c.type === 'template_body');
  if (body) {
    for (const member of body.children) {
      const memberSym = extractMember(member, source);
      if (memberSym) children.push(memberSym);
    }
  }

  const params = node.childForFieldName('class_parameters') ?? node.children.find(c => c.type === 'class_parameters');
  let signature: string | undefined;
  if (params) {
    signature = `${isCaseClass ? 'case class' : kind} ${name}${params.text}`;
  }

  return {
    name,
    kind: effectiveKind,
    visibility: extractScalaVisibility(node),
    signature,
    docComment: extractScalaDoc(node, source),
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    children: children.length > 0 ? children : undefined,
  };
}

function extractMember(node: Node, source: string): ExtractedSymbol | null {
  if (node.type === 'function_definition') return extractFuncDef(node, source);
  if (node.type === 'val_definition' || node.type === 'var_definition') return extractValDef(node, source);
  if (node.type === 'class_definition' || node.type === 'trait_definition' || node.type === 'object_definition') {
    return extractClassDef(node, source, node.type.replace('_definition', '') as SymbolKind);
  }
  return null;
}

function extractFuncDef(node: Node, source: string): ExtractedSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const visibility = extractScalaVisibility(node);
  if (visibility === 'private') return null;

  const params = node.childForFieldName('parameters') ?? node.children.find(c => c.type === 'parameters');
  const returnType = node.childForFieldName('return_type');

  let signature = `def ${nameNode.text}`;
  if (params) signature += params.text;
  if (returnType) signature += ': ' + returnType.text;

  return {
    name: nameNode.text,
    kind: 'method',
    visibility,
    signature,
    docComment: extractScalaDoc(node, source),
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  };
}

function extractValDef(node: Node, source: string): ExtractedSymbol | null {
  const pattern = node.childForFieldName('pattern');
  const name = pattern?.text ?? node.children.find(c => c.type === 'identifier')?.text;
  if (!name) return null;
  const visibility = extractScalaVisibility(node);
  if (visibility === 'private') return null;

  return {
    name,
    kind: 'field',
    visibility,
    signature: node.text.replace(/\s*=\s*[\s\S]*$/, '').replace(/\s+/g, ' ').trim().substring(0, 200),
    docComment: extractScalaDoc(node, source),
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  };
}

function extractScalaVisibility(node: Node): ExtractedSymbol['visibility'] {
  for (const child of node.children) {
    if (child.type === 'access_modifier') {
      if (child.text.includes('private')) return 'private';
      if (child.text.includes('protected')) return 'protected';
    }
    if (child.type === 'modifiers') {
      for (const mod of child.children) {
        if (mod.type === 'access_modifier') {
          if (mod.text.includes('private')) return 'private';
          if (mod.text.includes('protected')) return 'protected';
        }
      }
    }
  }
  return 'public';
}

function extractScalaDoc(node: Node, _source: string): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev && prev.type === 'comment' && prev.text.startsWith('/**')) {
    return prev.text
      .replace(/^\/\*\*/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .map(l => l.replace(/^\s*\*\s?/, '').trim())
      .filter(l => l.length > 0)
      .join('\n');
  }
  return undefined;
}
