#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { getPrismaClient, PrismaTaskStore } from '@openengineer/db';
import {
  assertGitRepo,
  assertRepoAllowed,
  cancelTask,
  collectDiff,
  createModel,
  detectProject,
  inspectGit,
  loadConfig,
  loadDotEnv,
  recoverInterruptedTasks,
  runTask,
  taskTitle,
  type EngineConfig,
  type TaskRecord,
} from '@openengineer/core';
import { OpenEngineerError, isTerminalStatus, resolveBudget } from '@openengineer/shared';

const program = new Command();
program
  .name('openengineer')
  .description('Run a software task in an isolated git worktree and verify the result.')
  .version('0.1.0');

program
  .command('run')
  .argument('<instruction>', 'Task instruction')
  .requiredOption('--repo <path>', 'Path to a local git repository')
  .option('--sandbox <mode>', 'docker or process')
  .option('--max-repairs <n>', 'Maximum repair attempts', (value) => Number(value))
  .option('--max-tool-calls <n>', 'Maximum tool calls', (value) => Number(value))
  .option('--timeout-ms <n>', 'Maximum task duration in milliseconds', (value) => Number(value))
  .option('--command-timeout-ms <n>', 'Maximum command duration in milliseconds', (value) => Number(value))
  .option('--provider <name>', 'openai, anthropic, or scripted')
  .option('--script <file>', 'Scripted program JSON. Required when --provider scripted is selected.')
  .option('--json', 'Print the final report as JSON')
  .action(async (instruction: string, options) => {
    const { store, config } = await bootstrap();
    const overridden = applyOverrides(config, options);
    const root = assertRepoAllowed(overridden, await realpath(options.repo));
    await assertGitRepo(root);
    let repository = await store.getRepositoryByPath(root);
    if (!repository) {
      const detected = await detectProject(root);
      const gitStatus = await inspectGit(root);
      const created = await store.createRepository({ name: path.basename(root), rootPath: root });
      repository = await store.updateRepository(created.id, {
        defaultBranch: gitStatus.branch,
        headCommit: gitStatus.headCommit,
        language: detected.languages[0] ?? null,
        packageManager: detected.packageManager,
        testFramework: detected.testFramework,
      });
    }
    const task = await store.createTask({
      repositoryId: repository.id,
      instruction,
      title: taskTitle(instruction),
      budget: resolveBudget({
        maxRepairAttempts: options.maxRepairs,
        maxToolCalls: options.maxToolCalls,
        maxDurationMs: options.timeoutMs,
        commandTimeoutMs: options.commandTimeoutMs,
      }),
    });
    process.stdout.write(`task ${task.id} queued\n`);
    await runTask(
      {
        store,
        model: createModel(overridden),
        config: overridden,
        onStep(step) {
          if (options.json) return;
          const suffix = step.error ? ` — ${step.error}` : '';
          process.stdout.write(`[${step.phase}] ${step.kind} ${step.name} (${step.status})${suffix}\n`);
        },
      },
      task.id,
    );
    const finished = await store.getTask(task.id);
    if (!finished) throw new OpenEngineerError('Task disappeared', 'not_found');
    if (options.json) process.stdout.write(`${JSON.stringify(reportBody(finished), null, 2)}\n`);
    else process.stdout.write(`\n${formatReport(finished)}\n`);
    await shutdown(exitCode(finished.status));
  });

program
  .command('status')
  .argument('<taskId>')
  .option('--json')
  .action(async (taskId: string, options: { json?: boolean }) => {
    const { store } = await bootstrap();
    const task = await must(store, taskId);
    if (options.json) process.stdout.write(`${JSON.stringify(present(task), null, 2)}\n`);
    else {
      process.stdout.write(`${task.status}  ${task.title}\n`);
      if (task.error) process.stdout.write(`${task.errorCode ?? 'error'}: ${task.error}\n`);
      if (task.branch) process.stdout.write(`branch ${task.branch} @ ${task.baseCommit}\n`);
    }
    await shutdown(0);
  });

program
  .command('cancel')
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const { store } = await bootstrap();
    const task = await cancelTask(store, taskId);
    process.stdout.write(`${task.status} ${task.id}\n`);
    await shutdown(0);
  });

program
  .command('diff')
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const { store } = await bootstrap();
    const task = await must(store, taskId);
    if (!task.worktreePath || !task.baseCommit) {
      process.stdout.write('No worktree diff is available for this task.\n');
      await shutdown(0);
      return;
    }
    const diff = await collectDiff(task.worktreePath, task.baseCommit);
    process.stdout.write(`${diff.filesChanged} files, +${diff.insertions} -${diff.deletions}\n`);
    for (const file of diff.files) process.stdout.write(`\n${file.patch}`);
    await shutdown(0);
  });

program
  .command('report')
  .argument('<taskId>')
  .option('--json')
  .action(async (taskId: string, options: { json?: boolean }) => {
    const { store } = await bootstrap();
    const task = await must(store, taskId);
    process.stdout.write(options.json ? `${JSON.stringify(reportBody(task), null, 2)}\n` : `${formatReport(task)}\n`);
    await shutdown(0);
  });

