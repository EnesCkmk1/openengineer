import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from './generated/client/client.js';
import {
  ApprovalResolutionSchema,
  BudgetSchema,
  CheckpointSchema,
  OpenEngineerError,
  PlanSchema,
  RepoDetectionSchema,
  TaskStatusSchema,
  UsageSchema,
  VerificationReportSchema,
  assertTransition,
  isRunningStatus,
  type ApprovalResolution,
} from '@openengineer/shared';
import type {
  AgentStepRecord,
  ApprovalRecord,
  RepositoryPatch,
  RepositoryRecord,
  TaskPatch,
  TaskRecord,
  TaskStore,
} from '@openengineer/core';

type RepositoryRow = Prisma.RepositoryGetPayload<object>;
type TaskRow = Prisma.TaskGetPayload<{ include: { repository: true } }>;

export class PrismaTaskStore implements TaskStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createRepository(input: { name: string; rootPath: string }): Promise<RepositoryRecord> {
    const row = await this.prisma.repository.create({
      data: { id: randomUUID(), name: input.name, rootPath: input.rootPath },
    });
    return mapRepository(row);
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    const rows = await this.prisma.repository.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(mapRepository);
  }

  async getRepository(id: string): Promise<RepositoryRecord | null> {
    const row = await this.prisma.repository.findUnique({ where: { id } });
    return row ? mapRepository(row) : null;
  }

  async getRepositoryByPath(rootPath: string): Promise<RepositoryRecord | null> {
    const row = await this.prisma.repository.findUnique({ where: { rootPath } });
    return row ? mapRepository(row) : null;
  }

  async updateRepository(id: string, patch: RepositoryPatch): Promise<RepositoryRecord> {
    const row = await this.prisma.repository.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.defaultBranch !== undefined ? { defaultBranch: patch.defaultBranch } : {}),
        ...(patch.headCommit !== undefined ? { headCommit: patch.headCommit } : {}),
        ...(patch.language !== undefined ? { language: patch.language } : {}),
        ...(patch.packageManager !== undefined ? { packageManager: patch.packageManager } : {}),
        ...(patch.testFramework !== undefined ? { testFramework: patch.testFramework } : {}),
        ...(patch.detection !== undefined ? { detection: toJson(patch.detection) } : {}),
      },
    });
    return mapRepository(row);
  }

  async createTask(input: {
    repositoryId: string;
    instruction: string;
    title: string;
    budget: TaskRecord['budget'];
  }): Promise<TaskRecord> {
    const row = await this.prisma.task.create({
      data: {
        id: randomUUID(),
        repositoryId: input.repositoryId,
        instruction: input.instruction,
        title: input.title,
        status: 'queued',
        budget: input.budget as Prisma.InputJsonValue,
      },
      include: { repository: true },
    });
    return mapTask(row);
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const row = await this.prisma.task.findUnique({ where: { id }, include: { repository: true } });
    return row ? mapTask(row) : null;
  }

  async listTasks(repositoryId?: string): Promise<TaskRecord[]> {
    const rows = await this.prisma.task.findMany({
      where: repositoryId ? { repositoryId } : {},
      include: { repository: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(mapTask);
  }

  async updateTask(id: string, patch: TaskPatch): Promise<TaskRecord> {
    const current = await this.prisma.task.findUnique({ where: { id } });
    if (!current) throw new OpenEngineerError('Task not found', 'not_found');
    if (patch.status) assertTransition(TaskStatusSchema.parse(current.status), patch.status);
    const row = await this.prisma.task.update({
      where: { id },
      data: taskData(patch),
      include: { repository: true },
    });
    return mapTask(row);
  }

  async claim(id: string, runnerId: string, staleMs: number): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new OpenEngineerError('Task not found', 'not_found');
    if (
      task.runnerId &&
      task.runnerId !== runnerId &&
      task.heartbeatAt &&
      Date.now() - task.heartbeatAt.getTime() < staleMs
    ) {
      throw new OpenEngineerError('Task is already running', 'already_running');
    }
    await this.prisma.task.update({
      where: { id },
      data: { runnerId, heartbeatAt: new Date(), startedAt: task.startedAt ?? new Date() },
    });
  }

  async heartbeat(id: string, runnerId: string): Promise<void> {
    await this.prisma.task.updateMany({
      where: { id, runnerId },
      data: { heartbeatAt: new Date() },
    });
  }

  async release(id: string, runnerId: string): Promise<void> {
    await this.prisma.task.updateMany({
      where: { id, runnerId },
      data: { runnerId: null },
    });
  }

  async listStale(cutoff: Date): Promise<TaskRecord[]> {
    const rows = await this.prisma.task.findMany({
      where: {
        status: { in: ['inspecting', 'planning', 'implementing', 'testing', 'repairing', 'verifying'] },
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: cutoff } }],
      },
      include: { repository: true },
    });
    return rows.filter((row) => isRunningStatus(TaskStatusSchema.parse(row.status))).map(mapTask);
  }

  async isCancelRequested(id: string): Promise<boolean> {
    const task = await this.prisma.task.findUnique({ where: { id }, select: { cancelRequested: true } });
    if (!task) throw new OpenEngineerError('Task not found', 'not_found');
    return task.cancelRequested;
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
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: input.taskId }, select: { id: true } });
      if (!task) throw new OpenEngineerError('Task not found', 'not_found');
      const last = await tx.agentStep.findFirst({
        where: { taskId: input.taskId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const now = new Date();
      const row = await tx.agentStep.create({
        data: {
          id: randomUUID(),
          taskId: input.taskId,
          sequence: (last?.sequence ?? 0) + 1,
          phase: input.phase,
          kind: input.kind,
          name: input.name,
          status: input.status,
          input: input.input === undefined ? undefined : toJson(input.input),
          output: input.output === undefined ? undefined : toJson(input.output),
          error: input.error ?? null,
          startedAt: input.startedAt ?? now,
          finishedAt: input.finishedAt ?? now,
          durationMs: input.durationMs ?? null,
        },
      });
      return mapStep(row);
    });
  }

  async listSteps(taskId: string): Promise<AgentStepRecord[]> {
    const rows = await this.prisma.agentStep.findMany({ where: { taskId }, orderBy: { sequence: 'asc' } });
    return rows.map(mapStep);
  }

  async createApproval(input: {
    taskId: string;
    kind: string;
    prompt: string;
    payload: unknown;
  }): Promise<ApprovalRecord> {
    const row = await this.prisma.approval.create({
      data: {
        id: randomUUID(),
        taskId: input.taskId,
        kind: input.kind,
        prompt: input.prompt,
        payload: toRequiredJson(input.payload),
        status: 'pending',
      },
    });
    return mapApproval(row);
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    const row = await this.prisma.approval.findUnique({ where: { id } });
    return row ? mapApproval(row) : null;
  }

  async listApprovals(taskId: string): Promise<ApprovalRecord[]> {
    const rows = await this.prisma.approval.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
    return rows.map(mapApproval);
  }

  async resolveApproval(id: string, resolution: ApprovalResolution): Promise<ApprovalRecord> {
    const current = await this.prisma.approval.findUnique({ where: { id } });
    if (!current) throw new OpenEngineerError('Approval not found', 'not_found');
    if (current.status !== 'pending') throw new OpenEngineerError('Approval is already resolved', 'invalid_transition');
    const parsed = ApprovalResolutionSchema.parse(resolution);
    const row = await this.prisma.approval.update({
      where: { id },
      data: {
        status: parsed.decision === 'approved' ? 'approved' : 'denied',
        resolution: parsed as Prisma.InputJsonValue,
        resolvedAt: new Date(),
      },
    });
    return mapApproval(row);
  }

  async closeApprovalStep(taskId: string, approvalId: string, status: 'approved' | 'denied' | 'cancelled'): Promise<void> {
    const rows = await this.prisma.agentStep.findMany({
      where: { taskId, kind: 'approval', status: 'pending' },
    });
    const match = rows.find((row) => approvalIdOf(row.output) === approvalId);
    if (!match) return;
    await this.prisma.agentStep.update({
      where: { id: match.id },
      data: { status, finishedAt: new Date() },
    });
  }

  async cancelOpenApprovals(taskId: string): Promise<void> {
    const rows = await this.prisma.approval.findMany({ where: { taskId, status: 'pending' } });
    for (const row of rows) {
      await this.prisma.approval.update({
        where: { id: row.id },
        data: { status: 'cancelled', resolvedAt: new Date() },
      });
      await this.closeApprovalStep(taskId, row.id, 'cancelled');
    }
  }
}

