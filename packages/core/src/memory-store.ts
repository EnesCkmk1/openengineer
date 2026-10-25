import { randomUUID } from 'node:crypto';
import { OpenEngineerError, assertTransition, isRunningStatus, resolveBudget } from '@openengineer/shared';
import type {
  AgentStepRecord,
  ApprovalRecord,
  RepositoryPatch,
  RepositoryRecord,
  TaskPatch,
  TaskRecord,
  TaskStore,
} from './store.js';

export class MemoryTaskStore implements TaskStore {
  private readonly repositories = new Map<string, RepositoryRecord>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly steps = new Map<string, AgentStepRecord[]>();
  private readonly approvals = new Map<string, ApprovalRecord>();

  async createRepository(input: { name: string; rootPath: string }): Promise<RepositoryRecord> {
    const now = new Date();
    const record: RepositoryRecord = {
      id: randomUUID(),
      name: input.name,
      rootPath: input.rootPath,
      defaultBranch: null,
      headCommit: null,
      language: null,
      packageManager: null,
      testFramework: null,
      detection: null,
      createdAt: now,
      updatedAt: now,
    };
    this.repositories.set(record.id, record);
    return clone(record);
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    return [...this.repositories.values()].map(clone).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getRepository(id: string): Promise<RepositoryRecord | null> {
    const record = this.repositories.get(id);
    return record ? clone(record) : null;
  }

  async getRepositoryByPath(rootPath: string): Promise<RepositoryRecord | null> {
    const record = [...this.repositories.values()].find((item) => item.rootPath === rootPath);
    return record ? clone(record) : null;
  }

  async updateRepository(id: string, patch: RepositoryPatch): Promise<RepositoryRecord> {
    const current = this.mustRepo(id);
    const next = { ...current, ...patch, updatedAt: new Date() };
    this.repositories.set(id, next);
    return clone(next);
  }

  async createTask(input: {
    repositoryId: string;
    instruction: string;
    title: string;
    budget: TaskRecord['budget'];
  }): Promise<TaskRecord> {
    const repository = this.mustRepo(input.repositoryId);
    const now = new Date();
    const record: TaskRecord = {
      id: randomUUID(),
      repositoryId: repository.id,
      instruction: input.instruction,
      title: input.title,
      status: 'queued',
      baseCommit: null,
      branch: null,
      worktreePath: null,
      plan: null,
      checkpoint: null,
      verification: null,
      usage: null,
      budget: resolveBudget(input.budget),
      error: null,
      errorCode: null,
      cancelRequested: false,
      runnerId: null,
      heartbeatAt: null,
      sandboxMode: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      repository: clone(repository),
    };
    this.tasks.set(record.id, record);
    return clone(record);
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const record = this.tasks.get(id);
    if (!record) return null;
    return clone(this.withRepository(record));
  }

  async listTasks(repositoryId?: string): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .filter((task) => !repositoryId || task.repositoryId === repositoryId)
      .map((task) => clone(this.withRepository(task)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async updateTask(id: string, patch: TaskPatch): Promise<TaskRecord> {
    const current = this.mustTask(id);
    if (patch.status) assertTransition(current.status, patch.status);
    const next: TaskRecord = { ...current, ...patch, updatedAt: new Date() };
    this.tasks.set(id, next);
    return clone(this.withRepository(next));
  }

  async claim(id: string, runnerId: string, staleMs: number): Promise<void> {
    const task = this.mustTask(id);
    if (
      task.runnerId &&
      task.runnerId !== runnerId &&
      task.heartbeatAt &&
      Date.now() - task.heartbeatAt.getTime() < staleMs
    ) {
      throw new OpenEngineerError('Task is already running', 'already_running');
    }
    task.runnerId = runnerId;
    task.heartbeatAt = new Date();
    task.startedAt ??= new Date();
    task.updatedAt = new Date();
  }

  async heartbeat(id: string, runnerId: string): Promise<void> {
    const task = this.mustTask(id);
    if (task.runnerId !== runnerId) return;
    task.heartbeatAt = new Date();
  }

  async release(id: string, runnerId: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.runnerId !== runnerId) return;
    task.runnerId = null;
    task.updatedAt = new Date();
  }

  async listStale(cutoff: Date): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          isRunningStatus(task.status) &&
          (!task.heartbeatAt || task.heartbeatAt.getTime() < cutoff.getTime()),
      )
      .map((task) => clone(this.withRepository(task)));
  }

