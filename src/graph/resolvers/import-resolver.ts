import * as path from 'path';
import type { GraphStore } from '../store.js';

export function resolveImportEdges(store: GraphStore): void {
  const allFiles = store.getAllFiles();
  const fileIndex = new Map(allFiles.map(f => [f.path, f]));

  for (const file of allFiles) {
    const imports = store.getFileImports(file.id);
    if (imports.length === 0) continue;

    const sourceNodes = store.getTopLevelNodesByFileId(file.id);
    if (sourceNodes.length === 0) continue;

    const sourceNode = sourceNodes[0];

    for (const imp of imports) {
      if (imp.endsWith('.*')) {
        resolveWildcardImport(store, imp, sourceNode.id, allFiles);
        continue;
      }
      const resolved = resolveImportTarget(store, imp, file.path, fileIndex);
      if (resolved !== null) {
        store.insertEdge(sourceNode.id, resolved, 'imports', null);
      }
    }
  }
}

function resolveImportTarget(
  store: GraphStore,
  importPath: string,
  sourceFilePath: string,
  fileIndex: Map<string, { id: number; path: string }>,
): number | null {
  if (importPath.includes('.') && !importPath.startsWith('.') && !importPath.startsWith('/')) {
    return resolveByQualifiedName(store, importPath);
  }

  if (importPath.startsWith('.')) {
    return resolveByRelativePath(store, importPath, sourceFilePath, fileIndex);
  }

  return null;
}

function resolveByQualifiedName(store: GraphStore, qualifiedName: string): number | null {
  // Try exact match on qualified name
  const nodes = store.searchSymbols(qualifiedName.split('.').pop() ?? qualifiedName, { limit: 20 });
  for (const node of nodes) {
    if (node.qualified === qualifiedName) {
      return node.id;
    }
  }

  // Try matching the last part of the import as a class name
  const simpleName = qualifiedName.split('.').pop();
  if (simpleName) {
    const byName = store.getNodesByName(simpleName);
    for (const n of byName) {
      if (n.qualified === qualifiedName) return n.id;
    }
    // Fallback: match by simple name if only one result
    if (byName.length === 1) return byName[0].id;
  }

  return null;
}

function resolveByRelativePath(
  store: GraphStore,
  importPath: string,
  sourceFilePath: string,
  fileIndex: Map<string, { id: number; path: string }>,
): number | null {
  const sourceDir = path.dirname(sourceFilePath);
  const resolved = path.resolve(sourceDir, importPath);

  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

  for (const ext of extensions) {
    const candidate = resolved + ext;
    const file = fileIndex.get(candidate);
    if (file) {
      const nodes = store.getTopLevelNodesByFileId(file.id);
      if (nodes.length > 0) return nodes[0].id;
    }
  }

  return null;
}

/**
 * Resolve Java wildcard imports like "com.acme.services.*"
 * Creates an import edge for every top-level node whose package matches.
 */
function resolveWildcardImport(
  store: GraphStore,
  wildcardImport: string,
  sourceNodeId: number,
  allFiles: Array<{ id: number; path: string }>,
): void {
  const packagePrefix = wildcardImport.slice(0, -2);

  for (const file of allFiles) {
    const nodes = store.getTopLevelNodesByFileId(file.id);
    for (const node of nodes) {
      if (node.qualified && node.qualified.startsWith(packagePrefix + '.')) {
        const remainder = node.qualified.slice(packagePrefix.length + 1);
        if (!remainder.includes('.')) {
          store.insertEdge(sourceNodeId, node.id, 'imports', null);
        }
      }
    }
  }
}
