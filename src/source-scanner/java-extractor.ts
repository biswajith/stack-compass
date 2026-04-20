import type { Tree, Node } from './parser.js';
import type { ExtractedSymbol, SymbolKind, RestEndpoint, GqlResolverInfo } from './types.js';

export function extractJavaSymbols(tree: Tree, source: string): { symbols: ExtractedSymbol[]; packageName?: string; imports: string[]; restEndpoints: RestEndpoint[]; gqlResolvers: GqlResolverInfo[] } {
  const root = tree.rootNode;
  const symbols: ExtractedSymbol[] = [];
  const imports: string[] = [];
  const restEndpoints: RestEndpoint[] = [];
  const gqlResolvers: GqlResolverInfo[] = [];
  let packageName: string | undefined;

  for (const child of root.children) {
    if (child.type === 'package_declaration') {
      const scope = child.childForFieldName('name') ?? child.children.find(c => c.type === 'scoped_identifier');
      if (scope) packageName = scope.text;
    }
    if (child.type === 'import_declaration') {
      const path = child.children.find(c => c.type === 'scoped_identifier');
      if (path) imports.push(path.text);
    }
    if (child.type === 'class_declaration' || child.type === 'interface_declaration' || child.type === 'enum_declaration' || child.type === 'annotation_type_declaration') {
      const sym = extractClassLike(child, source, restEndpoints, gqlResolvers);
      if (sym) symbols.push(sym);
    }
  }

  return { symbols, packageName, imports, restEndpoints, gqlResolvers };
}

function extractClassLike(node: Node, source: string, restEndpoints: RestEndpoint[], gqlResolvers: GqlResolverInfo[]): ExtractedSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  const kind = mapJavaKind(node.type);
  const visibility = extractVisibility(node);
  if (visibility === 'private') return null;

  const annotations = extractAnnotations(node);
  const docComment = extractDocComment(node, source);
  const extendsName = extractSuperclass(node);
  const implementsList = extractInterfaces(node);
  const children: ExtractedSymbol[] = [];

  // Extract class-level @RequestMapping prefix for REST path composition
  const classPrefix = extractClassRequestMappingPrefix(annotations);

  const body = node.childForFieldName('body');
  if (body) {
    for (const member of body.children) {
      if (member.type === 'method_declaration' || member.type === 'constructor_declaration') {
        const methodSym = extractMethod(member, source);
        if (methodSym) {
          children.push(methodSym);
          const ep = extractRestEndpoint(member, nameNode.text, classPrefix);
          if (ep) restEndpoints.push(ep);
          const gqlInfo = extractGqlResolverInfo(member);
          if (gqlInfo) gqlResolvers.push(gqlInfo);
        }
      }
      if (member.type === 'field_declaration') {
        const fieldSym = extractField(member, source);
        if (fieldSym) children.push(fieldSym);
      }
      if (member.type === 'enum_constant') {
        children.push({
          name: member.childForFieldName('name')?.text ?? member.text,
          kind: 'constant',
          visibility: 'public',
          location: { startLine: member.startPosition.row + 1, endLine: member.endPosition.row + 1 },
        });
      }
    }
  }

  return {
    name: nameNode.text,
    kind,
    visibility,
    annotations,
    docComment,
    extends: extendsName,
    implements: implementsList.length > 0 ? implementsList : undefined,
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    children: children.length > 0 ? children : undefined,
  };
}

function extractMethod(node: Node, source: string): ExtractedSymbol | null {
  const nameNode = node.childForFieldName('name') ?? (node.type === 'constructor_declaration' ? node.childForFieldName('name') : null);
  const visibility = extractVisibility(node);
  if (visibility === 'private') return null;

  const kind: SymbolKind = node.type === 'constructor_declaration' ? 'constructor' : 'method';
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('type');

  let signature = '';
  if (returnType) signature += returnType.text + ' ';
  signature += (nameNode?.text ?? '<init>');
  if (params) signature += params.text;

  const callSites = extractCallSites(node);

  return {
    name: nameNode?.text ?? '<init>',
    kind,
    visibility,
    signature,
    annotations: extractAnnotations(node),
    docComment: extractDocComment(node, source),
    callSites: callSites.length > 0 ? callSites : undefined,
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  };
}

function extractCallSites(node: Node): Array<{ target: string; receiver?: string }> {
  const sites: Array<{ target: string; receiver?: string }> = [];
  walkForCalls(node, sites);
  return sites;
}

function walkForCalls(node: Node, sites: Array<{ target: string; receiver?: string }>): void {
  if (node.type === 'method_invocation') {
    const obj = node.childForFieldName('object');
    const name = node.childForFieldName('name');
    if (name) {
      sites.push({
        target: name.text,
        receiver: obj?.text,
      });
    }
  }
  for (const child of node.children) {
    walkForCalls(child, sites);
  }
}

function extractField(node: Node, source: string): ExtractedSymbol | null {
  const visibility = extractVisibility(node);
  if (visibility === 'private') return null;

  const declarator = node.children.find(c => c.type === 'variable_declarator');
  const typeNode = node.childForFieldName('type');
  const name = declarator?.childForFieldName('name')?.text ?? 'unknown';

  return {
    name,
    kind: 'field',
    visibility,
    signature: typeNode ? `${typeNode.text} ${name}` : name,
    annotations: extractAnnotations(node),
    docComment: extractDocComment(node, source),
    location: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  };
}

