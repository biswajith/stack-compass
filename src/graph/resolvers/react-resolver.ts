import type { GraphStore } from '../store.js';

export function resolveReactEdges(store: GraphStore): void {
  const allFiles = store.getAllFiles();

  for (const file of allFiles) {
    const nodes = store.getAllNodesByFileId(file.id);
    for (const node of nodes) {
      resolveJsxUsages(store, node.id);
    }
  }
}

function resolveJsxUsages(store: GraphStore, nodeId: number): void {
  const usages = store.getJsxUsages(nodeId);

  for (const elementName of usages) {
    // Only resolve PascalCase names (user components), skip HTML elements
    if (elementName[0] !== elementName[0].toUpperCase()) continue;

    const targetId = resolveComponent(store, elementName, nodeId);
    if (targetId !== null) {
      store.insertEdge(nodeId, targetId, 'renders', null);
    }
  }
}

function resolveComponent(
  store: GraphStore,
  componentName: string,
  sourceNodeId: number,
): number | null {
  const matches = store.getNodesByName(componentName);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].id;

  // Disambiguate by module
  const sourceNode = store.getNodeById(sourceNodeId);
  if (sourceNode?.module) {
    const sameModule = matches.filter(m => m.module === sourceNode.module);
    if (sameModule.length === 1) return sameModule[0].id;
  }

  return null;
}
