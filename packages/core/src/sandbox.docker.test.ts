import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveBudget } from '@openengineer/shared';
import { loadConfig } from './config.js';
import { git } from './git.js';
import { silentLogger } from './log.js';
import { MemoryTaskStore } from './memory-store.js';
import { ScriptedModel, loadScriptedProgram } from './model.js';
import { runTask } from './runner.js';
import { createSandbox } from './sandbox.js';

const image = 'node:22-bookworm-slim';
const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/session-app');
const program = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../evals/fixtures/session-bugfix.json');

function dockerImageReady(): boolean {
  const info = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (info.status !== 0) return false;
  const inspect = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
  return inspect.status === 0;
}

const ready = dockerImageReady();

describe.skipIf(!ready)('docker sandbox', () => {
  it('keeps host secrets out, blocks the network, and confines the mount', async () => {
    process.env.OPENAI_API_KEY = 'supersecret-should-not-enter-container';
    const sandbox = await createSandbox({ mode: 'docker', allowProcessSandbox: false, dockerImage: image });
    expect(sandbox.mode).toBe('docker');
    expect(sandbox.secure).toBe(false);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oe-docker-'));
    await writeFile(path.join(dir, 'marker.txt'), 'workspace-marker');
    const hostSecret = path.join(os.tmpdir(), `oe-host-secret-${process.pid}`);
    await writeFile(hostSecret, 'host-only');

    const leaked = await sandbox.run({
      argv: ['node', '-e', 'process.stdout.write(process.env.OPENAI_API_KEY ?? "ABSENT")'],
      cwd: dir,
      timeoutMs: 20_000,
      network: false,
    });
    expect(leaked.exitCode).toBe(0);
    expect(leaked.stdout).toBe('ABSENT');

    const network = await sandbox.run({
      argv: [
        'node',
        '-e',
        'const net=require("net"); const s=net.connect(443,"1.1.1.1"); const done=(m)=>{process.stdout.write(m); process.exit(0)}; s.setTimeout(2000); s.on("connect",()=>done("OPEN")); s.on("timeout",()=>done("TIMEOUT")); s.on("error",(e)=>done("BLOCKED"));',
      ],
      cwd: dir,
      timeoutMs: 15_000,
      network: false,
    });
    expect(network.stdout).not.toBe('OPEN');
    expect(['BLOCKED', 'TIMEOUT']).toContain(network.stdout);

    const files = await sandbox.run({
      argv: [
        'node',
        '-e',
        `const fs=require("fs"); let root="WRITABLE"; try { fs.writeFileSync("/etc/oe-write","x") } catch { root="READONLY" } fs.writeFileSync("/workspace/probe.txt","ok"); process.stdout.write([root, fs.readFileSync("/workspace/probe.txt","utf8"), String(fs.existsSync(${JSON.stringify(hostSecret)}))].join(" "));`,
      ],
      cwd: dir,
      timeoutMs: 20_000,
      network: false,
    });
    expect(files.exitCode).toBe(0);
    expect(files.stdout).toBe('READONLY ok false');

    const timed = await sandbox.run({ argv: ['sleep', '30'], cwd: dir, timeoutMs: 500, network: false });
    expect(timed.timedOut).toBe(true);
    expect(timed.signal).toBe('SIGKILL');
  });

  it('refuses to run when the sandbox image has not been pulled', async () => {
    await expect(
      createSandbox({ mode: 'docker', allowProcessSandbox: false, dockerImage: 'openengineer-missing:no-such-tag' }),
    ).rejects.toMatchObject({ code: 'sandbox_unavailable' });
  });

  it('fixes the session fixture inside a container and leaves the checkout untouched', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'oe-docker-repo-'));
    const worktrees = await mkdtemp(path.join(os.tmpdir(), 'oe-docker-wt-'));
    await cp(fixture, repo, { recursive: true });
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 'dev@example.com']);
    await git(repo, ['config', 'user.name', 'Dev']);
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', 'init']);
    const store = new MemoryTaskStore();
    const repository = await store.createRepository({ name: 'session-app', rootPath: repo });
    const task = await store.createTask({
      repositoryId: repository.id,
      instruction: 'Fix the bug where expired sessions are accepted.',
      title: 'Fix session expiry',
      budget: resolveBudget({ maxDurationMs: 180_000, commandTimeoutMs: 60_000 }),
    });
    await runTask(
      {
        store,
        model: new ScriptedModel(loadScriptedProgram(program)),
        config: { ...loadConfig({ OPENENGINEER_SANDBOX: 'docker' }), dockerImage: image, worktreeRoot: worktrees },
        logger: silentLogger,
      },
      task.id,
    );
    const finished = await store.getTask(task.id);
    expect(finished?.status).toBe('completed');
    expect(finished?.sandboxMode).toBe('docker');
    expect(finished?.verification?.overall).toBe('passed');
    expect(finished?.verification?.checks.map((check) => [check.name, check.status])).toEqual([
      ['Tests', 'passed'],
      ['Lint', 'passed'],
      ['Diff inspection', 'passed'],
    ]);
    expect(await readFile(path.join(repo, 'src/session.js'), 'utf8')).toContain('expiresAt <= now');
    expect(await readFile(path.join(finished!.worktreePath!, 'src/session.js'), 'utf8')).toContain('expiresAt > now');
  });
});
