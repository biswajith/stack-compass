import * as path from 'path';
import type { GraphStore } from '../store.js';

export function resolveImportEdges(store: GraphStore): void {
  const allFiles = store.getAllFiles();

  for (const file of allFiles) {
    const imports = store.getFileImports(file.id);
    if (imports.length === 0) continue;

    const sourceNodes = store.getNodesByFileId(file.id);
    if (sourceNodes.length === 0) continue;

    // Use the first top-level node in the file as the edge source
    // (typically the class/component that owns these imports)
    const sourceNode = sourceNodes[0];

    for (const imp of imports) {
      // Wildcard imports handle edge insertion internally
      if (imp.endsWith('.*')) {
        resolveWildcardImport(store, imp, sourceNode.id);
        continue;
      }
      const resolved = resolveImportTarget(store, imp, file.path, allFiles);
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
  allFiles: Array<{ id: number; path: string }>,
): number | null {
  // Java-style: fully qualified name like "com.acme.UserService"
  if (importPath.includes('.') && !importPath.startsWith('.') && !importPath.startsWith('/')) {
    return resolveByQualifiedName(store, importPath);
  }

  // TS-style: relative path like "./UserList" or "../hooks/useAuth"
  if (importPath.startsWith('.')) {
    return resolveByRelativePath(store, importPath, sourceFilePath, allFiles);
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
  allFiles: Array<{ id: number; path: string }>,
): number | null {
  const sourceDir = path.dirname(sourceFilePath);
  const resolved = path.resolve(sourceDir, importPath);

  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

  for (const ext of extensions) {
    const candidate = resolved + ext;
    const file = allFiles.find(f => f.path === candidate);
    if (file) {
      const nodes = store.getNodesByFileId(file.id);
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
): void {
  const packagePrefix = wildcardImport.slice(0, -2); // strip ".*"
  const allFiles = store.getAllFiles();

  for (const file of allFiles) {
    const nodes = store.getNodesByFileId(file.id);
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
