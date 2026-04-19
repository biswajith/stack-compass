import type { GraphStore } from '../store.js';

export function normalizePath(urlPath: string): string {
  return urlPath
    .replace(/\/+$/, '')                    // strip trailing slash
    .replace(/:(\w+)/g, '{param}')          // :id → {param}
    .replace(/\{[^}]+\}/g, '{param}');      // {id} → {param}
}

/**
 * Matches TS api-call nodes (fetch/axios) to Java REST endpoints by URL path.
 * Creates `rest_match` edges.
 */
export function resolveRestEdges(store: GraphStore): void {
  const allFiles = store.getAllFiles();

  // Collect all REST endpoints from the rest_endpoints table
  const restEndpoints: Array<{ node_id: number; method: string; path: string }> = [];
  for (const file of allFiles) {
    const nodes = store.getAllNodesByFileId(file.id);
    for (const node of nodes) {
      const eps = store.getRestEndpointsByNodeId(node.id);
      for (const ep of eps) {
        restEndpoints.push({ node_id: node.id, method: ep.method, path: ep.path });
      }
    }
  }

  if (restEndpoints.length === 0) return;

  // Build normalized path → endpoint map
  const normalizedEndpoints = restEndpoints.map(ep => ({
    ...ep,
    normalizedPath: normalizePath(ep.path),
  }));

  // Find all api-call nodes
  for (const file of allFiles) {
    const nodes = store.getAllNodesByFileId(file.id);
    for (const node of nodes) {
      if (node.kind !== 'api-call' || !node.api_path) continue;

      const callNormalized = normalizePath(node.api_path);
      const callMethod = node.api_method ?? 'GET';

      for (const ep of normalizedEndpoints) {
        const methodMatches = ep.method === callMethod;
        const pathMatches = ep.normalizedPath === callNormalized
          || callNormalized.startsWith(ep.normalizedPath + '/');

        if (methodMatches && pathMatches) {
          store.insertEdge(node.id, ep.node_id, 'rest_match', null);
        }
      }
    }
  }
}
