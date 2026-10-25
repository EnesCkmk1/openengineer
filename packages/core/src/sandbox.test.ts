import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenEngineerError } from '@openengineer/shared';
import { createSandbox } from './sandbox.js';

describe('sandbox', () => {
  it('refuses process mode unless it is explicitly acknowledged', async () => {
    await expect(
      createSandbox({ mode: 'process', allowProcessSandbox: false, dockerImage: 'node:22-bookworm-slim' }),
    ).rejects.toMatchObject({ code: 'sandbox_unavailable' });
  });

  it('filters host secrets, enforces a timeout, and reports a non-zero result', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-secret';
    const sandbox = await createSandbox({
      mode: 'process',
      allowProcessSandbox: true,
      dockerImage: 'node:22-bookworm-slim',
    });
    expect(sandbox.secure).toBe(false);
    expect(sandbox.warning).toMatch(/not a security boundary/);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oe-sandbox-'));
    await writeFile(path.join(dir, 'package.json'), '{"name":"t","private":true}\n');
    const leaked = await sandbox.run({
      argv: ['node', '-e', 'process.stdout.write(process.env.OPENAI_API_KEY ?? "")'],
      cwd: dir,
      timeoutMs: 10_000,
      network: false,
    });
    expect(leaked.stdout).toBe('');
    expect(leaked.exitCode).toBe(0);

    const timed = await sandbox.run({
      argv: ['node', '-e', 'setTimeout(() => {}, 30_000)'],
      cwd: dir,
      timeoutMs: 400,
      network: false,
    });
    expect(timed.timedOut).toBe(true);
    expect(timed.exitCode).not.toBe(0);
  });

  it('fails closed when docker mode is selected and docker is missing', async () => {
    const original = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    const which = await import('node:child_process');
    const probe = which.spawnSync('docker', ['--version'], { encoding: 'utf8' });
    process.env.PATH = original;
    if (probe.status === 0) return;
    await expect(
      createSandbox({ mode: 'docker', allowProcessSandbox: false, dockerImage: 'node:22-bookworm-slim' }),
    ).rejects.toBeInstanceOf(OpenEngineerError);
  });
});
