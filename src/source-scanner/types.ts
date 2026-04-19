export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  visibility: 'public' | 'protected' | 'private' | 'default';
  signature?: string;
  docComment?: string;
  annotations?: string[];
  extends?: string;
  implements?: string[];
  callSites?: Array<{ target: string; receiver?: string }>;
  jsxElements?: string[];
  location: { startLine: number; endLine: number };
  children?: ExtractedSymbol[];
}

export type SymbolKind =
  | 'class' | 'interface' | 'enum' | 'annotation'
  | 'method' | 'constructor' | 'field' | 'constant'
  | 'function' | 'type' | 'trait' | 'object' | 'case-class'
  | 'component' | 'hook'
  | 'query' | 'mutation' | 'subscription' | 'graphql-type' | 'graphql-input' | 'graphql-enum'
  | 'gql-operation' | 'api-call';

export interface ScannedFile {
  filePath: string;
  language: string;
  symbols: ExtractedSymbol[];
  imports?: string[];
  packageName?: string;
}

export interface ScannedModule {
  name: string;
  path: string;
  language: string;
  files: ScannedFile[];
  summary: ModuleSummary;
}

export interface ModuleSummary {
  totalFiles: number;
  totalSymbols: number;
  publicClasses: string[];
  publicInterfaces: string[];
  publicMethods: number;
  annotations: string[];
  restEndpoints: RestEndpoint[];
  entities: string[];
  events: string[];
}

export interface RestEndpoint {
  method: string;
  path: string;
  handler: string;
  file: string;
}

export type SupportedLanguage = 'java' | 'typescript' | 'tsx' | 'scala' | 'graphql' | 'javascript';
