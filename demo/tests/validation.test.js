import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSql } from '../src/methods/validate.js';

test('libpg_query accepts valid PostgreSQL syntax', async () => {
  assert.deepEqual(await validateSql('SELECT s.handle FROM public.sailors AS s'), { valid: true, empty: false });
});

test('libpg_query reports a syntax error at the invalid token', async () => {
  const sql = 'SELECT * FRM public.sailors';
  const result = await validateSql(sql);
  assert.equal(result.valid, false);
  assert.match(result.message, /syntax error/i);
  assert.ok(result.offset >= sql.indexOf('FRM'));
});

test('validation explains a missing FROM source while retaining the PostgreSQL error', async () => {
  for (const sql of ['SELECT FROM ;', 'SELECT * FROM ;', 'SELECT FROM']) {
    const result = await validateSql(sql);
    assert.equal(result.valid, false);
    assert.equal(result.hint, 'Expected a FROM source, such as a table or subquery.');
    assert.match(result.message, /syntax error/i);
  }
  assert.equal((await validateSql('SELECT FROM public.sailors')).valid, true);
  assert.equal((await validateSql('SELECT 1 + ;')).hint, undefined);
});

test('validation reports errors from separate statements at document offsets', async () => {
  const sql = 'SELECT FROM ;\nSELECT 1 + ;\nSELECT 1;';
  const result = await validateSql(sql);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map(error => error.offset), [
    sql.indexOf(';'),
    sql.indexOf(';', sql.indexOf(';') + 1)
  ]);
  assert.equal(result.errors[0].hint, 'Expected a FROM source, such as a table or subquery.');
  assert.equal(result.message, result.errors[0].message);
});

test('statement splitting ignores semicolons inside strings, dollar quotes, and comments', async () => {
  const sql = "SELECT ';' AS semi; SELECT $tag$;$tag$; /* ; */ SELECT FROM ;";
  const result = await validateSql(sql);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].offset, sql.lastIndexOf(';'));
});

test('multi-statement validation keeps both error positions across varied valid statements', async () => {
  const fillers = ['SELECT 1;', "SELECT ';' AS text;", '/* ; */ SELECT 2;', 'SELECT $tag$;$tag$;'];
  let seed = 17;
  const pick = () => fillers[(seed = (seed * 1664525 + 1013904223) >>> 0) % fillers.length];
  for (let i = 0; i < 32; i++) {
    const sql = `${pick()}\nSELECT FROM ;\n${pick()}\nSELECT 1 + ;\n${pick()}`;
    const result = await validateSql(sql);
    assert.equal(result.errors.length, 2);
    assert.equal(result.errors[0].offset, sql.indexOf(';', sql.indexOf('SELECT FROM ')));
    assert.equal(result.errors[1].offset, sql.indexOf(';', sql.indexOf('SELECT 1 + ')));
  }
});
