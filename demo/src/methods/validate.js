import { parse } from 'libpg-query';
import { tokenizeSql } from './sql-lexical.js';

function bytePositionToOffset(sql, position) {
  if (!position || position < 1) return sql.length;
  const target = position;
  let bytes = 0;
  let offset = 0;
  for (const char of sql) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > target) break;
    bytes += size;
    offset += char.length;
  }
  return offset;
}

function syntaxHint(sql, offset) {
  if (offset < sql.length && sql[offset] !== ';') return undefined;
  const tokens = tokenizeSql(sql.slice(0, offset));
  if (tokens.at(-1)?.kind === 'ignored' && !tokens.at(-1).closed) return undefined;
  const last = tokens.findLast(token => token.kind !== 'ignored');
  if (last?.text?.toUpperCase() === 'FROM') {
    return 'Expected a FROM source, such as a table or subquery.';
  }
  return undefined;
}

function statements(sql) {
  const parts = [];
  let start = 0;
  let hasCode = false;
  for (const token of tokenizeSql(sql)) {
    if (token.kind === 'symbol' && token.text === ';') {
      if (hasCode) parts.push({ text: sql.slice(start, token.end), start });
      start = token.end;
      hasCode = false;
    } else if (token.kind !== 'ignored' || !token.closed) {
      hasCode = true;
    }
  }
  if (hasCode) parts.push({ text: sql.slice(start), start });
  return parts;
}

/** Parse locally with libpg_query. It checks syntax but does not execute SQL. */
export async function validateSql(sql) {
  if (!sql.trim()) return { valid: true, empty: true };
  const errors = [];
  for (const statement of statements(sql)) {
    try {
      await parse(statement.text);
    } catch (error) {
      if (!error.sqlDetails) throw error;
      const localOffset = bytePositionToOffset(statement.text, error.sqlDetails.cursorPosition);
      errors.push({
        message: error.message,
        hint: syntaxHint(statement.text, localOffset),
        offset: statement.start + localOffset
      });
    }
  }
  return errors.length
    ? { valid: false, ...errors[0], errors }
    : { valid: true, empty: false };
}
