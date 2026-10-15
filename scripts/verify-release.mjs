import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || tag !== `v${manifest.version}`) {
  throw new Error(`Release tag ${tag || '(missing)'} must match package version v${manifest.version}`);
}
const repository = manifest.repository?.url?.replace(/^git\+https:\/\/github\.com\//, '').replace(/\.git$/, '');
if (repository !== process.env.GITHUB_REPOSITORY) {
  throw new Error(`Package repository ${repository || '(missing)'} must match ${process.env.GITHUB_REPOSITORY || '(missing)'}`);
}
console.log(`Verified ${manifest.name}@${manifest.version} from ${repository}`);
