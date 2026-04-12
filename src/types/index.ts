export interface DetectedFramework {
  name: string;
  version?: string;
  category: FrameworkCategory;
  source: string;
  docKey?: string;
}

export type FrameworkCategory = 'frontend' | 'backend' | 'database' | 'build' | 'container' | 'orchestration' | 'api' | 'testing' | 'other';

export interface DocSection {
  id: string;
  title: string;
  summary: string;
  children?: DocSection[];
}

export interface DocTreeIndex {
  framework: string;
  version?: string;
  description: string;
  docUrl?: string;
  github?: string;
  sections: DocSection[];
}

export interface MonorepoModule {
  name: string;
  path: string;
  type: 'frontend' | 'backend' | 'service' | 'shared' | 'infra' | 'unknown';
  frameworks: DetectedFramework[];
}

export interface ProjectStack {
  rootPath: string;
  modules: MonorepoModule[];
  summary: {
    frontend: string[];
    backend: string[];
    databases: string[];
    containers: string[];
    orchestration: string[];
    apis: string[];
    build: string[];
    testing: string[];
    other: string[];
  };
}

export interface MonorepoConfig {
  structure: {
    [moduleName: string]: {
      path: string;
      type: MonorepoModule['type'];
      description?: string;
    };
  };
}

export interface FrameworkMeta {
  description: string;
  github?: string;
  llmsTxt?: string;
}

export interface VersionedMeta extends FrameworkMeta {
  minMajor?: number;
  maxMajor?: number;
}

export interface FrameworkDocEntry {
  versions: VersionedMeta[];
}

export { FRAMEWORK_DOCS, resolveFrameworkMeta, parseMajor } from './registry.js';
