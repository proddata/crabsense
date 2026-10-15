import { maskSql as maskIgnored, resolveCursor, referenceScope, queryScopes, joinConditionScope, tableFunctionArgumentScope, scanSql } from './sql-context.js';
import { rankSuggestions } from './ranking.js';

const keywords = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'LIMIT', 'AS', 'AND', 'OR', 'DISTINCT', 'RETURNING', 'VALUES', 'SET', 'INTO'];
const statements = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SHOW', 'WITH', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'EXPLAIN', 'BEGIN', 'COMMIT', 'ROLLBACK'];
const featuredBuiltinNames = ['count', 'sum', 'avg', 'min', 'max', 'lower', 'upper', 'length', 'now', 'date_trunc', 'round', 'substring', 'array_agg', 'string_agg', 'jsonb_build_object'];
const projectionKeywordPriority = ['DISTINCT', 'CASE', 'NULL', 'TRUE', 'FALSE', 'EXISTS', 'ALL'];
const expressionKeywordPriority = ['NULL', 'TRUE', 'FALSE', 'CASE', 'EXISTS', 'NOT', 'AND', 'OR'];
const selectClauses = [
  'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'WINDOW', 'ORDER BY', 'LIMIT', 'OFFSET',
  'FETCH FIRST', 'FOR UPDATE', 'FOR SHARE', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
];
const expressionContinuations = ['AND', 'OR', 'IS NULL', 'IS NOT NULL', 'IN', 'NOT IN', 'BETWEEN', 'LIKE', 'ILIKE', 'COLLATE', 'AT TIME ZONE'];
const operandKeywords = new Set(['NULL', 'TRUE', 'FALSE', 'CASE', 'EXISTS', 'NOT', 'DISTINCT', 'ALL', 'CAST', 'EXTRACT',
  'ARRAY', 'ROW', 'INTERVAL', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP',
  'CURRENT_USER', 'SESSION_USER', 'DEFAULT', 'COALESCE', 'NULLIF', 'GREATEST', 'LEAST']);
