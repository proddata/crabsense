import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { CompletionContext } from '@codemirror/autocomplete';
import { PostgreSQL, schemaCompletionSource, keywordCompletionSource } from '@codemirror/lang-sql';

// Metadata conversion only. SQL interpretation and candidates belong to CodeMirror.
export function codeMirrorConfig(metadata) {
  const schema = Object.create(null);
  const tables = new Map();
  for (const name of metadata.schemas || []) schema[name] = { self: { label: name, type: 'schema' }, children: Object.create(null) };
  for (const relation of metadata.relations || []) {
    const namespace = (schema[relation.schema] ??= { self: { label: relation.schema, type: 'schema' }, children: Object.create(null) }).children;
    const columns = [];
    namespace[relation.name] = { self: { label: relation.name, type: relation.kind === 'view' ? 'view' : 'table', detail: `${relation.schema}.${relation.name}` }, children: columns };
    tables.set(`${relation.schema}\0${relation.name}`, columns);
  }
  for (const column of metadata.columns || []) {
    tables.get(`${column.schema}\0${column.relation}`)?.push({ label: column.name, type: 'column', detail: column.type });
  }
  for (const fn of [...(metadata.functions || []), ...(metadata.builtinFunctions || [])]) {
    const namespace = (schema[fn.schema] ??= { self: { label: fn.schema, type: 'schema' }, children: Object.create(null) }).children;
    // SQLNamespace has no overload model; keep an existing table on collisions.
    namespace[fn.name] ??= { self: { label: fn.name, type: 'function', detail: fn.schema }, children: [] };
  }
  return { dialect: PostgreSQL, defaultSchema: metadata.currentSchema || 'public', schema };
}

export function createCodeMirror(metadata) {
  const config = codeMirrorConfig(metadata);
  const sources = [schemaCompletionSource(config), keywordCompletionSource(PostgreSQL, true)];
  let state = EditorState.create({ extensions: PostgreSQL.extension });
  return {
    // Upstream sources return unfiltered options. This adapter applies a simple
    // prefix filter for Monaco, preserving source order. It does not reproduce
    // CodeMirror's popup fuzzy ranking, so top-1 comparisons are unsupported.
    complete(sql, offset, { limit = Infinity } = {}) {
      if (state.doc.toString() !== sql) state = state.update({ changes: { from: 0, to: state.doc.length, insert: sql } }).state;
      if (!ensureSyntaxTree(state, sql.length, 1000)) throw new Error('CodeMirror parsing did not finish within its time budget');
      // As in CodeMirror's forceParsing(), publish parse work to state before
      // completion sources read syntaxTree(state), especially beyond 3,000 chars.
      state = state.update({}).state;
      const context = new CompletionContext(state, offset, true);
      const nativeResults = sources.map(source => source(context)).filter(Boolean);
      const suggestions = nativeResults.flatMap(result => {
        const prefix = sql.slice(result.from, offset).replace(/^"/, '').toLowerCase();
        return result.options.filter(option => option.label.replace(/^"/, '').toLowerCase().startsWith(prefix)).map(option => ({
          label: option.label, kind: option.type || 'text', insertText: typeof option.apply === 'string' ? option.apply : option.label,
          detail: option.detail || 'CodeMirror PostgreSQL', listDescription: option.detail || '',
          nativeEdit: { replacementStart: result.from, replacementEnd: result.to ?? offset }
        }));
      });
      return { context: 'upstream source (context not reported)', replacementStart: nativeResults[0]?.from ?? offset,
        suggestions: suggestions.slice(0, limit), incomplete: suggestions.length > limit,
        capabilities: { context: false, ranking: false }, nativeCandidateCount: nativeResults.reduce((n, result) => n + result.options.length, 0) };
    }
  };
}
