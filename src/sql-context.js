// Lexical facts and cursor state live here. Catalog lookup and ranking do not.
const namePattern = /[A-Za-z_]/;
const statementHeads = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'SHOW']);
const clauses = new Set(['SELECT', 'FROM', 'JOIN', 'ON', 'WHERE', 'HAVING', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'WINDOW', 'RETURNING', 'SET', 'VALUES']);
const operands = new Set(['AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'WHEN', 'THEN', 'ELSE', 'COLLATE', 'AT', 'TIME', 'ZONE']);

/** Offset-preserving PostgreSQL tokens, including incomplete input. */
export function scanSql(sql) {
  const tokens = [];
  for (let at = 0; at < sql.length;) {
    if (/\s/.test(sql[at])) { at++; continue; }
    const start = at;
    let kind = 'symbol';
    let closed = true;
    if (sql.startsWith('--', at)) {
      kind = 'comment';
      const end = sql.indexOf('\n', at + 2);
      closed = end !== -1;
      at = closed ? end : sql.length;
    } else if (sql.startsWith('/*', at)) {
      kind = 'comment';
      let depth = 1;
      at += 2;
      while (at < sql.length && depth) {
        if (sql.startsWith('/*', at)) { depth++; at += 2; }
        else if (sql.startsWith('*/', at)) { depth--; at += 2; }
        else at++;
      }
      closed = depth === 0;
    } else if (sql[at] === '"' || sql[at] === "'" || /[eEbBxXnN]/.test(sql[at]) && sql[at + 1] === "'") {
      const prefixed = sql[at] !== '"' && sql[at] !== "'";
      if (prefixed) at++;
      const quote = sql[at++];
      kind = quote === '"' ? 'identifier' : 'literal';
      const escape = prefixed && sql[start].toUpperCase() === 'E';
      closed = false;
      while (at < sql.length) {
        if (escape && sql[at] === '\\') { at = Math.min(at + 2, sql.length); continue; }
        if (sql[at] === quote && sql[at + 1] === quote) { at += 2; continue; }
        if (sql[at++] === quote) { closed = true; break; }
      }
    } else if (sql[at] === '$' && /^\$(?:[A-Za-z_][\w]*)?\$/.test(sql.slice(at))) {
      kind = 'literal';
      const delimiter = sql.slice(at).match(/^\$(?:[A-Za-z_][\w]*)?\$/)[0];
      const end = sql.indexOf(delimiter, at + delimiter.length);
      closed = end !== -1;
      at = closed ? end + delimiter.length : sql.length;
    } else if (namePattern.test(sql[at])) {
      kind = 'word';
      while (++at < sql.length && /[\w$]/.test(sql[at])) { /* identifier */ }
    } else if (/[0-9]/.test(sql[at]) || sql[at] === '.' && /[0-9]/.test(sql[at + 1] || '')) {
      kind = 'number';
      at += sql.slice(at).match(/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/)[0].length;
    } else if (sql[at] === '$' && /[0-9]/.test(sql[at + 1] || '')) {
      kind = 'parameter';
      at += sql.slice(at).match(/^\$[0-9]+/)[0].length;
    } else {
      const operator = sql.slice(at).match(/^(?:::|->>|->|#>>|#>|<=|>=|<>|!=|\|\|)/);
      at += operator?.[0].length || 1;
    }
    tokens.push({ kind, text: sql.slice(start, at), start, end: at, closed });
  }
  return tokens;
}

/** The catalog overlay still consumes text; mask it using the same lexer. */
export function maskSql(sql, tokens = scanSql(sql)) {
  let masked = '';
  let start = 0;
  for (const token of tokens) {
    if (token.kind !== 'literal' && token.kind !== 'comment') continue;
    masked += sql.slice(start, token.start) + token.text.replace(/[^\n]/g, ' ');
    start = token.end;
  }
  masked += sql.slice(start);
  const last = tokens.at(-1);
  return { masked, ignored: Boolean(last && !last.closed && ['literal', 'comment'].includes(last.kind)) };
}

const upper = token => token?.kind === 'word' ? token.text.toUpperCase() : '';
const isName = token => token && ['word', 'identifier'].includes(token.kind);
const canonical = token => token.kind === 'identifier'
  ? token.text.slice(1, -1).replaceAll('""', '"') : token.text.toLowerCase();
function startsQuery(tokens, at) {
  while (tokens[at]?.text === '(') at++;
  return ['SELECT', 'WITH'].includes(upper(tokens[at]));
}

/** Active query ancestors, restricted to the cursor's set-operation branch. */
export function queryScopes(sql, offset, tokens = scanSql(sql), start = 0, end = sql.length) {
  const root = { start, end, operators: [], inFrom: false };
  const groups = [];
  const stack = [];
  const relevant = tokens.filter(token => token.start >= start && token.start < end && token.kind !== 'comment');
  for (let i = 0; i < relevant.length; i++) {
    const token = relevant[i];
    if (token.text === '(') {
      const parent = stack.at(-1) || root;
      const previous = relevant[i - 1];
      const lateral = upper(previous) === 'LATERAL';
      const fromSource = parent.inFrom && (lateral || ['FROM', 'JOIN'].includes(upper(previous)) || previous?.text === ',');
      const group = { start: token.end, end, query: startsQuery(relevant, i + 1), operators: [], inFrom: false,
        // FROM subqueries may skip their immediate parent's bindings while
        // retaining correlation with ancestors. LATERAL sees only earlier items.
        parentVisibility: fromSource ? lateral ? 'preceding' : 'none' : 'all', sourceStart: token.start };
      groups.push(group);
      stack.push(group);
    } else if (token.text === ')' && stack.length) {
      stack.pop().end = token.start;
    } else if (['UNION', 'INTERSECT', 'EXCEPT'].includes(upper(token))) {
      // Operators inside expressions or nested queries cannot split an ancestor.
      const scope = stack.at(-1) || root;
      if (scope === root || scope.query) scope.operators.push(token);
    } else {
      const scope = stack.at(-1) || root;
      if (scope === root || scope.query) {
        const word = upper(token);
        if (['FROM', 'JOIN'].includes(word)) scope.inFrom = true;
        else if (['SELECT', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET', 'RETURNING'].includes(word)) scope.inFrom = false;
      }
    }
  }
  return [root, ...groups.filter(group => group.query && group.start <= offset && offset <= group.end)]
    .map(scope => {
      let branchStart = scope.start;
      let branchEnd = scope.end;
      for (const operator of scope.operators) {
        if (operator.end <= offset) branchStart = operator.end;
        else if (operator.start >= offset) { branchEnd = operator.start; break; }
      }
      return { start: branchStart, end: branchEnd, parentVisibility: scope.parentVisibility || 'all', sourceStart: scope.sourceStart };
    });
}

/** Source range visible to an active ON or USING condition, if there is one. */
export function joinConditionScope(sql, offset, start = 0) {
  const before = sql.slice(start, offset);
  if (!/\b(?:ON|USING)\b/i.test(before)) return null;
  const tokens = scanSql(before).filter(token => token.kind !== 'comment');
  const frames = [{ kind: 'query', inFrom: false, inCondition: false, sourceStart: 0, needsFrom: false }];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const frame = frames.at(-1);
    if (token.text === '(') {
      const previous = tokens[i - 1];
      const sourceGroup = frame.kind !== 'expression' && frame.inFrom &&
        (['FROM', 'JOIN'].includes(upper(previous)) || previous?.text === ',') &&
        !startsQuery(tokens, i + 1);
      frames.push(sourceGroup
        ? { kind: 'join', inFrom: true, inCondition: false, sourceStart: token.end, needsFrom: true }
        : { kind: 'expression' });
    } else if (token.text === ')') {
      if (frames.length > 1) frames.pop();
    } else if (frame.kind !== 'expression') {
      const word = upper(token);
      if (word === 'FROM') {
        frame.inFrom = true;
        frame.inCondition = false;
        frame.sourceStart = token.start;
        frame.needsFrom = false;
      } else if (word === 'JOIN') {
        frame.inFrom = true;
        frame.inCondition = false;
      } else if (['ON', 'USING'].includes(word) && frame.inFrom) {
        frame.inCondition = true;
      } else if (['SELECT', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET', 'RETURNING', 'UNION', 'INTERSECT', 'EXCEPT'].includes(word) || token.text === ';') {
        frame.inFrom = false;
        frame.inCondition = false;
      } else if (token.text === ',' && frame.inFrom) {
        frame.sourceStart = token.end;
        frame.needsFrom = true;
        frame.inCondition = false;
      }
    }
  }
  const frame = frames.findLast(item => item.kind !== 'expression');
  return frame?.inCondition
    ? { start: start + frame.sourceStart, needsFrom: frame.needsFrom }
    : null;
}

/** Earlier FROM sources visible inside a table function's arguments. */
export function tableFunctionArgumentScope(sql, offset, start = 0) {
  const tokens = scanSql(sql.slice(start, offset)).filter(token => token.kind !== 'comment');
  const groups = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.text === '(') {
      let nameAt = i - 1;
      if (tokens[i - 2]?.text === '.') nameAt = i - 3;
      const previous = tokens[nameAt - 1];
      const source = isName(tokens[nameAt]) &&
        (['FROM', 'JOIN', 'LATERAL'].includes(upper(previous)) || previous?.text === ',');
      groups.push(source ? tokens[nameAt].start : null);
    } else if (token.text === ')' && groups.length) groups.pop();
  }
  const sourceStart = groups.findLast(value => value !== null);
  return sourceStart === undefined ? null : start + sourceStart;
}

function typePosition(before) {
  if (/::\s*$/.test(before) || /\bCAST\s*\([^;]*\bAS\s*$/i.test(before)) return true;
  const identifier = '(?:"(?:[^"]|"")*"|[A-Za-z_][\\w$]*)';
  if (/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b/i.test(before) &&
      new RegExp(`(?:\\(|,)\\s*${identifier}\\s+$`, 'i').test(before)) return true;
  return new RegExp(`^\\s*ALTER\\s+TABLE\\b[\\s\\S]*\\b(?:ADD\\s+(?:COLUMN\\s+)?${identifier}\\s+|ALTER\\s+COLUMN\\s+${identifier}\\s+TYPE\\s+)$`, 'i').test(before) ||
    /\bRETURNS\s*$/i.test(before) || /^\s*CREATE\s+DOMAIN\b[\s\S]*\bAS\s*$/i.test(before);
}

function createTableColumnNamePosition(before) {
  if (!/^\s*CREATE\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\b/i.test(before)) return false;
  const tokens = scanSql(before);
  const open = tokens.findIndex(token => token.text === '(');
  if (open < 0) return false;
  const identifier = '(?:"(?:[^"]|"")*"|[A-Za-z_][\\w$]*)';
  if (!new RegExp(`^\\s*CREATE\\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}(?:\\.${identifier})?\\s*$`, 'i')
    .test(before.slice(0, tokens[open].start))) return false;
  let depth = 0;
  let boundary = open;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].text === '(') depth++;
    else if (tokens[i].text === ')') depth--;
    else if (tokens[i].text === ',' && depth === 1) boundary = i;
  }
  return depth === 1 && boundary === tokens.length - 1;
}

function cteHeaderPosition(tokens) {
  function afterGroup(at) {
    if (tokens[at]?.text !== '(') return at;
    let depth = 0;
    for (; at < tokens.length; at++) {
      if (tokens[at].text === '(') depth++;
      else if (tokens[at].text === ')' && --depth === 0) return at + 1;
    }
    return -1;
  }
  // A WITH may start the statement or a parenthesized subquery. Walk its
  // definitions in order, stopping as soon as the cursor enters a CTE body.
  for (let start = 0; start < tokens.length; start++) {
    if (upper(tokens[start]) !== 'WITH' || start && tokens[start - 1].text !== '(') continue;
    let at = start + 1;
    if (upper(tokens[at]) === 'RECURSIVE') at++;
    while (isName(tokens[at])) {
      at++;
      if (tokens[at]?.text === '(') {
        at = afterGroup(at);
        if (at < 0) break;
      }
      if (at === tokens.length) return 'cte-as';
      if (upper(tokens[at]) !== 'AS') break;
      at++;
      if (upper(tokens[at]) === 'NOT') at++;
      if (upper(tokens[at]) === 'MATERIALIZED') at++;
      if (tokens[at]?.text !== '(') break;
      at++;
      if (at === tokens.length) return 'cte-body-start';
      at = afterGroup(at - 1);
      if (at < 0 || tokens[at]?.text !== ',') break;
      at++;
    }
  }
  return null;
}

function cursorFrame(tokens) {
  const frames = [{ isQuery: true, clause: null, state: 'operand', cases: 0, modifier: false }];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const word = upper(token);
    const previous = tokens[i - 1];
    const frame = frames.at(-1);
    if (token.text === '(' || token.text === '[') {
      const modifier = frame.clause === 'SELECT' && frame.modifier && upper(previous) === 'ON';
      frames.push({ isQuery: false, clause: frame.clause, state: 'operand', cases: 0, modifier: false,
        group: upper(previous) === 'USING' ? 'using' : upper(previous) === 'CAST' ? 'cast' : 'expression',
        returnState: modifier ? 'operand' : 'continuation' });
    } else if (token.text === ')' || token.text === ']') {
      const group = frames.length > 1 ? frames.pop() : frame;
      frames.at(-1).state = group.returnState || 'continuation';
      frames.at(-1).modifier = false;
    } else if (word === 'SELECT') {
      frame.isQuery = true;
      frame.clause = 'SELECT';
      frame.state = 'operand';
      frame.modifier = true;
    } else if (frame.isQuery && !frame.cases && clauses.has(word) && !(frame.modifier && word === 'ON')) {
      frame.clause = word;
      frame.state = ['FROM', 'JOIN'].includes(word) ? 'relation' : 'operand';
      frame.modifier = false;
    } else if (frame.isQuery && ['UPDATE', 'INTO', 'TRUNCATE'].includes(word)) {
      frame.clause = word;
      frame.state = 'relation';
    } else if (word === 'SHOW' && frame.isQuery) {
      frame.clause = word;
      frame.state = 'setting';
    } else if (word === 'CASE') {
      frame.cases++;
      frame.state = 'operand';
    } else if (word === 'END' && frame.cases) {
      frame.cases--;
      frame.state = 'continuation';
    } else if (word === 'AS') {
      frame.state = frame.group === 'cast' ? 'type' : 'alias';
    } else if (token.text === '::') {
      frame.state = 'type';
    } else if (frame.modifier && ['ALL', 'DISTINCT', 'ON'].includes(word)) {
      frame.state = 'operand';
    } else if (['BY', 'TABLE', 'LATERAL', 'ONLY'].includes(word) && ['operand', 'relation'].includes(frame.state)) {
      // Clause/relation modifiers leave the next operand or source pending.
    } else if (word === 'FILTER' || word === 'OVER') {
      frame.state = 'operand';
    } else if (operands.has(word)) {
      frame.state = 'operand';
    } else if (token.text === ',') {
      frame.state = ['FROM', 'JOIN'].includes(frame.clause) ? 'relation' : 'operand';
    } else if (token.text === '.') {
      frame.state = ['FROM', 'JOIN', 'INTO', 'UPDATE', 'TRUNCATE'].includes(frame.clause) ? 'relation' : 'operand';
    } else if (token.text === '*' && frame.state === 'operand' && frame.isQuery && frame.clause === 'SELECT') {
      frame.state = 'wildcard';
    } else if (token.kind === 'symbol') {
      frame.state = 'operand';
    } else if (frame.state === 'relation' || frame.state === 'after-relation') {
      frame.state = 'after-relation';
    } else if (frame.state === 'setting') {
      // Settings have their own candidate collection.
    } else if (frame.state === 'alias' || frame.state === 'continuation' && frame.isQuery && frame.clause === 'SELECT' && !frame.cases) {
      frame.state = 'after-alias';
    } else {
      frame.state = 'continuation';
    }
    if (!['ALL', 'DISTINCT', 'ON', 'SELECT'].includes(word) && token.text !== '(') frame.modifier = false;
  }
  return frames.at(-1);
}

/** Resolve lexical boundaries, active scope, and expected cursor state once. */
export function resolveCursor(sql, offset) {
  const tokens = scanSql(sql);
  const masked = maskSql(sql, tokens).masked;
  const crossing = tokens.find(token => token.start < offset &&
    (offset < token.end || offset === token.end && !token.closed));
  const ignored = Boolean(crossing && ['comment', 'literal'].includes(crossing.kind));
  const previousSemicolon = tokens.findLast(token => token.text === ';' && token.end <= offset);
  const nextSemicolon = tokens.find(token => token.text === ';' && token.start >= offset);
  const statementStart = previousSemicolon?.end || 0;
  const statementEnd = nextSemicolon?.start ?? sql.length;
  const before = tokens.filter(token => token.start >= statementStart && token.start < offset && token.kind !== 'comment')
    .map(token => token.end <= offset ? token : { ...token, text: sql.slice(token.start, offset), end: offset, closed: false });
  let prefix = '';
  let qualifier = null;
  let qualifierQuoted = false;
  let contextStart = offset;
  let last = before.at(-1);
  if (isName(last) && last.end === offset) {
    prefix = last.text;
    contextStart = last.start;
    before.pop();
  }
  if (before.at(-1)?.text === '.' && before.at(-1).end === contextStart && isName(before.at(-2))) {
    const name = before.at(-2);
    if (name.end === before.at(-1).start) {
      qualifier = canonical(name);
      qualifierQuoted = name.kind === 'identifier';
      contextStart = name.start;
      before.splice(-2);
    }
  }
  if (!qualifier && !before.length && statementHeads.has(prefix.toUpperCase())) {
    before.push(last);
    prefix = '';
    contextStart = offset;
  }
  const frame = cursorFrame(before);
  const contextBefore = masked.slice(statementStart, contextStart);
  const statement = masked.slice(statementStart, offset);
  const state = typePosition(contextBefore) ? 'type' : frame.group === 'using' ? 'using-column' : frame.state;
  const ctePosition = cteHeaderPosition(before);
  const context = ignored ? 'ignored' : ctePosition || (state === 'type' ? 'type' : createTableColumnNamePosition(contextBefore) ? 'definition-column' : !before.length && !qualifier ? 'statement' :
    state === 'setting' ? 'setting' : state === 'relation' ? 'relation' : state === 'using-column' ? 'using-column' :
    frame.clause === 'SELECT' ? 'projection' : 'expression');
  return { context, state, prefix, qualifier, qualifierQuoted, replacementStart: offset - prefix.length,
    activeClause: frame.clause, queryBoundary: frame.isQuery && frame.clause === 'SELECT' && !frame.cases,
    statementStart, statementEnd, statement, wholeStatement: masked.slice(statementStart, statementEnd), contextBefore, masked,
    scopes: queryScopes(sql, offset, tokens, statementStart, statementEnd) };
}

/** Hide nested query internals while keeping derived-source parentheses/aliases. */
export function referenceScope(sql) {
  const tokens = scanSql(sql).filter(token => token.kind !== 'comment');
  const edits = [];
  let depth = 0;
  let start = null;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === '(') {
      depth++;
      if (start === null && ['SELECT', 'WITH'].includes(upper(tokens[i + 1]))) start = { at: tokens[i].end, depth };
    } else if (tokens[i].text === ')') {
      if (start && start.depth === depth) { edits.push([start.at, tokens[i].start]); start = null; }
      depth--;
    }
  }
  if (start) edits.push([start.at, sql.length]);
  let result = sql;
  for (const [from, to] of edits.reverse()) result = result.slice(0, from) + result.slice(from, to).replace(/[^\n]/g, ' ') + result.slice(to);
  return result;
}