const defaultTypeNames = ['bigint', 'boolean', 'bytea', 'character varying', 'date', 'double precision', 'integer', 'interval', 'json', 'jsonb', 'numeric', 'real', 'smallint', 'text', 'time', 'time with time zone', 'timestamp', 'timestamp with time zone', 'uuid'];
const defaultTypes = defaultTypeNames.map(name => ({ schema: 'pg_catalog', name, kind: 'base' }));
const maxBuiltinMatches = 200;
const identifier = '(?:"(?:[^"]|"")*"|[A-Za-z_][\\w$]*)';
const reserved = new Set(['ON', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'NATURAL', 'OUTER', 'LATERAL', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION', 'USING', 'SET', 'VALUES', 'RETURNING']);
const quotedKeywords = new Set([...reserved, 'FROM', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TABLE', 'AS', 'AND', 'OR', 'NOT', 'NULL']);
const referencePattern = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(${identifier}(?:\\.${identifier})?)(?:\\s+(?:AS\\s+)?(?!(?:${[...reserved].join('|')})\\b)(${identifier}))?`, 'gi');
const orderedCatalogs = new WeakMap();
const visibleRoutineIndexes = new WeakMap();
const relationIndexes = new WeakMap();
const columnIndexes = new WeakMap();

// Catalog arrays are snapshots. Sharing indexes by array identity also lets
// editor-local catalogs reuse indexes for arrays they have not changed.
function relationIndex(relations) {
  let index = relationIndexes.get(relations);
  if (!index) {
    index = { byName: new Map(), byQualifiedName: new Map(), byPathName: new Map() };
    relationIndexes.set(relations, index);
  }
  return index;
}

function findRelation(catalog, name, schemaName) {
  const index = relationIndex(catalog.relations);
  const qualified = schemaName != null;
  let matches = qualified ? index.byQualifiedName : index.byName;
  if (!qualified && catalog.searchPath) {
    const pathKey = catalog.searchPath.join('\0');
    matches = index.byPathName.get(pathKey);
    if (!matches) {
      matches = new Map();
      const priorities = new Map();
      for (const relation of catalog.relations) {
        const priority = relationPriority(catalog, relation);
        if (priority === Infinity) continue;
        if (!priorities.has(relation.name) || priority < priorities.get(relation.name)) {
          priorities.set(relation.name, priority);
          matches.set(relation.name, relation);
        }
      }
      index.byPathName.set(pathKey, matches);
    }
  }
  const key = qualified ? `${schemaName}\0${name}` : name;
  if (!matches.has(key)) matches.set(key, qualified
    ? catalog.relations.find(relation => relation.name === name && relation.schema === schemaName)
    : catalog.searchPath ? undefined : catalog.relations.find(relation => relation.name === name));
  return matches.get(key);
}

function relationPriority(catalog, relation) {
  if (['__cte__', '__derived__', '__join__', '__function__'].includes(relation.schema)) return -1;
  const index = catalog.searchPath?.indexOf(relation.schema) ?? -1;
  return index < 0 ? Infinity : index;
}

function routinePriority(catalog, routine) {
  const index = catalog.searchPath?.indexOf(routine.schema) ?? -1;
  return index < 0 ? Infinity : index;
}

function firstVisibleRoutine(catalog, routine) {
  const root = catalog.rootCatalog || catalog;
  let visible = visibleRoutineIndexes.get(root);
  if (!visible) {
    visible = new Map();
    for (const candidate of [...catalog.functions, ...(catalog.builtinFunctions || [])]) {
      const priority = routinePriority(catalog, candidate);
      if (priority === Infinity) continue;
      const key = `${candidate.name}\0${candidate.arguments}`;
      if (!visible.has(key) || priority < visible.get(key).priority) visible.set(key, { routine: candidate, priority });
    }
    visibleRoutineIndexes.set(root, visible);
  }
  return visible.get(`${routine.name}\0${routine.arguments}`)?.routine === routine;
}

function columnsFor(catalog, relation) {
  if (relation.columns) return relation.columns;
  const key = `${relation.schema}\0${relation.name}`;
  if (catalog.columnOverrides?.has(key)) return catalog.columnOverrides.get(key);
  const source = catalog.baseColumns || catalog.columns;
  let index = columnIndexes.get(source);
  if (!index) {
    index = new Map();
    columnIndexes.set(source, index);
  }
  if (!index.has(key)) index.set(key, source.filter(column =>
    column.schema === relation.schema && column.relation === relation.name));
  return index.get(key);
}

function suggestibleColumnsFor(catalog, relation) {
  const columns = columnsFor(catalog, relation);
  if (relation.kind !== 'join') return columns;
  const counts = new Map();
  for (const column of columns) counts.set(column.name, (counts.get(column.name) || 0) + 1);
  return columns.filter(column => counts.get(column.name) === 1);
}

function cacheColumnsFor(catalog, relations) {
  const source = catalog.baseColumns || catalog.columns;
  let index = columnIndexes.get(source);
  if (!index) {
    index = new Map();
    columnIndexes.set(source, index);
  }
  const wanted = new Map();
  for (const relation of relations) {
    const key = `${relation.schema}\0${relation.name}`;
    if (index.has(key)) continue;
    index.set(key, []);
    let schemas = wanted.get(relation.name);
    if (!schemas) wanted.set(relation.name, schemas = new Map());
    schemas.set(relation.schema, key);
  }
  if (wanted.size) for (const column of source) {
    const key = wanted.get(column.relation)?.get(column.schema);
    if (key) index.get(key).push(column);
  }
  return index;
}

// For a capped projection before FROM, retain columns from only the earliest
// relations that can fill the page. A narrow prefix may require another pass.
function leadingColumns(catalog, relations, search, limit) {
  if (!relations.length) return [];
  let threshold = Math.min(relations.length, Math.max(Math.ceil((limit + 1) / 8), 32));
  for (;;) {
    const leading = relations.slice(0, threshold);
    const groups = cacheColumnsFor(catalog, leading.filter(relation =>
      !catalog.columnOverrides?.has(`${relation.schema}\0${relation.name}`)));
    const found = [];
    for (const relation of leading) {
      const key = `${relation.schema}\0${relation.name}`;
      for (const column of catalog.columnOverrides?.get(key) || groups.get(key) || []) {
        if (!column.name.toLowerCase().startsWith(search)) continue;
        found.push(item(column.name, 'column', identifierText(column.name), `${relationDescription(relation)} · ${column.type}`));
        if (found.length > limit) return found;
      }
    }
    if (threshold === relations.length) return found;
    threshold = Math.min(relations.length, threshold * 2);
  }
}

function overlayCatalog(catalog, copySchemas = false) {
  const root = catalog.rootCatalog || catalog;
  const baseColumns = catalog.baseColumns || catalog.columns;
  const overrides = new Map(catalog.columnOverrides || []);
  const overlay = { ...root, schemas: copySchemas ? [...catalog.schemas] : catalog.schemas, relations: [...catalog.relations] };
  Object.defineProperties(overlay, {
    rootCatalog: { value: root },
    baseColumns: { value: baseColumns },
    columnOverrides: { value: overrides },
    columns: {
      enumerable: true,
      get() {
        if (!this.materializedColumns) {
          const visible = baseColumns.filter(column => !overrides.has(`${column.schema}\0${column.relation}`));
          for (const group of overrides.values()) visible.push(...group);
          Object.defineProperty(this, 'materializedColumns', { value: visible });
        }
        return this.materializedColumns;
      }
    }
  });
  return overlay;
}

function unquote(value) {
  return value?.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value;
}

function searchPrefix(value) {
  return value.startsWith('"') ? value.slice(1).replace(/"$/, '').replaceAll('""', '"') : value;
}

function identifierText(value) {
  return /^[a-z_][a-z0-9_$]*$/.test(value) && !quotedKeywords.has(value.toUpperCase())
    ? value : `"${value.replaceAll('"', '""')}"`;
}

function canonicalIdentifier(raw) {
  return raw.startsWith('"') ? unquote(raw) : raw.toLowerCase();
}

function tableFunctionAt(text, start, catalog) {
  const first = readIdentifier(text, start);
  if (!first) return null;
  let at = skipSpace(text, first.end);
  let schemaName = null;
  let name = first.name;
  if (text[at] === '.') {
    const second = readIdentifier(text, at + 1);
    if (!second) return null;
    schemaName = name;
    name = second.name;
    at = skipSpace(text, second.end);
  }
  const call = readGroup(text, at);
  if (!call) return null;
  const routines = [...catalog.functions, ...(catalog.builtinFunctions || [])].filter(fn =>
    fn.name === name && (schemaName ? fn.schema === schemaName :
      !catalog.searchPath || firstVisibleRoutine(catalog, fn)));
  if (!routines.length) return null;
  at = skipSpace(text, call.end);
  let ordinality = false;
  const withOrdinality = text.slice(at).match(/^WITH\s+ORDINALITY\b/i);
  if (withOrdinality) { ordinality = true; at = skipSpace(text, at + withOrdinality[0].length); }
  const as = text.slice(at).match(/^AS\b/i);
  if (as) at = skipSpace(text, at + as[0].length);
  const possibleAlias = readIdentifier(text, at);
  const alias = possibleAlias && !reserved.has(possibleAlias.name.toUpperCase()) ? possibleAlias.name : name;
  if (possibleAlias && alias === possibleAlias.name) at = skipSpace(text, possibleAlias.end);
  const commonReturn = routines.every(fn => fn.returns === routines[0].returns) ? routines[0].returns : 'unknown';
  const returnParts = commonReturn.match(new RegExp(`^(${identifier})(?:\\.(${identifier}))?$`));
  const composite = returnParts && findRelation(catalog,
    canonicalIdentifier(returnParts[2] || returnParts[1]), returnParts[2] ? canonicalIdentifier(returnParts[1]) : null);
  let columns = composite ? columnsFor(catalog, composite).map(column => ({ name: column.name, type: column.type })) :
    commonReturn === 'record' ? [] : [{ name, type: commonReturn }];
  if (ordinality) columns.push({ name: 'ordinality', type: 'bigint' });
  const aliases = readGroup(text, at);
  if (aliases) {
    const names = splitTopLevel(aliases.content).map(part => {
      const column = readIdentifier(part, 0);
      return column && { name: column.name, type: part.slice(column.end).trim() };
    }).filter(Boolean);
    columns = names.map((column, index) => ({ name: column.name,
      type: column.type || columns[index]?.type || 'unknown' }));
    at = aliases.end;
  }
  const relation = { schema: '__function__', name: alias, kind: 'function-source',
    columns: columns.map(column => ({ ...column, schema: '__function__', relation: alias })) };
  return { alias, relation, end: at };
}

function rowsFromAt(text, start, catalog) {
  const head = text.slice(start).match(/^ROWS\s+FROM\s*/i);
  if (!head) return null;
  const group = readGroup(text, start + head[0].length);
  if (!group) return null;
  const sources = splitTopLevel(group.content).map(part => tableFunctionAt(part, 0, catalog));
  if (sources.some(source => !source)) return null;
  let columns = sources.flatMap(source => source.relation.columns.map(column => ({ name: column.name, type: column.type })));
  let at = skipSpace(text, group.end);
  const withOrdinality = text.slice(at).match(/^WITH\s+ORDINALITY\b/i);
  if (withOrdinality) {
    columns.push({ name: 'ordinality', type: 'bigint' });
    at = skipSpace(text, at + withOrdinality[0].length);
  }
  const as = text.slice(at).match(/^AS\b/i);
  if (as) at = skipSpace(text, at + as[0].length);
  const possibleAlias = readIdentifier(text, at);
  const alias = possibleAlias && !reserved.has(possibleAlias.name.toUpperCase()) ? possibleAlias.name : sources[0].alias;
  if (possibleAlias && alias === possibleAlias.name) at = skipSpace(text, possibleAlias.end);
  const aliases = readGroup(text, at);
  if (aliases) {
    const names = splitTopLevel(aliases.content).map(part => readIdentifier(part, 0)?.name);
    columns = columns.map((column, index) => ({ ...column, name: names[index] || column.name }));
    at = aliases.end;
  }
  return { alias, relation: { schema: '__function__', name: alias, kind: 'function-source',
    columns: columns.map(column => ({ ...column, schema: '__function__', relation: alias })) }, end: at };
}

function joinedColumns(sql, schema) {
  const tokens = scanSql(sql).filter(token => token.kind !== 'comment');
  let at = 0;
  const word = index => tokens[index]?.kind === 'word' ? tokens[index].text.toUpperCase() : '';
  function aliasColumns(columns) {
    if (word(at) === 'AS') at++;
    if (tokens[at] && ['word', 'identifier'].includes(tokens[at].kind) && !reserved.has(word(at))) at++;
    if (tokens[at]?.text !== '(') return columns;
    const start = at++;
    let depth = 1;
    while (at < tokens.length && depth) {
      if (tokens[at].text === '(') depth++;
      else if (tokens[at].text === ')') depth--;
      at++;
    }
    const names = tokens.slice(start + 1, at - 1).filter(token => ['word', 'identifier'].includes(token.kind))
      .map(token => canonicalIdentifier(token.text));
    return columns.map((column, index) => ({ ...column, name: names[index] || column.name }));
  }
  function factor() {
    if (word(at) === 'LATERAL') at++;
    if (word(at) === 'ONLY') at++;
    if (tokens[at]?.text === '(') {
      const start = tokens[at++].end;
      let depth = 1;
      while (at < tokens.length && depth) {
        if (tokens[at].text === '(') depth++;
        else if (tokens[at].text === ')') depth--;
        at++;
      }
      const end = depth ? sql.length : tokens[at - 1].start;
      let columns = joinedColumns(sql.slice(start, end), schema);
      const aliasAt = word(at) === 'AS' ? at + 1 : at;
      if (!columns.length && ['word', 'identifier'].includes(tokens[aliasAt]?.kind)) {
        const relation = findRelation(schema, canonicalIdentifier(tokens[aliasAt].text));
        if (relation?.kind === 'derived') columns = columnsFor(schema, relation);
      }
      return aliasColumns(columns);
    }
    const first = tokens[at];
    if (!first || !['word', 'identifier'].includes(first.kind)) return [];
    if (word(at) === 'ROWS' && word(at + 1) === 'FROM') {
      const source = rowsFromAt(sql, first.start, schema);
      if (source) {
        while (at < tokens.length && tokens[at].start < source.end) at++;
        return columnsFor(schema, source.relation);
      }
    }
    at++;
    let name = canonicalIdentifier(first.text);
    let schemaName = null;
    if (tokens[at]?.text === '.' && ['word', 'identifier'].includes(tokens[at + 1]?.kind)) {
      schemaName = name;
      name = canonicalIdentifier(tokens[at + 1].text);
      at += 2;
    }
    if (tokens[at]?.text === '(') {
      const source = tableFunctionAt(sql, first.start, schema);
      if (source) {
        while (at < tokens.length && tokens[at].start < source.end) at++;
        return columnsFor(schema, source.relation);
      }
    }
    const relation = findRelation(schema, name, schemaName);
    return aliasColumns(relation ? columnsFor(schema, relation) : []);
  }
  function merge(left, right, names) {
    const shared = [...new Set(names)];
    const merged = shared.map(name => left.find(column => column.name === name) || right.find(column => column.name === name)).filter(Boolean);
    return [...merged, ...left.filter(column => !shared.includes(column.name)), ...right.filter(column => !shared.includes(column.name))];
  }
  let columns = factor();
  while (at < tokens.length) {
    const natural = word(at) === 'NATURAL';
    if (natural) at++;
    while (['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS'].includes(word(at))) at++;
    if (word(at) !== 'JOIN') break;
    at++;
    const right = factor();
    if (word(at) === 'USING' && tokens[at + 1]?.text === '(') {
      at += 2;
      const names = [];
      while (at < tokens.length && tokens[at].text !== ')') {
        if (['word', 'identifier'].includes(tokens[at].kind)) names.push(canonicalIdentifier(tokens[at].text));
        at++;
      }
      if (tokens[at]?.text === ')') at++;
      columns = merge(columns, right, names);
    } else if (natural) {
      const rightNames = new Set(right.map(column => column.name));
      columns = merge(columns, right, columns.filter(column => rightNames.has(column.name)).map(column => column.name));
    } else {
      columns = [...columns, ...right];
    }
    if (word(at) === 'ON') {
      at++;
      let depth = 0;
      while (at < tokens.length) {
        if (tokens[at].text === '(') depth++;
        else if (tokens[at].text === ')') depth--;
        if (depth === 0 && (word(at) === 'JOIN' || word(at) === 'NATURAL' ||
          ['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'].includes(word(at)))) break;
        at++;
      }
    }
  }
  return columns;
}

function joinOutputCounts(statement, schema) {
  const tokens = scanSql(statement);
  let depth = 0;
  let start = -1;
  for (const token of tokens) {
    if (token.text === '(') depth++;
    else if (token.text === ')') depth--;
    else if (depth === 0 && token.kind === 'word' && token.text.toUpperCase() === 'FROM') {
      start = token.end;
      break;
    }
  }
  if (start < 0) return null;
  depth = 0;
  let end = statement.length;
  for (const token of tokens.filter(token => token.start >= start)) {
    if (token.text === '(') depth++;
    else if (token.text === ')') depth--;
    else if (depth === 0 && token.text === ',') return null;
    else if (depth === 0 && token.kind === 'word' &&
      ['WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT'].includes(token.text.toUpperCase())) {
      end = token.start;
      break;
    }
  }
  const source = statement.slice(start, end);
  if (!/\bJOIN\b/i.test(source)) return null;
  const counts = new Map();
  for (const column of joinedColumns(source, schema)) counts.set(column.name, (counts.get(column.name) || 0) + 1);
  return counts;
}

function references(statement, schema) {
  const entries = [];
  const hiddenNames = new Set();
  function add(rawRelation, rawAlias, position) {
    const parts = [...rawRelation.matchAll(new RegExp(identifier, 'g'))].map(part => canonicalIdentifier(part[0]));
    const name = parts.at(-1);
    const relation = findRelation(schema, name, parts.length === 1 ? null : parts[0]);
    if (!relation) return;
    const alias = rawAlias && !reserved.has(rawAlias.toUpperCase()) ? canonicalIdentifier(rawAlias) : null;
    if (alias && alias !== name) {
      entries.push([position, alias, relation]);
      hiddenNames.add(name);
    } else entries.push([position, name, relation]);
  }
  // A JOIN group alias replaces its operand bindings outside the group. Keep
  // the same character positions so ordinary sources still sort by SQL order.
  let masked = null;
  const tokens = scanSql(statement);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const previous = tokens[i - 1];
    if (token.text !== '(' || !(['FROM', 'JOIN'].includes(previous?.text.toUpperCase()) || previous?.text === ',')) continue;
    if (previous?.text.toUpperCase() === 'FROM' && tokens[i - 2]?.text.toUpperCase() === 'ROWS') continue;
    const group = readGroup(statement, token.start);
    if (!group || /^\s*(?:SELECT|WITH)\b/i.test(group.content)) continue;
    let at = skipSpace(statement, group.end);
    const as = statement.slice(at).match(/^AS\b/i);
    if (as) at = skipSpace(statement, at + as[0].length);
    const alias = readIdentifier(statement, at);
    const grouped = alias && !reserved.has(alias.name.toUpperCase());
    let content = group.content.trim();
    while (content.startsWith('(') && readGroup(content, 0)?.end === content.length) {
      content = content.slice(1, -1).trim();
    }
    const inner = references(`FROM ${content}`, schema);
    if (!inner.size) continue;
    if (grouped) {
      let columns = joinedColumns(content, schema);
      if (!columns.length) columns = [...inner.values()].flatMap(relation => columnsFor(schema, relation));
      const renames = readGroup(statement, alias.end);
      if (renames) {
        const names = splitTopLevel(renames.content).map(name => canonicalIdentifier(name.trim()));
        columns = columns.map((column, index) => ({ ...column, name: names[index] || column.name }));
      }
      entries.push([token.start, alias.name, { schema: '__join__', name: alias.name, kind: 'join', columns }]);
      for (const name of inner.keys()) hiddenNames.add(name);
    } else {
      for (const [name, relation] of inner) entries.push([token.start, name, relation]);
      for (const name of inner.hiddenNames) hiddenNames.add(name);
    }
    masked ??= [...statement];
    for (let at = token.start; at < group.end; at++) if (masked[at] !== '\n') masked[at] = ' ';
    while (tokens[i + 1]?.start < group.end) i++;
  }
  if (masked) statement = masked.join('');
  for (const match of statement.matchAll(referencePattern)) {
    add(match[1], match[2], match.index);
  }
  const sourceTokens = masked ? scanSql(statement) : tokens;
  for (let i = 0; i < sourceTokens.length; i++) {
    const token = sourceTokens[i];
    if (!['word', 'identifier'].includes(token.kind)) continue;
    const previous = sourceTokens[i - 1];
    const before = previous?.text.toUpperCase();
    if (!['FROM', 'JOIN', 'LATERAL', ','].includes(before)) continue;
    const source = token.text.toUpperCase() === 'ROWS'
      ? rowsFromAt(statement, token.start, schema) : tableFunctionAt(statement, token.start, schema);
    if (source) entries.push([token.start, source.alias, source.relation]);
  }
  // A derived source starts with a parenthesized SELECT, so the ordinary
  // FROM/JOIN identifier pattern cannot see the alias after its closing `)`.
  for (const match of statement.matchAll(/\b(?:FROM|JOIN|LATERAL)\s*\(/gi)) {
    const open = statement.indexOf('(', match.index);
    const group = readGroup(statement, open);
    if (!group) continue;
    let at = skipSpace(statement, group.end);
    const as = statement.slice(at).match(/^AS\b/i);
    if (as) at = skipSpace(statement, at + as[0].length);
    const alias = readIdentifier(statement, at);
    if (!alias) continue;
    const relation = findRelation(schema, alias.name);
    if (relation?.kind === 'derived') entries.push([match.index, alias.name, relation]);
  }
  // Comma-separated sources are part of the same FROM list. Ignore commas in
  // nested expressions, such as a function call used as a table source.
  for (const from of statement.matchAll(/\bFROM\b([\s\S]*?)(?=\b(?:JOIN|ON|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION|RETURNING)\b|$)/gi)) {
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i <= from[1].length; i++) {
      const char = from[1][i];
      if (char === '"') {
        if (quoted && from[1][i + 1] === '"') { i++; continue; }
        quoted = !quoted;
      } else if (!quoted && char === '(') depth++;
      else if (!quoted && char === ')') depth--;
      if ((char === ',' && depth === 0 && !quoted) || i === from[1].length) {
        if (start > 0) {
          const segment = from[1].slice(start, i).trim();
          const match = segment.match(new RegExp(`^(${identifier}(?:\\.${identifier})?)(?:\\s+(?:AS\\s+)?(${identifier}))?`, 'i'));
          if (match) add(match[1], match[2], from.index + from[0].indexOf(from[1]) + start);
        }
        start = i + 1;
      }
    }
  }
  const found = new Map();
  for (const [, name, relation] of entries.sort((a, b) => a[0] - b[0])) found.set(name, relation);
  found.hiddenNames = hiddenNames;
  return found;
}

function selectAncestors(statement, offset) {
  return queryScopes(statement, offset).map(scope => scope.start - 1);
}

/** Shared contexts used by the demo's experimental parser adapters. */
export function useCommonCompletion(sql, offset) {
  const cursor = resolveCursor(sql, offset);
  return ['statement', 'setting', 'type'].includes(cursor.context) ||
    /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|SHOW)\b/i.test(cursor.statement) ||
    cursor.queryBoundary && ['continuation', 'wildcard', 'alias', 'after-alias'].includes(cursor.state);
}

export function isProjectionContext(sql, offset) {
  return resolveCursor(sql, offset).context === 'projection';
}

export function projectionWildcardAvailable(sql, offset) {
  const cursor = resolveCursor(sql, offset);
  return cursor.context === 'projection' && cursor.state === 'operand';
}

function item(label, kind, insertText = identifierText(label), detail = '', listDescription = detail) {
  return { label, kind, insertText, detail, listDescription };
}

function relationDescription(relation) {
  return relation.kind === 'cte' ? `CTE ${relation.name}` :
    relation.kind === 'join' ? `joined table ${relation.name}` :
    relation.kind === 'function-source' ? `table function ${relation.name}` :
    relation.kind === 'derived' ? `derived table ${relation.name}` :
    `${relation.schema}.${relation.name}${relation.draft ? ' · draft' : ''}`;
}

function relationKind(relation) {
  return `${relation.draft ? 'draft ' : ''}${relation.kind}`;
}

function builtinSuggestions(schema, prefix) {
  const search = searchPrefix(prefix).toLowerCase();
  const available = schema.builtinFunctions || [];
  let selected;
  if (search.length < 2) {
    selected = featuredBuiltinNames.flatMap(name => {
      if (!name.startsWith(search)) return [];
      const overloads = available.filter(f => f.name === name);
      const preferred = overloads.find(f => f.arguments === '') ||
        overloads.find(f => /\btext\b/.test(f.arguments)) || overloads[0];
      return preferred ? [preferred] : [];
    });
  } else {
    selected = available.filter(f => f.name.toLowerCase().startsWith(search)).slice(0, maxBuiltinMatches);
  }
  return selected.map(f => {
    const args = f.arguments || '';
    const displayArgs = f.name === 'count' && !args ? '*' : args;
    const call = f.name === 'count' && !args ? 'count(*)' : `${identifierText(f.name)}(${args ? '$1' : ''})`;
    return item(f.name, 'function', call,
      `pg_catalog.${f.name}(${displayArgs}) → ${f.returns}`,
      `built-in ${f.routineKind || 'function'} · (${displayArgs}) → ${f.returns}`);
  });
}

function typeSuggestions(schema, prefix, qualifier, limit) {
  const search = searchPrefix(prefix).toLowerCase();
  const available = schema.types?.length ? schema.types : defaultTypes;
  const visibleTypes = new Map();
  if (schema.searchPath) for (const type of available) {
    const priority = schema.searchPath.indexOf(type.schema);
    if (priority < 0) continue;
    const name = type.sqlName || type.name;
    if (!visibleTypes.has(name) || priority < visibleTypes.get(name).priority) visibleTypes.set(name, { type, priority });
  }
  const suggestions = [];
  for (const type of available) {
    if (qualifier && type.schema !== qualifier) continue;
    const matchesName = type.name.toLowerCase().startsWith(search);
    const matchesSqlName = type.sqlName?.toLowerCase().startsWith(search);
    if (!matchesName && !matchesSqlName) continue;
    const rawName = type.sqlName || type.name;
    const insertName = type.schema === 'pg_catalog' && !qualifier ? type.name : identifierText(rawName);
    const unqualified = schema.searchPath ? visibleTypes.get(rawName)?.type === type :
      type.schema === 'pg_catalog' || type.schema === schema.currentSchema || type.schema === 'public';
    const insertText = qualifier || unqualified
      ? insertName : `${identifierText(type.schema)}.${insertName}`;
    const suggestion = item(type.name, 'type', insertText, `${type.schema}.${type.name} · ${type.kind}`, `${type.schema} · ${type.kind}`);
    if (!matchesName && matchesSqlName) suggestion.filterText = rawName;
    suggestions.push(suggestion);
    if (!search && suggestions.length > limit) break;
  }
  return suggestions;
}

function rankedKeywords(schema, context, search, limit) {
  const available = (schema.keywords?.length ? schema.keywords : keywords).filter(word => operandKeywords.has(word.toUpperCase()));
  const priority = context === 'projection' ? projectionKeywordPriority : expressionKeywordPriority;
  const byUppercase = new Map(available.map(word => [word.toUpperCase(), word]));
  const featured = priority.map(word => byUppercase.get(word)).filter(Boolean);
  const ordered = search ? [...featured, ...available.filter(word => !priority.includes(word.toUpperCase()))] : featured;
  return ordered.filter(word => word.toLowerCase().startsWith(search)).slice(0, limit + 1)
    .map(word => item(word, 'keyword', word, 'SQL keyword', ''));
}

function interleave(primary, secondary, tertiary) {
  const groups = [primary, secondary, tertiary];
  const order = [0, 1, 2, 0, 0];
  const positions = [0, 0, 0];
  const output = [];
  while (positions.some((position, index) => position < groups[index].length)) {
    for (const index of order) {
      if (positions[index] < groups[index].length) output.push(groups[index][positions[index]++]);
    }
  }
  return output;
}

/** Return database-aware suggestions and the replacement start offset. */
export function complete(sql, offset, schema, options = {}) {
  completionLimit(options);
  const cursor = resolveCursor(sql, offset);
  schema = catalogAtMaskedCursor(cursor.masked, offset, schema);
  if (cursor.context === 'ignored') return { suggestions: [], replacementStart: offset, context: 'ignored', incomplete: false };
  const { wholeStatement, contextBefore, prefix, qualifier, qualifierQuoted, replacementStart } = cursor;
  const setOrderColumns = cursor.activeClause === 'ORDER'
    ? combinedOrderColumns(wholeStatement, offset - cursor.statementStart, schema) : null;
  if (setOrderColumns) return completeResolved({ context: 'set-order', prefix, replacementStart,
    setOrderColumns: qualifier ? [] : setOrderColumns }, schema, options);
  // Preserve correlated outer bindings; each nested query contributes its own
  // sources, with local aliases taking precedence. Closed subqueries stay hidden.
  const refs = new Map();
  const hiddenQualifiers = new Set();
  let localRefs = new Map();
  for (const [index, scope] of cursor.scopes.entries()) {
    const child = cursor.scopes[index + 1];
    const fullScope = referenceScope(cursor.masked.slice(scope.start, scope.end));
    const allRefs = references(fullScope, schema);
    const condition = child?.parentVisibility === 'none' || child?.parentVisibility === 'preceding'
      ? null : joinConditionScope(cursor.masked, child?.sourceStart ?? offset, scope.start);
    const functionStart = tableFunctionArgumentScope(cursor.masked, child?.sourceStart ?? offset, scope.start);
    const end = child?.parentVisibility === 'none' ? scope.start :
      child?.parentVisibility === 'preceding' ? child.sourceStart :
      functionStart !== null ? functionStart :
      condition ? child?.sourceStart ?? offset : scope.end;
    localRefs = !condition && functionStart === null && end === scope.end ? allRefs : references(`${condition?.needsFrom && functionStart === null ? 'FROM ' : ''}${referenceScope(cursor.masked.slice(condition?.start ?? scope.start, end))}`, schema);
    for (const name of allRefs.hiddenNames) hiddenQualifiers.add(name);
    for (const name of allRefs.keys()) if (!localRefs.has(name)) hiddenQualifiers.add(name);
    for (const [name, relation] of localRefs) refs.set(name, relation);
  }
  const target = /^\s*(?:INSERT\s+INTO|UPDATE)\s+/i.test(wholeStatement) ? [...refs.values()][0] : null;
  const targetColumns = Boolean(target && (
    /^\s*UPDATE\b[\s\S]*\bSET\s*(?:[\w".]+\s*=\s*[^,]*,\s*)?$/i.test(contextBefore) ||
    /^\s*INSERT\s+INTO\s+[\w".]+\s*\([^)]*$/i.test(contextBefore)
  ));
  const usingMatch = contextBefore.match(/\bUSING\s*\(([^()]*)$/i);
  const usingColumns = usingMatch && [...new Set(refs.values())].slice(-2);
  const usedUsingNames = new Set((usingMatch?.[1] || '').split(',').map(name => canonicalIdentifier(name.trim())).filter(Boolean));
  const context = targetColumns ? 'target-column' : cursor.context;
  const outputCounts = !qualifier && cursor.scopes.length === 1 && !joinConditionScope(cursor.masked, offset, cursor.scopes[0].start)
    ? joinOutputCounts(referenceScope(cursor.masked.slice(cursor.scopes[0].start, cursor.scopes[0].end)), schema) : null;
  const allowWildcard = context === 'projection' && cursor.state === 'operand' &&
    (qualifier && (refs.has(qualifier) || !hiddenQualifiers.has(qualifier) && findRelation(schema, qualifier)) ||
      localRefs.size > 0);
  return completeResolved({ context, qualifier, qualifierQuoted, prefix, replacementStart, refs, hiddenQualifiers, target, usingColumns, usedUsingNames, outputCounts,
    allowWildcard, position: cursor.state, queryBoundary: cursor.queryBoundary }, schema, options);
}

function completionLimit(options) {
  if (options.limit == null) return Infinity;
  if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
    throw new TypeError('CrabSense completion limit must be a non-negative integer');
  }
  return options.limit;
}

/** Turn a parser's cursor context into consistent catalog suggestions. */
export function completeResolved({ context, qualifier = null, qualifierQuoted = false, prefix = '', replacementStart, refs = new Map(), hiddenQualifiers = new Set(), target = null, usingColumns = null, usedUsingNames = new Set(), outputCounts = null, setOrderColumns = null, allowWildcard = true, position = 'operand', queryBoundary = context === 'projection', afterWildcard = false, preferredKeyword = null }, schema, options = {}) {
  // Compatibility for callers of the experimental parser bridge. The package
  // resolver passes an explicit state; ranking hints never control validity.
  if (afterWildcard) position = 'wildcard';
  const projection = context === 'projection';
  const limit = completionLimit(options);
  const search = searchPrefix(prefix).toLowerCase();
  let suggestions = [];

  if (context === 'set-order') {
    suggestions = (setOrderColumns || []).map(column => item(column.name, 'column', identifierText(column.name), `Query output · ${column.type}`));
  } else if (context === 'cte-as') {
    suggestions = [item('AS', 'keyword', 'AS', 'Start the CTE query', 'CTE keyword')];
  } else if (context === 'cte-body-start') {
    suggestions = ['SELECT', 'VALUES', 'INSERT', 'UPDATE', 'DELETE']
      .map(word => item(word, 'keyword', word, 'Start the CTE query', 'CTE query'));
  } else if (context === 'definition-column') {
    suggestions = [];
  } else if (context === 'type') {
    suggestions = typeSuggestions(schema, prefix, qualifierQuoted ? qualifier : qualifier?.toLowerCase(), limit);
  } else if (position === 'alias') {
    suggestions = [];
  } else if (['continuation', 'wildcard', 'after-alias'].includes(position)) {
    if (!qualifier && !prefix.startsWith('"')) {
      const continuations = position === 'wildcard' ? ['FROM'] : [
        ...(queryBoundary ? selectClauses : []),
        ...(position === 'continuation' ? [...(queryBoundary ? ['AS'] : []), ...expressionContinuations] : [])
      ];
      preferredKeyword = queryBoundary ? 'FROM' : null;
      suggestions = continuations
        .map(word => item(word, 'keyword', word, 'Continue the SELECT expression or clause', 'SQL continuation'));
    }
  } else if (qualifier) {
    const lookupName = qualifierQuoted ? qualifier : qualifier.toLowerCase();
    const relation = refs.get(lookupName) || (!hiddenQualifiers.has(lookupName) && findRelation(schema, lookupName));
    if (relation) {
      context = 'qualified-column';
      suggestions = suggestibleColumnsFor(schema, relation)
        .map(c => item(c.name, 'column', identifierText(c.name), `${relationDescription(relation)} · ${c.type}`));
      if (projection && allowWildcard) suggestions.unshift(item('*', 'keyword', '*', `${relationDescription(relation)} · all columns`, 'all columns'));
    } else if (lookupName === 'pg_catalog' && context !== 'relation') {
      context = 'schema-member';
      suggestions = builtinSuggestions(schema, prefix);
    } else if (schema.schemas.some(name => name === lookupName)) {
      context = 'schema-member';
      for (const r of schema.relations) {
        if (r.schema !== lookupName || !r.name.toLowerCase().startsWith(search)) continue;
        suggestions.push(item(r.name, r.kind, identifierText(r.name), `${r.schema}.${r.name} · ${relationKind(r)}`, relationKind(r)));
        if (suggestions.length > limit) break;
      }
      if (suggestions.length <= limit) for (const f of schema.functions) {
        if (f.schema !== lookupName || !f.name.toLowerCase().startsWith(search)) continue;
        suggestions.push(item(f.name, 'function', `${identifierText(f.name)}($1)`, `${f.schema}.${f.name}(${f.arguments}) → ${f.returns}`, `(${f.arguments}) → ${f.returns}`));
        if (suggestions.length > limit) break;
      }
    }
  } else if (context === 'relation') {
    context = 'relation';
    const addSchemas = () => {
      for (const s of schema.schemas) {
        if (!s.toLowerCase().startsWith(search)) continue;
        suggestions.push(item(s, 'schema', `${identifierText(s)}.`, `${s} · schema`, 'schema'));
        if (!search && suggestions.length > limit) break;
      }
    };
    if (search) addSchemas();
    if (search || suggestions.length <= limit) for (const r of schema.relations) {
      if (r.kind === 'derived' || !r.name.toLowerCase().startsWith(search)) continue;
      const unqualified = r.kind === 'cte' || (schema.searchPath ? findRelation(schema, r.name) === r : r.schema === 'public');
      suggestions.push(item(r.name, r.kind, unqualified ? identifierText(r.name) : `${identifierText(r.schema)}.${identifierText(r.name)}`, r.kind === 'cte' ? `CTE ${r.name}` : `${r.schema}.${r.name} · ${relationKind(r)}`, r.kind === 'cte' ? 'CTE' : `${r.schema} · ${relationKind(r)}`));
      if (!search && suggestions.length > limit) break;
    }
    if (!search && suggestions.length <= limit) addSchemas();
  } else if (context === 'statement') {
    suggestions = statements.map(k => item(k, 'keyword', k, 'SQL statement', ''));
  } else if (context === 'setting') {
    suggestions = [
      item('ALL', 'keyword', 'ALL', 'Show all PostgreSQL settings', 'all settings'),
      ...(schema.settings || []).map(s => item(s.name, 'setting', s.name, s.description, 'PostgreSQL setting'))
    ];
  } else if (context === 'target-column') {
    suggestions = (target ? columnsFor(schema, target) : [])
      .map(c => item(c.name, 'column', identifierText(c.name), `${relationDescription(target)} · ${c.type}`));
  } else if (context === 'using-column') {
    if (usingColumns?.length === 2) {
      const [left, right] = usingColumns;
      const rightNames = new Set(columnsFor(schema, right).map(c => c.name));
      suggestions = columnsFor(schema, left).filter(c => rightNames.has(c.name) && !usedUsingNames.has(c.name))
        .map(c => item(c.name, 'column', identifierText(c.name), `${relationDescription(left)} and ${relationDescription(right)} · ${c.type}`));
    }
  } else if (context !== 'ignored') {
    const used = [...new Set(refs.values())];
    const relevantRelations = used.length || !options.allColumnsFallback ? used : schema.relations;
    const bindings = [...refs].map(([name, relation]) => ({ relation, name }));
    const aliases = context === 'projection' && search
      ? [
          ...bindings.filter(({ name }) => name.toLowerCase().startsWith(search)),
          ...schema.relations.filter(relation => relation.kind === 'derived' && !hiddenQualifiers.has(relation.name) && !refs.has(relation.name) && relation.name.toLowerCase().startsWith(search))
            .map(relation => ({ relation, name: relation.name }))
        ].map(({ relation, name }) => item(name, 'alias', `${identifierText(name)}.`, `${relationDescription(relation)} · alias`, 'relation alias'))
      : [];
    const columnCandidates = bindings.flatMap(({ relation, name }) => suggestibleColumnsFor(schema, relation)
      .map(column => ({ column, relation, qualifier: name })));
    const nameCounts = new Map();
    for (const { column } of columnCandidates) nameCounts.set(column.name, (nameCounts.get(column.name) || 0) + 1);
    const seenUnqualified = new Set();
    const columns = used.length ? columnCandidates.flatMap(({ column, relation, qualifier }) => {
      const ambiguous = (outputCounts?.get(column.name) ?? nameCounts.get(column.name)) > 1;
      if (!ambiguous && seenUnqualified.has(column.name)) return [];
      if (!ambiguous) seenUnqualified.add(column.name);
      const label = ambiguous ? `${identifierText(qualifier)}.${identifierText(column.name)}` : column.name;
      return [{ ...item(label, 'column', ambiguous ? label : identifierText(column.name),
        `${relationDescription(relation)} · ${column.type}`), filterText: column.name, columnName: column.name }];
    }) : (() => {
      if (limit === Infinity) return relevantRelations.flatMap(relation => columnsFor(schema, relation)
        .map(column => item(column.name, 'column', identifierText(column.name), `${relationDescription(relation)} · ${column.type}`)));
      return leadingColumns(schema, relevantRelations, search, limit);
    })();
    const broadFallback = !used.length && options.allColumnsFallback;
    const functions = [];
    if (broadFallback || columns.length <= limit) for (const f of schema.functions) {
      if (!f.name.toLowerCase().startsWith(search)) continue;
      const unqualified = schema.searchPath ? firstVisibleRoutine(schema, f) : f.schema === 'public';
      functions.push(item(f.name, 'function', `${unqualified ? '' : `${identifierText(f.schema)}.`}${identifierText(f.name)}($1)`, `${f.schema}.${f.name}(${f.arguments}) → ${f.returns}`, `(${f.arguments}) → ${f.returns}`));
      if (broadFallback && functions.length > limit) break;
    }
    if (broadFallback) {
      const builtin = builtinSuggestions(schema, prefix);
      const routines = interleave(functions, builtin, []);
      suggestions = interleave(columns, routines, rankedKeywords(schema, context, search, limit));
      if (search) {
        const exact = suggestion => (suggestion.filterText || suggestion.label).toLowerCase() === search;
        suggestions = [...suggestions.filter(exact), ...suggestions.filter(suggestion => !exact(suggestion))];
      }
    } else {
      suggestions = [
        ...aliases,
        ...columns,
        ...functions,
        ...(columns.length > limit ? [] : builtinSuggestions(schema, prefix)),
        ...(columns.length > limit ? [] : rankedKeywords(schema, context, search, Infinity))
      ];
    }
    if (context === 'projection' && allowWildcard) suggestions.unshift(item('*', 'keyword', '*', 'All columns', 'all columns'));
  }

  const ranked = rankSuggestions(suggestions, { search, context, preferredKeyword, limit });
  return { ...ranked, replacementStart, context };
}

/** Compute a quote-aware Monaco edit without making the completion engine depend on Monaco. */
export function completionEdit(sql, offset, replacementStart, suggestion) {
  if (sql[replacementStart] !== '"') {
    return { replacementStart, replacementEnd: offset, insertText: suggestion.insertText, filterText: suggestion.filterText || suggestion.label };
  }
  const replacementEnd = sql[offset] === '"' ? offset + 1 : offset;
  const name = suggestion.columnName || suggestion.label;
  const escapedName = `"${name.replaceAll('"', '""')}"`;
  const insertText = suggestion.insertText.includes(escapedName)
    ? suggestion.insertText
    : suggestion.insertText.replace(identifierText(name), escapedName);
  return { replacementStart, replacementEnd, insertText, filterText: `"${name}` };
}

function argumentLabels(argumentsText) {
  if (!argumentsText) return [];
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < argumentsText.length; i++) {
    if (argumentsText[i] === '(') depth++;
    else if (argumentsText[i] === ')') depth--;
    else if (argumentsText[i] === ',' && depth === 0) {
      parts.push(argumentsText.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(argumentsText.slice(start).trim());
  return parts;
}

function signatureHelp(sql, offset, catalog) {
  const { masked, ignored } = maskIgnored(sql.slice(0, offset));
  if (ignored) return null;
  const stack = [];
  let inIdentifier = false;
  for (let i = 0; i < masked.length; i++) {
    const char = masked[i];
    if (char === '"') {
      if (inIdentifier && masked[i + 1] === '"') { i++; continue; }
      inIdentifier = !inIdentifier;
    }
    if (inIdentifier) continue;
    if (char === '(') stack.push({ start: i, commas: 0 });
    else if (char === ')') stack.pop();
    else if (char === ',' && stack.length) stack.at(-1).commas++;
  }
  const call = stack.at(-1);
  if (!call) return null;
  const name = masked.slice(0, call.start).match(new RegExp(`(${identifier})(?:\\.(${identifier}))?\\s*$`));
  if (!name) return null;
  const routineName = unquote(name[2] || name[1]);
  const schemaName = name[2] ? unquote(name[1]) : null;
  const matches = [...catalog.functions, ...catalog.builtinFunctions].filter(f =>
    f.name.toLowerCase() === routineName.toLowerCase() &&
    (schemaName ? f.schema.toLowerCase() === schemaName.toLowerCase() :
      !catalog.searchPath || firstVisibleRoutine(catalog, f)));
  if (!matches.length) return null;
  const signatures = matches.map(f => ({
    label: `${f.schema}.${f.name}(${f.name === 'count' && !f.arguments ? '*' : f.arguments}) → ${f.returns}`,
    parameters: argumentLabels(f.arguments).map(label => ({ label }))
  }));
  return { signatures, activeSignature: 0, activeParameter: call.commas };
}

function skipSpace(text, at) {
  while (/\s/.test(text[at] || '') && at < text.length) at++;
  return at;
}

function readIdentifier(text, at) {
  at = skipSpace(text, at);
  const match = text.slice(at).match(new RegExp(`^${identifier}`));
  return match ? { name: canonicalIdentifier(match[0]), end: at + match[0].length } : null;
}

function readGroup(text, at) {
  at = skipSpace(text, at);
  if (text[at] !== '(') return null;
  let depth = 0;
  let quoted = false;
  for (let i = at; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    } else if (!quoted && char === '(') depth++;
    else if (!quoted && char === ')' && --depth === 0) {
      return { content: text.slice(at + 1, i), end: i + 1 };
    }
  }
  return null;
}

function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    } else if (!quoted && char === '(') depth++;
    else if (!quoted && char === ')') depth--;
    if ((char === ',' && depth === 0 && !quoted) || i === text.length) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return parts;
}

function topLevelFrom(text, at) {
  let depth = 0;
  let quoted = false;
  for (let i = at; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    } else if (!quoted && char === '(') depth++;
    else if (!quoted && char === ')') depth--;
    if (!quoted && depth === 0 && /^FROM\b/i.test(text.slice(i)) && !/[\w$]/.test(text[i - 1] || '')) return i;
  }
  return text.length;
}

function projectedColumns(query, cteName, explicitNames, catalog) {
  const select = query.match(/^\s*SELECT\b/i);
  if (!select) return (explicitNames || []).map(name => ({ schema: '__cte__', relation: cteName, name, type: 'unknown' }));
  const selectStart = select[0].length;
  const list = query.slice(selectStart, topLevelFrom(query, selectStart)).replace(/^\s*(?:DISTINCT|ALL)\b/i, '');
  const refs = references(query, catalog);
  const columns = [];
  const add = (name, type = 'unknown') => {
    if (!columns.some(column => column.name === name)) columns.push({ schema: '__cte__', relation: cteName, name, type });
  };
  for (const expression of splitTopLevel(list)) {
    const as = expression.match(new RegExp(`(?:^|\\s+)AS\\s+(${identifier})\\s*$`, 'i'));
    const trailingName = !as && expression.match(new RegExp(`\\s+(${identifier})\\s*$`));
    const implicitAlias = trailingName && !/[+\-*/%<>=|&^.,(]$/.test(expression.slice(0, trailingName.index).trim());
    const source = as ? expression.slice(0, as.index).trim() :
      implicitAlias ? expression.slice(0, trailingName.index).trim() : expression.trim();
    const alias = as ? canonicalIdentifier(as[1]) : implicitAlias ? canonicalIdentifier(trailingName[1]) : null;
    const star = source.match(new RegExp(`^(${identifier})\\.\\*$`));
    if (source === '*' || star) {
      const relations = star ? [refs.get(canonicalIdentifier(star[1]))].filter(Boolean) : [...new Set(refs.values())];
      for (const relation of relations) {
        for (const column of columnsFor(catalog, relation)) add(column.name, column.type);
      }
      continue;
    }
    const direct = source.match(new RegExp(`^(?:(${identifier})\\.)?(${identifier})$`));
    if (direct) {
      const columnName = canonicalIdentifier(direct[2]);
      const relation = direct[1] ? refs.get(canonicalIdentifier(direct[1])) : null;
      const inScope = relation ? [relation] : [...new Set(refs.values())];
      const type = inScope.flatMap(r => columnsFor(catalog, r).filter(c => c.name === columnName))[0]?.type;
      add(alias || columnName, type);
    } else if (alias) add(alias);
  }
  return explicitNames?.length
    ? explicitNames.map((name, index) => ({ schema: '__cte__', relation: cteName, name, type: columns[index]?.type || 'unknown' }))
    : columns;
}

function firstSetBranch(query) {
  let depth = 0;
  for (const token of scanSql(query)) {
    if (token.text === '(') depth++;
    else if (token.text === ')') depth--;
    else if (depth === 0 && /^(?:UNION|INTERSECT|EXCEPT)$/i.test(token.text)) return query.slice(0, token.start);
  }
  return query;
}

function combinedOrderColumns(statement, cursor, catalog) {
  const tokens = scanSql(statement);
  const open = [];
  for (let index = 0; index < tokens.length && tokens[index].start < cursor; index++) {
    if (tokens[index].text === '(') open.push(index);
    else if (tokens[index].text === ')') open.pop();
  }
  const queryOpen = [...open].reverse().find(index => /^(?:SELECT|WITH)$/i.test(tokens[index + 1]?.text || ''));
  const queryDepth = queryOpen === undefined ? 0 : open.indexOf(queryOpen) + 1;
  const queryStart = queryOpen === undefined ? 0 : tokens[queryOpen].end;
  let depth = 0;
  let firstSet = null;
  let order = null;
  for (let index = 0; index < tokens.length && tokens[index].start < cursor; index++) {
    const token = tokens[index];
    if (token.text === '(') { depth++; continue; }
    if (token.text === ')') { depth--; continue; }
    if (depth !== queryDepth || token.start < queryStart || token.kind !== 'word') continue;
    const word = token.text.toUpperCase();
    if (['UNION', 'INTERSECT', 'EXCEPT'].includes(word)) {
      if (!firstSet) firstSet = token;
      order = null;
    } else if (firstSet && word === 'ORDER' && tokens[index + 1]?.text.toUpperCase() === 'BY') {
      order = tokens[index + 1];
    } else if (order && ['LIMIT', 'OFFSET', 'FETCH', 'FOR'].includes(word)) {
      order = null;
    }
  }
  if (!firstSet || !order || order.end > cursor) return null;
  const orderTail = statement.slice(order.end, cursor);
  let itemStart = 0;
  let itemDepth = 0;
  for (const token of scanSql(orderTail)) {
    if (token.text === '(') itemDepth++;
    else if (token.text === ')') itemDepth--;
    else if (itemDepth === 0 && token.text === ',') itemStart = token.end;
  }
  const currentItem = orderTail.slice(itemStart).trim();
  if (currentItem && !new RegExp(`^${identifier}$`).test(currentItem) && !/^"(?:[^"]|"")*$/.test(currentItem)) return [];
  let branch = statement.slice(queryStart, firstSet.start).trim();
  while (branch.startsWith('(') && readGroup(branch, 0)?.end === branch.length) branch = branch.slice(1, -1).trim();
  if (/^WITH\b/i.test(branch)) {
    let branchDepth = 0;
    for (const token of scanSql(branch)) {
      if (token.text === '(') branchDepth++;
      else if (token.text === ')') branchDepth--;
      else if (branchDepth === 0 && token.text.toUpperCase() === 'SELECT') {
        branch = branch.slice(token.start);
        break;
      }
    }
  }
  return projectedColumns(branch, '__output__', null, catalog);
}

// A script can refer to a table declared in an earlier statement before that
// statement has been run. Only completed statements contribute draft objects.
function draftCatalog(maskedSql, offset, catalog) {
  const masked = maskedSql.slice(0, offset);
  const statements = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '"') {
      if (quoted && masked[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    } else if (masked[i] === ';' && !quoted) {
      statements.push(masked.slice(start, i));
      start = i + 1;
    }
  }
  let augmented = null;
  for (const statement of statements) {
    const drop = statement.match(/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?/i);
    if (drop) {
      const first = readIdentifier(statement, drop[0].length);
      if (!first) continue;
      let schemaName = catalog.currentSchema || 'public';
      let tableName = first.name;
      const dot = skipSpace(statement, first.end);
      if (statement[dot] === '.') {
        const second = readIdentifier(statement, dot + 1);
        if (!second) continue;
        schemaName = first.name;
        tableName = second.name;
      }
      if (!augmented) augmented = overlayCatalog(catalog, true);
      augmented.relations = augmented.relations.filter(r => r.schema !== schemaName || r.name !== tableName);
      augmented.columnOverrides.set(`${schemaName}\0${tableName}`, []);
      continue;
    }
    const head = statement.match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i);
    if (!head) continue;
    const first = readIdentifier(statement, head[0].length);
    if (!first) continue;
    let at = skipSpace(statement, first.end);
    let schemaName = catalog.currentSchema || 'public';
    let tableName = first.name;
    if (statement[at] === '.') {
      const second = readIdentifier(statement, at + 1);
      if (!second) continue;
      schemaName = first.name;
      tableName = second.name;
      at = skipSpace(statement, second.end);
    }
    const body = readGroup(statement, at);
    if (!body) continue; // CREATE TABLE AS and incomplete column lists are outside this heuristic.
    const columns = [];
    for (const part of splitTopLevel(body.content)) {
      const column = readIdentifier(part, 0);
      if (!column || /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|LIKE)$/i.test(column.name)) continue;
      const declaration = part.slice(column.end).trim();
      if (!declaration) continue;
      const type = declaration.split(/\s+(?=COLLATE|CONSTRAINT|NOT\s+NULL|NULL\b|DEFAULT|GENERATED|PRIMARY\s+KEY|REFERENCES|CHECK\b|UNIQUE\b)/i)[0].trim();
      if (type) columns.push({ schema: schemaName, relation: tableName, name: column.name, type });
    }
    if (!augmented) augmented = overlayCatalog(catalog, true);
    if (!augmented.schemas.includes(schemaName)) augmented.schemas.push(schemaName);
    augmented.relations = augmented.relations.filter(r => r.schema !== schemaName || r.name !== tableName);
    augmented.relations.unshift({ schema: schemaName, name: tableName, kind: 'table', draft: true });
    augmented.columnOverrides.set(`${schemaName}\0${tableName}`, columns);
  }
  return augmented || catalog;
}

