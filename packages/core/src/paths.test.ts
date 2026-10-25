import { mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenEngineerError } from '@openengineer/shared';
import { assertWritableRelative, resolveInside } from './paths.js';

describe('resolveInside', () => {
  it('rejects traversal, absolute paths, and symlinks that leave the root', async () => {
    const root = await mkdirTemp();
    const outside = await mkdirTemp();
    await writeFile(path.join(outside, 'secret.txt'), 'nope');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'ok.txt'), 'yes');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak'));
    await symlink(outside, path.join(root, 'escape-dir'));

    const ok = await resolveInside(root, 'src/ok.txt');
    expect(ok.endsWith(`${path.sep}src${path.sep}ok.txt`)).toBe(true);
    await expect(resolveInside(root, '../secret.txt')).rejects.toBeInstanceOf(OpenEngineerError);
    await expect(resolveInside(root, path.join(outside, 'secret.txt'))).rejects.toMatchObject({
      code: 'path_escape',
    });
    await expect(resolveInside(root, 'leak')).rejects.toMatchObject({ code: 'path_escape' });
    await expect(resolveInside(root, 'escape-dir/secret.txt')).rejects.toMatchObject({ code: 'path_escape' });
    await expect(resolveInside(root, 'src/../../etc/passwd')).rejects.toMatchObject({ code: 'path_escape' });
  });

  it('refuses protected relative paths', () => {
    expect(() => assertWritableRelative('.env')).toThrow(/protected path/);
    expect(() => assertWritableRelative('keys/id_rsa')).toThrow(/protected path/);
    expect(() => assertWritableRelative('src/session.js')).not.toThrow();
  });
});

async function mkdirTemp(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(os.tmpdir(), 'oe-path-'));
}
