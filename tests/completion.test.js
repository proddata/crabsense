import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogAtCursor, complete, completionEdit, createCrabSense } from '../src/completion.js';

const schema = {
  schemas: ['harbor', 'public'],
  relations: [{ schema: 'public', name: 'sailors', kind: 'table' }, { schema: 'public', name: 'vessels', kind: 'table' }, { schema: 'harbor', name: 'voyages', kind: 'table' }],
  columns: [
    { schema: 'public', relation: 'sailors', name: 'id', type: 'integer' },
    { schema: 'public', relation: 'sailors', name: 'handle', type: 'text' },
    { schema: 'public', relation: 'vessels', name: 'id', type: 'integer' },
    { schema: 'public', relation: 'vessels', name: 'name', type: 'text' },
    { schema: 'harbor', relation: 'voyages', name: 'destination', type: 'text' }
  ],
  functions: [{ schema: 'harbor', name: 'port_label', arguments: 'port_name text', returns: 'text' }],
  settings: [{ name: 'search_path', description: 'Sets the schema search order.' }, { name: 'standard_conforming_strings', description: 'Causes string literals to treat backslashes literally.' }],
  builtinFunctions: [
    { schema: 'pg_catalog', name: 'count', arguments: '', returns: 'bigint', routineKind: 'aggregate' },
    { schema: 'pg_catalog', name: 'lower', arguments: 'text', returns: 'text', routineKind: 'function' },
    { schema: 'pg_catalog', name: 'lower', arguments: 'anyrange', returns: 'anyelement', routineKind: 'function' },
    { schema: 'pg_catalog', name: 'now', arguments: '', returns: 'timestamp with time zone', routineKind: 'function' },
    { schema: 'pg_catalog', name: 'pg_internal_helper', arguments: 'integer', returns: 'integer', routineKind: 'function' }
  ]
};

test('FROM offers relations and schemas', () => {
  const result = complete('SELECT * FROM ', 14, schema);
  assert.equal(result.context, 'relation');
  assert.ok(result.suggestions.some(x => x.label === 'voyages' && x.insertText === 'harbor.voyages'));
  assert.equal(result.suggestions.find(x => x.label === 'sailors').listDescription, 'public · table');
  assert.equal(result.suggestions.find(x => x.label === 'harbor' && x.kind === 'schema').insertText, 'harbor.');
});

test('CREATE TABLE column-name positions do not suggest catalog columns', () => {
  const metadata = { ...schema,
    columns: [...schema.columns, { schema: 'public', relation: 'sailors', name: 'timestamp', type: 'timestamp' }] };
  const engine = createCrabSense(metadata);
  for (const marked of [
    'CREATE TABLE harbor.cargo_checks (t|',
    'CREATE TABLE harbor.cargo_checks (id integer, t|',
    'CREATE TABLE harbor.cargo_checks (\n  id integer,\n  risk harbor.cargo_risk,\n  measured_weight harbor.positive_weight,\n  t|',
    'CREATE TABLE harbor.cargo_checks (id numeric(10, 2), t|'
  ]) {
    const offset = marked.indexOf('|');
    const result = engine.complete(marked.replace('|', ''), offset);
    assert.equal(result.context, 'definition-column', marked);
    assert.deepEqual(result.suggestions.filter(item => item.kind === 'column'), [], marked);
  }
  const typeSql = 'CREATE TABLE harbor.cargo_checks (id integer, measured_weight ';
  assert.equal(engine.complete(typeSql, typeSql.length).context, 'type');
});

test('completion limit bounds results and reports when more matches exist', () => {
  const engine = createCrabSense(schema);
  const sql = 'SELECT * FROM ';
  const full = engine.complete(sql, sql.length);
  const limited = engine.complete(sql, sql.length, { limit: 2 });
  assert.deepEqual(limited.suggestions, full.suggestions.slice(0, 2));
  assert.equal(limited.incomplete, true);
  assert.equal(engine.complete(sql, sql.length, { limit: 100 }).incomplete, false);
  assert.deepEqual(engine.complete(sql, sql.length, { limit: 0 }).suggestions, []);
  assert.throws(() => engine.complete(sql, sql.length, { limit: -1 }), /non-negative integer/);
  assert.throws(() => engine.complete(sql, sql.length, { limit: 1.5 }), /non-negative integer/);
});

test('unqualified relation lookup and relation suggestions prefer currentSchema', () => {
  const metadata = {
    ...schema,
    currentSchema: 'public',
    relations: [{ schema: 'harbor', name: 'sailors', kind: 'table' }, ...schema.relations],
    columns: [{ schema: 'harbor', relation: 'sailors', name: 'depth', type: 'integer' }, ...schema.columns]
  };
  const engine = createCrabSense(metadata);
  const from = engine.complete('SELECT * FROM ', 'SELECT * FROM '.length);
  assert.equal(from.suggestions.find(item => item.kind === 'table').detail, 'public.sailors · table');
  const qualified = engine.complete('SELECT s. FROM sailors s', 'SELECT s.'.length);
  assert.deepEqual(qualified.suggestions.map(item => item.label), ['*', 'id', 'handle']);
});

test('effective searchPath resolves duplicate relation names in PostgreSQL order', () => {
  const metadata = { ...schema, currentSchema: 'harbor', searchPath: ['pg_catalog', 'harbor', 'public'],
    relations: [...schema.relations, { schema: 'harbor', name: 'sailors', kind: 'table' }],
    columns: [...schema.columns, { schema: 'harbor', relation: 'sailors', name: 'depth', type: 'integer' }] };
  const engine = createCrabSense(metadata);
  const unqualified = 'SELECT s. FROM sailors s';
  assert.deepEqual(engine.complete(unqualified, unqualified.indexOf('s.') + 2).suggestions.map(x => x.label), ['*', 'depth']);
  const qualified = 'SELECT s. FROM public.sailors s';
  assert.deepEqual(engine.complete(qualified, qualified.indexOf('s.') + 2).suggestions.map(x => x.label), ['*', 'id', 'handle']);
  const cte = 'WITH sailors AS (SELECT destination FROM harbor.voyages) SELECT s. FROM sailors s';
  assert.deepEqual(engine.complete(cte, cte.indexOf('s. FROM') + 2).suggestions.map(x => x.label), ['*', 'destination']);
  const relation = engine.complete('SELECT * FROM sa', 'SELECT * FROM sa'.length).suggestions.filter(x => x.kind === 'table' && x.label === 'sailors');
  assert.equal(relation[0].insertText, 'sailors');
  assert.equal(relation[1].insertText, 'public.sailors');
});

test('effective searchPath excludes other schemas from unqualified lookup', () => {
  const engine = createCrabSense({ ...schema, currentSchema: 'public', searchPath: ['pg_catalog', 'public'] });
  const sql = 'SELECT v. FROM voyages v';
  assert.deepEqual(engine.complete(sql, sql.indexOf('v.') + 2).suggestions, []);
  const names = engine.complete('SELECT * FROM vo', 'SELECT * FROM vo'.length).suggestions;
  assert.equal(names.find(x => x.label === 'voyages').insertText, 'harbor.voyages');
});

test('type completions qualify names shadowed or excluded by searchPath', () => {
  const metadata = { ...schema, currentSchema: 'harbor', searchPath: ['pg_catalog', 'harbor', 'public'],
    types: [
      { schema: 'public', name: 'cargo_risk', kind: 'enum' },
      { schema: 'harbor', name: 'cargo_risk', kind: 'enum' },
      { schema: 'outside', name: 'cargo_risk', kind: 'enum' }
    ] };
  const sql = 'CREATE TABLE harbor.checks (risk ';
  const suggestions = createCrabSense(metadata).complete(sql, sql.length).suggestions.filter(x => x.label === 'cargo_risk');
  assert.deepEqual(suggestions.map(x => x.insertText), ['public.cargo_risk', 'cargo_risk', 'outside.cargo_risk']);
});

test('function sources and insertions follow searchPath for matching signatures', () => {
  const metadata = { ...schema, currentSchema: 'harbor', searchPath: ['pg_catalog', 'harbor', 'public'],
    functions: [
      { schema: 'public', name: 'scan_port', arguments: '', returns: 'text' },
      { schema: 'harbor', name: 'scan_port', arguments: '', returns: 'integer' },
      { schema: 'outside', name: 'scan_port', arguments: '', returns: 'boolean' }
    ] };
  const engine = createCrabSense(metadata);
  const sql = 'SELECT f. FROM scan_port() f';
  const columns = engine.complete(sql, sql.indexOf('f.') + 2).suggestions;
  assert.deepEqual(columns.map(x => x.label), ['*', 'scan_port']);
  assert.match(columns[1].detail, /integer/);
  const calls = engine.complete('SELECT scan_', 'SELECT scan_'.length).suggestions.filter(x => x.kind === 'function');
  assert.deepEqual(calls.map(x => x.insertText), ['public.scan_port($1)', 'scan_port($1)', 'outside.scan_port($1)']);
  assert.deepEqual(engine.signatureHelp('SELECT scan_port(', 'SELECT scan_port('.length).signatures.map(x => x.label),
    ['harbor.scan_port() → integer']);
  assert.deepEqual(engine.signatureHelp('SELECT public.scan_port(', 'SELECT public.scan_port('.length).signatures.map(x => x.label),
    ['public.scan_port() → text']);
});

test('aliases offer columns of their relation', () => {
  const sql = 'SELECT s. FROM public.sailors s';
  const result = complete(sql, 9, schema);
  assert.equal(result.context, 'qualified-column');
  assert.deepEqual(result.suggestions.map(x => x.label), ['*', 'id', 'handle']);
});

