import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore } from 'monaco-editor/esm/vs/base/common/filters.js';
import { createCrabSense } from '@proddata/crabsense';
import { monacoCompletionEdit } from '../src/monaco-completion.js';

const metadata = {
  schemas: ['pg_catalog'],
  relations: [{ schema: 'pg_catalog', name: 'pg_prepared_statements', kind: 'view' }],
  columns: [{ schema: 'pg_catalog', relation: 'pg_prepared_statements', name: 'from_sql', type: 'boolean' }],
  functions: [], keywords: ['FROM', 'FREEZE', 'FALSE']
};

const score = (prefix, filterText) => fuzzyScore(prefix, prefix.toLowerCase(), 0,
  filterText, filterText.toLowerCase(), 0, { firstMatchCanBeWeak: true, boostFullMatch: true })?.[0];

test('Monaco fuzzy scoring cannot reorder ranked keywords and catalog columns', () => {
  // This is the mismatch from the popup: case-sensitive scoring beats sortText.
  assert.ok(score('fr', 'from_sql') > score('fr', 'FROM'));
  const engine = createCrabSense(metadata);
  for (const prefix of ['f', 'fr', 'FR', 'Fr', 'fro', 'from']) {
    const sql = `SELECT * , id ${prefix}`;
    const result = engine.complete(sql, sql.length);
    assert.equal(result.suggestions[0].label, 'FROM', sql);
    const items = result.suggestions.map((suggestion, index) => ({
      label: suggestion.label,
      ...monacoCompletionEdit(sql, sql.length, result.replacementStart, suggestion, index)
    }));
    assert.ok(items.length >= 1);
    assert.equal(new Set(items.map(item => score(prefix, item.filterText))).size, 1);
    assert.deepEqual([...items].sort((a, b) =>
      score(prefix, b.filterText) - score(prefix, a.filterText) || a.sortText.localeCompare(b.sortText)
    ).map(item => item.label), result.suggestions.map(item => item.label));
  }
});

test('Monaco keeps engine ranking for mixed-case candidates in operand positions', () => {
  const sql = 'SELECT f';
  const result = createCrabSense(metadata).complete(sql, sql.length);
  const items = result.suggestions.map((suggestion, index) =>
    monacoCompletionEdit(sql, sql.length, result.replacementStart, suggestion, index));
  assert.ok(items.length > 1);
  assert.equal(new Set(items.map(item => score('f', item.filterText))).size, 1);
});

test('ranking keeps quoted identifier edits and qualified column insertions intact', () => {
  const quoted = monacoCompletionEdit('SELECT "ha"', 10, 7,
    { label: 'handle', insertText: 'handle', kind: 'column' }, 0);
  assert.equal(quoted.filterText, '"ha');
  assert.equal(quoted.insertText, '"handle"');
  assert.equal(quoted.replacementEnd, 11);
  const qualified = monacoCompletionEdit('SELECT id', 9, 7,
    { label: 's.id', filterText: 'id', insertText: 's.id', kind: 'column' }, 1);
  assert.equal(qualified.filterText, 'id');
  assert.equal(qualified.insertText, 's.id');
});
