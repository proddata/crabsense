import { createCodeMirror } from '../src/methods/codemirror.js';
import { createCrabSense } from 'crabsense';

// An intentionally small catalog makes both required and forbidden suggestions
// meaningful. Each case describes expected editor behavior, not another method's output.
const metadata = {
  currentSchema: 'public',
  schemas: ['public', 'harbor'],
  relations: [
    { schema: 'public', name: 'sailors', kind: 'table' },
    { schema: 'public', name: 'vessels', kind: 'table' },
    { schema: 'harbor', name: 'voyages', kind: 'table' },
    { schema: 'harbor', name: 'sailors', kind: 'table' },
    { schema: 'public', name: 'CrewLog', kind: 'table' }
  ],
  columns: [
    { schema: 'public', relation: 'sailors', name: 'id', type: 'integer' },
    { schema: 'public', relation: 'sailors', name: 'handle', type: 'text' },
    { schema: 'public', relation: 'vessels', name: 'id', type: 'integer' },
    { schema: 'public', relation: 'vessels', name: 'name', type: 'text' },
    { schema: 'harbor', relation: 'voyages', name: 'destination', type: 'text' },
    { schema: 'harbor', relation: 'sailors', name: 'depth', type: 'integer' },
    { schema: 'public', relation: 'CrewLog', name: 'LaunchDay', type: 'date' }
  ],
  functions: [{ schema: 'harbor', name: 'port_label', arguments: 'port_name text', returns: 'text' }],
  builtinFunctions: [
    { schema: 'pg_catalog', name: 'lower', arguments: 'text', returns: 'text', routineKind: 'function' },
    { schema: 'pg_catalog', name: 'generate_series', arguments: 'integer, integer', returns: 'integer', routineKind: 'function' },
    { schema: 'pg_catalog', name: 'json_to_record', arguments: 'json', returns: 'record', routineKind: 'function' }
  ],
  settings: [{ name: 'search_path', description: 'Schema lookup order' }]
};

