import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { parse } from 'libpg-query';
import { createCrabSense } from 'crabsense';
import { createCodeMirror } from '../src/methods/codemirror.js';
import { queryStressFixtures, stressMetadata, checkStressResult } from '../fixtures/query-stress.js';

const large = process.argv.includes('--large');
const runs = 15;
const fixtures = queryStressFixtures({ large });
const factories = [['CrabSense', createCrabSense], ['CodeMirror SQL', createCodeMirror]];
const rows = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const timed = (engine, sql, offset) => {
  const start = performance.now();
  try { return { result: engine.complete(sql, offset, { limit: 500 }), ms: performance.now() - start }; }
  catch (error) { return { error: error.message, ms: performance.now() - start }; }
};

for (const fixture of fixtures) {
  // Validate the completed scaffold, never execute it. This checks syntax only.
  await parse(fixture.validSql);
  for (const [method, factory] of factories) {
    const engine = factory(stressMetadata); // Preparation excluded; first parse included below.
    const first = timed(engine, fixture.sql, fixture.offset);
    const problems = first.error ? [first.error] : checkStressResult(first.result, fixture);
    const warm = [], edits = [];
    for (let i = 0; i < 3; i++) timed(engine, fixture.sql, fixture.offset);
    for (let i = 0; i < runs; i++) {
      const call = timed(engine, fixture.sql, fixture.offset);
      warm.push(call.ms);
      if (call.error && !problems.includes(call.error)) problems.push(call.error);
    }
    for (let i = 0; i < runs; i++) {
      // Alternate one-letter prefixes to force a real document edit each call.
      const extra = i % 2 === 0 ? fixture.wanted[0][fixture.prefix.length] || '' : '';
      const sql = fixture.sql.slice(0, fixture.offset) + extra + fixture.sql.slice(fixture.offset);
      const call = timed(engine, sql, fixture.offset + extra.length);
      edits.push(call.ms);
      const failures = call.error ? [call.error] : checkStressResult(call.result, fixture, fixture.offset + extra.length, fixture.prefix + extra);
      for (const failure of failures) if (!problems.includes(failure)) problems.push(failure);
    }
    rows.push({ query: fixture.name, chars: fixture.sql.length, method,
      correct: problems.length === 0, problems, suggestions: first.result?.suggestions.length ?? 0,
      firstMs: first.ms, warmP50: percentile(warm, .5), warmP95: percentile(warm, .95),
      editP50: percentile(edits, .5), editP95: percentile(edits, .95) });
  }
}
console.log(`${fixtures.length} single-statement fixtures · PostgreSQL syntax checked · ${runs} samples per mode · limit 500`);
console.log('First call includes initial SQL parsing; warm repeats reuse SQL; edit samples alternate prefixes. Metadata setup, editor rendering and network excluded.');
console.table(rows.map(({ problems, ...row }) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key, typeof value === 'number' && key !== 'chars' && key !== 'suggestions' ? +value.toFixed(2) : value]))));
for (const row of rows.filter(row => !row.correct)) console.log(`${row.method} ${row.query}: ${row.problems.join('; ')}`);
const report = { generatedAt: new Date().toISOString(), large, runs, limit: 500, rows };
const jsonIndex = process.argv.indexOf('--json');
if (jsonIndex >= 0) await writeFile(process.argv[jsonIndex + 1], JSON.stringify(report, null, 2) + '\n');
// Competitor differences and exploratory failures remain visible, not rewritten.
if (process.argv.includes('--assert-crabsense') && rows.some(row => row.method === 'CrabSense' && !row.correct)) process.exitCode = 1;