function taskData(patch: TaskPatch): Prisma.TaskUpdateInput {
  const data: Prisma.TaskUpdateInput = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.baseCommit !== undefined) data.baseCommit = patch.baseCommit;
  if (patch.branch !== undefined) data.branch = patch.branch;
  if (patch.worktreePath !== undefined) data.worktreePath = patch.worktreePath;
  if (patch.plan !== undefined) data.plan = toJson(patch.plan);
  if (patch.checkpoint !== undefined) data.checkpoint = toJson(patch.checkpoint);
  if (patch.verification !== undefined) data.verification = toJson(patch.verification);
  if (patch.usage !== undefined) data.usage = toJson(patch.usage);
  if (patch.error !== undefined) data.error = patch.error;
  if (patch.errorCode !== undefined) data.errorCode = patch.errorCode;
  if (patch.cancelRequested !== undefined) data.cancelRequested = patch.cancelRequested;
  if (patch.runnerId !== undefined) data.runnerId = patch.runnerId;
  if (patch.heartbeatAt !== undefined) data.heartbeatAt = patch.heartbeatAt;
  if (patch.sandboxMode !== undefined) data.sandboxMode = patch.sandboxMode;
  if (patch.startedAt !== undefined) data.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) data.finishedAt = patch.finishedAt;
  return data;
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === null || value === undefined) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

