export interface Relation {
  schema: string;
  name: string;
  kind: string;
  draft?: boolean;
}

export interface Column {
  schema: string;
  relation: string;
  name: string;
  type: string;
}

export interface Routine {
  schema: string;
  name: string;
  arguments: string;
  returns: string;
  routineKind?: string;
}

export interface DatabaseType {
  schema: string;
  name: string;
  kind: string;
  /** PostgreSQL catalog name used when the type is schema qualified. */
  sqlName?: string;
}

export interface Catalog {
  schemas: string[];
  relations: Relation[];
  columns: Column[];
  functions: Routine[];
  types?: DatabaseType[];
  currentSchema?: string;
  /** Effective PostgreSQL schema lookup order, e.g. current_schemas(true). */
  searchPath?: string[];
  builtinFunctions?: Routine[];
  settings?: { name: string; description: string }[];
  keywords?: string[];
  keywordCategories?: { word: string; category: 'U' | 'C' | 'T' | 'R' }[];
}

export interface Suggestion {
  label: string;
  kind: string;
  insertText: string;
  detail: string;
  listDescription: string;
  filterText?: string;
  columnName?: string;
}

export interface CompletionResult {
  suggestions: Suggestion[];
  replacementStart: number;
  context: string;
  incomplete: boolean;
}

export interface CompletionOptions {
  /** Maximum returned suggestions. Omit to return all matches. */
  limit?: number;
}

export interface SignatureHelp {
  signatures: { label: string; parameters: { label: string }[] }[];
  activeSignature: number;
  activeParameter: number;
}

export interface CrabSenseEngine {
  complete(sql: string, offset: number, options?: CompletionOptions): CompletionResult;
  signatureHelp(sql: string, offset: number): SignatureHelp | null;
}

export function createCrabSense(metadata: Catalog): CrabSenseEngine;
export function complete(sql: string, offset: number, catalog: Catalog, options?: CompletionOptions & { allColumnsFallback?: boolean }): CompletionResult;
export function completionEdit(sql: string, offset: number, replacementStart: number, suggestion: Suggestion): {
  replacementStart: number;
  replacementEnd: number;
  insertText: string;
  filterText: string;
};

/** Lower-level helpers used by the demo's experimental cursor resolvers. */
export function catalogAtCursor(sql: string, offset: number, catalog: Catalog): Catalog;
export function completeResolved(context: {
  context: string;
  qualifier?: string | null;
  qualifierQuoted?: boolean;
  prefix?: string;
  replacementStart: number;
  refs?: Map<string, Relation>;
  /** Known source names that must not fall back to global relation lookup. */
  hiddenQualifiers?: Set<string>;
  target?: Relation | null;
  usingColumns?: Relation[] | null;
  usedUsingNames?: Set<string>;
  /** Output columns for a combined query's trailing ORDER BY. */
  setOrderColumns?: Column[] | null;
  allowWildcard?: boolean;
  position?: 'operand' | 'continuation' | 'alias' | 'after-alias' | 'wildcard' | 'relation' | 'after-relation' | 'type' | 'setting' | 'using-column';
  queryBoundary?: boolean;
  /** @deprecated Pass position: 'wildcard'. */
  afterWildcard?: boolean;
  preferredKeyword?: string | null;
}, catalog: Catalog, options?: CompletionOptions & { allColumnsFallback?: boolean }): CompletionResult;
export function useCommonCompletion(sql: string, offset: number): boolean;
export function isProjectionContext(sql: string, offset: number): boolean;
export function projectionWildcardAvailable(sql: string, offset: number): boolean;