const c = (label, kind) => `${kind}:${label}`;
const scenarios = [
  { name: 'statement prefix', sql: 'SEL|', context: 'statement', require: [c('SELECT', 'keyword')], only: [c('SELECT', 'keyword')], first: c('SELECT', 'keyword'), replace: 'SEL' },
  { name: 'relation after FROM', sql: 'SELECT * FROM |', context: 'relation', require: [c('sailors', 'table'), c('voyages', 'table'), c('harbor', 'schema')], first: c('sailors', 'table') },
  { name: 'relation prefix after JOIN', sql: 'SELECT * FROM public.sailors s JOIN vo|', context: 'relation', only: [c('voyages', 'table')], replace: 'vo' },
  { name: 'schema members', sql: 'SELECT * FROM harbor.|', context: 'schema-member', require: [c('voyages', 'table'), c('sailors', 'table'), c('port_label', 'function')], detailIncludes: { [c('sailors', 'table')]: 'harbor.sailors' } },
  { name: 'alias columns', sql: 'SELECT s.| FROM public.sailors s', context: 'qualified-column', require: [c('handle', 'column'), c('*', 'keyword')], forbid: [c('name', 'column'), c('destination', 'column')] },
  { name: 'qualified column prefix', sql: 'SELECT s.ha| FROM public.sailors s', context: 'qualified-column', only: [c('handle', 'column')], first: c('handle', 'column'), replace: 'ha' },
  { name: 'quoted column prefix', sql: 'SELECT s."ha| FROM public.sailors s', context: 'qualified-column', only: [c('handle', 'column')], first: c('handle', 'column'), replace: '"ha' },
  { name: 'WHERE alias', sql: 'SELECT * FROM public.sailors s WHERE s.|', context: 'qualified-column', require: [c('handle', 'column')], forbid: [c('name', 'column')] },
  { name: 'alias hides original relation name', sql: 'SELECT sailors.| FROM public.sailors s', context: 'projection', only: [] },
  { name: 'AS alias hides original in WHERE', sql: 'SELECT * FROM public.sailors AS s WHERE sailors.|', context: 'expression', only: [] },
  { name: 'unaliased relation remains usable', sql: 'SELECT sailors.| FROM public.sailors', context: 'qualified-column', require: [c('handle', 'column')], forbid: [c('name', 'column')] },
  { name: 'mixed self join has distinct qualifiers', sql: 'SELECT | FROM public.sailors captain JOIN public.sailors ON captain.id = sailors.id', context: 'projection', require: [c('captain.id', 'column'), c('sailors.id', 'column')] },
  { name: 'ON sees current joins', sql: 'SELECT * FROM public.sailors s JOIN harbor.voyages y ON |', context: 'expression', require: [c('handle', 'column'), c('destination', 'column')], forbid: [c('name', 'column')] },
  { name: 'ON excludes future join', sql: 'SELECT * FROM public.sailors s JOIN harbor.voyages y ON | JOIN public.vessels v ON true', context: 'expression', require: [c('handle', 'column'), c('destination', 'column')], forbid: [c('name', 'column')] },
  { name: 'ON excludes preceding comma source', sql: 'SELECT * FROM public.sailors s, public.vessels v JOIN harbor.voyages y ON |', context: 'expression', require: [c('name', 'column'), c('destination', 'column')], forbid: [c('handle', 'column')] },
  { name: 'ON hides preceding comma alias', sql: 'SELECT * FROM public.sailors s, public.vessels v JOIN harbor.voyages y ON s.|', context: 'expression', only: [] },
  { name: 'nested JOIN ON hides enclosing source', sql: 'SELECT * FROM public.sailors s JOIN (public.vessels v JOIN harbor.voyages y ON s.|) ON true', context: 'expression', only: [] },
  { name: 'joined table alias columns', sql: 'SELECT j.| FROM (public.sailors s JOIN public.vessels v ON s.id = v.id) j', context: 'qualified-column', require: [c('handle', 'column'), c('name', 'column')], forbid: [c('id', 'column')] },
  { name: 'joined table alias hides operands', sql: 'SELECT s.| FROM (public.sailors s JOIN public.vessels v ON s.id = v.id) j', context: 'projection', only: [] },
  { name: 'USING joined table has one id', sql: 'SELECT j.| FROM (public.sailors s JOIN public.vessels v USING (id)) j', context: 'qualified-column', require: [c('id', 'column'), c('handle', 'column'), c('name', 'column')] },
  { name: 'chained USING joined output', sql: 'SELECT j.| FROM (public.sailors s JOIN public.vessels v USING (id) JOIN public.sailors s2 USING (id)) j', context: 'qualified-column', require: [c('id', 'column'), c('name', 'column')], forbid: [c('handle', 'column')] },
  { name: 'NATURAL joined output', sql: 'SELECT j.| FROM (public.sailors s NATURAL JOIN public.vessels v NATURAL JOIN public.sailors s2) j', context: 'qualified-column', require: [c('id', 'column'), c('handle', 'column'), c('name', 'column')] },
  { name: 'unaliased nested JOIN operand', sql: 'SELECT s.| FROM ((public.sailors s JOIN public.vessels v USING (id))) JOIN harbor.voyages y ON true', context: 'qualified-column', require: [c('handle', 'column')], forbid: [c('name', 'column')] },
  { name: 'nested JOIN alias with USING', sql: 'SELECT j.| FROM ((public.sailors s JOIN public.vessels v USING (id)) JOIN harbor.voyages y ON true) j', context: 'qualified-column', require: [c('id', 'column'), c('handle', 'column'), c('name', 'column'), c('destination', 'column')] },
  { name: 'unqualified USING output', sql: 'SELECT | FROM (public.sailors s JOIN public.vessels v USING (id))', context: 'projection', require: [c('id', 'column')], forbid: [c('s.id', 'column'), c('v.id', 'column')] },
  { name: 'derived source in joined output', sql: 'SELECT j.| FROM ((SELECT id, handle AS nickname FROM public.sailors) d JOIN public.vessels v USING (id)) j', context: 'qualified-column', require: [c('id', 'column'), c('nickname', 'column'), c('name', 'column')] },
  { name: 'table function alias columns', sql: "SELECT f.| FROM harbor.port_label('dock') AS f(label)", context: 'qualified-column', require: [c('label', 'column')], forbid: [c('port_label', 'column')] },
  { name: 'table function joined output', sql: 'SELECT j.| FROM (public.sailors s JOIN harbor.port_label(s.handle) AS f(label) ON true) j', context: 'qualified-column', require: [c('handle', 'column'), c('label', 'column')] },
  { name: 'LATERAL table function joined output', sql: 'SELECT j.| FROM (public.sailors s JOIN LATERAL harbor.port_label(s.handle) AS f(label) ON true) j', context: 'qualified-column', require: [c('handle', 'column'), c('label', 'column')] },
  { name: 'table function sees earlier source', sql: 'SELECT * FROM public.sailors s JOIN harbor.port_label(s.|) f ON true', context: 'qualified-column', require: [c('handle', 'column')] },
  { name: 'table function excludes later source', sql: 'SELECT * FROM harbor.port_label(future.|) f JOIN public.sailors future ON true', context: 'expression', only: [] },
  { name: 'record function definitions', sql: "SELECT r.| FROM json_to_record('{}') AS r(code integer, label text)", context: 'qualified-column', require: [c('code', 'column'), c('label', 'column')] },
  { name: 'ROWS FROM aliases', sql: "SELECT r.| FROM ROWS FROM (generate_series(1, 3), json_to_record('{}') AS (code integer, label text)) AS r(n, code, label)", context: 'qualified-column', require: [c('n', 'column'), c('code', 'column'), c('label', 'column')] },
  { name: 'ROWS FROM ordinality', sql: 'SELECT r.| FROM ROWS FROM (generate_series(1, 3)) WITH ORDINALITY AS r(n, ordinal)', context: 'qualified-column', require: [c('n', 'column'), c('ordinal', 'column')] },
  { name: 'ROWS FROM joined output', sql: "SELECT j.| FROM (public.sailors s JOIN ROWS FROM (generate_series(1, 3), json_to_record('{}') AS (code integer)) AS r(n, code) ON true) j", context: 'qualified-column', require: [c('handle', 'column'), c('n', 'column'), c('code', 'column')] },
  { name: 'nested SELECT qualifier', sql: 'SELECT (SELECT y.| FROM harbor.voyages y) FROM public.sailors s', context: 'qualified-column', require: [c('destination', 'column')], forbid: [c('handle', 'column')] },
  { name: 'nested SELECT after outer FROM', sql: 'SELECT * FROM public.sailors s WHERE EXISTS (SELECT y.| FROM harbor.voyages y)', context: 'qualified-column', require: [c('destination', 'column')], forbid: [c('handle', 'column')] },
  { name: 'nested alias shadows outer alias', sql: 'SELECT (SELECT s.| FROM harbor.voyages s) FROM public.sailors s', context: 'qualified-column', require: [c('destination', 'column')], forbid: [c('handle', 'column')] },
  { name: 'three-level alias shadow', sql: 'SELECT (SELECT (SELECT s.| FROM harbor.voyages s) FROM public.vessels s) FROM public.sailors s', context: 'qualified-column', require: [c('destination', 'column')], forbid: [c('handle', 'column'), c('name', 'column')] },
  { name: 'ordinary FROM hides preceding source', sql: 'SELECT * FROM public.sailors s, (SELECT s.|) d', context: 'projection', only: [] },
  { name: 'ordinary FROM hides following source', sql: 'SELECT * FROM (SELECT future.|) d, public.sailors future', context: 'projection', only: [] },
  { name: 'LATERAL sees preceding source', sql: 'SELECT * FROM public.sailors s, LATERAL (SELECT s.|) d', context: 'qualified-column', require: [c('handle', 'column')], forbid: [c('name', 'column')] },
  { name: 'LATERAL excludes following source', sql: 'SELECT * FROM LATERAL (SELECT future.|) d, public.sailors future', context: 'projection', only: [] },
  { name: 'FROM retains outer ancestor', sql: 'SELECT (SELECT * FROM public.sailors s, (SELECT outer_ship.|) d) FROM public.vessels outer_ship', context: 'qualified-column', require: [c('name', 'column')], forbid: [c('handle', 'column')] },
  { name: 'LATERAL local alias shadows prior source', sql: 'SELECT * FROM public.sailors s, LATERAL (SELECT s.| FROM harbor.voyages s) d', context: 'qualified-column', require: [c('destination', 'column')], forbid: [c('handle', 'column')] },
  { name: 'UNION first branch alias', sql: 'SELECT q.| FROM public.sailors q UNION ALL SELECT q.destination FROM harbor.voyages q', context: 'qualified-column', require: [c('handle', 'column')], forbid: [c('destination', 'column')] },
  { name: 'UNION second branch alias', sql: 'SELECT q.handle FROM public.sailors q UNION ALL SELECT q.| FROM harbor.voyages q', context: 'qualified-column', require: [c('destination', 'column')], forbid: [c('handle', 'column')] },
  { name: 'INTERSECT branch columns', sql: 'SELECT | FROM public.sailors s INTERSECT SELECT destination FROM harbor.voyages v', context: 'projection', require: [c('handle', 'column')], forbid: [c('destination', 'column')] },
  { name: 'EXCEPT parenthesized branch', sql: '(SELECT q.| FROM public.sailors q) EXCEPT (SELECT q.destination FROM harbor.voyages q)', context: 'qualified-column', require: [c('handle', 'column')], forbid: [c('destination', 'column')] },
  { name: 'set result ORDER BY output', sql: 'SELECT handle AS crew_name FROM public.sailors UNION SELECT destination FROM harbor.voyages ORDER BY cr|', context: 'set-order', only: [c('crew_name', 'column')], replace: 'cr' },
  { name: 'set branch correlation', sql: 'SELECT (SELECT outer_ship.| FROM public.sailors q UNION ALL SELECT destination FROM harbor.voyages q) FROM public.vessels outer_ship', context: 'qualified-column', require: [c('name', 'column')], forbid: [c('handle', 'column'), c('destination', 'column')] },
  { name: 'sibling set derived alias is hidden', sql: 'SELECT d.nickname FROM (SELECT handle AS nickname FROM public.sailors) d UNION SELECT d.| FROM public.vessels v', context: 'projection', only: [] },
  { name: 'derived table columns', sql: 'SELECT d.| FROM (SELECT s.handle AS nickname FROM public.sailors s) d', context: 'qualified-column', require: [c('nickname', 'column')], forbid: [c('handle', 'column')] },
  { name: 'LATERAL derived table', sql: 'SELECT x.| FROM public.sailors s, LATERAL (SELECT s.handle AS nickname) x', context: 'qualified-column', require: [c('nickname', 'column')] },
  { name: 'sibling derived alias is hidden', sql: 'SELECT d.| FROM public.sailors d WHERE EXISTS (SELECT * FROM (SELECT 1 AS nickname) d)', context: 'qualified-column', require: [c('handle', 'column')], forbid: [c('nickname', 'column')] },
  { name: 'recursive CTE explicit columns', sql: 'WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM nums) SELECT x.| FROM nums x', context: 'qualified-column', require: [c('n', 'column')] },
  { name: 'comma FROM second alias', sql: 'SELECT v.| FROM public.sailors s, public.vessels v', context: 'qualified-column', require: [c('name', 'column')], forbid: [c('handle', 'column')] },
  { name: 'explicit schema disambiguation', sql: 'SELECT h.| FROM harbor.sailors h', context: 'qualified-column', require: [c('depth', 'column')], forbid: [c('handle', 'column')] },
  { name: 'quoted mixed-case relation and column', sql: 'SELECT c.| FROM public."CrewLog" c', context: 'qualified-column', require: [c('LaunchDay', 'column')], forbid: [c('handle', 'column')] },
  { name: 'PostgreSQL cast before cursor', sql: 'SELECT s.handle::text, | FROM public.sailors s', context: 'projection', require: [c('handle', 'column')] },
  { name: 'incomplete JOIN relation', sql: 'SELECT * FROM public.sailors s JOIN |', context: 'relation', require: [c('voyages', 'table')] },
  { name: 'completion before unfinished JOIN', sql: 'SELECT s.| FROM public.sailors s JOIN', context: 'qualified-column', require: [c('handle', 'column')] },
  { name: 'completion inside unfinished subquery', sql: 'SELECT * FROM public.sailors s WHERE EXISTS (SELECT y.| FROM harbor.voyages y', context: 'qualified-column', require: [c('destination', 'column')] },
  { name: 'completion before later syntax error', sql: 'SELECT s.| FROM public.sailors s; SELECT FROM', context: 'qualified-column', require: [c('handle', 'column')] },
  { name: 'completion after malformed JOIN source', sql: 'SELECT * FROM public.sailors s JOIN p-ublic.vessels v ON s.|', context: 'qualified-column', require: [c('handle', 'column')] },
  { name: 'projection wildcard', sql: 'SELECT | FROM public.sailors s', context: 'projection', require: [c('*', 'keyword'), c('handle', 'column')] },
  { name: 'clause after mixed wildcard projection', sql: 'SELECT * , id fr|', context: 'projection', first: c('FROM', 'keyword'), only: [c('FROM', 'keyword')], replace: 'fr' },
  { name: 'clause after function projection', sql: 'SELECT count(*) fr|', context: 'projection', first: c('FROM', 'keyword'), only: [c('FROM', 'keyword')], replace: 'fr' },
  { name: 'SQL after prior statement', sql: 'SELECT * FROM public.vessels v; SELECT s.| FROM public.sailors s', context: 'qualified-column', require: [c('handle', 'column')], forbid: [c('name', 'column')] },
  { name: 'semicolon inside preceding string', sql: "SELECT ';'; SELECT * FROM |", context: 'relation', require: [c('sailors', 'table')] },
  { name: 'semicolon inside preceding comment', sql: 'SELECT 1; /* ; */ SELECT * FROM |', context: 'relation', require: [c('sailors', 'table')] },
  { name: 'comment ignored', sql: 'SELECT * -- s.|', context: 'ignored', only: [] },
  { name: 'string ignored', sql: "SELECT 's.|'", context: 'ignored', only: [] },
  { name: 'dollar quote ignored', sql: 'SELECT $tag$s.|$tag$', context: 'ignored', only: [] },
  { name: 'INSERT target', sql: 'INSERT INTO |', context: 'relation', require: [c('sailors', 'table')] },
  { name: 'INSERT columns', sql: 'INSERT INTO public.sailors (|', context: 'target-column', require: [c('handle', 'column')], forbid: [c('name', 'column')] },
  { name: 'UPDATE columns', sql: 'UPDATE public.sailors SET |', context: 'target-column', require: [c('handle', 'column')], forbid: [c('name', 'column')] },
  { name: 'DELETE alias', sql: 'DELETE FROM public.sailors s WHERE s.|', context: 'qualified-column', require: [c('handle', 'column')], forbid: [c('name', 'column')] },
  { name: 'SHOW setting', sql: 'SHOW sear|', context: 'setting', only: [c('search_path', 'setting')], first: c('search_path', 'setting'), replace: 'sear' },
  { name: 'builtin routine', sql: 'SELECT low| FROM public.sailors s', context: 'projection', require: [c('lower', 'function')], first: c('lower', 'function'), replace: 'low' },
  { name: 'CTE relation', sql: 'WITH crew AS (SELECT id, handle FROM public.sailors) SELECT * FROM |', context: 'relation', require: [c('crew', 'cte')] },
  { name: 'CTE projected columns', sql: 'WITH crew AS (SELECT id, handle FROM public.sailors) SELECT c.| FROM crew c', context: 'qualified-column', require: [c('handle', 'column')], forbid: [c('name', 'column')] },
  { name: 'draft DDL relation', sql: 'CREATE TABLE harbor.docks (id integer, label text); SELECT * FROM |', context: 'relation', require: [c('docks', 'table')], detailIncludes: { [c('docks', 'table')]: 'draft' } },
  { name: 'draft DDL columns', sql: 'CREATE TABLE harbor.docks (id integer, label text); SELECT d.| FROM harbor.docks d', context: 'qualified-column', require: [c('label', 'column')], forbid: [c('handle', 'column')] },
  { name: 'CREATE TABLE new column name', sql: 'CREATE TABLE harbor.cargo_checks (\n  id integer,\n  risk harbor.cargo_risk,\n  measured_weight harbor.positive_weight,\n  t|', context: 'definition-column', only: [], replace: 't' },
  { name: 'future DDL excluded', sql: 'SELECT * FROM |; CREATE TABLE harbor.docks (id integer)', context: 'relation', forbid: [c('docks', 'table')] }
];