test('a relation alias hides the original relation name in its query', () => {
  const engine = createCrabSense({ ...schema,
    relations: [...schema.relations, { schema: 'public', name: 'CrewLog', kind: 'table' }],
    columns: [...schema.columns, { schema: 'public', relation: 'CrewLog', name: 'LaunchDay', type: 'date' }] });
  for (const marked of [
    'SELECT sailors.| FROM public.sailors s',
    'SELECT sailors.| FROM public.sailors AS s',
    'SELECT * FROM public.sailors s WHERE sailors.|',
    'SELECT (SELECT sailors.|) FROM public.sailors s',
    'SELECT "CrewLog".| FROM public."CrewLog" c',
    'WITH crew AS (SELECT handle FROM public.sailors) SELECT crew.| FROM crew c'
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions, [], marked);
  }
  for (const [marked, expected] of [
    ['SELECT s.| FROM public.sailors s', ['*', 'id', 'handle']],
    ['SELECT sailors.| FROM public.sailors', ['*', 'id', 'handle']],
    ['SELECT c.| FROM public."CrewLog" c', ['*', 'LaunchDay']],
    ['SELECT crew.| FROM public.sailors s JOIN public.vessels crew ON true', ['*', 'id', 'name']]
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions.map(item => item.label), expected, marked);
  }
});

test('an aliased and unaliased self-join keep separate column qualifiers', () => {
  const marked = 'SELECT | FROM public.sailors captain JOIN public.sailors ON captain.id = sailors.id';
  const result = createCrabSense(schema).complete(marked.replace('|', ''), marked.indexOf('|'));
  assert.deepEqual(result.suggestions.filter(item => item.kind === 'column').map(item => item.label),
    ['captain.id', 'captain.handle', 'sailors.id', 'sailors.handle']);
});

test('aliases may begin with a reserved word without being that word', () => {
  for (const alias of ['outer_ship', 'orders', 'joinery', 'onboard', 'returning_crew']) {
    const sql = `SELECT ${alias}. FROM public.sailors ${alias}`;
    assert.deepEqual(complete(sql, sql.indexOf('.') + 1, schema).suggestions.map(item => item.label), ['*', 'id', 'handle'], alias);
  }
});

test('schema qualification offers its objects', () => {
  const result = complete('SELECT * FROM harbor.', 21, schema);
  assert.equal(result.context, 'schema-member');
  assert.ok(result.suggestions.some(x => x.label === 'voyages'));
  assert.equal(result.suggestions.find(x => x.label === 'port_label').listDescription, '(port_name text) → text');
});

test('comments and strings do not offer suggestions', () => {
  assert.equal(complete('-- SELECT ', 10, schema).suggestions.length, 0);
  assert.equal(complete("SELECT 'har", 11, schema).suggestions.length, 0);
});

test('typed relation prefix after JOIN keeps relation suggestions', () => {
  const sql = 'SELECT * FROM public.sailors s JOIN vo';
  const result = complete(sql, sql.length, schema);
  assert.equal(result.context, 'relation');
  assert.equal(result.replacementStart, sql.indexOf('vo', sql.indexOf('JOIN')));
  assert.deepEqual(result.suggestions.map(x => x.label), ['voyages']);
});

test('WHERE alias dot offers only that relation’s columns', () => {
  const sql = 'SELECT * FROM public.sailors s JOIN public.vessels v ON v.id = s.id WHERE s.';
  const result = complete(sql, sql.length, schema);
  assert.equal(result.context, 'qualified-column');
  assert.deepEqual(result.suggestions.map(x => x.label), ['id', 'handle']);
});

test('JOIN USING offers only shared columns and skips names already used', () => {
  const metadata = {
    ...schema,
    relations: [...schema.relations, { schema: 'public', name: 'crew', kind: 'table' }],
    columns: [...schema.columns,
      { schema: 'public', relation: 'crew', name: 'id', type: 'integer' },
      { schema: 'public', relation: 'crew', name: 'handle', type: 'text' },
      { schema: 'public', relation: 'crew', name: 'rank', type: 'text' }]
  };
  const first = 'SELECT * FROM public.sailors s JOIN public.crew c USING (';
  const result = complete(first, first.length, metadata);
  assert.equal(result.context, 'using-column');
  assert.deepEqual(result.suggestions.map(item => item.label), ['id', 'handle']);
  const next = `${first}id, `;
  assert.deepEqual(complete(next, next.length, metadata).suggestions.map(item => item.label), ['handle']);
});

test('ON only offers columns from relations introduced before the cursor', () => {
  const sql = 'SELECT * FROM public.sailors s JOIN public.vessels v ON | JOIN harbor.voyages y ON y.destination = s.handle';
  const result = complete(sql.replace('|', ''), sql.indexOf('|'), schema);
  assert.equal(result.context, 'expression');
  assert.ok(result.suggestions.some(x => x.label === 'handle'));
  assert.ok(result.suggestions.some(x => x.label === 'name'));
  assert.ok(!result.suggestions.some(x => x.label === 'destination'));
});

test('ON uses its JOIN operands rather than earlier comma-separated sources', () => {
  const engine = createCrabSense(schema);
  for (const [marked, expected] of [
    ['SELECT * FROM public.sailors s, public.vessels v JOIN harbor.voyages y ON |', ['id', 'name', 'destination']],
    ['SELECT * FROM public.sailors s, public.vessels v JOIN harbor.voyages y ON s.|', []],
    ['SELECT * FROM public.sailors s, public.vessels v JOIN harbor.voyages y ON v.|', ['id', 'name']],
    ['SELECT * FROM public.sailors s, public.vessels v JOIN harbor.voyages y ON EXISTS (SELECT s.|)', []],
    ['SELECT * FROM public.sailors s JOIN (public.vessels v JOIN harbor.voyages y ON s.|) ON true', []],
    ['SELECT * FROM public.sailors s JOIN (public.vessels v JOIN harbor.voyages y ON v.|) ON true', ['id', 'name']],
    ['SELECT * FROM public.sailors s, public.vessels v JOIN harbor.voyages y ON true WHERE s.|', ['id', 'handle']]
  ]) {
    const offset = marked.indexOf('|');
    const result = engine.complete(marked.replace('|', ''), offset);
    const labels = result.suggestions.filter(item => item.kind === 'column').map(item => item.label);
    assert.deepEqual(labels, expected, marked);
  }
});

test('USING inside a parenthesized JOIN compares only the joined sources', () => {
  const metadata = { ...schema,
    columns: [...schema.columns,
      { schema: 'harbor', relation: 'voyages', name: 'id', type: 'integer' },
      { schema: 'harbor', relation: 'voyages', name: 'handle', type: 'text' }] };
  const marked = 'SELECT * FROM public.sailors s JOIN (public.vessels v JOIN harbor.voyages y USING (|)) ON true';
  const result = createCrabSense(metadata).complete(marked.replace('|', ''), marked.indexOf('|'));
  assert.equal(result.context, 'using-column');
  assert.deepEqual(result.suggestions.map(item => item.label), ['id']);
});

test('a parenthesized JOIN alias exposes its output and hides operand names', () => {
  const engine = createCrabSense(schema);
  for (const [marked, expected] of [
    ['SELECT j.| FROM (public.sailors s JOIN public.vessels v ON s.id = v.id) AS j', ['*', 'handle', 'name']],
    ['SELECT s.| FROM (public.sailors s JOIN public.vessels v ON s.id = v.id) AS j', []],
    ['SELECT v.| FROM (public.sailors s JOIN public.vessels v ON s.id = v.id) AS j', []],
    ['SELECT j.| FROM (public.sailors s JOIN public.vessels v USING (id)) j', ['*', 'id', 'handle', 'name']],
    ['SELECT j.| FROM ((public.sailors s JOIN public.vessels v ON s.id = v.id)) j', ['*', 'handle', 'name']],
    ['SELECT j.| FROM public.sailors outer_s, (public.vessels v JOIN harbor.voyages y ON true) j', ['*', 'id', 'name', 'destination']],
    ['SELECT outer_s.| FROM public.sailors outer_s, (public.vessels v JOIN harbor.voyages y ON true) j', ['*', 'id', 'handle']],
    ['SELECT j.| FROM (public.sailors s JOIN public.vessels v ON s.id = v.id) j(first_id, captain)', ['*', 'first_id', 'captain', 'id', 'name']]
  ]) {
    const offset = marked.indexOf('|');
    const labels = engine.complete(marked.replace('|', ''), offset).suggestions.map(item => item.label);
    assert.deepEqual(labels, expected, marked);
  }
});

test('a JOIN alias is visible after its group, while its ON still sees operands', () => {
  const engine = createCrabSense(schema);
  for (const [marked, expected] of [
    ['SELECT * FROM (public.sailors s JOIN public.vessels v ON s.|) j', ['id', 'handle']],
    ['SELECT * FROM (public.sailors s JOIN public.vessels v ON v.|) j', ['id', 'name']],
    ['SELECT * FROM (public.sailors s JOIN public.vessels v ON true) j JOIN harbor.voyages y ON j.|', ['handle', 'name']],
    ['SELECT * FROM (public.sailors s JOIN public.vessels v ON true) j JOIN harbor.voyages y ON s.|', []],
    ['SELECT * FROM (public.sailors s JOIN public.vessels v ON true) j WHERE EXISTS (SELECT s.|)', []]
  ]) {
    const offset = marked.indexOf('|');
    const labels = engine.complete(marked.replace('|', ''), offset).suggestions.filter(item => item.kind === 'column').map(item => item.label);
    assert.deepEqual(labels, expected, marked);
  }
});

test('chained USING and NATURAL joins merge output columns in SQL order', () => {
  const engine = createCrabSense({ ...schema, columns: [...schema.columns,
    { schema: 'harbor', relation: 'voyages', name: 'id', type: 'integer' }] });
  for (const [marked, expected] of [
    ['SELECT j.| FROM (public.sailors s JOIN public.vessels v USING (id) JOIN harbor.voyages y USING (id)) j', ['*', 'id', 'handle', 'name', 'destination']],
    ['SELECT j.| FROM (public.sailors s NATURAL JOIN public.vessels v NATURAL JOIN harbor.voyages y) j', ['*', 'id', 'handle', 'name', 'destination']],
    ['SELECT j.| FROM (public.sailors s JOIN (public.vessels v JOIN harbor.voyages y USING (id)) USING (id)) j', ['*', 'id', 'handle', 'name', 'destination']],
    ['SELECT j.| FROM (public.sailors s JOIN public.vessels v USING (id) JOIN harbor.voyages y USING (id)) j(join_id, captain, ship, port)', ['*', 'join_id', 'captain', 'ship', 'port']]
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions.map(item => item.label), expected, marked);
  }
});

