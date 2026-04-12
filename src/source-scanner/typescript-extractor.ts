import type { Tree, Node } from './parser.js';
import type { ExtractedSymbol, SymbolKind } from './types.js';

export function extractTypeScriptSymbols(tree: Tree, source: string): { symbols: ExtractedSymbol[]; imports: string[] } {
  const root = tree.rootNode;
  const symbols: ExtractedSymbol[] = [];
  const imports: string[] = [];

  for (const child of root.children) {
    if (child.type === 'import_statement') {
      const src = child.childForFieldName('source');
      if (src) imports.push(src.text.replace(/['"]/g, ''));
    }

    if (child.type === 'export_statement') {
      const decl = child.childForFieldName('declaration') ?? child.children.find(c => isDeclaration(c.type));
      if (decl) {
        const sym = extractDeclaration(decl, source, true, child);
        if (sym) symbols.push(sym);
      }
      continue;
    }

    if (isDeclaration(child.type)) {
      const sym = extractDeclaration(child, source, isExported(child));
      if (sym) symbols.push(sym);
    }
  }

  return { symbols, imports };
}

function isDeclaration(type: string): boolean {
  return [
    'class_declaration', 'abstract_class_declaration',
    'interface_declaration', 'type_alias_declaration',
    'function_declaration', 'lexical_declaration',
    'enum_declaration',
  ].includes(type);
}

function isExported(node: Node): boolean {
  const prev = node.previousSibling;
  if (prev && prev.type === 'export_statement') return true;
  if (node.parent?.type === 'export_statement') return true;
  return false;
}

function extractDeclaration(node: Node, source: string, exported: boolean, exportNode?: Node): ExtractedSymbol | null {
  if (!exported) return null;
  const docNode = exportNode ?? node;

  switch (node.type) {
    case 'class_declaration':
    case 'abstract_class_declaration':
      return extractClass(node, source, docNode);
    case 'interface_declaration':
      return extractInterface(node, source, docNode);
    case 'type_alias_declaration':
      return extractTypeAlias(node, source, docNode);
    case 'function_declaration':
      return extractFunction(node, source, docNode);
    case 'lexical_declaration':
      return extractLexicalDecl(node, source, docNode);
    case 'enum_declaration':
      return extractEnum(node, source, docNode);
    default:
      return null;
  }
}

function extractClass(node: Node, source: string, docNode?: Node): ExtractedSymbol {
  const nameNode = node.childForFieldName('name');
  const children: ExtractedSymbol[] = [];

  const body = node.childForFieldName('body');
  if (body) {
    for (const member of body.children) {
      const sym = extractClassMember(member, source);
      if (sym) children.push(sym);
    }
  }

  return {
    name: nameNode?.text ?? 'Anonymous',
    kind: 'class',
    visibility: 'public',
    docComment: extractJsDoc(docNode ?? node, source),
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    children: children.length > 0 ? children : undefined,
  };
}

function extractInterface(node: Node, source: string, docNode?: Node): ExtractedSymbol {
  const nameNode = node.childForFieldName('name');
  const children: ExtractedSymbol[] = [];

  const body = node.childForFieldName('body');
  if (body) {
    for (const member of body.children) {
      if (member.type === 'property_signature' || member.type === 'method_signature') {
        const name = member.childForFieldName('name')?.text ?? member.text.split('(')[0].split(':')[0].trim();
        children.push({
          name,
          kind: member.type === 'method_signature' ? 'method' : 'field',
          visibility: 'public',
          signature: member.text.replace(/\s+/g, ' ').trim(),
          location: { startLine: member.startPosition.row + 1, endLine: member.endPosition.row + 1 },
        });
      }
    }
  }

  return {
    name: nameNode?.text ?? 'Anonymous',
    kind: 'interface',
    visibility: 'public',
    docComment: extractJsDoc(docNode ?? node, source),
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    children: children.length > 0 ? children : undefined,
  };
}

function extractTypeAlias(node: Node, source: string, docNode?: Node): ExtractedSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? 'Unknown',
    kind: 'type',
    visibility: 'public',
    signature: node.text.replace(/\s+/g, ' ').substring(0, 200),
    docComment: extractJsDoc(docNode ?? node, source),
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  };
}

function extractFunction(node: Node, source: string, docNode?: Node): ExtractedSymbol {
  const nameNode = node.childForFieldName('name');
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');

  let signature = nameNode?.text ?? 'anonymous';
  if (params) signature += params.text;
  if (returnType) signature += ': ' + returnType.text;

  const name = nameNode?.text ?? 'anonymous';
  const kind: SymbolKind = isReactComponent(name, node) ? 'component' : isReactHook(name) ? 'hook' : 'function';

  return {
    name,
    kind,
    visibility: 'public',
    signature,
    docComment: extractJsDoc(docNode ?? node, source),
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  };
}

function extractLexicalDecl(node: Node, source: string, docNode?: Node): ExtractedSymbol | null {
  const declarator = node.children.find(c => c.type === 'variable_declarator');
  if (!declarator) return null;

  const nameNode = declarator.childForFieldName('name');
  const value = declarator.childForFieldName('value');

  const name = nameNode?.text ?? 'unknown';
  const isArrowFn = value?.type === 'arrow_function';
  const isFunction = value?.type === 'function_expression' || value?.type === 'function';

  if (isArrowFn || isFunction) {
    const kind: SymbolKind = isReactComponent(name, value!) ? 'component' : isReactHook(name) ? 'hook' : 'function';
    const params = value!.childForFieldName('parameters');
    let signature = name;
    if (params) signature += params.text;
    return {
      name,
      kind,
      visibility: 'public',
      signature,
      docComment: extractJsDoc(docNode ?? node, source),
      location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    };
  }

  return {
    name,
    kind: 'constant',
    visibility: 'public',
    signature: node.text.replace(/\s+/g, ' ').substring(0, 200),
    docComment: extractJsDoc(docNode ?? node, source),
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  };
}

function extractEnum(node: Node, source: string, docNode?: Node): ExtractedSymbol {
  const nameNode = node.childForFieldName('name');
  const children: ExtractedSymbol[] = [];

  const body = node.childForFieldName('body');
  if (body) {
    for (const member of body.children) {
      if (member.type === 'enum_assignment' || member.type === 'property_identifier') {
        const mName = member.childForFieldName('name')?.text ?? member.text.split('=')[0].trim();
        if (mName && mName !== '{' && mName !== '}' && mName !== ',') {
          children.push({
            name: mName,
            kind: 'constant',
            visibility: 'public',
            location: { startLine: member.startPosition.row + 1, endLine: member.endPosition.row + 1 },
          });
        }
      }
    }
  }

  return {
    name: nameNode?.text ?? 'Unknown',
    kind: 'enum',
    visibility: 'public',
    docComment: extractJsDoc(docNode ?? node, source),
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    children: children.length > 0 ? children : undefined,
  };
}

function extractClassMember(node: Node, source: string): ExtractedSymbol | null {
  if (node.type === 'method_definition' || node.type === 'public_field_definition') {
    const accessibility = node.children.find(c => c.type === 'accessibility_modifier');
    if (accessibility?.text === 'private') return null;

    const nameNode = node.childForFieldName('name');
    const kind: SymbolKind = node.type === 'method_definition' ? 'method' : 'field';

    return {
      name: nameNode?.text ?? 'unknown',
      kind,
      visibility: accessibility?.text === 'protected' ? 'protected' : 'public',
      signature: node.text.replace(/\{[\s\S]*\}/, '').replace(/\s+/g, ' ').trim().substring(0, 200),
      docComment: extractJsDoc(node, source),
      location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    };
  }
  return null;
}

function extractJsDoc(node: Node, _source: string): string | undefined {
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

function isReactComponent(name: string, _node: Node): boolean {
  return /^[A-Z]/.test(name) && !name.startsWith('use');
}

function isReactHook(name: string): boolean {
  return name.startsWith('use') && name.length > 3 && /^use[A-Z]/.test(name);
}
