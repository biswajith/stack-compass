export interface InternalDependency {
  /** e.g. "com.company:auth-lib" or "@company/utils" */
  artifact: string;
  version?: string;
  /** Which module declared this dependency */
  declaredIn: string;
  /** Language ecosystem: maven, npm, sbt */
  ecosystem: 'maven' | 'npm' | 'sbt' | 'gradle';
  /** Resolved source path if the module is found locally */
  sourcePath?: string;
}

export interface InternalPatternConfig {
  /** Maven group prefixes, e.g. ["com.company", "com.company.shared"] */
  mavenGroupPrefixes: string[];
  /** npm scope prefixes, e.g. ["@company", "@company-shared"] */
  npmScopes: string[];
  /** Scala/SBT org prefixes */
  sbtOrgPrefixes: string[];
  /** Additional patterns as regex strings */
  customPatterns: string[];
}

export const DEFAULT_PATTERNS: InternalPatternConfig = {
  mavenGroupPrefixes: [],
  npmScopes: [],
  sbtOrgPrefixes: [],
  customPatterns: [],
};
