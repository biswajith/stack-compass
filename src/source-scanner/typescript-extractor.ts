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

  // Extract api-call symbols from fetch/axios calls in all function bodies
  const apiCalls = extractApiCallSymbols(root, source);
  symbols.push(...apiCalls);

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
  const extendsName = extractTsHeritage(node, 'extends_clause');
  const implementsList = extractTsHeritageList(node, 'implements_clause');

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
    extends: extendsName,
    implements: implementsList.length > 0 ? implementsList : undefined,
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    children: children.length > 0 ? children : undefined,
  };
}

function extractInterface(node: Node, source: string, docNode?: Node): ExtractedSymbol {
  const nameNode = node.childForFieldName('name');
  const children: ExtractedSymbol[] = [];
  const extendsName = extractInterfaceExtends(node);

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
    extends: extendsName,
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    children: children.length > 0 ? children : undefined,
  };
}

function extractInterfaceExtends(node: Node): string | undefined {
  // interface_declaration → extends_type_clause → type_identifier
  const clause = node.children.find(c => c.type === 'extends_type_clause' || c.type === 'extends_clause');
  if (!clause) return undefined;
  const typeId = clause.children.find(c => c.type === 'identifier' || c.type === 'type_identifier');
  return typeId?.text;
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
  const callSites = extractTsCallSites(node);
  const jsxElements = extractJsxElements(node);

  return {
    name,
    kind,
    visibility: 'public',
    signature,
    docComment: extractJsDoc(docNode ?? node, source),
    callSites: callSites.length > 0 ? callSites : undefined,
    jsxElements: jsxElements.length > 0 ? jsxElements : undefined,
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  };
}