test('unaliased parenthesized JOIN groups retain their operand qualifiers', () => {
  const engine = createCrabSense({ ...schema, columns: [...schema.columns,
    { schema: 'harbor', relation: 'voyages', name: 'id', type: 'integer' }] });
  for (const [marked, expected] of [
    ['SELECT s.| FROM (public.sailors s JOIN public.vessels v USING (id)) JOIN harbor.voyages y ON true', ['*', 'id', 'handle']],
    ['SELECT v.| FROM ((public.sailors s JOIN public.vessels v USING (id))) JOIN harbor.voyages y ON true', ['*', 'id', 'name']],
    ['SELECT * FROM (public.sailors s JOIN public.vessels v USING (id)) JOIN harbor.voyages y ON s.|', ['id', 'handle']],
    ['SELECT j.| FROM ((public.sailors s JOIN public.vessels v USING (id)) JOIN harbor.voyages y USING (id)) j', ['*', 'id', 'handle', 'name', 'destination']]
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions.map(item => item.label), expected, marked);
  }
});

test('unqualified merged JOIN columns are suggested once', () => {
  const engine = createCrabSense(schema);
  for (const [marked, expected] of [
    ['SELECT | FROM public.sailors s JOIN public.vessels v USING (id)', ['id', 'handle', 'name']],
    ['SELECT | FROM (public.sailors s JOIN public.vessels v USING (id))', ['id', 'handle', 'name']],
    ['SELECT | FROM public.sailors s NATURAL JOIN public.vessels v', ['id', 'handle', 'name']],
    ['SELECT | FROM public.sailors s JOIN public.vessels v ON s.id = v.id', ['s.id', 'handle', 'v.id', 'name']]
  ]) {
    const offset = marked.indexOf('|');
    const labels = engine.complete(marked.replace('|', ''), offset).suggestions.filter(item => item.kind === 'column').map(item => item.label);
    assert.deepEqual(labels, expected, marked);
  }
});

test('derived sources retain projected columns inside JOIN groups', () => {
  const engine = createCrabSense(schema);
  for (const [marked, expected] of [
    ['SELECT j.| FROM ((SELECT id, handle AS nickname FROM public.sailors) d JOIN public.vessels v USING (id)) j', ['*', 'id', 'nickname', 'name']],
    ['SELECT d.| FROM ((SELECT id, handle AS nickname FROM public.sailors) d JOIN public.vessels v USING (id))', ['*', 'id', 'nickname']],
    ['SELECT j.| FROM (public.sailors s JOIN (SELECT id, name AS ship FROM public.vessels) d USING (id)) j', ['*', 'id', 'handle', 'ship']]
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions.map(item => item.label), expected, marked);
  }
});

test('table function sources expose their output names inside JOIN trees', () => {
  const metadata = { ...schema, builtinFunctions: [...schema.builtinFunctions,
    { schema: 'pg_catalog', name: 'generate_series', arguments: 'integer, integer', returns: 'integer' }] };
  const engine = createCrabSense(metadata);
  for (const [marked, expected] of [
    ["SELECT f.| FROM harbor.port_label('dock') AS f(label)", ['*', 'label']],
    ["SELECT port_label.| FROM harbor.port_label('dock')", ['*', 'port_label']],
    ['SELECT g.| FROM generate_series(1, 3) AS g(n)', ['*', 'n']],
    ['SELECT j.| FROM (public.sailors s JOIN harbor.port_label(s.handle) AS f(label) ON true) j', ['*', 'id', 'handle', 'label']],
    ['SELECT j.| FROM (public.sailors s JOIN LATERAL harbor.port_label(s.handle) AS f(label) ON true) j', ['*', 'id', 'handle', 'label']]
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions.map(item => item.label), expected, marked);
  }
});

test('table function arguments see preceding sources but not later ones', () => {
  const engine = createCrabSense(schema);
  for (const [marked, expected] of [
    ['SELECT * FROM public.sailors s JOIN harbor.port_label(s.|) f ON true', ['id', 'handle']],
    ['SELECT * FROM public.sailors s, public.vessels v JOIN harbor.port_label(s.|) f ON true', ['id', 'handle']],
    ['SELECT * FROM harbor.port_label(future.|) f JOIN public.sailors future ON true', []],
    ['SELECT * FROM public.sailors s JOIN harbor.port_label(v.|) f ON true JOIN public.vessels v ON true', []]
  ]) {
    const offset = marked.indexOf('|');
    const labels = engine.complete(marked.replace('|', ''), offset).suggestions.filter(item => item.kind === 'column').map(item => item.label);
    assert.deepEqual(labels, expected, marked);
  }
});

test('record functions use explicit output definitions and composite relation types', () => {
  const metadata = { ...schema,
    functions: [...schema.functions, { schema: 'harbor', name: 'crew_rows', arguments: '', returns: 'public.sailors' }],
    builtinFunctions: [...schema.builtinFunctions, { schema: 'pg_catalog', name: 'json_to_record', arguments: 'json', returns: 'record' }] };
  const engine = createCrabSense(metadata);
  for (const [marked, expected] of [
    ["SELECT r.| FROM json_to_record('{}') AS r(code integer, label text)", ['*', 'code', 'label']],
    ['SELECT c.| FROM harbor.crew_rows() AS c', ['*', 'id', 'handle']]
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions.map(item => item.label), expected, marked);
  }
});

test('ROWS FROM combines function outputs and applies column aliases', () => {
  const metadata = { ...schema, builtinFunctions: [...schema.builtinFunctions,
    { schema: 'pg_catalog', name: 'generate_series', arguments: 'integer, integer', returns: 'integer' },
    { schema: 'pg_catalog', name: 'json_to_record', arguments: 'json', returns: 'record' }] };
  const engine = createCrabSense(metadata);
  for (const [marked, expected] of [
    ["SELECT r.| FROM ROWS FROM (generate_series(1, 3), json_to_record('{}') AS (code integer, label text)) AS r(n, code, label)", ['*', 'n', 'code', 'label']],
    ['SELECT r.| FROM ROWS FROM (generate_series(1, 3)) WITH ORDINALITY AS r(n, ordinal)', ['*', 'n', 'ordinal']],
    ['SELECT generate_series.| FROM ROWS FROM (generate_series(1, 3))', ['*', 'generate_series']],
    ["SELECT j.| FROM (public.sailors s JOIN ROWS FROM (generate_series(1, 3), json_to_record('{}') AS (code integer)) AS r(n, code) ON true) j", ['*', 'id', 'handle', 'n', 'code']]
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions.map(item => item.label), expected, marked);
  }
});

test('inner alias shadows a matching outer alias', () => {
  const sql = 'SELECT (SELECT s. FROM harbor.voyages s) FROM public.sailors s';
  const result = createCrabSense(schema).complete(sql, sql.indexOf('s.') + 2);
  assert.equal(result.context, 'qualified-column');
  assert.deepEqual(result.suggestions.map(item => item.label), ['*', 'destination']);
});

test('ordinary FROM subqueries cannot see sibling sources', () => {
  const engine = createCrabSense(schema);
  for (const marked of [
    'SELECT * FROM public.sailors crew, (SELECT crew.|) d',
    'SELECT * FROM (SELECT crew.|) d, public.sailors crew',
    'SELECT * FROM public.sailors crew JOIN (SELECT crew.|) d ON true',
    'SELECT * FROM public.sailors, (SELECT sailors.|) d',
    'SELECT * FROM public.sailors crew, ((SELECT crew.|)) d',
    'SELECT * FROM public.sailors crew, (SELECT (SELECT crew.|)) d',
    'SELECT * FROM (SELECT handle AS nickname FROM public.sailors) crew, (SELECT crew.|) d'
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions, [], marked);
  }
});

test('LATERAL subqueries see preceding sources but not later sources or themselves', () => {
  const engine = createCrabSense(schema);
  for (const marked of [
    'SELECT * FROM public.sailors crew, LATERAL (SELECT crew.|) d',
    'SELECT * FROM public.sailors crew CROSS JOIN LATERAL (SELECT crew.|) d',
    'SELECT * FROM public.sailors crew LEFT JOIN LATERAL (SELECT crew.|) d ON true',
    'SELECT * FROM public.sailors crew, LATERAL /* note */ (SELECT (SELECT crew.|)) d',
    'SELECT * FROM public.sailors crew, LATERAL ((SELECT crew.|)) d',
    'SELECT * FROM public.sailors crew, LATERAL (SELECT crew.|'
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions.map(item => item.label), ['*', 'id', 'handle'], marked);
  }
  for (const marked of [
    'SELECT * FROM LATERAL (SELECT future.|) d, public.sailors future',
    'SELECT * FROM public.vessels ship, LATERAL (SELECT future.|) d JOIN public.sailors future ON true',
    'SELECT * FROM public.sailors crew, LATERAL (SELECT d.|) d',
    'SELECT * FROM LATERAL (SELECT sailors.|) d, public.sailors'
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions, [], marked);
  }
});