function evaluate(result, scenario, offset) {
  const labels = result.suggestions.map(item => c(item.label, item.kind));
  const set = new Set(labels);
  const problems = [];
  const checks = {
    context: Number(result.context === scenario.context),
    required: (scenario.require || []).filter(item => set.has(item)).length,
    requiredTotal: (scenario.require || []).length,
    excluded: (scenario.forbid || []).filter(item => !set.has(item)).length,
    excludedTotal: (scenario.forbid || []).length,
    top1: Number(Boolean(scenario.first) && labels[0] === scenario.first),
    top1Total: Number(Boolean(scenario.first))
  };
  if (result.capabilities?.context !== false && result.context !== scenario.context) problems.push(`context ${result.context} ≠ ${scenario.context}`);
  for (const wanted of scenario.require || []) if (!set.has(wanted)) problems.push(`missing ${wanted}`);
  for (const unwanted of scenario.forbid || []) if (set.has(unwanted)) problems.push(`unexpected ${unwanted}`);
  for (const [wanted, fragment] of Object.entries(scenario.detailIncludes || {})) {
    if (!result.suggestions.some(item => c(item.label, item.kind) === wanted && item.detail?.includes(fragment))) {
      problems.push(`${wanted} detail lacks ${fragment}`);
    }
  }
  if (scenario.only && (labels.length !== scenario.only.length || labels.some(item => !scenario.only.includes(item)))) {
    problems.push(`expected only [${scenario.only.join(', ')}], got [${labels.join(', ')}]`);
  }
  if (result.capabilities?.ranking !== false && scenario.first && labels[0] !== scenario.first) problems.push(`first ${labels[0] || 'none'} ≠ ${scenario.first}`);
  const expectedStart = offset - (scenario.replace?.length || 0);
  checks.replacement = Number(result.replacementStart === expectedStart);
  if (result.replacementStart !== expectedStart) problems.push(`replacementStart ${result.replacementStart} ≠ ${expectedStart}`);
  return { problems, checks };
}

