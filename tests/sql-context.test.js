import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSql, resolveCursor } from '../src/sql-context.js';

test('lexer preserves token offsets, literal kinds, quoted names, and nested comments', () => {
  const sql = `SELECT "a.b", 'it''s; FROM', $x$JOIN;$x$, 1.2e-3 /* a /* b */ c */`;
  const tokens = scanSql(sql);
  for (const token of tokens) assert.equal(sql.slice(token.start, token.end), token.text);
  assert.deepEqual(tokens.filter(token => token.kind === 'literal').map(token => token.text), ["'it''s; FROM'", '$x$JOIN;$x$']);
  assert.equal(tokens.find(token => token.kind === 'identifier').text, '"a.b"');
  assert.equal(tokens.find(token => token.kind === 'number').text, '1.2e-3');
  assert.equal(tokens.at(-1).closed, true);
});

test('cursor states are determined within the active group and query scope', () => {
  for (const [sql, state, clause] of [
    ['SELECT ', 'operand', 'SELECT'], ['SELECT *, ', 'operand', 'SELECT'],
    ['SELECT id + ', 'operand', 'SELECT'], ['SELECT id ', 'continuation', 'SELECT'],
    ["SELECT 'hello' ", 'continuation', 'SELECT'],
    ["SELECT E'it\\'s' ", 'continuation', 'SELECT'],
    ['SELECT id AS ', 'alias', 'SELECT'], ['SELECT id AS name ', 'after-alias', 'SELECT'],
    ['SELECT (SELECT id FROM sailors) ', 'continuation', 'SELECT'],
    ['SELECT * FROM sailors WHERE EXISTS (SELECT ', 'operand', 'SELECT'],
    ['SELECT coalesce(id, ', 'operand', 'SELECT'],
    ['SELECT coalesce(id ', 'continuation', 'SELECT'],
    ['SELECT * FROM ', 'relation', 'FROM']
  ]) {
    const result = resolveCursor(sql, sql.length);
    assert.equal(result.state, state, sql);
    assert.equal(result.activeClause, clause, sql);
  }
});

test('cursor prefix and qualifier use tokens and preserve replacement offsets', () => {
  for (const [sql, prefix, qualifier] of [
    ['SELECT "from" fr', 'fr', null], ['SELECT s."ha', '"ha', 's'],
    ['SELECT "a.b".', '', 'a.b'], ['SELECT pg_catalog.fr', 'fr', 'pg_catalog']
  ]) {
    const result = resolveCursor(sql, sql.length);
    assert.equal(result.prefix, prefix, sql);
    assert.equal(result.qualifier, qualifier, sql);
    assert.equal(result.replacementStart, sql.length - prefix.length, sql);
  }
  const sql = 'SELECT s.ha FROM sailors s; SELECT * FROM vessels';
  const result = resolveCursor(sql, 11);
  assert.equal(result.prefix, 'ha');
  assert.equal(result.statementEnd, sql.indexOf(';'));
});