test('FROM visibility restrictions preserve legal ancestors and local shadowing', () => {
  const engine = createCrabSense(schema);
  for (const [marked, expected] of [
    ['SELECT (SELECT * FROM (SELECT outer_ship.|) d) FROM public.vessels outer_ship', ['*', 'id', 'name']],
    ['SELECT (SELECT * FROM public.sailors crew, (SELECT outer_ship.|) d) FROM public.vessels outer_ship', ['*', 'id', 'name']],
    ['SELECT (SELECT * FROM public.sailors q, (SELECT q.|) d) FROM public.vessels q', ['*', 'id', 'name']],
    ['SELECT * FROM public.sailors crew, LATERAL (SELECT crew.| FROM harbor.voyages crew) d', ['*', 'destination']],
    ['SELECT * FROM public.sailors crew, LATERAL (SELECT crew.id UNION SELECT crew.|) d', ['*', 'id', 'handle']],
    ['SELECT (SELECT outer_ship.|) FROM public.vessels outer_ship', ['*', 'id', 'name']],
    ['SELECT * FROM public.vessels outer_ship WHERE EXISTS (SELECT outer_ship.|)', ['*', 'id', 'name']]
  ]) {
    const offset = marked.indexOf('|');
    assert.deepEqual(engine.complete(marked.replace('|', ''), offset).suggestions.map(item => item.label), expected, marked);
  }
});

test('set-operation branches keep their own relation aliases and columns', () => {
  const engine = createCrabSense(schema);
  for (const operator of ['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT']) {
    for (const [left, right, expected] of [
      ['SELECT q. FROM public.sailors q', 'SELECT q. FROM harbor.voyages q', ['*', 'id', 'handle']],
      ['SELECT q. FROM harbor.voyages q', 'SELECT q. FROM public.sailors q', ['*', 'destination']]
    ]) {
      const sql = `${left} ${operator} ${right}`;
      assert.deepEqual(engine.complete(sql, sql.indexOf('q.') + 2).suggestions.map(item => item.label), expected, sql);
      assert.deepEqual(engine.complete(sql, sql.lastIndexOf('q.') + 2).suggestions.map(item => item.label),
        right.includes('sailors') ? ['*', 'id', 'handle'] : ['*', 'destination'], sql);
    }
    const sql = `SELECT left_crew. FROM public.sailors left_crew ${operator} SELECT left_crew. FROM harbor.voyages right_crew`;
    assert.deepEqual(engine.complete(sql, sql.lastIndexOf('left_crew.') + 'left_crew.'.length).suggestions, [], sql);
  }
});

test('nested set branches retain correlated outer aliases without sibling bindings', () => {
  const engine = createCrabSense(schema);
  const sql = 'SELECT (SELECT q. FROM public.sailors q UNION ALL SELECT q. FROM harbor.voyages q WHERE outer_ship.id > 0) FROM public.vessels outer_ship';
  assert.deepEqual(engine.complete(sql, sql.indexOf('q.') + 2).suggestions.map(item => item.label), ['*', 'id', 'handle']);
  assert.deepEqual(engine.complete(sql, sql.lastIndexOf('q.') + 2).suggestions.map(item => item.label), ['*', 'destination']);
  const correlated = sql.replace('outer_ship.id', 'outer_ship.');
  assert.deepEqual(engine.complete(correlated, correlated.indexOf('outer_ship.') + 'outer_ship.'.length).suggestions.map(item => item.label), ['id', 'name']);
});

test('derived aliases from sibling set branches stay hidden', () => {
  const sql = 'SELECT d. FROM (SELECT handle AS nickname FROM public.sailors) d UNION ALL SELECT d. FROM public.vessels v';
  const engine = createCrabSense(schema);
  assert.deepEqual(engine.complete(sql, sql.indexOf('d.') + 2).suggestions.map(item => item.label), ['*', 'nickname']);
  assert.deepEqual(engine.complete(sql, sql.lastIndexOf('d.') + 2).suggestions, []);
});

test('set branch boundaries respect parentheses, CTEs, quoting, and incomplete edits', () => {
  const engine = createCrabSense(schema);
  for (const [marked, expected] of [
    ['(SELECT q.| FROM public.sailors q) UNION ALL (SELECT q.destination FROM harbor.voyages q)', ['*', 'id', 'handle']],
    ['(SELECT q.handle FROM public.sailors q) EXCEPT (SELECT q.| FROM harbor.voyages q)', ['*', 'destination']],
    ['WITH crew AS (SELECT handle FROM public.sailors) SELECT q.handle FROM crew q UNION SELECT q.| FROM crew q', ['*', 'handle']],
    ['SELECT q.| FROM public.sailors q WHERE EXISTS (SELECT 1 FROM harbor.voyages q UNION SELECT 2)', ['*', 'id', 'handle']],
    ['SELECT q.| FROM public.sailors q UNION ALL SELECT', ['*', 'id', 'handle']],
    ['SELECT q.| FROM public.sailors q /* UNION SELECT * FROM harbor.voyages q */', ['*', 'id', 'handle']],
    ['SELECT q.|, \'UNION\' FROM public.sailors q', ['*', 'id', 'handle']],
    ['SELECT "UNION".| FROM public.sailors "UNION"', ['*', 'id', 'handle']],
    ['SELECT q.| FROM (SELECT destination AS port FROM harbor.voyages) q UNION SELECT q.handle FROM public.sailors q', ['*', 'port']]
  ]) {
    const offset = marked.indexOf('|');
    const result = engine.complete(marked.replace('|', ''), offset);
    assert.deepEqual(result.suggestions.map(item => item.label), expected, marked);
    assert.equal(result.replacementStart, offset, marked);
  }
  const marked = 'SELECT | FROM public.sailors s UNION ALL SELECT destination FROM harbor.voyages v';
  const columns = engine.complete(marked.replace('|', ''), marked.indexOf('|')).suggestions.filter(item => item.kind === 'column');
  assert.deepEqual(columns.map(item => item.label), ['id', 'handle']);
});

test('combined ORDER BY offers output names from the first set branch only', () => {
  const engine = createCrabSense(schema);
  for (const operator of ['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT']) {
    const sql = `SELECT handle AS crew_name FROM public.sailors ${operator} SELECT destination AS port FROM harbor.voyages ORDER BY `;
    const result = engine.complete(sql, sql.length);
    assert.deepEqual(result.suggestions.map(item => item.label), ['crew_name'], operator);
    assert.equal(result.context, 'set-order', operator);
    assert.deepEqual(engine.complete(`${sql}cr`, sql.length + 2).suggestions.map(item => item.label), ['crew_name'], operator);
    assert.deepEqual(engine.complete(`${sql}v.`, sql.length + 2).suggestions, [], operator);
  }
});

test('combined ORDER BY expands first-branch stars and stays within its query', () => {
  const engine = createCrabSense(schema);
  const star = 'SELECT * FROM public.sailors UNION SELECT id, name FROM public.vessels ORDER BY ';
  assert.deepEqual(engine.complete(star, star.length).suggestions.map(item => item.label), ['id', 'handle']);
  const nested = 'SELECT (SELECT handle AS nickname FROM public.sailors UNION SELECT destination FROM harbor.voyages ORDER BY |) FROM public.vessels ORDER BY name';
  assert.deepEqual(engine.complete(nested.replace('|', ''), nested.indexOf('|')).suggestions.map(item => item.label), ['nickname']);
  const outer = 'SELECT (SELECT handle FROM public.sailors UNION SELECT destination FROM harbor.voyages) FROM public.vessels ORDER BY ';
  assert.ok(engine.complete(outer, outer.length).suggestions.some(item => item.label === 'name'));
  const cte = 'WITH crew AS (SELECT handle FROM public.sailors) SELECT handle AS crew_name FROM crew UNION SELECT destination FROM harbor.voyages ORDER BY ';
  assert.deepEqual(engine.complete(cte, cte.length).suggestions.map(item => item.label), ['crew_name']);
  const grouped = '(SELECT handle AS crew_name FROM public.sailors) UNION (SELECT destination FROM harbor.voyages) ORDER BY ';
  assert.deepEqual(engine.complete(grouped, grouped.length).suggestions.map(item => item.label), ['crew_name']);
  assert.deepEqual(engine.complete(`${grouped}crew_name, `, grouped.length + 'crew_name, '.length).suggestions.map(item => item.label), ['crew_name']);
  assert.deepEqual(engine.complete(`${grouped}crew_name DESC `, grouped.length + 'crew_name DESC '.length).suggestions, []);
});

test('derived and LATERAL subqueries offer their projected aliases', () => {
  const engine = createCrabSense(schema);
  for (const sql of [
    'SELECT d. FROM (SELECT s.handle AS nickname FROM public.sailors s) d',
    'SELECT d. FROM public.sailors s, LATERAL (SELECT s.handle AS nickname) d'
  ]) {
    const result = engine.complete(sql, sql.indexOf('d.') + 2);
    assert.equal(result.context, 'qualified-column');
    assert.deepEqual(result.suggestions.map(item => item.label), ['*', 'nickname']);
  }
});

test('outer projection offers derived and joined aliases and resolves their columns', () => {
  const metadata = {
    ...schema,
    relations: [...schema.relations, { schema: 'harbor', name: 'ports', kind: 'table' }],
    columns: [...schema.columns, { schema: 'harbor', relation: 'ports', name: 'region', type: 'text' }]
  };
  const sql = `SELECT recent.vessel_name, p.region
FROM (
  SELECT v.name AS vessel_name, y.destination
  FROM public.vessels v JOIN harbor.voyages y ON y.destination = v.name
) recent
JOIN harbor.ports p ON p.region = recent.destination`;
  const engine = createCrabSense(metadata);
  for (const [typed, expected] of [['rec', 'recent'], ['p', 'p']]) {
    const query = sql.replace('SELECT recent.vessel_name', `SELECT ${typed}`);
    const result = engine.complete(query, `SELECT ${typed}`.length);
    assert.ok(result.suggestions.some(item => item.kind === 'alias' && item.label === expected && item.insertText === `${expected}.`));
  }
  for (const [typed, expected] of [['recent.', 'vessel_name'], ['p.', 'region']]) {
    const query = sql.replace('SELECT recent.vessel_name', `SELECT ${typed}`);
    const result = engine.complete(query, `SELECT ${typed}`.length);
    assert.equal(result.context, 'qualified-column');
    assert.ok(result.suggestions.some(item => item.label === expected));
  }
});

