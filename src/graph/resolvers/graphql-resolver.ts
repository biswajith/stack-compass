import type { GraphStore } from '../store.js';

/**
 * Resolves cross-language GraphQL edges:
 * 1. gql-operation (TS) → GQL schema query/mutation (field name match)
 * 2. Java resolver (@DgsQuery etc.) → GQL schema query/mutation (field name match)
 */
export function resolveGraphqlEdges(store: GraphStore): void {
  resolveGqlOperationToSchema(store);
  resolveJavaResolverToSchema(store);
  resolveGqlTypeToEntity(store);
}

function resolveGqlOperationToSchema(store: GraphStore): void {
  const operations = store.getGqlOperations();

  for (const op of operations) {
    let fields: string[];
    try { fields = JSON.parse(op.fields); } catch { continue; }
    const opType = op.operation_type;

    for (const fieldName of fields) {
      // Find GQL schema nodes matching the field name and operation type
      const schemaNodes = store.getNodesByName(fieldName, { kind: opType });
      if (schemaNodes.length === 1) {
        store.insertEdge(op.node_id, schemaNodes[0].id, 'gql_resolves', null);
      } else if (schemaNodes.length > 1) {
        // Disambiguate: prefer top-level query/mutation nodes (parent_id = null)
        const topLevel = schemaNodes.filter(n => n.parent_id === null);
        if (topLevel.length === 1) {
          store.insertEdge(op.node_id, topLevel[0].id, 'gql_resolves', null);
        }
      }
    }
  }
}

function resolveJavaResolverToSchema(store: GraphStore): void {
  const resolvers = store.getGqlResolvers();

  for (const resolver of resolvers) {
    const { node_id, field_name, parent_type, operation_type } = resolver;

    // Map parent_type to a symbol kind for searching
    let targetKind: string;
    if (parent_type === 'Query') targetKind = 'query';
    else if (parent_type === 'Mutation') targetKind = 'mutation';
    else if (parent_type === 'Subscription') targetKind = 'subscription';
    else targetKind = 'field'; // Nested resolver (e.g., User.posts)

    // Find GQL schema nodes matching field name
    if (targetKind === 'field') {
      // For nested resolvers: find the field node inside the parent type
      const parentNodes = store.getNodesByName(parent_type, { kind: 'graphql-type' });
      for (const parent of parentNodes) {
        const children = store.getChildNodes(parent.id);
        const fieldNode = children.find(c => c.name === field_name);
        if (fieldNode) {
          store.insertEdge(node_id, fieldNode.id, 'gql_resolves', null);
          break;
        }
      }
    } else {
      const schemaNodes = store.getNodesByName(field_name, { kind: targetKind });
      for (const sn of schemaNodes) {
        store.insertEdge(node_id, sn.id, 'gql_resolves', null);
      }
    }
  }
}

function resolveGqlTypeToEntity(store: GraphStore): void {
  const allFiles = store.getAllFiles();
  const ENTITY_ANNOTATIONS = new Set(['Entity', 'Document', 'DgsData']);

  for (const file of allFiles) {
    const nodes = store.getTopLevelNodesByFileId(file.id);
    for (const node of nodes) {
      if (node.kind !== 'graphql-type') continue;

      // Find Java classes with the same name that have @Entity/@Document
      const javaClasses = store.getNodesByName(node.name, { kind: 'class' });
      for (const cls of javaClasses) {
        const annotations = store.getAnnotations(cls.id);
        const hasEntityAnnotation = annotations.some(a => ENTITY_ANNOTATIONS.has(a.name));
        if (hasEntityAnnotation) {
          store.insertEdge(node.id, cls.id, 'type_match', null);
        }
      }
    }
  }
}
