import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrabSense } from '@proddata/crabsense';
import { examples } from '../src/examples.js';
import { validateSql } from '../src/methods/validate.js';

const relations = [
  ['public', 'sailors'], ['public', 'vessels'], ['harbor', 'voyages'],
  ['harbor', 'ports'], ['harbor', 'cargo']
].map(([schema, name]) => ({ schema, name, kind: 'table' }));
const columns = Object.entries({
  sailors: ['id', 'handle', 'home_port'],
  vessels: ['id', 'name', 'captain_id'],
  voyages: ['id', 'vessel_id', 'port_id', 'destination', 'departed_at'],
  ports: ['id', 'name', 'region'],
  cargo: ['id', 'voyage_id', 'weight_kg']
}).flatMap(([relation, names]) => names.map(name => ({
  schema: ['voyages', 'ports', 'cargo'].includes(relation) ? 'harbor' : 'public',
  relation, name, type: 'text'
})));
const engine = createCrabSense({ schemas: ['public', 'harbor'], relations, columns, functions: [],
  builtinFunctions: [{ schema: 'pg_catalog', name: 'generate_series', arguments: 'integer, integer', returns: 'integer' }],
  types: [{ schema: 'harbor', name: 'cargo_risk', kind: 'enum' }, { schema: 'harbor', name: 'positive_weight', kind: 'domain' }] });
const expected = ['handle', 'vessel_name', 'SELECT', 'weight_kg', 'vessel_name', 'cargo_risk',
  'id', 'display_name', 'note', 'generate_series'];

for (const [index, example] of examples.entries()) {
  test(`${example.label} is valid SQL and has completion at its example cursor`, async () => {
    assert.deepEqual(await validateSql(example.sql), { valid: true, empty: false });
    const at = example.sql.indexOf(example.cursorAfter);
    assert.ok(at >= 0, `Cursor anchor missing from ${example.label}`);
    const result = engine.complete(example.sql, at + example.cursorAfter.length, { limit: 100 });
    assert.ok(result.suggestions.some(item => item.label === expected[index]),
      `${example.label} did not suggest ${expected[index]}: ${result.suggestions.map(item => item.label).join(', ')}`);
  });
}

test('derived table example completes outer aliases and joined table columns', () => {
  const original = examples.find(example => example.label === 'Derived table').sql;
  for (const [typed, label, kind] of [
    ['rec', 'recent', 'alias'],
    ['p.', 'region', 'column'],
    ['recent.', 'vessel_name', 'column']
  ]) {
    const sql = original.replace('SELECT recent.vessel_name', `SELECT ${typed}`);
    const result = engine.complete(sql, `SELECT ${typed}`.length);
    assert.ok(result.suggestions.some(item => item.label === label && item.kind === kind),
      `${typed} did not suggest ${label}: ${result.suggestions.map(item => item.label).join(', ')}`);
  }
});
