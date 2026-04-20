import type { GraphStore } from '../store.js';

export function resolveCallEdges(store: GraphStore): void {
  const allFiles = store.getAllFiles();

  for (const file of allFiles) {
    const nodes = store.getAllNodesByFileId(file.id);
    for (const node of nodes) {
      resolveNodeCalls(store, node.id);
    }
  }
}

function resolveNodeCalls(store: GraphStore, nodeId: number): void {
  const callSites = store.getCallSites(nodeId);

  for (const cs of callSites) {
    const targetId = resolveCallTarget(store, cs.target, cs.receiver, nodeId);
    if (targetId !== null) {
      store.insertEdge(nodeId, targetId, 'calls', cs.receiver ?? null);
    }
  }
}

function resolveCallTarget(
  store: GraphStore,
  target: string,
  receiver: string | null,
  sourceNodeId: number,
): number | null {
  if (receiver) {
    // receiver.target() — look for a method named `target` inside a class
    // that matches the receiver type (heuristic: match by receiver name as class)
    return resolveMethodOnReceiver(store, target, receiver, sourceNodeId);
  }

  // Unqualified call — look for a function/hook by name in the graph
  const matches = store.getNodesByName(target);
  if (matches.length === 1) return matches[0].id;

  // Disambiguate: prefer nodes in the same module
  const sourceNode = store.getNodeById(sourceNodeId);
  if (sourceNode?.module) {
    const sameModule = matches.filter(m => m.module === sourceNode.module);
    if (sameModule.length === 1) return sameModule[0].id;
  }

  return null;
}

function resolveMethodOnReceiver(
  store: GraphStore,
  methodName: string,
  receiverName: string,
  sourceNodeId: number,
): number | null {
  const sourceNode = store.getNodeById(sourceNodeId);
  const capitalReceiver = receiverName.charAt(0).toUpperCase() + receiverName.slice(1);

  // Strategy 1: Exact class name match
  const exactMatches = store.getNodesByName(receiverName);
  // Strategy 2: Capitalized name (e.g., "service" → "Service")
  const capitalMatches = store.getNodesByName(capitalReceiver);
  // Strategy 3: Suffix match — find classes whose name ends with capitalized receiver
  // e.g., "repository" → "UserRepository", "service" → "UserService"
  const suffixMatches = store.getNodesByNameSuffix(capitalReceiver);

  const candidates = dedup([...exactMatches, ...capitalMatches, ...suffixMatches]);

  // Prefer same-module candidates
  for (const cls of candidates) {
    if (sourceNode?.module && cls.module === sourceNode.module) {
      const methods = store.getChildNodes(cls.id);
      const method = methods.find(m => m.name === methodName);
      if (method) return method.id;
    }
  }

  // Fall back to any candidate
  for (const cls of candidates) {
    const methods = store.getChildNodes(cls.id);
    const method = methods.find(m => m.name === methodName);
    if (method) return method.id;
  }

  // Strategy 4: Direct method name search (no receiver context)
  const directMethods = store.getNodesByName(methodName, { kind: 'method' });
  if (directMethods.length === 1) return directMethods[0].id;
  if (sourceNode?.module) {
    const sameModule = directMethods.filter(m => m.module === sourceNode.module);
    if (sameModule.length === 1) return sameModule[0].id;
  }

  return null;
}

function dedup(nodes: import('../store.js').NodeRow[]): import('../store.js').NodeRow[] {
  const seen = new Set<number>();
  return nodes.filter(n => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}