program
  .command('repos')
  .argument('<action>', 'add or list')
  .argument('[repoPath]')
  .action(async (action: string, repoPath: string | undefined) => {
    const { store, config } = await bootstrap();
    if (action === 'list') {
      const repos = await store.listRepositories();
      if (repos.length === 0) process.stdout.write('No repositories.\n');
      for (const repo of repos) {
        process.stdout.write(`${repo.id}  ${repo.name}  ${repo.rootPath}  ${repo.packageManager ?? 'unknown'}\n`);
      }
      await shutdown(0);
      return;
    }
    if (action !== 'add' || !repoPath) {
      throw new OpenEngineerError('Usage: openengineer repos add <path> | openengineer repos list', 'validation');
    }
    const root = assertRepoAllowed(config, await realpath(repoPath));
    await assertGitRepo(root);
    const existing = await store.getRepositoryByPath(root);
    if (existing) {
      process.stdout.write(`${existing.id}  ${existing.rootPath}\n`);
      await shutdown(0);
      return;
    }
    const created = await store.createRepository({ name: path.basename(root), rootPath: root });
    process.stdout.write(`${created.id}  ${created.rootPath}\n`);
    await shutdown(0);
  });

program
  .command('serve')
  .option('--host <host>', 'Bind address', process.env.OPENENGINEER_HOST ?? '127.0.0.1')
  .option('--port <port>', 'Port', process.env.OPENENGINEER_PORT ?? '3001')
  .action((options: { host: string; port: string }) => {
    const env = { ...process.env, OPENENGINEER_HOST: options.host, OPENENGINEER_PORT: options.port };
    const built = path.resolve('dist/api.js');
    const child = existsSync(built)
      ? spawn(process.execPath, [built], { stdio: 'inherit', env })
      : spawn(process.execPath, ['--import', 'tsx', path.resolve('packages/api/src/main.ts')], { stdio: 'inherit', env });
    child.on('exit', (code) => process.exit(code ?? 1));
  });

program.parseAsync(process.argv).catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  await shutdown(1);
});

async function bootstrap() {
  await loadDotEnv(process.env.OPENENGINEER_ENV_FILE ?? '.env');
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new OpenEngineerError('DATABASE_URL is required. See .env.example.', 'validation');
  }
  process.env.DATABASE_URL = config.databaseUrl;
  const store = new PrismaTaskStore(getPrismaClient());
  await recoverInterruptedTasks(store);
  return { store, config };
}

function applyOverrides(config: EngineConfig, options: {
  sandbox?: string;
  provider?: string;
  script?: string;
}): EngineConfig {
  const next = { ...config };
  if (options.sandbox) {
    if (options.sandbox !== 'docker' && options.sandbox !== 'process') {
      throw new OpenEngineerError('--sandbox must be docker or process', 'validation');
    }
    next.sandboxMode = options.sandbox;
  }
  if (options.provider) {
    if (options.provider !== 'openai' && options.provider !== 'anthropic' && options.provider !== 'scripted') {
      throw new OpenEngineerError('--provider must be openai, anthropic, or scripted', 'validation');
    }
    next.provider = options.provider;
  }
  if (options.script) next.scriptedFile = options.script;
  return next;
}

async function must(store: PrismaTaskStore, taskId: string): Promise<TaskRecord> {
  const task = await store.getTask(taskId);
  if (!task) throw new OpenEngineerError('Task not found', 'not_found');
  return task;
}

function present(task: TaskRecord) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    error: task.error,
    errorCode: task.errorCode,
    branch: task.branch,
    baseCommit: task.baseCommit,
    worktreePath: task.worktreePath,
    usage: task.usage,
    verification: task.verification?.overall ?? null,
  };
}

function reportBody(task: TaskRecord) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    error: task.error,
    errorCode: task.errorCode,
    branch: task.branch,
    baseCommit: task.baseCommit,
    worktreePath: task.worktreePath,
    plan: task.plan,
    verification: task.verification,
    usage: task.usage,
  };
}

function formatReport(task: TaskRecord): string {
  const lines = [
    `Status: ${task.status}`,
    `Verification: ${task.verification?.overall ?? 'not run'}`,
    `Sandbox: ${task.sandboxMode ?? 'unknown'}`,
  ];
  if (task.error) lines.push(`Error: ${task.errorCode ?? 'error'}: ${task.error}`);
  if (task.branch) lines.push(`Branch: ${task.branch}`);
  if (task.baseCommit) lines.push(`Base: ${task.baseCommit}`);
  if (task.worktreePath) lines.push(`Worktree: ${task.worktreePath}`);
  for (const check of task.verification?.checks ?? []) {
    lines.push(`- ${check.name}: ${check.status}${check.command ? ` (${check.command})` : ''}`);
  }
  if (task.verification?.sandbox.warning) lines.push(task.verification.sandbox.warning);
  if (task.usage) {
    lines.push(
      `Tokens: ${task.usage.inputTokens} in / ${task.usage.outputTokens} out (${task.usage.tokenAccounting})`,
    );
    lines.push(`Estimated cost USD: ${task.usage.estimatedCostUsd === null ? 'unavailable' : task.usage.estimatedCostUsd}`);
    lines.push(`Duration: ${task.usage.durationMs}ms`);
    lines.push(`Repair attempts: ${task.usage.repairAttempts}`);
  }
  if (!isTerminalStatus(task.status)) lines.push('The task is not finished.');
  return lines.join('\n');
}

function exitCode(status: TaskRecord['status']): number {
  if (status === 'completed') return 0;
  if (status === 'cancelled') return 3;
  if (status === 'awaiting_approval') return 4;
  return 2;
}

async function shutdown(code: number): Promise<void> {
  await getPrismaClient().$disconnect().catch(() => undefined);
  process.exit(code);
}