function extractLexicalDecl(node: Node, source: string, docNode?: Node): ExtractedSymbol | null {
  const declarator = node.children.find(c => c.type === 'variable_declarator');
  if (!declarator) return null;

  const nameNode = declarator.childForFieldName('name');
  const value = declarator.childForFieldName('value');

  const name = nameNode?.text ?? 'unknown';

  // Detect gql tagged template: const X = gql`...`
  if (value?.type === 'call_expression') {
    const fn = value.childForFieldName('function');
    if (fn?.text === 'gql') {
      const gqlResult = extractGqlTaggedTemplate(name, value, source);
      if (gqlResult) return gqlResult;
    }
  }

  const isArrowFn = value?.type === 'arrow_function';
  const isFunction = value?.type === 'function_expression' || value?.type === 'function';

  if (isArrowFn || isFunction) {
    const kind: SymbolKind = isReactComponent(name, value!) ? 'component' : isReactHook(name) ? 'hook' : 'function';
    const params = value!.childForFieldName('parameters');
    let signature = name;
    if (params) signature += params.text;
    const callSites = extractTsCallSites(value!);
    const jsxElements = extractJsxElements(value!);
    return {
      name,
      kind,
      visibility: 'public',
      signature,
      docComment: extractJsDoc(docNode ?? node, source),
      callSites: callSites.length > 0 ? callSites : undefined,
      jsxElements: jsxElements.length > 0 ? jsxElements : undefined,
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

function extractTsHeritage(node: Node, clauseType: string): string | undefined {
  // class_heritage → extends_clause/implements_clause → identifier
  const heritage = node.children.find(c => c.type === 'class_heritage');
  if (!heritage) return undefined;
  const clause = heritage.children.find(c => c.type === clauseType);
  if (!clause) return undefined;
  const typeId = clause.children.find(c => c.type === 'identifier' || c.type === 'type_identifier');
  return typeId?.text;
}

function extractTsHeritageList(node: Node, clauseType: string): string[] {
  const heritage = node.children.find(c => c.type === 'class_heritage');
  if (!heritage) return [];
  const clause = heritage.children.find(c => c.type === clauseType);
  if (!clause) return [];
  return clause.children
    .filter(c => c.type === 'identifier' || c.type === 'type_identifier')
    .map(c => c.text);
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

function extractTsCallSites(node: Node): Array<{ target: string; receiver?: string }> {
  const sites: Array<{ target: string; receiver?: string }> = [];
  walkTsForCalls(node, sites);
  return sites;
}

function walkTsForCalls(node: Node, sites: Array<{ target: string; receiver?: string }>): void {
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    if (fn) {
      if (fn.type === 'member_expression') {
        const obj = fn.childForFieldName('object');
        const prop = fn.childForFieldName('property');
        if (prop) {
          sites.push({ target: prop.text, receiver: obj?.text });
        }
      } else if (fn.type === 'identifier') {
        sites.push({ target: fn.text });
      }
    }
  }
  for (const child of node.children) {
    walkTsForCalls(child, sites);
  }
}

function extractJsxElements(node: Node): string[] {
  const elements: Set<string> = new Set();
  walkForJsx(node, elements);
  return [...elements];
}

function walkForJsx(node: Node, elements: Set<string>): void {
  if (node.type === 'jsx_self_closing_element' || node.type === 'jsx_opening_element') {
    const name = node.childForFieldName('name');
    if (name && /^[A-Z]/.test(name.text)) {
      elements.add(name.text);
    }
  }
  for (const child of node.children) {
    walkForJsx(child, elements);
  }
}

// ── gql tagged template extraction ──────────────────────────────────────

function extractGqlTaggedTemplate(
  varName: string,
  callNode: Node,
  _source: string,
): ExtractedSymbol | null {
  // Tagged template: gql`query GetUsers { users { id name } }`
  // Tree-sitter parses as call_expression with template_string as direct child
  const templateArg = callNode.children.find(c => c.type === 'template_string');
  if (!templateArg) return null;

  const content = templateArg.text.replace(/^`/, '').replace(/`$/, '').trim();
  return parseGqlContent(varName, content, callNode);
}

function parseGqlContent(
  varName: string,
  content: string,
  node: Node,
): ExtractedSymbol | null {
  // Parse operation type and fields from gql content
  const opMatch = content.match(/^\s*(query|mutation|subscription)\s+\w+\s*\{/);
  if (!opMatch) return null;

  const operationType = opMatch[1] as 'query' | 'mutation' | 'subscription';

  // Extract top-level field names from the operation body
  const fields: string[] = [];
  const bodyStart = content.indexOf('{');
  if (bodyStart >= 0) {
    const body = content.slice(bodyStart + 1);
    // Find top-level field names (before any nested braces)
    let depth = 0;
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '}') { depth--; if (depth < 0) break; continue; }
      if (depth === 0) {
        const fieldMatch = trimmed.match(/^(\w+)/);
        if (fieldMatch && fieldMatch[1] !== '}') {
          fields.push(fieldMatch[1]);
        }
      }
      if (trimmed.includes('{')) depth++;
    }
  }

  return {
    name: varName,
    kind: 'gql-operation',
    visibility: 'public',
    gqlOperationType: operationType,
    gqlFields: fields,
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  };
}

// ── API call extraction (fetch/axios) ───────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

function extractApiCallSymbols(root: Node, _source: string): ExtractedSymbol[] {
  const calls: ExtractedSymbol[] = [];
  walkForApiCalls(root, calls);
  return calls;
}

function walkForApiCalls(node: Node, calls: ExtractedSymbol[]): void {
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    const args = node.childForFieldName('arguments');

    if (fn && args) {
      let method: string | null = null;
      let isFetchLike = false;

      if (fn.type === 'identifier' && fn.text === 'fetch') {
        method = 'GET';
        isFetchLike = true;
      } else if (fn.type === 'member_expression') {
        const prop = fn.childForFieldName('property');
        if (prop && HTTP_METHODS.has(prop.text)) {
          method = prop.text.toUpperCase();
          isFetchLike = true;
        }
      }

      if (isFetchLike && method) {
        const urlArg = args.children.find(c =>
          c.type === 'string' || c.type === 'template_string'
        );

        if (urlArg) {
          const path = extractUrlPath(urlArg);
          if (path && path.startsWith('/')) {
            const funcParent = findParentFunction(node);
            const name = funcParent ?? `api_call_${node.startPosition.row + 1}`;
            calls.push({
              name,
              kind: 'api-call',
              visibility: 'public',
              apiMethod: method,
              apiPath: path,
              location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
            });
          }
        }
      }
    }
  }

  for (const child of node.children) {
    walkForApiCalls(child, calls);
  }
}

function extractUrlPath(node: Node): string | null {
  if (node.type === 'string') {
    return node.text.replace(/^['"]/, '').replace(/['"]$/, '');
  }
  if (node.type === 'template_string') {
    // Extract static prefix from template literal: `/api/users/${id}` → `/api/users/{param}`
    const content = node.text.replace(/^`/, '').replace(/`$/, '');
    const parts = content.split(/\$\{[^}]*\}/);
    let result = parts[0];
    for (let i = 1; i < parts.length; i++) {
      result += '{param}' + parts[i];
    }
    return result.replace(/\/$/, '');
  }
  return null;
}

function findParentFunction(node: Node): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'function_declaration') {
      return current.childForFieldName('name')?.text ?? null;
    }
    if (current.type === 'variable_declarator') {
      return current.childForFieldName('name')?.text ?? null;
    }
    current = current.parent;
  }
  return null;
}
