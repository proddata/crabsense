import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrabSense } from '../src/completion.js';

// Adapted SQL situations from pgcli's completion tests, with CrabSense's own
// catalog and expected symbols. This is an independent behavior corpus, not a
// translation of pgcli's Python implementation or its internal result types.
// https://github.com/dbcli/pgcli/blob/main/tests/test_sqlcompletion.py
// https://github.com/dbcli/pgcli/blob/main/tests/test_smart_completion_multiple_schemata.py
const catalog = {
  currentSchema: 'public',
  schemas: ['public', 'custom'],
  relations: [
    { schema: 'public', name: 'tabl1', kind: 'table' },
    { schema: 'public', name: 'tabl2', kind: 'table' },
    { schema: 'public', name: 'foo', kind: 'table' },
    { schema: 'public', name: 'bar', kind: 'table' },
    { schema: 'custom', name: 'products', kind: 'table' }
  ],
  columns: [
    { schema: 'public', relation: 'tabl1', name: 'first_col', type: 'integer' },
    { schema: 'public', relation: 'tabl2', name: 'second_col', type: 'text' },
    { schema: 'public', relation: 'foo', name: 'outer_col', type: 'integer' },
    { schema: 'public', relation: 'foo', name: 'id', type: 'integer' },
    { schema: 'public', relation: 'bar', name: 'inner_col', type: 'integer' },
    { schema: 'public', relation: 'bar', name: 'id', type: 'integer' },
    { schema: 'custom', relation: 'products', name: 'product_name', type: 'text' }
  ],
  functions: [{ schema: 'custom', name: 'func3', arguments: '', returns: 'integer' }]
};
const engine = createCrabSense(catalog);

function atCursor(marked) {
  const offset = marked.indexOf('|');
  assert.notEqual(offset, -1, `missing cursor in ${marked}`);
  assert.equal(marked.lastIndexOf('|'), offset, `multiple cursors in ${marked}`);
  return engine.complete(marked.slice(0, offset) + marked.slice(offset + 1), offset);
}

function symbols(result, kind) {
  return result.suggestions.filter(item => item.kind === kind).map(item => item.label);
}

const cases = [
  // pgcli: test_dot_suggests_cols_of_an_alias, _where,
  // test_dot_col_comma_suggests_cols_or_schema_qualified_table.
  { name: 'first alias before FROM', sql: 'SELECT t1.| FROM tabl1 t1, tabl2 t2', context: 'qualified-column', columns: ['first_col'], absent: ['second_col'] },
  { name: 'quoted first relation', sql: 'SELECT t1.| FROM "tabl1" t1, "tabl2" t2', context: 'qualified-column', columns: ['first_col'], absent: ['second_col'] },
  { name: 'second alias after comma', sql: 'SELECT t1.first_col, t2.| FROM tabl1 t1, tabl2 t2', context: 'qualified-column', columns: ['second_col'], absent: ['first_col'] },
  { name: 'first alias in WHERE', sql: 'SELECT * FROM tabl1 t1, tabl2 t2 WHERE t1.|', context: 'qualified-column', columns: ['first_col'], absent: ['second_col'] },
  { name: 'quoted first relation in WHERE', sql: 'SELECT * FROM "tabl1" t1, tabl2 t2 WHERE t1.|', context: 'qualified-column', columns: ['first_col'], absent: ['second_col'] },

  // pgcli: test_outer_table_reference_in_exists_subquery_suggests_columns,
  // test_sub_select_table_name_completion, test_sub_select_dot_col_name_completion.
  { name: 'correlated outer alias', sql: 'SELECT * FROM foo f WHERE EXISTS (SELECT 1 FROM bar WHERE f.|', context: 'qualified-column', columns: ['outer_col'], absent: ['inner_col'] },
  { name: 'inner alias in subquery', sql: 'SELECT * FROM foo f WHERE EXISTS (SELECT b.| FROM bar b)', context: 'qualified-column', columns: ['inner_col'], absent: ['outer_col'] },
  { name: 'nested relation position', sql: 'SELECT * FROM (SELECT * FROM |', context: 'relation', relations: ['foo', 'bar'] },
  { name: 'EXISTS relation position', sql: 'SELECT * FROM foo WHERE EXISTS (SELECT * FROM |', context: 'relation', relations: ['bar'] },

  // pgcli: test_join_suggests_tables_and_schemas,
  // test_suggest_columns_after_multiple_joins.
  { name: 'left join relation', sql: 'SELECT * FROM tabl1 t1 LEFT JOIN |', context: 'relation', relations: ['tabl2'], schemas: ['custom'] },
  { name: 'right outer join relation', sql: 'SELECT * FROM tabl1 RIGHT OUTER JOIN |', context: 'relation', relations: ['tabl2'] },
  { name: 'last of three joined relations', sql: 'SELECT * FROM foo JOIN tabl1 ON foo.outer_col = tabl1.first_col JOIN tabl2 ON tabl2.|', context: 'qualified-column', columns: ['second_col'], absent: ['first_col', 'outer_col'] },
  // pgcli: test_join_using_suggests_common_columns.
  { name: 'JOIN USING shared column', sql: 'SELECT * FROM foo JOIN bar USING (|', context: 'using-column', columns: ['id'], absent: ['outer_col', 'inner_col'] },

  // pgcli: test_2_statements_2nd_current, test_2_statements_1st_current,
  // test_3_statements_2nd_current. The cursor is not always at document end.
  { name: 'second statement after malformed first', sql: 'SELECT * FROM; SELECT * FROM |', context: 'relation', relations: ['foo'] },
  { name: 'first statement before later SQL', sql: 'SELECT * FROM |; SELECT * FROM bar', context: 'relation', relations: ['foo'] },
  { name: 'middle statement of three', sql: 'SELECT * FROM foo; SELECT b.| FROM bar b; SELECT * FROM tabl1', context: 'qualified-column', columns: ['inner_col'], absent: ['first_col', 'outer_col'] },

  // pgcli: test_schema_qualified_function_name. pgcli also covers functions
  // as FROM sources; CrabSense currently scopes schema members to expressions.
  { name: 'schema qualified function prefix', sql: 'SELECT custom.fun|', context: 'schema-member', functions: ['func3'] },
  { name: 'schema qualified relation', sql: 'SELECT * FROM custom.|', context: 'schema-member', relations: ['products'] }
];

for (const scenario of cases) {
  test(`pgcli corpus: ${scenario.name}`, () => {
    const result = atCursor(scenario.sql);
    assert.equal(result.context, scenario.context);
    for (const [field, kind] of [['columns', 'column'], ['relations', 'table'], ['schemas', 'schema'], ['functions', 'function']]) {
      for (const label of scenario[field] || []) {
        assert.ok(symbols(result, kind).includes(label), `missing ${kind}:${label}; got ${JSON.stringify(result.suggestions.map(item => `${item.kind}:${item.label}`))}`);
      }
    }
    for (const label of scenario.absent || []) {
      assert.ok(!symbols(result, 'column').includes(label), `unexpected column:${label}`);
    }
  });
}
