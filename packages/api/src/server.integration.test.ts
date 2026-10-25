import { cp, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedModel, git, loadConfig, type EngineConfig, type ScriptedProgram } from '@openengineer/core';
import { PrismaTaskStore, getPrismaClient } from '@openengineer/db';
import { buildServer, pendingRuns } from './server.js';

process.env.DATABASE_URL = 'postgresql://openengineer:openengineer@127.0.0.1:5432/openengineer_test';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/session-app');

const program: ScriptedProgram = {
  plan: {
    objective: 'Reject expired sessions',
    acceptanceCriteria: ['Expired sessions are rejected'],
    relevantFiles: ['src/session.js'],
    dependencies: [],
    steps: [{ id: 'fix', description: 'Fix the comparison' }],
    validationCommands: ['npm test'],
    risks: [],
    assumptions: ['expiresAt is exclusive'],
    needsClarification: false,
    clarificationQuestions: [],
  },
  implement: [
    {
      toolCalls: [
        {
          name: 'edit_file',
          arguments: {
            path: 'src/session.js',
            oldString: 'return session.expiresAt <= now;',
            newString: 'return session.expiresAt > now;',
          },
        },
      ],
    },
    { toolCalls: [{ name: 'finish', arguments: { summary: 'Expired sessions are rejected.' } }] },
  ],
  review: { summary: 'Supplementary.', concerns: [], confidence: 'low' },
};

describe('API', () => {
  const prisma = getPrismaClient();
  const store = new PrismaTaskStore(prisma);
  let config: EngineConfig;
  let worktrees = '';

  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Approval", "AgentStep", "Task", "Repository" CASCADE');
    worktrees = await mkdtemp(path.join(os.tmpdir(), 'oe-api-wt-'));
    config = {
      ...loadConfig({
        DATABASE_URL: process.env.DATABASE_URL,
        OPENENGINEER_SANDBOX: 'process',
        OPENENGINEER_ALLOW_PROCESS_SANDBOX: 'true',
        OPENENGINEER_MODEL_PROVIDER: 'scripted',
        OPENENGINEER_REPO_ROOTS: os.tmpdir(),
      }),
      worktreeRoot: worktrees,
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('runs a real task and serves the diff and report from PostgreSQL', async () => {
    const repo = await tempRepo();
    const app = await buildServer({
      store,
      config,
      logger: false,
      modelFactory: () => new ScriptedModel(program),
    });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, sandbox: 'process' });

    const denied = await app.inject({ method: 'POST', url: '/api/repositories', payload: { path: '/etc' } });
    expect(denied.statusCode).toBe(400);

    const created = await app.inject({ method: 'POST', url: '/api/repositories', payload: { path: repo } });
    expect(created.statusCode).toBe(201);
    const repository = created.json();
    expect(repository.packageManager).toBe('npm');
    expect(repository.testFramework).toBe('node:test');

    const taskResponse = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { repositoryId: repository.id, instruction: 'Fix the bug where expired sessions are accepted.' },
    });
    expect(taskResponse.statusCode).toBe(201);
    const taskId = taskResponse.json().id as string;
    await pendingRuns();
    const stored = await store.getTask(taskId);
    expect(stored?.status).toBe('completed');
    expect(stored?.verification?.overall).toBe('passed');

    const reloaded = new PrismaTaskStore(prisma);
    const afterRestart = await reloaded.getTask(taskId);
    expect(afterRestart?.status).toBe('completed');
    expect(afterRestart?.plan?.objective).toBe('Reject expired sessions');
    expect((await reloaded.listSteps(taskId)).length).toBeGreaterThan(3);

    const diff = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/diff` });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().files.map((file: { path: string }) => file.path)).toContain('src/session.js');
    const report = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/report` });
    expect(report.json().verification.overall).toBe('passed');
    expect(report.json().verification.checks.find((check: { id: string }) => check.id === 'test').status).toBe('passed');

    const cancel = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/cancel` });
    expect(cancel.statusCode).toBe(409);
    const missing = await app.inject({ method: 'GET', url: '/api/tasks/00000000-0000-0000-0000-000000000000' });
    expect(missing.statusCode).toBe(404);

    expect(await readFile(path.join(repo, 'src/session.js'), 'utf8')).toContain('<=');
    await app.close();
  });
});

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oe-api-repo-'));
  await cp(fixture, dir, { recursive: true });
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'dev@example.com']);
  await git(dir, ['config', 'user.name', 'Dev']);
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}
