export { SourceScanner } from './scanner.js';
export { moduleToDocSections, formatModuleMarkdown } from './formatter.js';
export { detectLanguage } from './parser.js';
export { isTestSource, detectTestFrameworks } from './test-detector.js';
export type { TestMarkers } from './test-detector.js';
export type {
  ExtractedSymbol,
  SymbolKind,
  ScannedFile,
  ScannedModule,
  ModuleSummary,
  RestEndpoint,
  SupportedLanguage,
} from './types.js';
