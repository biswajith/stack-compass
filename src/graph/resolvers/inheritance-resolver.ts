import type { GraphStore, NodeRow } from '../store.js';

export function resolveInheritanceEdges(store: GraphStore): void {
  const allFiles = store.getAllFiles();

  for (const file of allFiles) {
    const nodes = store.getTopLevelNodesByFileId(file.id);

    for (const node of nodes) {
      resolveNodeInheritance(store, node);
      resolveChildrenInheritance(store, node);
    }
  }
}

function resolveNodeInheritance(store: GraphStore, node: NodeRow): void {
  if (node.extends_name) {
    const targets = store.getNodesByName(node.extends_name);
    if (targets.length === 1) {
      store.insertEdge(node.id, targets[0].id, 'extends', null);
    } else if (targets.length > 1) {
      // Disambiguate by same module
      const sameModule = targets.find(t => t.module === node.module);
      if (sameModule) {
        store.insertEdge(node.id, sameModule.id, 'extends', null);
      }
    }
  }

  if (node.implements_names) {
    try {
      const names: string[] = JSON.parse(node.implements_names);
      for (const name of names) {
        const targets = store.getNodesByName(name);
        if (targets.length === 1) {
          store.insertEdge(node.id, targets[0].id, 'implements', null);
        } else if (targets.length > 1) {
          const sameModule = targets.find(t => t.module === node.module);
          if (sameModule) {
            store.insertEdge(node.id, sameModule.id, 'implements', null);
          }
        }
      }
    } catch {
      // malformed JSON — skip
    }
  }
}

function resolveChildrenInheritance(store: GraphStore, parent: NodeRow, visited = new Set<number>()): void {
  if (visited.has(parent.id)) return;
  visited.add(parent.id);
  const children = store.getChildNodes(parent.id);
  for (const child of children) {
    resolveNodeInheritance(store, child);
    resolveChildrenInheritance(store, child, visited);
  }
}