test('a typed schema prefix ranks the schema before longer relation names', () => {
  const metadata = {
    ...schema,
    schemas: [...schema.schemas, 'information_schema'],
    relations: [...schema.relations, { schema: 'information_schema', name: 'information_schema_catalog_name', kind: 'view' }]
  };
  const sql = 'SELECT * FROM inf';
  const result = createCrabSense(metadata).complete(sql, sql.length);
  assert.equal(result.suggestions[0].label, 'information_schema');
  assert.equal(result.suggestions[0].kind, 'schema');
  assert.equal(result.suggestions[0].insertText, 'information_schema.');
});

test('typed prefixes rank exact and shorter names even when they occur after a result cap', () => {
  const metadata = {
    ...schema,
    relations: [
      ...Array.from({ length: 12 }, (_, index) => ({ schema: 'public', name: `from_sql_${index}`, kind: 'table' })),
      { schema: 'public', name: 'from_sql', kind: 'table' },
      { schema: 'public', name: 'from', kind: 'table' }
    ]
  };
  const sql = 'SELECT * FROM fro';
  const result = createCrabSense(metadata).complete(sql, sql.length, { limit: 2 });
  assert.deepEqual(result.suggestions.map(item => item.label), ['from', 'from_sql']);
  assert.equal(result.suggestions[0].insertText, '"from"');
  assert.equal(result.incomplete, true);
});

test('FROM ranks first after a completed SELECT wildcard', () => {
  const metadata = { ...schema, keywords: ['FOR', 'FROM', 'FALSE', 'FETCH', 'FILTER'] };
  const engine = createCrabSense(metadata);
  const afterStar = 'SELECT * ';
  assert.deepEqual(engine.complete(afterStar, afterStar.length).suggestions.map(item => item.label), ['FROM']);
  const sql = 'SELECT * f';
  const result = engine.complete(sql, sql.length, { limit: 2 });
  assert.equal(result.context, 'projection');
  assert.deepEqual(result.suggestions.map(item => item.label), ['FROM']);
  assert.equal(result.incomplete, false);
  const stillInProjection = engine.complete('SELECT *, f', 'SELECT *, f'.length, { limit: 2 });
  assert.equal(stillInProjection.suggestions[0].label, 'FALSE');
});

test('FROM ranks first after completed projection expressions, including mixed wildcard lists', () => {
  const metadata = {
    ...schema,
    keywords: ['FROM', 'FREEZE', 'FALSE'],
    columns: [...schema.columns, { schema: 'public', relation: 'sailors', name: 'from_sql', type: 'boolean' }]
  };
  const engine = createCrabSense(metadata);
  for (const sql of [
    'SELECT * , id fr', 'SELECT id fr', 'SELECT s.id fr', 'SELECT count(*) fr',
    'SELECT id + 1 fr', 'SELECT CASE WHEN true THEN id ELSE 0 END fr',
    'WITH c AS (SELECT id FROM sailors) SELECT id fr',
    'SELECT (SELECT id fr', 'SELECT "from" fr', 'SELECT DISTINCT id fr'
  ]) {
    const result = engine.complete(sql, sql.length, { limit: 2 });
    assert.deepEqual(result.suggestions.map(item => item.label), ['FROM'], sql);
    assert.equal(result.replacementStart, sql.length - 2, sql);
  }
});

test('completed projections offer continuations instead of new expression operands', () => {
  const engine = createCrabSense(schema);
  const sql = 'SELECT *, id ';
  const result = engine.complete(sql, sql.length);
  assert.ok(result.suggestions.some(item => item.label === 'FROM'));
  assert.ok(result.suggestions.some(item => item.label === 'AS'));
  assert.ok(result.suggestions.some(item => item.label === 'WHERE'));
  assert.ok(result.suggestions.every(item => item.kind === 'keyword'));
  assert.ok(!result.suggestions.some(item => ['FALSE', 'FREEZE', '*'].includes(item.label)));
  for (const suffix of ['pg_catalog.fr', '"fr']) {
    const query = sql + suffix;
    assert.deepEqual(engine.complete(query, query.length).suggestions, [], query);
  }
  for (const query of ['SELECT *, fr', 'SELECT id + fr', 'SELECT coalesce(id, fr']) {
    const choices = createCrabSense({ ...schema, builtinFunctions: [
      ...schema.builtinFunctions, { schema: 'pg_catalog', name: 'frob', arguments: '', returns: 'integer' }
    ] }).complete(query, query.length).suggestions;
    assert.ok(choices.some(item => item.kind === 'function' && item.label === 'frob'), query);
  }
});

test('one cursor model handles literal, subquery, and alias boundaries', () => {
  const engine = createCrabSense({ ...schema, keywords: ['FROM', 'FREEZE', 'FALSE'] });
  for (const sql of [
    "SELECT 'hello' fr", 'SELECT $$hello; FROM$$ fr',
    'SELECT (SELECT id FROM sailors) fr',
    'SELECT id AS name fr', 'SELECT id name fr',
    'SELECT id /* outer /* inner */ comment */ fr'
  ]) {
    assert.deepEqual(engine.complete(sql, sql.length).suggestions.map(item => item.label), ['FROM'], sql);
  }
  for (const sql of ['SELECT id AS name ', 'SELECT id name ']) {
    const choices = engine.complete(sql, sql.length).suggestions;
    assert.ok(choices.some(item => item.label === 'FROM'), sql);
    assert.ok(!choices.some(item => ['AS', 'AND', 'COLLATE'].includes(item.label)), sql);
    assert.ok(choices.every(item => item.kind === 'keyword'), sql);
  }
  for (const sql of ['SELECT id AS ', 'SELECT id AS na']) {
    assert.deepEqual(engine.complete(sql, sql.length).suggestions, [], sql);
  }
  for (const sql of ['SELECT fr', 'SELECT id + fr', 'SELECT coalesce(id, fr']) {
    const choices = engine.complete(sql, sql.length).suggestions;
    assert.ok(!choices.some(item => ['FROM', 'FREEZE'].includes(item.label)), sql);
  }
});

test('FROM gets no clause preference inside unfinished projection expressions', () => {
  const engine = createCrabSense({ ...schema, keywords: ['FROM', 'FALSE'] });
  for (const sql of [
    'SELECT f', 'SELECT *, f', 'SELECT id + f',
    'SELECT CASE WHEN f', 'SELECT CASE WHEN true THEN f',
    'SELECT coalesce(id, f', 'SELECT DISTINCT f', 'SELECT DISTINCT ON (id) f'
  ]) {
    assert.equal(engine.complete(sql, sql.length).suggestions[0]?.label, 'FALSE', sql);
  }
});

test('expression keywords outrank unrelated keywords while callable functions stay competitive', () => {
  const metadata = {
    ...schema,
    keywords: ['FOR', 'FROM', 'FALSE', 'FLOOR', 'LOCALTIME'],
    builtinFunctions: [
      ...schema.builtinFunctions,
      { schema: 'pg_catalog', name: 'floor', arguments: 'numeric', returns: 'numeric', routineKind: 'function' }
    ]
  };
  const engine = createCrabSense(metadata);
  const literal = 'SELECT * FROM public.sailors s WHERE f';
  assert.equal(engine.complete(literal, literal.length).suggestions[0].label, 'FALSE');
  const functionCall = 'SELECT flo';
  const choices = engine.complete(functionCall, functionCall.length).suggestions;
  assert.equal(choices[0].kind, 'function');
  assert.equal(choices[0].label, 'floor');
});

test('derived alias in a sibling subquery does not hide an outer table alias', () => {
  const sql = 'SELECT d. FROM public.sailors d WHERE EXISTS (SELECT * FROM (SELECT 1 AS nickname) d)';
  const result = createCrabSense(schema).complete(sql, sql.indexOf('d.') + 2);
  assert.deepEqual(result.suggestions.map(item => item.label), ['*', 'id', 'handle']);
});

test('shared expression columns use distinct qualified insertions', () => {
  const sql = 'SELECT | FROM public.sailors s JOIN public.vessels v ON v.id = s.id';
  const result = complete(sql.replace('|', ''), sql.indexOf('|'), schema);
  const ids = result.suggestions.filter(x => x.kind === 'column' && x.label.endsWith('.id'));
  assert.deepEqual(ids.map(x => x.label), ['s.id', 'v.id']);
  assert.deepEqual(ids.map(x => x.insertText), ['s.id', 'v.id']);
  assert.deepEqual(ids.map(x => x.listDescription), ['public.sailors · integer', 'public.vessels · integer']);
  assert.equal(result.suggestions.find(x => x.label === 'handle').insertText, 'handle');

  const typed = sql.replace('|', 'id');
  assert.deepEqual(complete(typed, sql.indexOf('|') + 2, schema).suggestions
    .filter(x => x.kind === 'column').map(x => x.label), ['s.id', 'v.id']);

  const quoted = sql.replace('|', '"id');
  const quotedResult = complete(quoted, sql.indexOf('|') + 3, schema);
  const edit = completionEdit(quoted, sql.indexOf('|') + 3, quotedResult.replacementStart,
    quotedResult.suggestions.find(x => x.label === 's.id'));
  assert.equal(edit.insertText, 's."id"');
});

test('a self join keeps both alias-qualified copies of a shared column', () => {
  const sql = 'SELECT  FROM public.sailors captain JOIN public.sailors mate ON captain.id = mate.id';
  const result = complete(sql, 'SELECT '.length, schema);
  assert.deepEqual(result.suggestions.filter(item => item.kind === 'column').map(item => item.label),
    ['captain.id', 'captain.handle', 'mate.id', 'mate.handle']);
  assert.deepEqual(result.suggestions.filter(item => item.kind === 'column' && item.label.endsWith('.id'))
    .map(item => item.insertText), ['captain.id', 'mate.id']);
});

