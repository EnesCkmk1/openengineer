import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectProject } from './detect.js';

describe('detectProject', () => {
  it('detects an npm node:test project and proposes required checks', async () => {
    const root = await mkdtemp();
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'sample',
        scripts: { test: 'node --test', lint: 'node scripts/lint.js' },
      }),
    );
    const detected = await detectProject(root);
    expect(detected.languages).toContain('javascript');
    expect(detected.packageManager).toBe('npm');
    expect(detected.testFramework).toBe('node:test');
    expect(detected.suggestedChecks.map((check) => check.display)).toEqual(['npm test', 'npm run lint']);
    expect(detected.suggestedChecks.every((check) => check.required)).toBe(true);
  });

  it('prefers the pnpm lockfile and leaves non-node ecosystems unexecuted', async () => {
    const root = await mkdtemp();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sample', scripts: { test: 'vitest' } }));
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(path.join(root, 'tsconfig.json'), '{}');
    const detected = await detectProject(root);
    expect(detected.packageManager).toBe('pnpm');
    expect(detected.languages).toContain('typescript');
    expect(detected.testFramework).toBe('vitest');

    const py = await mkdtemp();
    await writeFile(path.join(py, 'pyproject.toml'), '[project]\nname="x"\n');
    const python = await detectProject(py);
    expect(python.packageManager).toBe('pip');
    expect(python.suggestedChecks).toEqual([]);
    expect(python.notes.join(' ')).toMatch(/not executed/);
  });
});

async function mkdtemp(): Promise<string> {
  const { mkdtemp: make } = await import('node:fs/promises');
  return make(path.join(os.tmpdir(), 'oe-detect-'));
}