function withCatalog(statement, start, cursor, catalog) {
  let at = skipSpace(statement, start);
  const withKeyword = statement.slice(at).match(/^WITH\b/i);
  if (!withKeyword) return catalog;
  at = skipSpace(statement, at + withKeyword[0].length);
  const recursive = statement.slice(at).match(/^RECURSIVE\b/i);
  if (recursive) at = skipSpace(statement, at + recursive[0].length);
  const definitions = [];
  while (at < statement.length) {
    const cte = readIdentifier(statement, at);
    if (!cte) break;
    at = skipSpace(statement, cte.end);
    let names = null;
    let body = null;
    if (statement[at] === '(') {
      const group = readGroup(statement, at);
      if (!group) break;
      // Recovery for `WITH name (SELECT ...)`: PostgreSQL requires AS, but
      // the editor can still identify a completed CTE while the user fixes it.
      if (/^\s*(?:SELECT|WITH|VALUES)\b/i.test(group.content)) body = group;
      else names = splitTopLevel(group.content).map(name => canonicalIdentifier(name));
      at = skipSpace(statement, group.end);
    }
    if (!body) {
      const as = statement.slice(at).match(/^AS\b/i);
      if (!as) break;
      at = skipSpace(statement, at + as[0].length);
      const materialized = statement.slice(at).match(/^(?:NOT\s+)?MATERIALIZED\b/i);
      if (materialized) at = skipSpace(statement, at + materialized[0].length);
      body = readGroup(statement, at);
      if (!body && statement[at] === '(') {
        body = { content: statement.slice(at + 1), end: statement.length + 1 };
      }
    }
    if (!body) break;
    definitions.push({ name: cte.name, names, body, bodyStart: at });
    at = skipSpace(statement, body.end);
    if (statement[at] !== ',') break;
    at = skipSpace(statement, at + 1);
  }
  const augmented = overlayCatalog(catalog);
  if (!recursive) {
    for (const definition of definitions) {
      if (definition.body.end > cursor) break;
      const projected = projectedColumns(definition.body.content, definition.name, definition.names, augmented);
      augmented.relations.unshift({ schema: '__cte__', name: definition.name, kind: 'cte' });
      augmented.columnOverrides.set(`__cte__\0${definition.name}`, projected);
    }
    return augmented;
  }
  // PostgreSQL makes a recursive WITH namespace available to all its CTE
  // definitions, including forward references. Seed every relation before
  // inferring columns so references can resolve in either declaration order.
  for (const definition of definitions) {
    augmented.relations.unshift({ schema: '__cte__', name: definition.name, kind: 'cte' });
    augmented.columnOverrides.set(`__cte__\0${definition.name}`, (definition.names || []).map(name => ({
      schema: '__cte__', relation: definition.name, name, type: 'unknown'
    })));
  }
  for (let pass = 0; pass < definitions.length; pass++) {
    let changed = false;
    for (const definition of definitions) {
      // The nonrecursive branch fixes a recursive CTE's output shape.
      const projected = projectedColumns(firstSetBranch(definition.body.content), definition.name, definition.names, augmented);
      const key = `__cte__\0${definition.name}`;
      if (JSON.stringify(projected) !== JSON.stringify(augmented.columnOverrides.get(key))) {
        augmented.columnOverrides.set(key, projected);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const active = definitions.find(definition => cursor >= definition.bodyStart && cursor < definition.body.end);
  if (active && cursor < active.bodyStart + 1 + firstSetBranch(active.body.content).length) {
    augmented.relations = augmented.relations.filter(relation => relation.schema !== '__cte__' || relation.name !== active.name);
  }
  return augmented;
}

function cteCatalog(masked, offset, catalog) {
  const before = masked.slice(0, offset);
  const start = before.lastIndexOf(';') + 1;
  const end = masked.indexOf(';', offset);
  const statement = masked.slice(start, end < 0 ? undefined : end);
  if (!/\bWITH\b/i.test(statement)) return catalog;
  const cursor = offset - start;
  const tokens = scanSql(statement);
  const starts = [0];
  const open = [];
  for (let index = 0; index < tokens.length && tokens[index].start < cursor; index++) {
    const token = tokens[index];
    if (token.text === '(') {
      open.push(index);
    } else if (token.text === ')') {
      open.pop();
    }
  }
  // Only WITH clauses on the cursor's parenthesis path can contribute names.
  // A sibling subquery's WITH must not enter this query's catalog.
  for (const index of open) {
    if (tokens[index + 1]?.text.toUpperCase() === 'WITH') starts.push(tokens[index + 1].start);
  }
  let augmented = catalog;
  for (const withStart of starts) augmented = withCatalog(statement, withStart, cursor, augmented);
  return augmented;
}

function derivedCatalog(masked, offset, catalog) {
  const start = masked.slice(0, offset).lastIndexOf(';') + 1;
  const end = masked.indexOf(';', offset);
  const statement = masked.slice(start, end < 0 ? undefined : end);
  // Every supported derived source starts after FROM, JOIN, LATERAL, or a comma.
  if (!/\b(?:FROM|JOIN|LATERAL)\s*\(|,\s*\(/i.test(statement)) return catalog;
  const cursor = offset - start;
  const visibleScopes = new Set(selectAncestors(statement, cursor));
  let augmented = null;
  const tokens = scanSql(statement);
  const sourceRoots = new Map();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.text !== '(') continue;
    const previous = tokens[index - 1];
    const sourceAt = ['FROM', 'JOIN', 'LATERAL'].includes(previous?.text.toUpperCase()) || previous?.text === ','
      ? token.start : previous?.text === '(' ? sourceRoots.get(previous.start) : undefined;
    if (sourceAt === undefined) continue;
    sourceRoots.set(token.start, sourceAt);
    const body = readGroup(statement, token.start);
    if (!body || !/^\s*SELECT\b/i.test(body.content)) continue;
    if (!visibleScopes.has(selectAncestors(statement, sourceAt).at(-1)) || cursor > token.start && cursor < body.end) continue;
    let at = skipSpace(statement, body.end);
    const as = statement.slice(at).match(/^AS\b/i);
    if (as) at = skipSpace(statement, at + as[0].length);
    const alias = readIdentifier(statement, at);
    if (!alias || reserved.has(alias.name.toUpperCase())) continue;
    const projected = projectedColumns(body.content, alias.name, null, catalog);
    if (!augmented) augmented = overlayCatalog(catalog);
    augmented.relations.unshift({ schema: '__derived__', name: alias.name, kind: 'derived' });
    augmented.columnOverrides.set(`__derived__\0${alias.name}`, projected.map(column => ({ ...column, schema: '__derived__' })));
    while (tokens[index + 1]?.start < body.end) index++;
  }
  return augmented || catalog;
}

/** Add completed editor-local CTE and draft DDL objects to a catalog snapshot. */
function catalogAtMaskedCursor(masked, offset, catalog) {
  let base = catalog;
  if (catalog.currentSchema || catalog.searchPath) {
    base = orderedCatalogs.get(catalog);
    if (!base) {
      const rank = relation => relation.schema === catalog.currentSchema ? -1 :
        relation.schema === 'pg_catalog' ? (catalog.searchPath?.length ?? 0) :
          catalog.searchPath ? relationPriority(catalog, relation) : 0;
      base = { ...catalog, relations: [...catalog.relations].sort((left, right) => rank(left) - rank(right)) };
      orderedCatalogs.set(catalog, base);
    }
  }
  return derivedCatalog(masked, offset, cteCatalog(masked, offset, draftCatalog(masked, offset, base)));
}

export function catalogAtCursor(sql, offset, catalog) {
  return catalogAtMaskedCursor(maskIgnored(sql).masked, offset, catalog);
}

/**
 * Create the browser completion engine from a permission-filtered metadata snapshot.
 * Required arrays: schemas (names), relations ({schema,name,kind}),
 * columns ({schema,relation,name,type}), functions ({schema,name,arguments,returns}).
 * Optional arrays: types ({schema,name,kind,sqlName?}),
 * builtinFunctions (same as functions, plus routineKind), settings
 * ({name,description}), keywords (PostgreSQL keyword strings).
 * Optional currentSchema sets the target for unqualified draft CREATE TABLE;
 * searchPath is the effective ordered schema path for unqualified lookup.
 * No SQL or database connection is used here.
 */
export function createCrabSense(metadata) {
  for (const key of ['schemas', 'relations', 'columns', 'functions']) {
    if (!Array.isArray(metadata?.[key])) throw new TypeError(`CrabSense metadata requires ${key} array`);
  }
  for (const key of ['types', 'builtinFunctions', 'settings', 'keywords']) {
    if (metadata[key] != null && !Array.isArray(metadata[key])) {
      throw new TypeError(`CrabSense metadata expects ${key} array`);
    }
  }
  if (metadata.currentSchema != null && typeof metadata.currentSchema !== 'string') {
    throw new TypeError('CrabSense metadata expects currentSchema string');
  }
  if (metadata.searchPath != null && (!Array.isArray(metadata.searchPath) ||
      !metadata.searchPath.every(name => typeof name === 'string'))) {
    throw new TypeError('CrabSense metadata expects searchPath string array');
  }
  const catalog = {
    ...metadata,
    types: metadata.types || [],
    builtinFunctions: metadata.builtinFunctions || [],
    settings: metadata.settings || [],
    keywords: metadata.keywords || []
  };
  return {
    complete: (sql, offset, options = {}) => complete(sql, offset, catalog, { ...options, allColumnsFallback: true }),
    signatureHelp: (sql, offset) => signatureHelp(sql, offset, catalog)
  };
}
