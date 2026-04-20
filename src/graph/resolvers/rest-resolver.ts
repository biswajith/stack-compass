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
  // Bulk query: single SELECT instead of per-node queries
  const restEndpoints = store.getAllRestEndpoints();
  if (restEndpoints.length === 0) return;

  const normalizedEndpoints = restEndpoints.map(ep => ({
    ...ep,
    normalizedPath: normalizePath(ep.path),
  }));

  // Bulk query: get all api-call nodes in one pass
  const apiCalls = store.getApiCalls();

  for (const call of apiCalls) {
    if (!call.path) continue;

    const callNormalized = normalizePath(call.path);
    const callMethod = call.method ?? 'GET';

    for (const ep of normalizedEndpoints) {
      const methodMatches = ep.method === callMethod || ep.method === 'ANY';
      const pathMatches = ep.normalizedPath === callNormalized
        || callNormalized.startsWith(ep.normalizedPath + '/');

      if (methodMatches && pathMatches) {
        store.insertEdge(call.node_id, ep.node_id, 'rest_match', null);
      }
    }
  }
}