const engine = createCrabSense(metadata);
const codeMirror = createCodeMirror(metadata);
const methods = [
  ['CrabSense', (sql, offset) => engine.complete(sql, offset)],
  ['CodeMirror SQL', (sql, offset) => codeMirror.complete(sql, offset)]
];
const failures = new Map(methods.map(([name]) => [name, []]));
const totals = new Map(methods.map(([name]) => [name, { context: 0, required: 0, requiredTotal: 0, excluded: 0, excludedTotal: 0, replacement: 0, top1: 0, top1Total: 0 }]));
for (const scenario of scenarios) {
  const offset = scenario.sql.indexOf('|');
  const sql = scenario.sql.slice(0, offset) + scenario.sql.slice(offset + 1);
  for (const [name, method] of methods) {
    try {
      const { problems, checks } = evaluate(method(sql, offset), scenario, offset);
      for (const [key, value] of Object.entries(checks)) totals.get(name)[key] += value;
      if (problems.length) failures.get(name).push({ scenario: scenario.name, problems });
    } catch (error) {
      failures.get(name).push({ scenario: scenario.name, problems: [`threw ${error.message}`] });
    }
  }
}

console.log(`${scenarios.length} scenario oracles · ${methods.length} methods · one point per scenario passing all applicable checks`);
console.log('CodeMirror sources do not report context or popup ranking: those checks are n/a, not passes. Other checks use the same scenarios.');
console.table(methods.map(([name]) => ({ method: name, passed: scenarios.length - failures.get(name).length,
  total: scenarios.length, context: name === 'CodeMirror SQL' ? 'n/a' : `${totals.get(name).context}/${scenarios.length}`,
  required: `${totals.get(name).required}/${totals.get(name).requiredTotal}`,
  excluded: `${totals.get(name).excluded}/${totals.get(name).excludedTotal}`,
  replacement: `${totals.get(name).replacement}/${scenarios.length}`,
  top1: name === 'CodeMirror SQL' ? 'n/a' : `${totals.get(name).top1}/${totals.get(name).top1Total}` })));
for (const [name] of methods) {
  const missed = failures.get(name);
  console.log(`${name} misses (${missed.length}):`);
  for (const { scenario, problems } of missed) console.log(`  ${scenario}: ${problems.join('; ')}`);
}
if (process.argv.includes('--assert-crabsense') && failures.get('CrabSense').length) process.exitCode = 1;
