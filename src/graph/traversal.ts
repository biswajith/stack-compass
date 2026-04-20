import * as fs from 'fs';
import type { GraphStore, NodeRow } from './store.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface TraversalEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
  edgeKind: string;
  depth: number;
}

export interface ImpactResult {
  nodes: Array<{ name: string; kind: string; file: string; line: number; edgeKind: string; depth: number }>;
  directCount: number;
  transitiveCount: number;
}

export interface ContextEntry {
  name: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  module: string | null;
  signature: string | null;
  source?: string;
}

// ── get-callers: reverse BFS on "calls" edges ────────────────────────────

const MAX_TRAVERSAL_DEPTH = 10;

export function getCallers(store: GraphStore, symbolName: string, depth: number = 2, module?: string): TraversalEntry[] {
  const seedNodes = store.getNodesByName(symbolName, module ? { module } : undefined);
  if (seedNodes.length === 0) return [];

  return bfsTraverse(store, seedNodes.map(n => n.id), Math.min(depth, MAX_TRAVERSAL_DEPTH), 'reverse', ['calls']);
}

// ── get-callees: forward BFS on "calls" edges ───────────────────────────

export function getCallees(store: GraphStore, symbolName: string, depth: number = 2, module?: string): TraversalEntry[] {
  const seedNodes = store.getNodesByName(symbolName, module ? { module } : undefined);
  if (seedNodes.length === 0) return [];

  return bfsTraverse(store, seedNodes.map(n => n.id), Math.min(depth, MAX_TRAVERSAL_DEPTH), 'forward', ['calls']);
}

// ── get-impact: reverse BFS on ALL edge types ───────────────────────────

export function getImpact(store: GraphStore, symbolName: string, depth: number = 3, module?: string): ImpactResult {
  const seedNodes = store.getNodesByName(symbolName, module ? { module } : undefined);
  if (seedNodes.length === 0) return { nodes: [], directCount: 0, transitiveCount: 0 };

  // Also include children of the symbol (e.g., methods of a class)
  const seedIds = new Set<number>();
  for (const n of seedNodes) {
    seedIds.add(n.id);
    const children = store.getChildNodes(n.id);
    for (const c of children) seedIds.add(c.id);
  }

  const entries = bfsTraverse(store, [...seedIds], Math.min(depth, MAX_TRAVERSAL_DEPTH), 'reverse', null);

  let directCount = 0;
  let transitiveCount = 0;
  for (const e of entries) {
    if (e.depth === 1) directCount++;
    transitiveCount++;
  }

  return {
    nodes: entries,
    directCount,
    transitiveCount,
  };
}

// ── build-context: task-driven context assembly ─────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their',
  'this', 'that', 'these', 'those',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
  'into', 'about', 'between', 'through', 'during', 'before', 'after',
  'up', 'down', 'out', 'off', 'over', 'under', 'again',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any', 'no',
  'just', 'very', 'also', 'too', 'only',
  'fix', 'add', 'update', 'change', 'remove', 'refactor', 'implement',
  'delete', 'modify', 'make', 'move', 'rename', 'write',
  'check', 'find', 'look', 'get', 'set', 'new',
]);

