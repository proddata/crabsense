import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { createCrabSense } from '../../src/completion.js';
import { queryStressFixtures, stressMetadata, checkStressResult } from '../fixtures/query-stress.js';

const argument = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const modulePath = argument('--module');
if (!modulePath) throw new Error('Pass --module /path/to/@postgres-language-server/wasm/dist/workspace.js');
const packageRoot = resolve(dirname(resolve(modulePath)), '..');
const packageInfo = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const wasmPath = join(packageRoot, 'wasm', 'pgls.wasm');
const wasmBytes = await readFile(wasmPath);
const { createWorkspace } = await import(pathToFileURL(resolve(modulePath)).href);
const selectedFixture = argument('--fixture');
const fixtures = queryStressFixtures({ large: process.argv.includes('--large') })
  .filter(fixture => !selectedFixture || fixture.name === selectedFixture);
if (selectedFixture && !fixtures.length) throw new Error(`Unknown fixture: ${selectedFixture}`);
const runs = Number(argument('--runs') || 10);
if (!Number.isSafeInteger(runs) || runs < 2) throw new Error('--runs must be an integer of at least 2');
const percentile = (samples, fraction) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];
const summarize = samples => ({ p50: percentile(samples, .5), p95: percentile(samples, .95) });

// The WASM API consumes a different schema-cache contract. Match the two
// relations and four columns in the existing stress fixture, with stable OIDs.
function wasmSchema(snapshot) {
  const tableIds = new Map(snapshot.relations.map((table, index) => [`${table.schema}.${table.name}`, 10000 + index]));
  const columnPositions = new Map();
  return {
    schemas: [...snapshot.schemas, 'pg_catalog'].map((name, index) => ({ id: 2200 + index, name, owner: 'postgres',
      allowed_creators: [], allowed_users: [], function_count: 0,
      table_count: snapshot.relations.filter(table => table.schema === name).length, total_size: '0', view_count: 0 })),
    tables: snapshot.relations.map(table => ({ id: tableIds.get(`${table.schema}.${table.name}`),
      schema: table.schema, name: table.name, bytes: 0, dead_rows_estimate: 0, live_rows_estimate: 0,
      replica_identity: 'Default', rls_enabled: false, rls_forced: false, size: '0', table_kind: 'Ordinary' })),
    columns: snapshot.columns.map(column => {
      const table = `${column.schema}.${column.relation}`;
      const number = (columnPositions.get(table) || 0) + 1;
      columnPositions.set(table, number);
      return { class_kind: 'OrdinaryTable', is_nullable: true,
        is_primary_key: false, is_unique: false, name: column.name, number,
        schema_name: column.schema, table_name: column.relation,
        table_oid: tableIds.get(table), type_id: column.type === 'integer' ? 23 : 25, type_name: column.type };
    }),
    functions: [], types: [
      { id: 23, schema: 'pg_catalog', name: 'int4', format: 'integer', attributes: { attrs: [] }, enums: { values: [] } },
      { id: 25, schema: 'pg_catalog', name: 'text', format: 'text', attributes: { attrs: [] }, enums: { values: [] } }
    ]
  };
}

const start = performance.now();
const workspace = await createWorkspace();
const wasmInitMs = performance.now() - start;
const schemaStart = performance.now();
workspace.setSchema(wasmSchema(stressMetadata));
const wasmSchemaMs = performance.now() - schemaStart;
const engine = createCrabSense(stressMetadata);
const file = '/benchmark.sql';

function pglsCall(sql, offset) {
  const insertStart = performance.now();
  workspace.insertFile(file, sql);
  const insertMs = performance.now() - insertStart;
  const completeStart = performance.now();
  const suggestions = workspace.complete(file, offset);
  return { suggestions, insertMs, completeMs: performance.now() - completeStart };
}

function candidateProblems(suggestions, fixture) {
  const labels = new Set(suggestions.map(item => item.label.replaceAll('"', '')));
  return [
    ...fixture.wanted.filter(label => !labels.has(label)).map(label => `missing ${label}`),
    ...fixture.forbidden.filter(label => labels.has(label)).map(label => `unexpected ${label}`)
  ];
}

const featureQueries = [
  ['CTE AS', 'WITH acs a', 'AS'],
  ['CTE body SELECT', 'WITH acs AS (', 'SELECT'],
  ['FROM relation', 'SELECT * FROM ', 'sailors'],
  ['qualified column', 'SELECT s.ha FROM public.sailors s', 'handle']
];
const features = featureQueries.map(([name, sql, wanted]) => {
  const offset = name === 'qualified column' ? 'SELECT s.ha'.length : sql.length;
  const ours = engine.complete(sql, offset, { limit: 500 });
  const theirs = pglsCall(sql, offset);
  return { name, wanted, crabsense: ours.suggestions.some(item => item.label === wanted),
    pgls: theirs.suggestions.some(item => item.label === wanted),
    pglsLabels: theirs.suggestions.slice(0, 10).map(item => item.label) };
});

