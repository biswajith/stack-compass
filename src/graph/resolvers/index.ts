import type { GraphStore } from '../store.js';
import { resolveImportEdges } from './import-resolver.js';
import { resolveInheritanceEdges } from './inheritance-resolver.js';
import { resolveCallEdges } from './call-resolver.js';
import { resolveReactEdges } from './react-resolver.js';
import { resolveGraphqlEdges } from './graphql-resolver.js';
import { resolveRestEdges } from './rest-resolver.js';
import { resolveSpringEdges } from './spring-resolver.js';

const RESOLVER_EDGE_KINDS = [
  'imports', 'extends', 'implements',
  'calls', 'renders', 'hook_calls',
  'gql_resolves', 'rest_match', 'type_match', 'injects',
];

export function resolveAllEdges(store: GraphStore): void {
  store.deleteEdgesByKinds(RESOLVER_EDGE_KINDS);
  resolveImportEdges(store);
  resolveInheritanceEdges(store);
  resolveCallEdges(store);
  resolveReactEdges(store);
  resolveGraphqlEdges(store);
  resolveRestEdges(store);
  resolveSpringEdges(store);
}

export { resolveImportEdges, resolveInheritanceEdges, resolveCallEdges, resolveReactEdges,
  resolveGraphqlEdges, resolveRestEdges, resolveSpringEdges };