test('later statements do not leak aliases into the current statement', () => {
  const sql = 'SELECT v. FROM public.sailors s; SELECT * FROM public.vessels v';
  const result = complete(sql, 'SELECT v.'.length, schema);
  assert.deepEqual(result.suggestions, []);
});

test('quoted relation and alias resolve columns without replacing the qualifier', () => {
  const sql = 'SELECT "crew".ha FROM "public"."sailors" AS "crew"';
  const result = complete(sql, 'SELECT "crew".ha'.length, schema);
  assert.equal(result.context, 'qualified-column');
  assert.equal(result.replacementStart, 'SELECT "crew".'.length);
  assert.deepEqual(result.suggestions.map(x => x.label), ['handle']);
});

test('partially quoted names match catalog objects in relation and column contexts', () => {
  const relationSql = 'SELECT * FROM "sai';
  const relation = complete(relationSql, relationSql.length, schema);
  assert.equal(relation.context, 'relation');
  assert.deepEqual(relation.suggestions.map(x => x.label), ['sailors']);
  assert.equal(relation.replacementStart, relationSql.indexOf('"'));

  const columnSql = 'SELECT s."ha FROM public.sailors s';
  const column = complete(columnSql, 'SELECT s."ha'.length, schema);
  assert.equal(column.context, 'qualified-column');
  assert.deepEqual(column.suggestions.map(x => x.label), ['handle']);
});

test('quoted Monaco edits replace paired quotes and retain quote-aware matching', () => {
  const sql = 'SELECT s."ha" FROM public.sailors s';
  const offset = 'SELECT s."ha'.length;
  const result = complete(sql, offset, schema);
  const edit = completionEdit(sql, offset, result.replacementStart, result.suggestions[0]);
  assert.equal(edit.replacementStart, 'SELECT s.'.length);
  assert.equal(edit.replacementEnd, offset + 1);
  assert.equal(edit.insertText, '"handle"');
  assert.equal(edit.filterText, '"handle');
});

test('quoted completion does not double quote mixed-case identifiers', () => {
  const sql = 'SELECT * FROM "Sai"';
  const edit = completionEdit(sql, 'SELECT * FROM "Sai'.length, sql.indexOf('"'), {
    label: 'Sailors', insertText: '"Sailors"'
  });
  assert.equal(edit.insertText, '"Sailors"');
});

test('an empty statement and a typed prefix offer statement keywords', () => {
  assert.ok(complete('', 0, schema).suggestions.some(x => x.label === 'SELECT'));
  assert.deepEqual(complete('SEL', 3, schema).suggestions.map(x => x.label), ['SELECT']);
  assert.ok(complete('SELECT', 6, schema).suggestions.some(x => x.label === 'DISTINCT'));
});

test('INSERT INTO offers relations and target columns', () => {
  const relation = complete('INSERT INTO sa', 'INSERT INTO sa'.length, schema);
  assert.equal(relation.context, 'relation');
  assert.deepEqual(relation.suggestions.map(x => x.label), ['sailors']);
  const columns = complete('INSERT INTO public.sailors (', 'INSERT INTO public.sailors ('.length, schema);
  assert.equal(columns.context, 'target-column');
  assert.deepEqual(columns.suggestions.map(x => x.label), ['id', 'handle']);
});

test('UPDATE and DELETE use the target relation in expressions', () => {
  const update = complete('UPDATE public.sailors s SET |', 'UPDATE public.sailors s SET |'.indexOf('|'), schema);
  assert.equal(update.context, 'target-column');
  assert.deepEqual(update.suggestions.map(x => x.label), ['id', 'handle']);
  const where = 'DELETE FROM public.sailors s WHERE s.';
  assert.deepEqual(complete(where, where.length, schema).suggestions.map(x => x.label), ['id', 'handle']);
});

test('UPDATE, DELETE FROM and TRUNCATE offer relation names', () => {
  for (const sql of ['UPDATE ', 'DELETE FROM ', 'TRUNCATE TABLE ']) {
    const result = complete(sql, sql.length, schema);
    assert.equal(result.context, 'relation');
    assert.ok(result.suggestions.some(x => x.label === 'sailors'));
  }
});

test('SELECT offers wildcard and qualified relations offer relation wildcard', () => {
  const select = complete('SELECT  FROM public.sailors s', 'SELECT '.length, schema);
  assert.ok(select.suggestions.some(x => x.label === '*' && x.insertText === '*'));
  assert.ok(!complete('SELECT ', 'SELECT '.length, schema).suggestions.some(x => x.label === '*'));
  const alias = 'SELECT s. FROM public.sailors s';
  const suggestions = complete(alias, 'SELECT s.'.length, schema).suggestions;
  assert.ok(suggestions.some(x => x.label === '*' && x.insertText === '*'));
  assert.ok(suggestions.some(x => x.label === 'handle'));
});

test('SELECT does not offer another wildcard immediately after one was typed', () => {
  for (const sql of ['SELECT *', 'SELECT * ', 'SELECT s.* ', 'SELECT * FROM public.sailors s WHERE EXISTS (SELECT * ']) {
    const result = complete(sql, sql.length, schema);
    assert.ok(!result.suggestions.some(item => item.label === '*'), sql);
  }
  const afterComma = 'SELECT *,  FROM public.sailors s';
  assert.ok(complete(afterComma, 'SELECT *, '.length, schema).suggestions.some(item => item.label === '*'));
  const nested = 'SELECT (SELECT  ) FROM public.sailors s';
  assert.ok(!complete(nested, 'SELECT (SELECT '.length, schema).suggestions.some(item => item.label === '*'));
});

test('SHOW appears as a statement and completes PostgreSQL settings', () => {
  assert.deepEqual(complete('SHO', 3, schema).suggestions.map(x => x.label), ['SHOW']);
  const all = complete('SHOW ', 5, schema);
  assert.equal(all.context, 'setting');
  assert.ok(all.suggestions.some(x => x.label === 'ALL'));
  const setting = complete('SHOW sear', 9, schema);
  assert.equal(setting.replacementStart, 5);
  assert.deepEqual(setting.suggestions.map(x => x.label), ['search_path']);
  assert.equal(setting.suggestions[0].detail, 'Sets the schema search order.');
});

test('built-in routines come from metadata with overloads and useful insertion text', () => {
  const blank = complete('SELECT ', 7, schema).suggestions;
  assert.equal(blank.find(x => x.label === 'count').insertText, 'count(*)');
  assert.equal(blank.find(x => x.label === 'now').insertText, 'now()');
  assert.ok(!blank.some(x => x.label === 'pg_internal_helper'));

  const typed = complete('SELECT low', 10, schema).suggestions.filter(x => x.label === 'lower');
  assert.deepEqual(typed.map(x => x.detail), [
    'pg_catalog.lower(text) → text',
    'pg_catalog.lower(anyrange) → anyelement'
  ]);
  assert.ok(typed.every(x => x.insertText === 'lower($1)'));
});

test('pg_catalog qualification offers built-in functions', () => {
  const sql = 'SELECT pg_catalog.low';
  const result = complete(sql, sql.length, schema);
  assert.equal(result.context, 'schema-member');
  assert.equal(result.replacementStart, 'SELECT pg_catalog.'.length);
  assert.equal(result.suggestions.filter(x => x.label === 'lower').length, 2);
});

test('system schema qualification distinguishes FROM relations from expression functions', () => {
  const metadata = {
    ...schema,
    schemas: [...schema.schemas, 'pg_catalog', 'information_schema'],
    relations: [...schema.relations,
      { schema: 'pg_catalog', name: 'pg_class', kind: 'table' },
      { schema: 'information_schema', name: 'tables', kind: 'view' }]
  };
  const engine = createCrabSense(metadata);
  const fromCatalog = 'SELECT * FROM pg_catalog.';
  assert.ok(engine.complete(fromCatalog, fromCatalog.length).suggestions.some(item => item.label === 'pg_class'));
  const fromInformationSchema = 'SELECT * FROM information_schema.';
  assert.ok(engine.complete(fromInformationSchema, fromInformationSchema.length).suggestions.some(item => item.label === 'tables'));
  const routine = 'SELECT pg_catalog.co';
  assert.ok(engine.complete(routine, routine.length).suggestions.some(item => item.label === 'count'));
});

test('CrabSense exposes one catalog-backed completion and signature interface', () => {
  const engine = createCrabSense(schema);
  const relation = engine.complete('SELECT * FROM ha', 'SELECT * FROM ha'.length);
  assert.equal(relation.context, 'relation');
  assert.deepEqual(relation.suggestions.map(x => x.label), ['harbor']);
  const alias = 'SELECT s. FROM public.sailors s';
  assert.deepEqual(engine.complete(alias, 'SELECT s.'.length).suggestions.map(x => x.label), ['*', 'id', 'handle']);
  assert.equal(engine.signatureHelp('SELECT harbor.port_label(', 'SELECT harbor.port_label('.length).signatures[0].label,
    'harbor.port_label(port_name text) → text');
});

test('CrabSense has all-column fallback before FROM and nested signature help', () => {
  const engine = createCrabSense({
    ...schema,
    functions: [...schema.functions, { schema: 'harbor', name: 'dock_pair', arguments: 'first text, second text', returns: 'text' }]
  });
  const result = engine.complete('SELECT han', 'SELECT han'.length);
  assert.deepEqual(result.suggestions.filter(x => x.kind === 'column').map(x => x.label), ['handle']);
  const sql = "SELECT harbor.dock_pair(lower('a,b'), ";
  const help = engine.signatureHelp(sql, sql.length);
  assert.equal(help.activeParameter, 1);
  assert.equal(help.signatures[0].label, 'harbor.dock_pair(first text, second text) → text');
});