function approvalIdOf(output: unknown): string | null {
  if (!output || typeof output !== 'object' || !('approvalId' in output)) return null;
  const id = (output as { approvalId?: unknown }).approvalId;
  return typeof id === 'string' ? id : null;
}

function toRequiredJson(value: unknown): Prisma.InputJsonValue {
  return (value ?? {}) as Prisma.InputJsonValue;
}

function mapRepository(row: RepositoryRow): RepositoryRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    defaultBranch: row.defaultBranch,
    headCommit: row.headCommit,
    language: row.language,
    packageManager: row.packageManager,
    testFramework: row.testFramework,
    detection: parseNullable(RepoDetectionSchema, row.detection, 'repository detection'),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    instruction: row.instruction,
    title: row.title,
    status: TaskStatusSchema.parse(row.status),
    baseCommit: row.baseCommit,
    branch: row.branch,
    worktreePath: row.worktreePath,
    plan: parseNullable(PlanSchema, row.plan, 'plan'),
    checkpoint: parseNullable(CheckpointSchema, row.checkpoint, 'checkpoint'),
    verification: parseNullable(VerificationReportSchema, row.verification, 'verification'),
    usage: parseNullable(UsageSchema, row.usage, 'usage'),
    budget: BudgetSchema.parse(row.budget),
    error: row.error,
    errorCode: row.errorCode,
    cancelRequested: row.cancelRequested,
    runnerId: row.runnerId,
    heartbeatAt: row.heartbeatAt,
    sandboxMode: row.sandboxMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    repository: mapRepository(row.repository),
  };
}

function mapStep(row: Prisma.AgentStepGetPayload<object>): AgentStepRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    sequence: row.sequence,
    phase: row.phase,
    kind: row.kind,
    name: row.name,
    status: row.status,
    input: row.input ?? null,
    output: row.output ?? null,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
  };
}

function mapApproval(row: Prisma.ApprovalGetPayload<object>): ApprovalRecord {
  const status =
    row.status === 'approved' || row.status === 'denied' || row.status === 'pending' || row.status === 'cancelled'
      ? row.status
      : 'pending';
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    prompt: row.prompt,
    payload: row.payload,
    status,
    resolution: parseNullable(ApprovalResolutionSchema, row.resolution, 'approval resolution'),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

function parseNullable<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, value: unknown, label: string): T | null {
  if (value === null || value === undefined) return null;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new OpenEngineerError(`Stored ${label} failed validation: ${parsed.error.message}`, 'validation');
  }
  return parsed.data;
}
