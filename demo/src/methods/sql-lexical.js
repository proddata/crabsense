// Lexical helpers for parser adapters and statement validation.
export function tokenizeSql(sql) {
  const tokens = [];
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const start = i;
    const char = sql[i];
    if (/\s/.test(char)) { i++; continue; }
    if (sql.startsWith('--', i)) {
      i = sql.indexOf('\n', i + 2);
      if (i < 0) i = sql.length;
      tokens.push({ kind: 'ignored', start, end: i, closed: i < sql.length });
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let level = 1;
      i += 2;
      while (i < sql.length && level) {
        if (sql.startsWith('/*', i)) { level++; i += 2; }
        else if (sql.startsWith('*/', i)) { level--; i += 2; }
        else i++;
      }
      tokens.push({ kind: 'ignored', start, end: i, closed: level === 0 });
      continue;
    }
    const dollar = sql.slice(i).match(/^\$[A-Za-z_][\w]*\$|^\$\$/);
    if (dollar) {
      const close = sql.indexOf(dollar[0], i + dollar[0].length);
      i = close < 0 ? sql.length : close + dollar[0].length;
      tokens.push({ kind: 'ignored', start, end: i, closed: close >= 0 });
      continue;
    }
    if (char === "'") {
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i++] === "'") { closed = true; break; }
      }
      tokens.push({ kind: 'ignored', start, end: i, closed });
      continue;
    }
    if (char === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i++] === '"') break;
      }
      tokens.push({ kind: 'identifier', text: sql.slice(start, i), start, end: i, depth });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      i++;
      while (i < sql.length && /[\w$]/.test(sql[i])) i++;
      tokens.push({ kind: 'identifier', text: sql.slice(start, i), start, end: i, depth });
      continue;
    }
    if (char === ')') depth = Math.max(0, depth - 1);
    tokens.push({ kind: 'symbol', text: char, start, end: ++i, depth });
    if (char === '(') depth++;
  }
  return tokens;
}

/** Lexical cursor boundaries; parser adapters decide the syntax context. */
export function cursorInfo(sql, offset, tokens = tokenizeSql(sql)) {
  const ignored = tokens.some(token => token.kind === 'ignored' && token.start < offset && (offset < token.end || !token.closed && offset === token.end));
  const before = tokens.filter(token => token.kind !== 'ignored' && token.start < offset);
  let at = before.length - 1;
  let prefix = '';
  let replacementStart = offset;
  if (before[at]?.kind === 'identifier' && before[at].end >= offset) {
    prefix = sql.slice(before[at].start, offset);
    replacementStart = before[at].start;
    at--;
  }
  let qualifier = null;
  if (before[at]?.text === '.' && before[at - 1]?.kind === 'identifier') {
    const text = before[at - 1].text;
    qualifier = text.startsWith('"') ? text.slice(1, -1).replaceAll('""', '"') : text.toLowerCase();
    at -= 2;
  }
  return { ignored, prefix, replacementStart, qualifier, contextStart: before[at]?.end ?? 0 };
}