  async isCancelRequested(id: string): Promise<boolean> {
    return this.mustTask(id).cancelRequested;
  }

  async appendStep(input: {
    taskId: string;
    phase: string;
    kind: string;
    name: string;
    status: string;
    input?: unknown;
    output?: unknown;
    error?: string | null;
    startedAt?: Date;
    finishedAt?: Date | null;
    durationMs?: number | null;
  }): Promise<AgentStepRecord> {
    this.mustTask(input.taskId);
    const list = this.steps.get(input.taskId) ?? [];
    const sequence = list.reduce((max, step) => Math.max(max, step.sequence), 0) + 1;
    const now = new Date();
    const record: AgentStepRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      sequence,
      phase: input.phase,
      kind: input.kind,
      name: input.name,
      status: input.status,
      input: input.input ?? null,
      output: input.output ?? null,
      error: input.error ?? null,
      startedAt: input.startedAt ?? now,
      finishedAt: input.finishedAt ?? now,
      durationMs: input.durationMs ?? null,
    };
    list.push(record);
    this.steps.set(input.taskId, list);
    return clone(record);
  }

  async listSteps(taskId: string): Promise<AgentStepRecord[]> {
    return (this.steps.get(taskId) ?? []).map(clone);
  }

  async createApproval(input: {
    taskId: string;
    kind: string;
    prompt: string;
    payload: unknown;
  }): Promise<ApprovalRecord> {
    this.mustTask(input.taskId);
    const record: ApprovalRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      kind: input.kind,
      prompt: input.prompt,
      payload: input.payload,
      status: 'pending',
      resolution: null,
      createdAt: new Date(),
      resolvedAt: null,
    };
    this.approvals.set(record.id, record);
    return clone(record);
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    const record = this.approvals.get(id);
    return record ? clone(record) : null;
  }

  async listApprovals(taskId: string): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()].filter((approval) => approval.taskId === taskId).map(clone);
  }

  async resolveApproval(id: string, resolution: ApprovalRecord['resolution'] & object): Promise<ApprovalRecord> {
    const record = this.approvals.get(id);
    if (!record) throw new OpenEngineerError('Approval not found', 'not_found');
    if (record.status !== 'pending') {
      throw new OpenEngineerError('Approval is already resolved', 'invalid_transition');
    }
    if (!resolution) throw new OpenEngineerError('Approval resolution is required', 'validation');
    record.status = resolution.decision === 'approved' ? 'approved' : 'denied';
    record.resolution = resolution;
    record.resolvedAt = new Date();
    return clone(record);
  }

  async closeApprovalStep(taskId: string, approvalId: string, status: 'approved' | 'denied' | 'cancelled'): Promise<void> {
    const step = (this.steps.get(taskId) ?? []).find(
      (item) => item.kind === 'approval' && item.status === 'pending' && approvalIdOf(item.output) === approvalId,
    );
    if (!step) return;
    step.status = status;
    step.finishedAt = new Date();
  }

  async cancelOpenApprovals(taskId: string): Promise<void> {
    for (const approval of this.approvals.values()) {
      if (approval.taskId !== taskId || approval.status !== 'pending') continue;
      approval.status = 'cancelled';
      approval.resolvedAt = new Date();
      await this.closeApprovalStep(taskId, approval.id, 'cancelled');
    }
  }

  private mustRepo(id: string): RepositoryRecord {
    const record = this.repositories.get(id);
    if (!record) throw new OpenEngineerError('Repository not found', 'not_found');
    return record;
  }

  private mustTask(id: string): TaskRecord {
    const record = this.tasks.get(id);
    if (!record) throw new OpenEngineerError('Task not found', 'not_found');
    return record;
  }

  private withRepository(task: TaskRecord): TaskRecord {
    const repository = this.mustRepo(task.repositoryId);
    return { ...task, repository: clone(repository) };
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function approvalIdOf(output: unknown): string | null {
  if (!output || typeof output !== 'object' || !('approvalId' in output)) return null;
  const id = (output as { approvalId?: unknown }).approvalId;
  return typeof id === 'string' ? id : null;
}
