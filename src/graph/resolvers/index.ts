import type { GraphStore } from '../store.js';
import { resolveImportEdges } from './import-resolver.js';
import { resolveInheritanceEdges } from './inheritance-resolver.js';
import { resolveCallEdges } from './call-resolver.js';
import { resolveReactEdges } from './react-resolver.js';

export function resolveAllEdges(store: GraphStore): void {
  resolveImportEdges(store);
  resolveInheritanceEdges(store);
  resolveCallEdges(store);
  resolveReactEdges(store);
}

export { resolveImportEdges, resolveInheritanceEdges, resolveCallEdges, resolveReactEdges };
