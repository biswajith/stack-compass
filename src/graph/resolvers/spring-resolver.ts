import type { GraphStore } from '../store.js';

const INJECTABLE_ANNOTATIONS = new Set(['Autowired', 'Inject']);
const IMPL_ANNOTATIONS = new Set(['Service', 'Component', 'Repository']);

/**
 * Resolves Spring dependency injection:
 * @Autowired fields → find the @Service/@Repository class that implements the field type.
 * Creates `injects` edges from the containing class to the implementation class.
 */
export function resolveSpringEdges(store: GraphStore): void {
  const allFiles = store.getAllFiles();

  for (const file of allFiles) {
    const topNodes = store.getNodesByFileId(file.id);
    for (const cls of topNodes) {
      if (cls.kind !== 'class') continue;

      const children = store.getChildNodes(cls.id);
      for (const field of children) {
        if (field.kind !== 'field') continue;

        const annotations = store.getAnnotations(field.id);
        const isInjectable = annotations.some(a => INJECTABLE_ANNOTATIONS.has(a.name));
        if (!isInjectable) continue;

        // Extract the type name from the field signature (e.g., "UserRepository repository")
        const typeName = extractFieldType(field.signature);
        if (!typeName) continue;

        // Find implementation class
        const implId = findImplementation(store, typeName);
        if (implId !== null) {
          store.insertEdge(cls.id, implId, 'injects', typeName);
        }
      }
    }
  }
}

function extractFieldType(signature: string | null): string | null {
  if (!signature) return null;
  // "UserRepository repository" → "UserRepository"
  const parts = signature.trim().split(/\s+/);
  return parts.length >= 2 ? parts[0] : null;
}

function findImplementation(store: GraphStore, interfaceName: string): number | null {
  // Strategy 1: Find a class that implements this interface
  const allFiles = store.getAllFiles();
  for (const file of allFiles) {
    const nodes = store.getNodesByFileId(file.id);
    for (const node of nodes) {
      if (node.kind !== 'class') continue;
      if (!node.implements_names) continue;

      const implList: string[] = JSON.parse(node.implements_names);
      if (implList.includes(interfaceName)) {
        const annotations = store.getAnnotations(node.id);
        const isSpringBean = annotations.some(a => IMPL_ANNOTATIONS.has(a.name));
        if (isSpringBean) return node.id;
      }
    }
  }

  // Strategy 2: Find a class with matching name that is a Spring bean
  const directMatches = store.getNodesByName(interfaceName, { kind: 'class' });
  for (const match of directMatches) {
    const annotations = store.getAnnotations(match.id);
    if (annotations.some(a => IMPL_ANNOTATIONS.has(a.name))) return match.id;
  }

  return null;
}
