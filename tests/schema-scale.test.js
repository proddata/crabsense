import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrabSense } from '../src/completion.js';

test('large catalog keeps late relations and their columns discoverable', () => {
  const relations = Array.from({ length: 10_000 }, (_, index) => ({
    schema: 'public', name: `table_${String(index).padStart(5, '0')}`, kind: 'table'
  }));
  const columns = relations.flatMap(relation => Array.from({ length: 10 }, (_, index) => ({
    schema: relation.schema, relation: relation.name, name: `column_${index}`, type: 'integer'
  })));
  const engine = createCrabSense({ currentSchema: 'public', searchPath: ['pg_catalog', 'public'],
    schemas: ['public'], relations, columns, functions: [] });

  const broad = engine.complete('SELECT * FROM ', 'SELECT * FROM '.length, { limit: 20 });
  assert.equal(broad.suggestions.length, 20);
  assert.equal(broad.incomplete, true);

  const fromSql = 'SELECT * FROM table_0999';
  const from = engine.complete(fromSql, fromSql.length);
  assert.equal(from.context, 'relation');
  assert.deepEqual(from.suggestions.map(item => item.label),
    Array.from({ length: 10 }, (_, index) => `table_0999${index}`));
  assert.equal(from.suggestions.at(-1).insertText, 'table_09999');
  const narrowed = engine.complete(fromSql, fromSql.length, { limit: 5 });
  assert.deepEqual(narrowed.suggestions.map(item => item.label), from.suggestions.slice(0, 5).map(item => item.label));
  assert.equal(narrowed.incomplete, true);

  const qualifiedSql = 'SELECT t.column_9 FROM public.table_09999 t';
  const qualified = engine.complete(qualifiedSql, 'SELECT t.column_9'.length);
  assert.equal(qualified.context, 'qualified-column');
  assert.deepEqual(qualified.suggestions.map(item => item.label), ['column_9']);
  assert.match(qualified.suggestions[0].detail, /public\.table_09999/);

  const beforeFrom = engine.complete('SELECT ', 'SELECT '.length, { limit: 10 });
  assert.equal(beforeFrom.suggestions.length, 10);
  assert.equal(beforeFrom.incomplete, true);
  assert.ok(beforeFrom.suggestions.some(item => item.label === 'DISTINCT'));
  assert.deepEqual(beforeFrom.suggestions.filter(item => item.kind === 'column').map(item => item.label),
    Array.from({ length: 9 }, (_, index) => `column_${index}`));
});
