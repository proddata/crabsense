import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCrabSense } from '../src/completion.js';

const fallback = {
  currentSchema: 'public',
  schemas: ['public', 'harbor'],
  relations: [{ schema: 'public', name: 'sailors', kind: 'table' }],
  columns: [{ schema: 'public', relation: 'sailors', name: 'handle', type: 'text' }],
  functions: []
};
const metadata = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : fallback;
const engine = createCrabSense(metadata);
const workloads = [
  ['short SELECT', 'SELECT s.| FROM public.sailors s'],
  ['100 prior statements', `${'SELECT 1;\n'.repeat(100)}SELECT s.| FROM public.sailors s`],
  ['1,000 prior statements', `${'SELECT 1;\n'.repeat(1000)}SELECT s.| FROM public.sailors s`],
  ['1,000 draft statements', `${'CREATE TABLE harbor.docks (id integer, label text);\n'.repeat(1000)}SELECT d.| FROM harbor.docks d`]
];
function percentile(values, rank) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * rank) - 1].toFixed(2);
}
console.log(`CrabSense completion only · 50 measured calls per workload · ${metadata.relations.length} catalog relations`);
console.table(workloads.map(([name, marked]) => {
  const offset = marked.indexOf('|');
  const sql = marked.slice(0, offset) + marked.slice(offset + 1);
  for (let i = 0; i < 10; i++) engine.complete(sql, offset);
  const times = [];
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    engine.complete(sql, offset);
    times.push(performance.now() - start);
  }
  return { workload: name, characters: sql.length, 'p50 ms': percentile(times, 0.5), 'p95 ms': percentile(times, 0.95) };
}));