function extractSuperclass(node: Node): string | undefined {
  const superclass = node.childForFieldName('superclass');
  if (!superclass) return undefined;

  // Direct type_identifier (no generics)
  const directType = superclass.children.find(c => c.type === 'type_identifier');
  if (directType) return directType.text;

  // generic_type → type_identifier (strip type arguments)
  const genericType = superclass.children.find(c => c.type === 'generic_type');
  if (genericType) {
    const inner = genericType.children.find(c => c.type === 'type_identifier');
    return inner?.text;
  }

  return undefined;
}

function extractInterfaces(node: Node): string[] {
  const ifaces = node.childForFieldName('interfaces');
  if (!ifaces) return [];
  const typeList = ifaces.children.find(c => c.type === 'type_list');
  if (!typeList) return [];
  return typeList.children
    .filter(c => c.type === 'type_identifier' || c.type === 'generic_type')
    .map(c => c.type === 'generic_type' ? (c.children.find(g => g.type === 'type_identifier')?.text ?? c.text) : c.text);
}

function mapJavaKind(type: string): SymbolKind {
  switch (type) {
    case 'class_declaration': return 'class';
    case 'interface_declaration': return 'interface';
    case 'enum_declaration': return 'enum';
    case 'annotation_type_declaration': return 'annotation';
    default: return 'class';
  }
}

function extractVisibility(node: Node): ExtractedSymbol['visibility'] {
  for (const child of node.children) {
    if (child.type === 'modifiers') {
      const text = child.text;
      if (text.includes('public')) return 'public';
      if (text.includes('protected')) return 'protected';
      if (text.includes('private')) return 'private';
    }
  }
  return 'default';
}

function extractAnnotations(node: Node): string[] {
  const annotations: string[] = [];
  for (const child of node.children) {
    if (child.type === 'modifiers') {
      for (const mod of child.children) {
        if (mod.type === 'marker_annotation' || mod.type === 'annotation') {
          annotations.push(mod.text);
        }
      }
    }
  }
  return annotations.length > 0 ? annotations : [];
}

function extractDocComment(node: Node, _source: string): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev && (prev.type === 'block_comment' || prev.type === 'comment') && prev.text.startsWith('/**')) {
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

const REQUEST_MAPPING_METHODS = new Set([
  '@RequestMapping', '@GetMapping', '@PostMapping', '@PutMapping', '@DeleteMapping', '@PatchMapping',
]);

function extractClassRequestMappingPrefix(classAnnotations: string[]): string {
  for (const ann of classAnnotations) {
    if (ann.startsWith('@RequestMapping')) {
      const pathMatch = ann.match(/(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["']/);
      if (pathMatch) return pathMatch[1].replace(/\/$/, '');
    }
  }
  return '';
}

function extractRestEndpoint(node: Node, className: string, classPrefix: string = ''): RestEndpoint | null {
  const annotations = extractAnnotations(node);
  for (const ann of annotations) {
    for (const mapping of REQUEST_MAPPING_METHODS) {
      if (ann.startsWith(mapping)) {
        const method = mapping === '@RequestMapping'
          ? extractMappingMethod(ann) ?? 'ANY'
          : mapping.replace('@', '').replace('Mapping', '').toUpperCase();

        const pathMatch = ann.match(/(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["']/);
        const methodPath = pathMatch?.[1] ?? '/';
        const fullPath = classPrefix + methodPath;
        const handlerName = node.childForFieldName('name')?.text ?? 'unknown';

        return { method, path: fullPath, handler: `${className}.${handlerName}`, file: '' };
      }
    }
  }
  return null;
}

function extractMappingMethod(annotation: string): string | null {
  const methodMatch = annotation.match(/method\s*=\s*RequestMethod\.(\w+)/);
  return methodMatch ? methodMatch[1] : null;
}

// ── GQL resolver annotation extraction ──────────────────────────────────

const GQL_RESOLVER_ANNOTATIONS: Record<string, { defaultParentType: string; operationType: 'query' | 'mutation' | 'subscription' }> = {
  '@DgsQuery':        { defaultParentType: 'Query',        operationType: 'query' },
  '@DgsMutation':     { defaultParentType: 'Mutation',     operationType: 'mutation' },
  '@QueryMapping':    { defaultParentType: 'Query',        operationType: 'query' },
  '@MutationMapping': { defaultParentType: 'Mutation',     operationType: 'mutation' },
  '@DgsData':         { defaultParentType: 'Query',        operationType: 'query' },
  '@SchemaMapping':   { defaultParentType: 'Query',        operationType: 'query' },
};

function extractGqlResolverInfo(node: Node): GqlResolverInfo | null {
  const annotations = extractAnnotations(node);
  const methodName = node.childForFieldName('name')?.text ?? 'unknown';

  for (const ann of annotations) {
    for (const [prefix, defaults] of Object.entries(GQL_RESOLVER_ANNOTATIONS)) {
      if (!ann.startsWith(prefix)) continue;

      let fieldName = methodName;
      let parentType = defaults.defaultParentType;
      let operationType = defaults.operationType;

      // Extract explicit field name from annotation params
      const fieldMatch = ann.match(/field\s*=\s*["']([^"']+)["']/);
      if (fieldMatch) fieldName = fieldMatch[1];

      // Extract explicit parentType/typeName
      const parentMatch = ann.match(/(?:parentType|typeName)\s*=\s*["']([^"']+)["']/);
      if (parentMatch) {
        parentType = parentMatch[1];
        if (parentType === 'Mutation') operationType = 'mutation';
        else if (parentType === 'Subscription') operationType = 'subscription';
      }

      return { methodName, fieldName, parentType, operationType };
    }
  }
  return null;
}