test('broad SELECT suggestions mix columns, functions, and useful keywords before the cap', () => {
  const metadata = {
    ...schema,
    relations: [schema.relations[0]],
    columns: Array.from({ length: 30 }, (_, index) => ({ schema: 'public', relation: 'sailors', name: `column_${index}`, type: 'text' })),
    keywords: ['SELECT', 'FROM', 'DISTINCT', 'CASE'],
    builtinFunctions: [{ schema: 'pg_catalog', name: 'count', arguments: '', returns: 'bigint' }]
  };
  const engine = createCrabSense(metadata);
  const sql = 'SELECT ';
  const full = engine.complete(sql, sql.length);
  const capped = engine.complete(sql, sql.length, { limit: 10 });
  assert.deepEqual(capped.suggestions, full.suggestions.slice(0, 10));
  assert.equal(capped.incomplete, true);
  assert.ok(capped.suggestions.some(suggestion => suggestion.kind === 'column'));
  assert.ok(capped.suggestions.some(suggestion => suggestion.label === 'port_label'));
  assert.ok(capped.suggestions.some(suggestion => suggestion.label === 'count'));
  assert.ok(capped.suggestions.some(suggestion => suggestion.label === 'DISTINCT'));
  assert.ok(!capped.suggestions.some(suggestion => suggestion.label === 'FROM'));
  const narrowed = 'SELECT co';
  assert.ok(engine.complete(narrowed, narrowed.length, { limit: 5 }).suggestions.some(suggestion => suggestion.label === 'count'));
  const exact = createCrabSense({
    ...metadata,
    columns: [{ schema: 'public', relation: 'sailors', name: 'count_suffix', type: 'integer' }, ...metadata.columns]
  }).complete('SELECT count', 'SELECT count'.length, { limit: 2 });
  assert.equal(exact.suggestions[0].label, 'count');
});

test('capped columns before FROM preserve relation order with sparse matches and shuffled metadata', () => {
  const relations = Array.from({ length: 40 }, (_, index) => ({ schema: 'public', name: `table_${index}`, kind: 'table' }));
  const columns = [39, 34, 35, 33].map(index => ({ schema: 'public', relation: `table_${index}`, name: `match_${index}`, type: 'text' }));
  const engine = createCrabSense({ schemas: ['public'], relations, columns, functions: [] });
  const sql = 'SELECT match_';
  const full = engine.complete(sql, sql.length);
  const capped = engine.complete(sql, sql.length, { limit: 2 });
  assert.deepEqual(full.suggestions.filter(item => item.kind === 'column').map(item => item.label),
    ['match_33', 'match_34', 'match_35', 'match_39']);
  assert.deepEqual(capped.suggestions, full.suggestions.slice(0, 2));
  assert.equal(capped.incomplete, true);
});

test('CrabSense metadata contract reports missing required collections', () => {
  assert.throws(() => createCrabSense({ relations: [], columns: [] }), /schemas/);
  assert.throws(() => createCrabSense({ ...schema, keywords: 'SHOW' }), /keywords/);
  assert.throws(() => createCrabSense({ ...schema, currentSchema: 42 }), /currentSchema/);
  assert.throws(() => createCrabSense({ ...schema, searchPath: ['public', 42] }), /searchPath/);
  assert.throws(() => createCrabSense({ ...schema, types: 'integer' }), /types/);
});

test('type positions offer catalog types and preserve schema qualification', () => {
  const engine = createCrabSense({
    ...schema,
    types: [
      { schema: 'pg_catalog', name: 'integer', sqlName: 'int4', kind: 'base' },
      { schema: 'pg_catalog', name: 'numeric', sqlName: 'numeric', kind: 'base' },
      { schema: 'harbor', name: 'cargo_state', kind: 'enum' }
    ]
  });
  for (const sql of ['CREATE TABLE harbor.docks (id int', 'SELECT 1::int']) {
    const result = engine.complete(sql, sql.length);
    assert.equal(result.context, 'type');
    assert.equal(result.suggestions[0].label, 'integer');
    assert.equal(result.suggestions[0].insertText, 'integer');
  }
  const qualified = 'SELECT 1::pg_catalog.int4';
  const builtin = engine.complete(qualified, qualified.length);
  assert.equal(builtin.context, 'type');
  assert.equal(builtin.suggestions[0].label, 'integer');
  assert.equal(builtin.suggestions[0].insertText, 'int4');
  const custom = 'CREATE TABLE harbor.docks (state cargo';
  assert.equal(engine.complete(custom, custom.length).suggestions[0].insertText, 'harbor.cargo_state');
  for (const sql of ['SELECT CAST(1 AS num', 'ALTER TABLE harbor.docks ADD COLUMN weight num',
    'ALTER TABLE harbor.docks ALTER COLUMN weight TYPE num', 'CREATE DOMAIN harbor.weight AS num']) {
    const result = engine.complete(sql, sql.length);
    assert.equal(result.context, 'type', sql);
    assert.equal(result.suggestions[0].label, 'numeric', sql);
  }
  assert.notEqual(engine.complete('SELECT int', 'SELECT int'.length).context, 'type');
  assert.equal(createCrabSense(schema).complete('SELECT 1::tex', 'SELECT 1::tex'.length).suggestions[0].label, 'text');
});

test('CrabSense uses supplied PostgreSQL keywords', () => {
  const engine = createCrabSense({ ...schema, keywords: ['CURRENT_DATE'] });
  const suggestions = engine.complete('SELECT current', 'SELECT current'.length).suggestions;
  assert.ok(suggestions.some(x => x.label === 'CURRENT_DATE'));
});

test('CrabSense resolves comma-separated FROM aliases and quoted alias case', () => {
  const engine = createCrabSense(schema);
  const comma = 'SELECT v. FROM public.sailors s, public.vessels v';
  assert.deepEqual(engine.complete(comma, 'SELECT v.'.length).suggestions.map(x => x.label), ['*', 'id', 'name']);
  const quoted = 'SELECT "Crew". FROM public.sailors AS "Crew"';
  assert.deepEqual(engine.complete(quoted, 'SELECT "Crew".'.length).suggestions.map(x => x.label), ['*', 'id', 'handle']);
  const wrongCase = 'SELECT "crew". FROM public.sailors AS "Crew"';
  assert.deepEqual(engine.complete(wrongCase, 'SELECT "crew".'.length).suggestions, []);
});

test('CrabSense offers a CTE as a relation and its projected columns through an alias', () => {
  const engine = createCrabSense(schema);
  const source = 'WITH crew AS (SELECT s.id, s.handle AS nickname FROM public.sailors s) SELECT * FROM ';
  const names = engine.complete(source, source.length).suggestions;
  assert.ok(names.some(x => x.label === 'crew' && x.kind === 'cte' && x.insertText === 'crew'));
  const query = `${source}crew c WHERE c.`;
  assert.deepEqual(engine.complete(query, query.length).suggestions.map(x => x.label), ['id', 'nickname']);
});

test('unfinished CTE headers offer AS and a newly opened body offers SELECT', () => {
  const engine = createCrabSense(schema);
  for (const sql of [
    'WITH acs a', 'WITH RECURSIVE acs a',
    'WITH acs(id) a',
    'WITH first AS (SELECT id FROM public.sailors), acs a'
  ]) {
    const result = engine.complete(sql, sql.length);
    assert.equal(result.context, 'cte-as', sql);
    assert.deepEqual(result.suggestions.map(item => item.label), ['AS'], sql);
    assert.equal(result.replacementStart, sql.length - 1, sql);
  }
  for (const sql of [
    'WITH acs AS (', 'WITH acs AS (se',
    'WITH acs(id) AS (',
    'WITH acs AS NOT MATERIALIZED (',
    'WITH first AS (SELECT id FROM public.sailors), acs AS (',
    'SELECT (WITH acs AS ('
  ]) {
    const result = engine.complete(sql, sql.length);
    assert.equal(result.context, 'cte-body-start', sql);
    assert.ok(result.suggestions.some(item => item.label === 'SELECT'), sql);
    assert.ok(!result.suggestions.some(item => item.kind === 'column'), sql);
  }
  const paired = 'WITH acs AS ()';
  assert.equal(engine.complete(paired, paired.indexOf(')')).context, 'cte-body-start');
  const body = 'WITH acs AS (SELECT s.ha FROM public.sailors s) SELECT * FROM acs';
  assert.equal(engine.complete(body, body.indexOf('s.ha') + 4).suggestions[0].label, 'handle');
  for (const sql of ["WITH acs AS ('SELECT", 'SELECT (WITH acs AS (SELECT id FROM public.sailors) SELECT 1)']) {
    assert.notEqual(engine.complete(sql, sql.length).context, 'cte-body-start', sql);
  }
});

test('CrabSense uses explicit CTE column names and expands a base-table star', () => {
  const engine = createCrabSense(schema);
  const explicit = 'WITH crew(member_id, name) AS (SELECT id, handle FROM public.sailors) SELECT crew.';
  assert.deepEqual(engine.complete(explicit, explicit.length).suggestions.map(x => x.label), ['*', 'member_id', 'name']);
  const star = 'WITH crew AS (SELECT * FROM public.sailors) SELECT crew.';
  assert.deepEqual(engine.complete(star, star.length).suggestions.map(x => x.label), ['*', 'id', 'handle']);
});

test('CrabSense CTE names stay within their statement and later CTEs can use earlier ones', () => {
  const engine = createCrabSense(schema);
  const chained = 'WITH first AS (SELECT id FROM public.sailors), second AS (SELECT id FROM first) SELECT second.';
  assert.deepEqual(engine.complete(chained, chained.length).suggestions.map(x => x.label), ['*', 'id']);
  const separate = 'WITH crew AS (SELECT id FROM public.sailors) SELECT * FROM crew; SELECT * FROM cr';
  assert.ok(!engine.complete(separate, separate.length).suggestions.some(x => x.label === 'crew'));
});

test('nested WITH shadows an outer CTE only inside its query', () => {
  const engine = createCrabSense(schema);
  const marked = 'WITH crew AS (SELECT id, handle FROM public.sailors) SELECT (WITH crew AS (SELECT destination FROM harbor.voyages) SELECT c.| FROM crew c) FROM crew outer_crew WHERE outer_crew.|';
  const sql = marked.replaceAll('|', '');
  const inner = marked.indexOf('|');
  const outer = marked.lastIndexOf('|') - 1;
  assert.deepEqual(engine.complete(sql, inner).suggestions.map(x => x.label), ['*', 'destination']);
  assert.deepEqual(engine.complete(sql, outer).suggestions.map(x => x.label), ['id', 'handle']);
});

