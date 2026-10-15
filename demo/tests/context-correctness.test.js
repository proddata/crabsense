import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'libpg-query';
import { createCrabSense } from 'crabsense';

const engine = createCrabSense({
  schemas: ['public'], relations: [{ schema: 'public', name: 'sailors', kind: 'table' }],
  columns: [{ schema: 'public', relation: 'sailors', name: 'from_sql', type: 'text' }],
  functions: [], keywords: ['FROM', 'FREEZE', 'FALSE']
});

test('projection boundary completions produce PostgreSQL-parseable queries across expressions', async () => {
  const expressions = [
    'id', 's.id', '1', '.5', '1.2e-3', '$1', "'hello'", "E'it\\'s'", '$tag$FROM; SELECT$tag$',
    'count(*)', 'coalesce(id, 0)', 'CAST(id AS integer)', 'id::integer',
    '(SELECT id FROM sailors LIMIT 1)', '(SELECT (SELECT 1))', 'ARRAY[1,2]',
    'CASE WHEN id IS NULL THEN 0 ELSE id END', 'count(*) FILTER (WHERE id > 0)',
    'row_number() OVER (ORDER BY id)', 'id AS nickname', 'id nickname'
  ];
  for (const expression of expressions) {
    const sql = `SELECT ${expression} fr`;
    const result = engine.complete(sql, sql.length);
    assert.deepEqual(result.suggestions.map(item => item.label), ['FROM'], sql);
    const query = sql.slice(0, result.replacementStart) + result.suggestions[0].insertText + ' sailors s';
    await assert.doesNotReject(() => parse(query), query);
  }
});

test('every offered SELECT continuation has a valid PostgreSQL grammar expansion', async () => {
  const suffix = {
    FROM: ' sailors', AS: ' nickname', WHERE: ' true', 'GROUP BY': ' 1', HAVING: ' true',
    WINDOW: ' w AS ()', 'ORDER BY': ' 1', LIMIT: ' 1', OFFSET: ' 1', 'FETCH FIRST': ' 1 ROWS ONLY',
    'FOR UPDATE': '', 'FOR SHARE': '', UNION: ' SELECT 1', 'UNION ALL': ' SELECT 1',
    INTERSECT: ' SELECT 1', EXCEPT: ' SELECT 1', AND: ' true', OR: ' true',
    'IS NULL': '', 'IS NOT NULL': '', IN: ' (1)', 'NOT IN': ' (1)', BETWEEN: ' 0 AND 2',
    LIKE: " '1'", ILIKE: " '1'", COLLATE: ' "default"', 'AT TIME ZONE': " 'UTC'"
  };
  for (const sql of ['SELECT 1 ', 'SELECT 1 AS nickname ']) {
    for (const suggestion of engine.complete(sql, sql.length).suggestions) {
      assert.ok(Object.hasOwn(suffix, suggestion.label), suggestion.label);
      const query = sql + suggestion.insertText + suffix[suggestion.label];
      await assert.doesNotReject(() => parse(query), query);
    }
  }
});
