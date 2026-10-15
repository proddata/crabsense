import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryStressFixtures } from '../fixtures/query-stress.js';

const argument = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const modulePath = argument('--module');
if (!modulePath) throw new Error('Pass --module /path/to/@postgres-language-server/wasm/dist/workspace.js');
const large = process.argv.includes('--large');
const runs = argument('--runs') || '10';
const fixtures = queryStressFixtures({ large });
const temporary = await mkdtemp(join(tmpdir(), 'crabsense-pgls-'));
const rows = [];
let packageDetails = null;
let features = null;
try {
  for (const [index, fixture] of fixtures.entries()) {
    const reportPath = join(temporary, `${index}.json`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./bench-pgls-wasm.mjs', import.meta.url)),
      '--module', modulePath, '--runs', runs, ...(large ? ['--large'] : []),
      '--fixture', fixture.name, '--json', reportPath], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status === 0) {
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      packageDetails ??= Object.fromEntries(['node', 'platform', 'pglsPackage', 'wasmBytes', 'wasmGzipBytes', 'wasmSha256', 'wasmInitMs', 'wasmSchemaMs', 'methodology']
        .map(key => [key, report[key]]));
      features ??= report.features;
      rows.push(report.rows[0]);
    } else {
      rows.push({ query: fixture.name, chars: fixture.sql.length, crash: true,
        exitCode: result.status, signal: result.signal,
        error: (result.stderr || result.error?.message || '').split('\n').filter(Boolean).slice(0, 3).join(' ') });
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const report = { generatedAt: new Date().toISOString(), runs: Number(runs), large, ...packageDetails, features, rows };
const output = argument('--json');
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`PGLS WASM ${report.pglsPackage}: ${fixtures.length} isolated fixture processes, ${rows.filter(row => row.crash).length} crashes`);
console.table(features?.map(({ name, wanted, crabsense, pgls }) => ({ name, wanted, crabsense, pgls })) || []);
console.table(rows.map(row => ({ query: row.query, chars: row.chars, crash: Boolean(row.crash),
  crabsense: row.crabsense?.problems.length === 0, pgls: row.pgls?.problems.length === 0,
  crabsenseEditP50: row.crabsense ? +row.crabsense.editMs.p50.toFixed(2) : null,
  pglsEditP50: row.pgls ? +row.pgls.editMs.p50.toFixed(2) : null })));
for (const row of rows.filter(row => row.crash || row.pgls?.problems.length)) {
  console.log(`${row.query}: ${row.crash ? row.error : row.pgls.problems.join('; ')}`);
}
