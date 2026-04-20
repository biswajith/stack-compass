import type { GraphStore } from '../store.js';

const INJECTABLE_ANNOTATIONS = new Set(['Autowired', 'Inject']);
const IMPL_ANNOTATIONS = new Set(['Service', 'Component', 'Repository']);

/**
 * Resolves Spring dependency injection:
 * @Autowired fields → find the @Service/@Repository class that implements the field type.
 * Creates `injects` edges from the containing class to the implementation class.
 */
export function resolveSpringEdges(store: GraphStore): void {
  // Pre-load all classes with implements in one query
  const implCandidates = store.getClassesWithImplements();

  // Build interface→implementation index in memory
  const implIndex = new Map<string, number[]>();
  for (const cls of implCandidates) {
    if (!cls.implements_names) continue;
    try {
      const implList: string[] = JSON.parse(cls.implements_names);
      const annotations = store.getAnnotations(cls.id);
      const isSpringBean = annotations.some(a => IMPL_ANNOTATIONS.has(a.name));
      if (!isSpringBean) continue;
      for (const iface of implList) {
        if (!implIndex.has(iface)) implIndex.set(iface, []);
        implIndex.get(iface)!.push(cls.id);
      }
    } catch { /* malformed JSON — skip */ }
  }

  const allFiles = store.getAllFiles();

  for (const file of allFiles) {
    const topNodes = store.getTopLevelNodesByFileId(file.id);
    for (const cls of topNodes) {
      if (cls.kind !== 'class') continue;

      const children = store.getChildNodes(cls.id);
      for (const field of children) {
        if (field.kind !== 'field') continue;

        const annotations = store.getAnnotations(field.id);
        const isInjectable = annotations.some(a => INJECTABLE_ANNOTATIONS.has(a.name));
        if (!isInjectable) continue;

        const typeName = extractFieldType(field.signature);
        if (!typeName) continue;

        // Look up in pre-built index first
        const implIds = implIndex.get(typeName);
        if (implIds && implIds.length > 0) {
          store.insertEdge(cls.id, implIds[0], 'injects', typeName);
          continue;
        }

        // Fallback: direct name match
        const directMatches = store.getNodesByName(typeName, { kind: 'class' });
        for (const match of directMatches) {
          const matchAnns = store.getAnnotations(match.id);
          if (matchAnns.some(a => IMPL_ANNOTATIONS.has(a.name))) {
            store.insertEdge(cls.id, match.id, 'injects', typeName);
            break;
          }
        }
      }
    }
  }
}

function extractFieldType(signature: string | null): string | null {
  if (!signature) return null;
  const parts = signature.trim().split(/\s+/);
  return parts.length >= 2 ? parts[0] : null;
}
