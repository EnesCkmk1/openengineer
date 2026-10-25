import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  assertGitRepo,
  assertRepoAllowed,
  cancelTask,
  collectDiff,
  createModel,
  detectProject,
  inspectGit,
  runTask,
  taskTitle,
  type EngineConfig,
  type Logger,
  type ModelAdapter,
  type TaskStore,
} from '@openengineer/core';
import {
  BudgetSchema,
  OpenEngineerError,
  errorCode,
  errorMessage,
  isOpenEngineerError,
  isTerminalStatus,
  resolveBudget,
} from '@openengineer/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

export interface ServerOptions {
  store: TaskStore;
  config: EngineConfig;
  modelFactory?: () => ModelAdapter;
  logger?: boolean | Logger;
  staticDir?: string | null;
  approvalPolicy?: 'ask' | 'deny';
}

const inflight = new Set<Promise<void>>();

export function pendingRuns(): Promise<void> {
  return Promise.all([...inflight]).then(() => undefined);
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: 'info' },
  });
  const store = options.store;
  const config = options.config;
  const modelFactory = options.modelFactory ?? (() => createModel(config));

  await app.register(cors, { origin: true });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: { code: 'validation', message: error.issues.map((issue) => issue.message).join('; ') },
      });
    }
    if (isOpenEngineerError(error)) {
      const status =
        error.code === 'not_found' ? 404 : error.code === 'invalid_transition' || error.code === 'already_running' ? 409 : 400;
      return reply.status(status).send({ error: { code: error.code, message: error.message } });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });

  app.get('/api/health', async () => ({
    ok: true,
    sandbox: config.sandboxMode,
    processSandbox: config.allowProcessSandbox,
    provider: config.provider,
  }));

  app.get('/api/repositories', async () => ({ repositories: await store.listRepositories() }));

  app.post('/api/repositories', async (request, reply) => {
    const body = z.object({ path: z.string().min(1) }).parse(request.body);
    let resolved: string;
    try {
      resolved = assertRepoAllowed(config, await realpath(body.path));
      await access(resolved);
    } catch (error) {
      if (isOpenEngineerError(error)) throw error;
      throw new OpenEngineerError(`Cannot read repository path: ${body.path}`, 'validation');
    }
    await assertGitRepo(resolved);
    const existing = await store.getRepositoryByPath(resolved);
    const detected = await detectProject(resolved);
    const gitStatus = await inspectGit(resolved);
    const patch = {
      defaultBranch: gitStatus.branch,
      headCommit: gitStatus.headCommit,
      language: detected.languages[0] ?? null,
      packageManager: detected.packageManager,
      testFramework: detected.testFramework,
      detection: {
        ...detected,
        hasUncommittedChanges: gitStatus.dirty,
        headCommit: gitStatus.headCommit,
        branch: gitStatus.branch,
        statusPorcelain: gitStatus.porcelain,
      },
    };
    if (existing) {
      const updated = await store.updateRepository(existing.id, patch);
      return reply.send(updated);
    }
    const created = await store.createRepository({ name: path.basename(resolved), rootPath: resolved });
    const updated = await store.updateRepository(created.id, patch);
    return reply.status(201).send(updated);
  });

  app.get('/api/repositories/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const repository = await store.getRepository(id);
    if (!repository) throw new OpenEngineerError('Repository not found', 'not_found');
    return repository;
  });

  app.get('/api/tasks', async (request) => {
    const query = z.object({ repositoryId: z.string().uuid().optional() }).parse(request.query);
    const tasks = await store.listTasks(query.repositoryId);
    return { tasks: tasks.map(presentTask) };
  });

  app.post('/api/tasks', async (request, reply) => {
    const body = z
      .object({
        repositoryId: z.string().uuid(),
        instruction: z.string().min(1).max(20_000),
        budget: BudgetSchema.partial().optional(),
      })
      .parse(request.body);
    const repository = await store.getRepository(body.repositoryId);
    if (!repository) throw new OpenEngineerError('Repository not found', 'not_found');
    const task = await store.createTask({
      repositoryId: repository.id,
      instruction: body.instruction,
      title: taskTitle(body.instruction),
      budget: resolveBudget(body.budget),
    });
    startRun(app, options, task.id, modelFactory);
    return reply.status(201).send(presentTask(task));
  });

  app.get('/api/tasks/:id', async (request) => {
    const task = await mustTask(store, request.params);
    const approvals = await store.listApprovals(task.id);
    return { task: presentTask(task), approvals };
  });

  app.get('/api/tasks/:id/steps', async (request) => {
    const task = await mustTask(store, request.params);
    return { steps: await store.listSteps(task.id) };
  });

  app.get('/api/tasks/:id/diff', async (request) => {
    const task = await mustTask(store, request.params);
    if (!task.worktreePath || !task.baseCommit) {
      return { baseCommit: task.baseCommit, branch: task.branch, filesChanged: 0, insertions: 0, deletions: 0, files: [] };
    }
    const diff = await collectDiff(task.worktreePath, task.baseCommit);
    return { baseCommit: task.baseCommit, branch: task.branch, worktreePath: task.worktreePath, ...diff };
  });

  app.get('/api/tasks/:id/report', async (request) => {
    const task = await mustTask(store, request.params);
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      error: task.error,
      errorCode: task.errorCode,
      baseCommit: task.baseCommit,
      branch: task.branch,
      worktreePath: task.worktreePath,
      plan: task.plan,
      verification: task.verification,
      usage: task.usage,
      sandboxMode: task.sandboxMode,
    };
  });

  app.post('/api/tasks/:id/cancel', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return { task: presentTask(await cancelTask(store, id)) };
  });

  app.post('/api/tasks/:id/approvals/:approvalId', async (request) => {
    const params = z.object({ id: z.string().uuid(), approvalId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        decision: z.enum(['approve', 'deny']),
        note: z.string().optional(),
        answers: z.array(z.string()).optional(),
      })
      .parse(request.body);
    const task = await store.getTask(params.id);
    if (!task) throw new OpenEngineerError('Task not found', 'not_found');
    if (isTerminalStatus(task.status)) {
      throw new OpenEngineerError(`Task is already ${task.status}`, 'invalid_transition');
    }
    const approval = await store.getApproval(params.approvalId);
    if (!approval || approval.taskId !== task.id) throw new OpenEngineerError('Approval not found', 'not_found');
    await store.resolveApproval(approval.id, {
      decision: body.decision === 'approve' ? 'approved' : 'denied',
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.answers !== undefined ? { answers: body.answers } : {}),
    });
    startRun(app, options, task.id, modelFactory);
    const updated = await store.getTask(task.id);
    return { task: presentTask(updated!), approvals: await store.listApprovals(task.id) };
  });

  app.get('/api/tasks/:id/events', async (request, reply) => {
    const task = await mustTask(store, request.params);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });
    const send = async () => {
      const current = await store.getTask(task.id);
      if (!current) return true;
      const payload = {
        task: presentTask(current),
        steps: await store.listSteps(task.id),
        approvals: await store.listApprovals(task.id),
      };
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      return isTerminalStatus(current.status);
    };
    if (await send()) {
      reply.raw.end();
      return;
    }
    const timer = setInterval(() => {
      if (closed) {
        clearInterval(timer);
        return;
      }
      void send()
        .then((done) => {
          if (done) {
            clearInterval(timer);
            reply.raw.end();
          }
        })
        .catch((error) => {
          request.log.error({ err: errorMessage(error) }, 'event stream failed');
          clearInterval(timer);
          reply.raw.end();
        });
    }, 1000);
    timer.unref?.();
  });

  if (options.staticDir) {
    await app.register(fastifyStatic, { root: options.staticDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

function startRun(
  app: FastifyInstance,
  options: ServerOptions,
  taskId: string,
  modelFactory: () => ModelAdapter,
): void {
  const promise = (async () => {
    let model: ModelAdapter;
    try {
      model = modelFactory();
    } catch (error) {
      const task = await options.store.getTask(taskId);
      if (task && !isTerminalStatus(task.status)) {
        await options.store.updateTask(taskId, {
          status: 'failed',
          error: errorMessage(error),
          errorCode: errorCode(error),
          finishedAt: new Date(),
        });
      }
      return;
    }
    await runTask(
      {
        store: options.store,
        model,
        config: options.config,
        approvalPolicy: options.approvalPolicy ?? 'ask',
        logger: fastifyLogger(app),
      },
      taskId,
    );
  })().catch((error) => {
    app.log.error({ err: errorMessage(error), taskId }, 'task runner crashed');
  });
  inflight.add(promise);
  void promise.finally(() => inflight.delete(promise));
}

function fastifyLogger(app: FastifyInstance): Logger {
  return {
    info(obj, msg) {
      app.log.info(obj, msg);
    },
    warn(obj, msg) {
      app.log.warn(obj, msg);
    },
    error(obj, msg) {
      app.log.error(obj, msg);
    },
    child() {
      return fastifyLogger(app);
    },
  };
}

async function mustTask(store: TaskStore, params: unknown) {
  const { id } = z.object({ id: z.string().uuid() }).parse(params);
  const task = await store.getTask(id);
  if (!task) throw new OpenEngineerError('Task not found', 'not_found');
  return task;
}

function presentTask(task: Awaited<ReturnType<TaskStore['getTask']>> & object) {
  return {
    id: task.id,
    repositoryId: task.repositoryId,
    instruction: task.instruction,
    title: task.title,
    status: task.status,
    baseCommit: task.baseCommit,
    branch: task.branch,
    worktreePath: task.worktreePath,
    plan: task.plan,
    verification: task.verification,
    usage: task.usage,
    budget: task.budget,
    error: task.error,
    errorCode: task.errorCode,
    cancelRequested: task.cancelRequested,
    sandboxMode: task.sandboxMode,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    pendingApproval: task.checkpoint?.pendingToolCall
      ? {
          phase: task.checkpoint.phase,
          tool: task.checkpoint.pendingToolCall.name,
          approvalId: task.checkpoint.pendingToolCall.approvalId,
        }
      : null,
    repository: {
      id: task.repository.id,
      name: task.repository.name,
      rootPath: task.repository.rootPath,
      language: task.repository.language,
      packageManager: task.repository.packageManager,
      testFramework: task.repository.testFramework,
    },
  };
}
