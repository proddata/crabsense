import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createCrabSense } from '../dist/index.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
const [pack] = JSON.parse(output);
const files = new Set(pack.files.map(file => file.path));
const required = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/ranking.js', 'dist/sql-context.js'];
const missing = required.filter(file => !files.has(file));
const unexpected = [...files].filter(file => !required.includes(file) && !/^docs\/.+\.md$/.test(file));

if (pack.name !== manifest.name || pack.version !== manifest.version || missing.length || unexpected.length) {
  throw new Error(`Invalid npm package: ${JSON.stringify({ name: pack.name, version: pack.version, missing, unexpected })}`);
}
if (manifest.main !== './dist/index.js' || manifest.types !== './dist/index.d.ts' ||
    manifest.exports?.['.']?.import !== manifest.main || manifest.exports?.['.']?.types !== manifest.types) {
  throw new Error('Package entry points do not match the built files');
}
const engine = createCrabSense({ schemas: [], relations: [], columns: [], functions: [] });
if (typeof engine.complete !== 'function') throw new Error('Built package does not expose completion');

console.log(`${pack.id}: ${files.size} files, ${(pack.size / 1024).toFixed(1)} KiB; entry point OK`);
