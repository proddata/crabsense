import { cp, mkdir, rm } from 'node:fs/promises';

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await cp(new URL('../src/completion.js', import.meta.url), new URL('../dist/index.js', import.meta.url));
await cp(new URL('../src/completion.d.ts', import.meta.url), new URL('../dist/index.d.ts', import.meta.url));
for (const file of ['sql-context.js', 'ranking.js']) {
  await cp(new URL(`../src/${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}