const rows = [];
for (const fixture of fixtures) {
  const firstStart = performance.now();
  const firstCrabSense = engine.complete(fixture.sql, fixture.offset, { limit: 500 });
  const crabsenseFirstMs = performance.now() - firstStart;
  const firstPgls = pglsCall(fixture.sql, fixture.offset);
  const crabsenseProblems = checkStressResult(firstCrabSense, fixture);
  const pglsProblems = candidateProblems(firstPgls.suggestions, fixture);
  const crabsenseWarm = [], pglsWarm = [], crabsenseEdits = [], pglsEdits = [], pglsEditComplete = [];
  for (let i = 0; i < 3; i++) {
    engine.complete(fixture.sql, fixture.offset, { limit: 500 });
    workspace.complete(file, fixture.offset);
  }
  for (let i = 0; i < runs; i++) {
    let at = performance.now();
    engine.complete(fixture.sql, fixture.offset, { limit: 500 });
    crabsenseWarm.push(performance.now() - at);
    at = performance.now();
    workspace.complete(file, fixture.offset);
    pglsWarm.push(performance.now() - at);
  }
  for (let i = 0; i < runs; i++) {
    const extra = i % 2 === 0 ? fixture.wanted[0][fixture.prefix.length] || '' : '';
    const sql = fixture.sql.slice(0, fixture.offset) + extra + fixture.sql.slice(fixture.offset);
    const offset = fixture.offset + extra.length;
    let at = performance.now();
    const ours = engine.complete(sql, offset, { limit: 500 });
    crabsenseEdits.push(performance.now() - at);
    for (const problem of checkStressResult(ours, fixture, offset, fixture.prefix + extra)) {
      if (!crabsenseProblems.includes(problem)) crabsenseProblems.push(problem);
    }
    const theirs = pglsCall(sql, offset);
    pglsEdits.push(theirs.insertMs + theirs.completeMs);
    pglsEditComplete.push(theirs.completeMs);
    for (const problem of candidateProblems(theirs.suggestions, fixture)) {
      if (!pglsProblems.includes(problem)) pglsProblems.push(problem);
    }
  }
  rows.push({ query: fixture.name, chars: fixture.sql.length,
    crabsense: { suggestions: firstCrabSense.suggestions.length, problems: crabsenseProblems,
      firstMs: crabsenseFirstMs, warmMs: summarize(crabsenseWarm), editMs: summarize(crabsenseEdits) },
    pgls: { suggestions: firstPgls.suggestions.length, problems: pglsProblems,
      firstInsertMs: firstPgls.insertMs, firstCompleteMs: firstPgls.completeMs,
      warmMs: summarize(pglsWarm), editMs: summarize(pglsEdits), editCompleteMs: summarize(pglsEditComplete) } });
}

const report = { generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
  pglsPackage: packageInfo.version, wasmBytes: wasmBytes.length, wasmGzipBytes: gzipSync(wasmBytes).length,
  wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'), wasmInitMs, wasmSchemaMs,
  runs, large: process.argv.includes('--large'),
  methodology: 'Node API calls. PGLS edits include full-document insertFile plus complete; CrabSense edits call complete. No browser or worker transfer. PGLS candidate checks omit replacement ranges because its Workspace API returns no edit ranges.',
  features, rows };
const output = argument('--json');
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`PGLS WASM ${packageInfo.version}: ${(wasmBytes.length / 1048576).toFixed(2)} MiB raw, ${(report.wasmGzipBytes / 1048576).toFixed(2)} MiB gzipped; init ${wasmInitMs.toFixed(1)} ms, schema ${wasmSchemaMs.toFixed(1)} ms`);
console.table(features.map(({ name, wanted, crabsense, pgls }) => ({ name, wanted, crabsense, pgls })));
console.table(rows.map(row => ({ query: row.query, chars: row.chars,
  crabsense: row.crabsense.problems.length === 0, pgls: row.pgls.problems.length === 0,
  crabsenseEditP50: +row.crabsense.editMs.p50.toFixed(2), pglsEditP50: +row.pgls.editMs.p50.toFixed(2),
  pglsCompleteP50: +row.pgls.editCompleteMs.p50.toFixed(2) })));
for (const row of rows.filter(row => row.pgls.problems.length)) console.log(`${row.query}: ${row.pgls.problems.join('; ')}`);