export function extractTerms(task: string): string[] {
  return task
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

const KIND_BOOST: Record<string, number> = {
  class: 2,
  interface: 2,
  component: 2,
  enum: 1,
  method: 0,
  function: 0,
  field: 0,
  hook: 1,
  type: 1,
};

export function buildContext(store: GraphStore, task: string, maxNodes: number = 20): ContextEntry[] {
  // Step 1: Term extraction
  const terms = extractTerms(task);
  if (terms.length === 0) return [];

  // Step 2: Seed search via FTS5 (terms are pre-sanitized by extractTerms)
  const ftsQuery = terms.map(t => `"${t}"`).join(' OR ');
  let seeds: import('./store.js').SearchResult[];
  try {
    seeds = store.searchSymbols(ftsQuery, { limit: 10, rawFts: true });
  } catch {
    return [];
  }
  if (seeds.length === 0) return [];

  // Step 3: Graph expansion — BFS from each seed, depth 2, all edge types
  const visited = new Map<number, { depth: number; seedRank: number }>();
  for (let i = 0; i < seeds.length; i++) {
    const seedId = seeds[i].id;
    if (!visited.has(seedId)) {
      visited.set(seedId, { depth: 0, seedRank: i });
    }
    bfsExpand(store, seedId, 2, visited, i);
  }

  // Step 4: Scoring
  const scored: Array<ContextEntry & { nodeId: number }> = [];
  for (const [nodeId, info] of visited) {
    const node = store.getNodeById(nodeId);
    if (!node) continue;
    const file = store.getFileById(node.file_id);

    const ftsRank = info.depth === 0 ? (10 - info.seedRank) : 0;
    const edgeProximity = 1 / (info.depth + 1);
    const kindBoost = KIND_BOOST[node.kind] ?? 0;
    const restEndpoints = store.getRestEndpointsByNodeId(nodeId);
    const restBoost = restEndpoints.length > 0 ? 3 : 0;
    const score = ftsRank * 3 + edgeProximity + kindBoost + restBoost;

    scored.push({
      nodeId,
      name: node.name,
      kind: node.kind,
      file: file?.path ?? '?',
      startLine: node.start_line,
      endLine: node.end_line,
      score,
      module: node.module,
      signature: node.signature,
    });
  }

  // Step 5: Budget enforcement — sort by score desc, take maxNodes
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, maxNodes);

  // Step 6: Source assembly
  for (const entry of selected) {
    try {
      const lines = fs.readFileSync(entry.file, 'utf-8').split('\n');
      const start = Math.max(0, entry.startLine - 1);
      const end = Math.min(lines.length, entry.endLine);
      entry.source = lines.slice(start, end).join('\n');
    } catch {
      // File not on disk — skip source
    }
  }

  return selected;
}

// ── BFS traversal core ──────────────────────────────────────────────────

function bfsTraverse(
  store: GraphStore,
  seedIds: number[],
  maxDepth: number,
  direction: 'forward' | 'reverse',
  edgeKindFilter: string[] | null,
): TraversalEntry[] {
  const visited = new Set<number>(seedIds);
  const result: TraversalEntry[] = [];
  let frontier = seedIds;

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier: number[] = [];

    for (const nodeId of frontier) {
      const edges = direction === 'forward'
        ? store.getEdgesFrom(nodeId)
        : store.getEdgesTo(nodeId);

      for (const edge of edges) {
        if (edgeKindFilter && !edgeKindFilter.includes(edge.kind)) continue;

        const neighborId = direction === 'forward' ? edge.target_id : edge.source_id;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighbor = store.getNodeById(neighborId);
        if (!neighbor) continue;

        const file = store.getFileById(neighbor.file_id);

        result.push({
          name: neighbor.name,
          kind: neighbor.kind,
          file: file?.path ?? '?',
          line: neighbor.start_line,
          edgeKind: edge.kind,
          depth: d,
        });

        nextFrontier.push(neighborId);
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return result;
}

function bfsExpand(
  store: GraphStore,
  seedId: number,
  maxDepth: number,
  visited: Map<number, { depth: number; seedRank: number }>,
  seedRank: number,
): void {
  let frontier = [seedId];

  for (let d = 1; d <= maxDepth; d++) {
    const next: number[] = [];

    for (const nodeId of frontier) {
      // Expand in both directions for context
      const outEdges = store.getEdgesFrom(nodeId);
      const inEdges = store.getEdgesTo(nodeId);

      for (const edge of [...outEdges, ...inEdges]) {
        const neighborId = edge.source_id === nodeId ? edge.target_id : edge.source_id;
        if (visited.has(neighborId)) continue;
        visited.set(neighborId, { depth: d, seedRank });
        next.push(neighborId);
      }
    }

    frontier = next;
    if (frontier.length === 0) break;
  }
}
