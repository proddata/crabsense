import { createCodeMirror } from '../src/methods/codemirror.js';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createCrabSense } from 'crabsense';

const sizes = process.argv.includes('--large') ? [100, 1000, 10000, 50000] : [100, 1000, 10000];
const runs = 30;

function catalog(size) {
  const relations = Array.from({ length: size }, (_, index) => ({
    schema: 'public', name: `table_${String(index).padStart(5, '0')}`, kind: 'table'
  }));
  const columns = relations.flatMap(relation => Array.from({ length: 10 }, (_, index) => ({
    schema: relation.schema, relation: relation.name, name: `column_${index}`, type: 'integer'
  })));
  return { currentSchema: 'public', schemas: ['public'], relations, columns, functions: [], builtinFunctions: [] };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2);
}

const rows = [];
for (const size of sizes) {
  const metadata = catalog(size);
  const bytes = Buffer.byteLength(JSON.stringify(metadata));
  const engine = createCrabSense(metadata);
    const codeMirror = createCodeMirror(metadata);
  const name = metadata.relations.at(-1).name;
  const workloads = [
    ['relation prefix', `SELECT * FROM ${name.slice(0, -1)}|`],
    ['alias columns', `SELECT t.| FROM public.${name} t`],
    ['projection', `SELECT | FROM public.${name} t`],
    ['empty FROM', 'SELECT * FROM |']
  ];
  const methods = [
    ['CrabSense', (sql, offset) => engine.complete(sql, offset)],
    ['CrabSense capped', (sql, offset) => engine.complete(sql, offset, { limit: 500 })],
    ['CodeMirror SQL', (sql, offset) => codeMirror.complete(sql, offset)]
  ];
  for (const [workload, marked] of workloads) {
    const offset = marked.indexOf('|');
    const sql = marked.slice(0, offset) + marked.slice(offset + 1);
    for (const [methodName, method] of methods) {
      for (let i = 0; i < 5; i++) method(sql, offset);
      const times = [];
      let result;
      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        result = method(sql, offset);
        times.push(performance.now() - start);
      }
      if (methodName !== 'CodeMirror SQL' && workload === 'relation prefix') {
        assert.ok(result.suggestions.some(item => item.label === name), `${methodName} missed ${name}`);
      } else if (methodName !== 'CodeMirror SQL' && workload === 'alias columns') {
        assert.ok(result.suggestions.some(item => item.label === 'column_9'), `${methodName} missed column_9`);
      } else if (methodName !== 'CodeMirror SQL' && workload === 'empty FROM') {
        assert.ok(result.suggestions.length >= Math.min(size, 500), `${methodName} missed catalog relations`);
        if (methodName === 'CrabSense capped') assert.equal(result.incomplete, size > 500);
      }
      rows.push({ relations: size, columns: metadata.columns.length,
        snapshotMB: (bytes / 2 ** 20).toFixed(1), workload, method: methodName,
        suggestions: result.suggestions.length, expectedCandidate: workload === 'relation prefix' ? result.suggestions.some(item => item.label === name) : workload === 'alias columns' ? result.suggestions.some(item => item.label === 'column_9') : null, p50ms: percentile(times, 0.5), p95ms: percentile(times, 0.95) });
    }
  }
  console.log(`${size} relations · ${metadata.columns.length} columns · ${(bytes / 2 ** 20).toFixed(1)} MiB snapshot JSON`);
  console.table(rows.filter(row => row.relations === size).map(({ workload, method, suggestions, expectedCandidate, p50ms, p95ms }) =>
    ({ workload, method, suggestions, expectedCandidate, 'p50 ms': p50ms, 'p95 ms': p95ms })));
}
console.log(`Completion only · ${runs} measured calls after five warm-ups per cell · one Node process · no Monaco rendering or network time`);
