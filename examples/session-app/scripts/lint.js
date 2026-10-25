import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function files(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const jsFiles = await files(root);
let failed = false;
for (const file of jsFiles) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) {
    failed = true;
    process.stderr.write(check.stderr ?? '');
  }
  const text = await readFile(file, 'utf8');
  const marker = ['TODO', 'SECURITY', 'BYPASS'].join('-');
  if (text.includes(marker)) {
    failed = true;
    process.stderr.write(`${file} contains ${marker}\n`);
  }
}
if (failed) process.exit(1);
process.stdout.write(`lint ok (${jsFiles.length} files)\n`);
