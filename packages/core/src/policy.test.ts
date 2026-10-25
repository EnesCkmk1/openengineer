import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCommand } from './policy.js';

const cwd = path.join(os.tmpdir(), 'openengineer-policy');

describe('command policy', () => {
  it('allows project validation commands and read-only git', () => {
    expect(classifyCommand('npm test', cwd).action).toBe('allow');
    expect(classifyCommand('npm run lint', cwd).action).toBe('allow');
    expect(classifyCommand('pnpm run typecheck', cwd).action).toBe('allow');
    expect(classifyCommand('node --check src/session.js', cwd).action).toBe('allow');
    expect(classifyCommand('git diff --stat', cwd).action).toBe('allow');
    expect(classifyCommand('npx vitest run', cwd).action).toBe('allow');
  });

  it('requires approval for network and destructive commands', () => {
    const curl = classifyCommand('curl https://example.com', cwd);
    expect(curl.action).toBe('approve');
    if (curl.action === 'approve') expect(curl.network).toBe(true);
    expect(classifyCommand('npm install left-pad', cwd).action).toBe('approve');
    expect(classifyCommand('rm -rf src/old.js', cwd).action).toBe('approve');
    expect(classifyCommand('git push origin HEAD', cwd).action).toBe('approve');
  });

  it('denies shell syntax, privilege escalation, and paths outside the worktree', () => {
    expect(classifyCommand('npm test && curl https://evil.test', cwd).action).toBe('deny');
    expect(classifyCommand('sudo npm test', cwd).action).toBe('deny');
    expect(classifyCommand('git push --force origin main', cwd).action).toBe('deny');
    expect(classifyCommand('node --check ../../.ssh/id_rsa', cwd).action).toBe('deny');
    expect(classifyCommand('rm -rf /', cwd).action).toBe('deny');
    expect(classifyCommand('python exploit.py', cwd).action).toBe('deny');
  });
});