test('nested WITH sees outer CTEs but does not leak into sibling subqueries', () => {
  const engine = createCrabSense(schema);
  const inner = 'WITH outer_crew AS (SELECT handle FROM public.sailors) SELECT (WITH local_crew AS (SELECT * FROM outer_crew) SELECT l.| FROM local_crew l)';
  assert.deepEqual(engine.complete(inner.replace('|', ''), inner.indexOf('|')).suggestions.map(x => x.label), ['*', 'handle']);
  const sibling = 'SELECT (WITH local_crew AS (SELECT id FROM public.sailors) SELECT id FROM local_crew), (SELECT * FROM local_)';
  assert.ok(!engine.complete(sibling, sibling.indexOf('local_)')).suggestions.some(x => x.label === 'local_crew'));
});

test('a CTE body sees earlier siblings but not later siblings or its own nonrecursive name', () => {
  const engine = createCrabSense(schema);
  const earlier = 'WITH first AS (SELECT id FROM public.sailors), second AS (SELECT f.| FROM first f) SELECT * FROM second';
  assert.deepEqual(engine.complete(earlier.replace('|', ''), earlier.indexOf('|')).suggestions.map(x => x.label), ['*', 'id']);
  const later = 'WITH first AS (SELECT * FROM sec|), second AS (SELECT id FROM public.sailors) SELECT * FROM first';
  assert.ok(!engine.complete(later.replace('|', ''), later.indexOf('|')).suggestions.some(x => x.label === 'second'));
  const self = 'WITH crew AS (SELECT * FROM cr|) SELECT * FROM crew';
  assert.ok(!engine.complete(self.replace('|', ''), self.indexOf('|')).suggestions.some(x => x.label === 'crew'));
});

test('a derived source can project columns from a visible CTE', () => {
  const sql = 'WITH crew AS (SELECT handle FROM public.sailors) SELECT d. FROM (SELECT * FROM crew) d';
  assert.deepEqual(createCrabSense(schema).complete(sql, sql.indexOf('d.') + 2).suggestions.map(x => x.label), ['*', 'handle']);
});

test('a derived source remains visible with a comment before its opening parenthesis', () => {
  const marked = 'SELECT d.| FROM /* source */ (SELECT handle AS nickname FROM public.sailors) d';
  assert.deepEqual(createCrabSense(schema).complete(marked.replace('|', ''), marked.indexOf('|')).suggestions.map(x => x.label),
    ['*', 'nickname']);
});

test('a recursive CTE exposes explicit output names inside its own body', () => {
  const marked = 'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT s.| FROM seq s WHERE s.n < 3) SELECT * FROM seq';
  assert.deepEqual(createCrabSense(schema).complete(marked.replace('|', ''), marked.indexOf('|')).suggestions.map(x => x.label), ['*', 'n']);
});

test('WITH RECURSIVE resolves later sibling CTEs and their projected types', () => {
  const engine = createCrabSense(schema);
  const marked = 'WITH RECURSIVE first AS (SELECT l.| FROM later l), later AS (SELECT id FROM public.sailors) SELECT * FROM first';
  const suggestions = engine.complete(marked.replace('|', ''), marked.indexOf('|')).suggestions;
  assert.deepEqual(suggestions.map(x => x.label), ['*', 'id']);
  assert.match(suggestions.find(x => x.label === 'id').detail, /integer/);
  const result = 'WITH RECURSIVE first AS (SELECT id FROM later), later AS (SELECT id FROM public.sailors) SELECT first.';
  assert.deepEqual(engine.complete(result, result.length).suggestions.map(x => x.label), ['*', 'id']);
});

test('a recursive CTE infers its own output names and types from the anchor SELECT', () => {
  const engine = createCrabSense(schema);
  const marked = 'WITH RECURSIVE crew AS (SELECT id, handle FROM public.sailors UNION ALL SELECT c.| FROM crew c) SELECT * FROM crew';
  const suggestions = engine.complete(marked.replace('|', ''), marked.indexOf('|')).suggestions;
  assert.deepEqual(suggestions.map(x => x.label), ['*', 'id', 'handle']);
  assert.match(suggestions.find(x => x.label === 'id').detail, /integer/);
  assert.match(suggestions.find(x => x.label === 'handle').detail, /text/);
  const unfinished = 'WITH RECURSIVE crew AS (SELECT id, handle FROM public.sailors UNION ALL SELECT c. FROM crew c';
  assert.deepEqual(engine.complete(unfinished, unfinished.indexOf('c. FROM') + 2).suggestions.map(x => x.label), ['*', 'id', 'handle']);
});

test('a recursive name is unavailable in its anchor term', () => {
  const marked = 'WITH RECURSIVE seq(n) AS (SELECT * FROM se| UNION ALL SELECT n FROM seq) SELECT * FROM seq';
  assert.ok(!createCrabSense(schema).complete(marked.replace('|', ''), marked.indexOf('|')).suggestions.some(x => x.label === 'seq'));
});

test('CrabSense recovers a CTE missing AS while SQL validation can still flag it', () => {
  const engine = createCrabSense(schema);
  const sql = 'WITH abc (SELECT id FROM harbor.voyages) SELECT * FROM a';
  const result = engine.complete(sql, sql.length);
  assert.deepEqual(result.suggestions.filter(x => x.kind === 'cte').map(x => x.label), ['abc']);
  const column = 'WITH abc (SELECT id FROM harbor.voyages) SELECT abc.';
  assert.deepEqual(engine.complete(column, column.length).suggestions.map(x => x.label), ['*', 'id']);
});

test('CrabSense keeps a projected alias when the expression is a string literal', () => {
  const engine = createCrabSense(schema);
  const sql = "WITH abc AS (SELECT '(,;)' AS label FROM harbor.voyages) SELECT abc.";
  assert.deepEqual(engine.complete(sql, sql.length).suggestions.map(x => x.label), ['*', 'label']);
});

test('CrabSense recognizes a CTE projection alias without AS', () => {
  const engine = createCrabSense(schema);
  const sql = 'WITH abc AS (SELECT id + 1 next_id FROM harbor.voyages) SELECT abc.';
  assert.deepEqual(engine.complete(sql, sql.length).suggestions.map(x => x.label), ['*', 'next_id']);
});

test('CrabSense suggests a draft table and columns from an earlier CREATE TABLE statement', () => {
  const engine = createCrabSense(schema);
  const relationSql = 'CREATE TABLE harbor.docks (id integer, "Dock Name" text); SELECT * FROM do';
  const relation = engine.complete(relationSql, relationSql.length);
  const draft = relation.suggestions.find(item => item.label === 'docks');
  assert.equal(draft.insertText, 'harbor.docks');
  assert.match(draft.listDescription, /draft/);

  const columnSql = 'CREATE TABLE harbor.docks (id integer, "Dock Name" text); SELECT d. FROM harbor.docks d';
  const columns = engine.complete(columnSql, columnSql.indexOf('d. FROM') + 2);
  assert.deepEqual(columns.suggestions.map(item => item.label), ['*', 'id', 'Dock Name']);
});

test('editor-local catalog overlays expose draft and CTE columns without changing the snapshot', () => {
  const draftSql = 'CREATE TABLE public.sailors (new_id integer); SELECT s. FROM public.sailors s';
  const draft = catalogAtCursor(draftSql, draftSql.indexOf('s. FROM') + 2, schema);
  assert.deepEqual(draft.columns.filter(column => column.relation === 'sailors').map(column => column.name), ['new_id']);
  assert.deepEqual(schema.columns.filter(column => column.relation === 'sailors').map(column => column.name), ['id', 'handle']);

  const cteSql = 'WITH recent AS (SELECT id FROM public.sailors) SELECT recent.';
  const cte = catalogAtCursor(cteSql, cteSql.length, schema);
  assert.deepEqual(cte.columns.filter(column => column.relation === 'recent').map(column => column.name), ['id']);
});

test('CrabSense does not include future or unfinished CREATE TABLE statements', () => {
  const engine = createCrabSense(schema);
  const future = 'SELECT * FROM do; CREATE TABLE harbor.docks (id integer);';
  assert.ok(!engine.complete(future, 'SELECT * FROM do'.length).suggestions.some(item => item.label === 'docks'));
  const unfinished = 'CREATE TABLE harbor.docks (id integer) SELECT * FROM do';
  assert.ok(!engine.complete(unfinished, unfinished.length).suggestions.some(item => item.label === 'docks'));
});

test('CrabSense ignores CREATE TABLE text in comments and strings and removes a dropped draft table', () => {
  const engine = createCrabSense(schema);
  for (const sql of [
    '-- CREATE TABLE harbor.docks (id integer);\nSELECT * FROM do',
    "SELECT 'CREATE TABLE harbor.docks (id integer);'; SELECT * FROM do",
    'SELECT $body$CREATE TABLE harbor.docks (id integer);$body$; SELECT * FROM do',
    'CREATE TABLE harbor.docks (id integer); DROP TABLE harbor.docks; SELECT * FROM do'
  ]) {
    assert.ok(!engine.complete(sql, sql.length).suggestions.some(item => item.label === 'docks'));
  }
});

test('CrabSense places an unqualified draft table in the supplied current schema', () => {
  const engine = createCrabSense({ ...schema, currentSchema: 'harbor' });
  const sql = 'CREATE TABLE docks (id integer); SELECT d. FROM docks d';
  const result = engine.complete(sql, sql.indexOf('d. FROM') + 2);
  assert.deepEqual(result.suggestions.map(item => item.label), ['*', 'id']);
  assert.match(result.suggestions[1].detail, /harbor\.docks/);
});
