import { createCodeMirror } from '../src/methods/codemirror.js';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCrabSense } from 'crabsense';

const fallbackSchema = {
  schemas: ['public', 'harbor'],
  relations: [
    { schema: 'public', name: 'sailors', kind: 'table' },
    { schema: 'public', name: 'vessels', kind: 'table' },
    { schema: 'harbor', name: 'voyages', kind: 'table' }
  ],
  columns: [
    { schema: 'public', relation: 'sailors', name: 'id', type: 'integer' },
    { schema: 'public', relation: 'sailors', name: 'handle', type: 'text' },
    { schema: 'public', relation: 'vessels', name: 'id', type: 'integer' },
    { schema: 'public', relation: 'vessels', name: 'name', type: 'text' },
    { schema: 'harbor', relation: 'voyages', name: 'destination', type: 'text' }
  ],
  functions: []
};

const schema = process.argv[2]
  ? JSON.parse(await readFile(process.argv[2], 'utf8'))
  : fallbackSchema;
const engine = createCrabSense(schema);
const codeMirror = createCodeMirror(schema);

const methods = [
  ['CrabSense', (sql, offset) => engine.complete(sql, offset)],
  ['CodeMirror SQL', (sql, offset) => codeMirror.complete(sql, offset)]
];
const templates = [
  'SELECT | FROM public.sailors s',
  'SELECT s.| FROM public.sailors s',
  'SELECT * FROM |',
  'SELECT * FROM public.sailors s JOIN |',
  'SELECT * FROM public.sailors s WHERE |',
  'SELECT * FROM public.sailors s JOIN public.vessels v ON |',
  'SELECT (SELECT | FROM harbor.voyages y) FROM public.sailors s',
  'SELECT * FROM harbor.|',
  'INSERT INTO |',
  'UPDATE public.sailors SET |',
  'SHOW |',
  'WITH crew AS (SELECT id, handle FROM public.sailors) SELECT c.| FROM crew c'
];
let randomState = 20261010;
function random() {
  randomState = (1664525 * randomState + 1013904223) >>> 0;
  return randomState / 2 ** 32;
}
const cases = templates.map(marked => ({ marked, type: 'baseline' }));
const prefixes = ['', 's', 'ha', 'v', '"ha', 'pub', 'LOW'];
const insertions = ['(', ')', ',', ';', '.', "'", '"', ' ', '\n', '-', 'x'];
for (let i = 0; i < 200; i++) {
  let marked = templates[Math.floor(random() * templates.length)];
  marked = marked.replace('|', prefixes[Math.floor(random() * prefixes.length)] + '|');
  const edits = Math.floor(random() * 3);
  for (let edit = 0; edit < edits; edit++) {
    const at = Math.floor(random() * (marked.length + 1));
    marked = marked.slice(0, at) + insertions[Math.floor(random() * insertions.length)] + marked.slice(at);
  }
  cases.push({ marked, type: 'fuzz' });
}

function atCursor(marked) {
  const offset = marked.indexOf('|');
  return { sql: marked.slice(0, offset) + marked.slice(offset + 1), offset };
}
function labels(result) {
  return [...new Set(result.suggestions.map(item => `${item.kind}:${item.label}`))].sort().join('|');
}
function percentile(values, rank) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * rank) - 1)]?.toFixed(2) ?? '—';
}

// Warm both independent completion sources before measuring.
for (const [, method] of methods) {
  for (const marked of templates) {
    const { sql, offset } = atCursor(marked);
    method(sql, offset);
  }
}
const metrics = methods.map(([name]) => ({ name, times: [], failures: [], results: [] }));
for (const testCase of cases) {
  const { sql, offset } = atCursor(testCase.marked);
  for (let index = 0; index < methods.length; index++) {
    const start = performance.now();
    try {
      const result = methods[index][1](sql, offset);
      metrics[index].times.push(performance.now() - start);
      if (!Array.isArray(result.suggestions) || typeof result.context !== 'string' ||
        !Number.isInteger(result.replacementStart) ||
        result.replacementStart < 0 || result.replacementStart > offset) {
        throw new Error('Invalid completion result');
      }
      metrics[index].results.push({ context: result.context, labels: labels(result), count: result.suggestions.length });
    } catch (error) {
      metrics[index].failures.push({ marked: testCase.marked, message: error.message });
      metrics[index].results.push(null);
    }
  }
}

console.log(`Seed 20261010 · ${cases.length} cases (${templates.length} baseline, 200 fuzz) · ${schema.relations.length} relations · ${schema.builtinFunctions?.length || 0} built-in routines`);
console.table(metrics.map(metric => ({
  method: metric.name,
  failures: metric.failures.length,
  'p50 ms': percentile(metric.times, 0.5),
  'p95 ms': percentile(metric.times, 0.95),
  'max ms': percentile(metric.times, 1),
  'same context as CrabSense': metric.name === 'CodeMirror SQL' ? 'n/a' : metric.results.filter((result, index) => result && result.context === metrics[0].results[index]?.context).length,
  'same labels as CrabSense': metric.results.filter((result, index) => result && result.labels === metrics[0].results[index]?.labels).length
})));
for (const metric of metrics.slice(1)) {
  const examples = metric.results.flatMap((result, index) =>
    result && (result.context !== metrics[0].results[index]?.context || result.labels !== metrics[0].results[index]?.labels)
      ? [{ sql: cases[index].marked, crabsense: metrics[0].results[index]?.context, method: result.context,
        crabsenseCount: metrics[0].results[index]?.count, count: result.count }]
      : []).slice(0, 3);
  console.log(`${metric.name} disagreement examples:`, examples);
}
for (const metric of metrics) {
  if (metric.failures.length) console.log(`${metric.name} failures:`, metric.failures.slice(0, 5));
}
