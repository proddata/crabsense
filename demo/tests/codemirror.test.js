import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { ensureSyntaxTree } from '@codemirror/language';
import { PostgreSQL, schemaCompletionSource, keywordCompletionSource } from '@codemirror/lang-sql';
import { codeMirrorConfig, createCodeMirror } from '../src/methods/codemirror.js';
import { monacoCompletionEdit } from '../src/monaco-completion.js';

const metadata = {
  currentSchema: 'public', schemas: ['public', 'harbor'],
  relations: [{ schema: 'public', name: 'sailors', kind: 'table' }, { schema: 'harbor', name: 'voyages', kind: 'view' }],
  columns: [{ schema: 'public', relation: 'sailors', name: 'handle', type: 'text' }, { schema: 'harbor', relation: 'voyages', name: 'destination', type: 'text' }],
  functions: [{ schema: 'harbor', name: 'port_label' }]
};

test('CodeMirror adapter preserves native candidates and ranges without CrabSense recovery', () => {
  const engine = createCodeMirror(metadata);
  for (const marked of [
    'sel|', 'SELECT * FROM |', 'SELECT * FROM harbor.|',
    'SELECT s.ha| FROM sailors s', 'SELECT s."ha|" FROM sailors s',
    'SELECT *, id fr|', 'SELECT (SELECT v.| FROM harbor.voyages v) FROM sailors s',
    "SELECT 'hel|lo'", 'SELECT -- co|mment\n1'
  ]) {
    const offset = marked.indexOf('|');
    const sql = marked.replace('|', '');
    let state = EditorState.create({ doc: sql, extensions: PostgreSQL.extension });
    assert.ok(ensureSyntaxTree(state, sql.length, 1000));
    state = state.update({}).state; // Publish the completed parse, as the adapter does.
    const context = new CompletionContext(state, offset, true);
    const results = [schemaCompletionSource(codeMirrorConfig(metadata)), keywordCompletionSource(PostgreSQL, true)]
      .map(source => source(context)).filter(Boolean);
    const expected = results.flatMap(result => result.options.filter(option =>
      option.label.replace(/^"/, '').toLowerCase().startsWith(sql.slice(result.from, offset).replace(/^"/, '').toLowerCase())
    ).map(option => ({ label: option.label, from: result.from, to: result.to ?? offset })));
    const actual = engine.complete(sql, offset);
    assert.deepEqual(actual.suggestions.map(item => ({ label: item.label, from: item.nativeEdit.replacementStart, to: item.nativeEdit.replacementEnd })), expected, marked);
    for (const item of actual.suggestions) {
      const edit = monacoCompletionEdit(sql, offset, actual.replacementStart, item, 0);
      assert.equal(edit.replacementStart, item.nativeEdit.replacementStart);
      assert.equal(edit.replacementEnd, item.nativeEdit.replacementEnd);
      assert.equal(edit.insertText, item.insertText);
    }
  }
});

test('CodeMirror receives the same schemas, relations and columns through its native namespace format', () => {
  const engine = createCodeMirror(metadata);
  const query = 'SELECT s.ha FROM public.sailors s';
  assert.ok(engine.complete(query, query.indexOf('ha') + 2).suggestions.some(item => item.kind === 'column' && item.label === 'handle'));
  const schemaQuery = 'SELECT * FROM harbor.';
  assert.ok(engine.complete(schemaQuery, schemaQuery.length).suggestions.some(item => item.kind === 'view' && item.label === 'voyages'));
  const full = engine.complete('SELECT ', 7);
  const capped = engine.complete('SELECT ', 7, { limit: 2 });
  assert.deepEqual(capped.suggestions, full.suggestions.slice(0, 2));
  assert.equal(capped.incomplete, true);
  assert.deepEqual(capped.capabilities, { context: false, ranking: false });
});

test('CodeMirror exposes aliases beyond the initial parsing viewport in long documents', () => {
  const projections = Array.from({ length: 5000 }, (_, i) => `coalesce(s.handle, 'fallback') AS label_${i}`).join(',\n');
  const sql = `SELECT s.ha, ${projections} FROM public.sailors s`;
  const engine = createCodeMirror(metadata);
  assert.ok(engine.complete(sql, 'SELECT s.ha'.length).suggestions.some(item => item.label === 'handle'));
});
