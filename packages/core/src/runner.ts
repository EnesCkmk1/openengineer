import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  OpenEngineerError,
  PlanSchema,
  emptyUsage,
  errorCode,
  errorMessage,
  isOpenEngineerError,
  isRunningStatus,
  isTerminalStatus,
  type CheckResult,
  type Checkpoint,
  type ModelMessage,
  type Plan,
  type RepoDetection,
  type TaskStatus,
  type Usage,
  type VerificationReport,
} from '@openengineer/shared';
import { loadConfig, type EngineConfig } from './config.js';
import { detectProject } from './detect.js';
import { editFile, listFiles, readTextFile, searchText, writeTextFile } from './fsops.js';
import { collectDiff, commitWorktree, createTaskWorktree, inspectGit, type DiffSummary } from './git.js';
import { silentLogger, type Logger } from './log.js';
import { estimateCostUsd, type ModelAdapter, type ModelResponse, type ToolCall } from './model.js';
import { IMPLEMENT_SYSTEM, IMPLEMENT_TOOLS, PLAN_SYSTEM, PLAN_TOOLS, REVIEW_SYSTEM } from './prompts.js';
import { classifyCommand } from './policy.js';
import { createSandbox, type CommandResult, type Sandbox } from './sandbox.js';
import type { AgentStepRecord, TaskRecord, TaskStore } from './store.js';
import { failedChecks, finalizeReport, parseAiReview, runChecks } from './verification.js';

export interface RunnerDeps {
  store: TaskStore;
  model: ModelAdapter;
  config?: EngineConfig;
  logger?: Logger;
  approvalPolicy?: 'ask' | 'deny';
  signal?: AbortSignal;
  onStep?: (step: AgentStepRecord) => void;
}

export function taskTitle(instruction: string): string {
  const line = instruction.trim().split('\n')[0] ?? 'Task';
  return line.length > 90 ? `${line.slice(0, 87)}...` : line;
}

export async function recoverInterruptedTasks(store: TaskStore, now = new Date(), staleMs = 30_000): Promise<string[]> {
  const cutoff = new Date(now.getTime() - staleMs);
  const stale = await store.listStale(cutoff);
  const ids: string[] = [];
  for (const task of stale) {
    await store.updateTask(task.id, {
      status: 'failed',
      errorCode: 'interrupted',
      error: 'Execution stopped before the task reached a terminal state. Partial steps are preserved and nothing was merged.',
      finishedAt: now,
      runnerId: null,
    });
    ids.push(task.id);
  }
  return ids;
}

export async function cancelTask(store: TaskStore, taskId: string): Promise<TaskRecord> {
  const task = await store.getTask(taskId);
  if (!task) throw new OpenEngineerError('Task not found', 'not_found');
  if (isTerminalStatus(task.status)) {
    throw new OpenEngineerError(`Task is already ${task.status}`, 'invalid_transition');
  }
  await store.updateTask(taskId, { cancelRequested: true });
  await store.cancelOpenApprovals(taskId);
  if (!isRunningStatus(task.status)) {
    return store.updateTask(taskId, {
      status: 'cancelled',
      error: 'Cancelled by user',
      errorCode: 'cancelled',
      finishedAt: new Date(),
      runnerId: null,
    });
  }
  const updated = await store.getTask(taskId);
  if (!updated) throw new OpenEngineerError('Task not found', 'not_found');
  return updated;
}

export async function runTask(deps: RunnerDeps, taskId: string): Promise<void> {
  const run = new TaskRun(deps, taskId);
  await run.start();
}

class TaskRun {
  private readonly store: TaskStore;
  private readonly model: ModelAdapter;
  private readonly config: EngineConfig;
  private readonly logger: Logger;
  private readonly approvalPolicy: 'ask' | 'deny';
  private readonly runnerId = randomUUID();
  private readonly abort = new AbortController();
  private heartbeat: NodeJS.Timeout | null = null;
  private cancelPoll: NodeJS.Timeout | null = null;
  private sandbox: Sandbox | null = null;
  private usage: Usage;
  private costKnown = true;
  private costUsd = 0;
  private messages: ModelMessage[] = [];
  private plan: Plan | null = null;
  private repairAttempt = 0;
  private turnIndex = 0;
  private instruction = '';
  private worktreePath: string | null = null;
  private baseCommit: string | null = null;
  private branch: string | null = null;
  private paused = false;
  private status: TaskStatus = 'queued';
  private startedMs = Date.now();
  private detection: RepoDetection | null = null;

  constructor(
    private readonly deps: RunnerDeps,
    private readonly taskId: string,
  ) {
    this.store = deps.store;
    this.model = deps.model;
    this.config = deps.config ?? loadConfig();
    this.logger = deps.logger ?? silentLogger;
    this.approvalPolicy = deps.approvalPolicy ?? 'ask';
    this.usage = emptyUsage(deps.model.provider, deps.model.model);
  }

  async start(): Promise<void> {
    const task = await this.mustTask();
    if (isTerminalStatus(task.status)) return;
    if (task.status === 'awaiting_approval') {
      const pending = task.checkpoint?.pendingToolCall;
      if (!pending) return;
      const approval = await this.store.getApproval(pending.approvalId);
      if (!approval || approval.status === 'pending') return;
    } else if (task.status !== 'queued') {
      throw new OpenEngineerError('Task is already in progress', 'already_running');
    }
    await this.store.claim(this.taskId, this.runnerId, 30_000);
    this.heartbeat = setInterval(() => {
      void this.store.heartbeat(this.taskId, this.runnerId).catch((error) => {
        this.logger.error({ err: errorMessage(error), taskId: this.taskId }, 'heartbeat failed');
      });
    }, 5_000);
    this.heartbeat.unref?.();
    this.cancelPoll = setInterval(() => {
      void this.store.isCancelRequested(this.taskId).then((requested) => {
        if (requested) this.abort.abort();
      }).catch((error) => {
        this.logger.error({ err: errorMessage(error), taskId: this.taskId }, 'cancel poll failed');
      });
    }, 250);
    this.cancelPoll.unref?.();
    this.deps.signal?.addEventListener('abort', () => this.abort.abort(), { once: true });
    try {
      await this.execute(task);
    } catch (error) {
      await this.handleFailure(error);
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.cancelPoll) clearInterval(this.cancelPoll);
      await this.store.release(this.taskId, this.runnerId);
    }
  }

  private async execute(initial: TaskRecord): Promise<void> {
    this.status = initial.status;
    this.plan = initial.plan;
    this.instruction = initial.instruction;
    this.usage = initial.usage ?? this.usage;
    this.worktreePath = initial.worktreePath;
    this.baseCommit = initial.baseCommit;
    this.branch = initial.branch;
    this.startedMs = initial.startedAt?.getTime() ?? Date.now();
    let entry: 'fresh' | Checkpoint['phase'] = 'fresh';
    if (initial.checkpoint?.pendingToolCall && initial.status === 'awaiting_approval') {
      entry = await this.settlePending(initial);
      if (this.paused) return;
    }
    if (entry === 'fresh') {
      await this.transition('inspecting');
      await this.inspect();
      await this.transition('planning');
      const planned = await this.planLoop([]);
      if (planned === 'paused') return;
      entry = 'implementing';
    } else if (entry === 'planning') {
      const planned = await this.planLoop(this.messages);
      if (planned === 'paused') return;
      entry = 'implementing';
    }
    await this.ensureSandbox();
    await this.ensureWorktree();
    if (entry === 'implementing') {
      if (this.messages[0]?.content !== IMPLEMENT_SYSTEM) {
        this.messages = [
          { role: 'system', content: IMPLEMENT_SYSTEM },
          { role: 'user', content: this.implementationPrompt() },
        ];
        this.turnIndex = 0;
      }
      await this.transition('implementing');
      const outcome = await this.toolLoop('implementing');
      if (outcome === 'paused' || outcome === 'refused') return;
    } else if (entry === 'repairing') {
      await this.transition('repairing');
      const outcome = await this.toolLoop('repairing');
      if (outcome === 'paused' || outcome === 'refused') return;
    }
    const tested = await this.testAndRepair();
    if (tested !== 'continue') return;
    await this.verify();
  }

  private async settlePending(task: TaskRecord): Promise<Checkpoint['phase']> {
    const checkpoint = task.checkpoint;
    const pending = checkpoint?.pendingToolCall;
    if (!checkpoint || !pending) return 'implementing';
    const approval = await this.store.getApproval(pending.approvalId);
    if (!approval || approval.status === 'pending') {
      this.paused = true;
      return checkpoint.phase;
    }
    this.messages = checkpoint.messages.map((message) => ({ ...message }));
    this.repairAttempt = checkpoint.repairAttempt;
    this.turnIndex = checkpoint.turnIndex;
    this.plan = task.plan;
    const phase = checkpoint.phase;
    await this.transition(phase);
    if (approval.status === 'cancelled') {
      this.paused = true;
      return checkpoint.phase;
    }
    await this.store.closeApprovalStep(this.taskId, approval.id, approval.status === 'denied' ? 'denied' : 'approved');
    if (approval.status === 'denied') {
      this.messages.push({
        role: 'tool',
        toolCallId: pending.id,
        name: pending.name,
        content: `Denied by the user. ${approval.resolution?.note ?? 'Choose a safer action or refuse the task.'}`.trim(),
      });
    } else if (pending.name === 'request_clarification' || pending.name === 'submit_plan') {
      this.messages.push({
        role: 'tool',
        toolCallId: pending.id,
        name: pending.name,
        content: JSON.stringify({ answers: approval.resolution?.answers ?? [], note: approval.resolution?.note ?? null }),
      });
    } else if (pending.name === 'run_command') {
      await this.ensureSandbox();
      await this.ensureWorktree();
      const payload = z
        .object({ argv: z.array(z.string()).min(1), network: z.boolean(), display: z.string() })
        .parse(approval.payload);
      const decision = classifyCommand(payload.display, this.worktreePath!);
      if (decision.action === 'deny') {
        this.messages.push({
          role: 'tool',
          toolCallId: pending.id,
          name: pending.name,
          content: `Denied: ${decision.reason}`,
        });
      } else {
        const result = await this.sandbox!.run(
          {
            argv: payload.argv,
            cwd: this.worktreePath!,
            timeoutMs: task.budget.commandTimeoutMs,
            network: payload.network,
          },
          this.abort.signal,
        );
        this.usage.commandCount += 1;
        await this.record({
          phase,
          kind: 'command',
          name: payload.display,
          status: result.exitCode === 0 && !result.timedOut ? 'completed' : 'failed',
          input: payload,
          output: commandOutput(result),
          error: null,
          durationMs: result.durationMs,
        });
        this.messages.push({
          role: 'tool',
          toolCallId: pending.id,
          name: pending.name,
          content: commandOutput(result),
        });
      }
    } else {
      this.messages.push({
        role: 'tool',
        toolCallId: pending.id,
        name: pending.name,
        content: 'Approved, but this tool cannot be resumed.',
      });
    }
    await this.persistCheckpoint(phase);
    return phase;
  }

  private async inspect(): Promise<void> {
    const task = await this.mustTask();
    const project = await detectProject(task.repository.rootPath);
    const gitStatus = await inspectGit(task.repository.rootPath);
    const files = await listFiles(task.repository.rootPath);
    this.detection = {
      ...project,
      hasUncommittedChanges: gitStatus.dirty,
      headCommit: gitStatus.headCommit,
      branch: gitStatus.branch,
      statusPorcelain: gitStatus.porcelain,
    };
    await this.store.updateRepository(task.repositoryId, {
      defaultBranch: gitStatus.branch,
      headCommit: gitStatus.headCommit,
      language: project.languages[0] ?? null,
      packageManager: project.packageManager,
      testFramework: project.testFramework,
      detection: this.detection,
    });
    await this.record({
      phase: 'inspecting',
      kind: 'inspection',
      name: 'inspect_repository',
      status: 'completed',
      input: { rootPath: task.repository.rootPath },
      output: {
        languages: this.detection.languages,
        packageManager: this.detection.packageManager,
        testFramework: this.detection.testFramework,
        checks: this.detection.suggestedChecks.map((check) => check.display),
        dirty: this.detection.hasUncommittedChanges,
        fileCount: files.length,
      },
      error: null,
      durationMs: null,
    });
    this.logger.info({ taskId: this.taskId, packageManager: project.packageManager }, 'repository inspected');
  }

  private async planLoop(seed: ModelMessage[]): Promise<'ready' | 'paused'> {
    const task = await this.mustTask();
    if (seed.length === 0) {
      const files = await listFiles(task.repository.rootPath);
      const preview = await excerptFiles(task.repository.rootPath, files, task.instruction);
      this.messages = [
        { role: 'system', content: PLAN_SYSTEM },
        {
          role: 'user',
          content: [
            `Task:\n${task.instruction}`,
            `Languages: ${this.detection?.languages.join(', ') ?? 'unknown'}`,
            `Package manager: ${this.detection?.packageManager ?? 'unknown'}`,
            `Test framework: ${this.detection?.testFramework ?? 'none'}`,
            `HEAD: ${this.detection?.branch ?? 'unknown'} @ ${this.detection?.headCommit ?? 'unknown'}`,
            this.detection?.hasUncommittedChanges
              ? `Uncommitted user changes are preserved and are excluded from the task base.\n${this.detection.statusPorcelain}`
              : 'The user checkout is clean.',
            `Detected checks:\n${this.detection?.suggestedChecks.map((check) => check.display).join('\n') || 'none'}`,
            `Files:\n${files.slice(0, 200).join('\n')}`,
            preview,
          ].join('\n\n'),
        },
      ];
    } else {
      this.messages = seed;
    }
    let nudges = 0;
    for (let step = 0; step < 8; step += 1) {
      await this.assertContinue();
      const response = await this.complete('plan', PLAN_TOOLS);
      if (response.toolCalls.length === 0) {
        nudges += 1;
        if (nudges > 2) throw new OpenEngineerError('Planner stopped without submitting a plan', 'model_stopped');
        this.messages.push({ role: 'user', content: 'Call submit_plan or request_clarification.' });
        continue;
      }
      for (const call of response.toolCalls) {
        if (call.name === 'submit_plan' || call.name === 'request_clarification') {
          const outcome = await this.handlePlanCall(call);
          if (outcome === 'paused') return 'paused';
          if (outcome === 'ready') return 'ready';
          continue;
        }
        const content = await this.readOnlyTool(task.repository.rootPath, call);
        this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
      }
    }
    throw new OpenEngineerError('Planning exceeded its step limit', 'budget_exceeded');
  }

  private async handlePlanCall(call: ToolCall): Promise<'ready' | 'paused' | 'error'> {
    if (call.name === 'request_clarification') {
      const parsed = z.object({ questions: z.array(z.string().min(1)).min(1) }).safeParse(call.arguments);
      if (!parsed.success) {
        this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: parsed.error.message });
        return 'error';
      }
      await this.pauseForApproval('planning', call, 'clarification', parsed.data.questions.join('\n'), {
        questions: parsed.data.questions,
      });
      return 'paused';
    }
    const parsed = PlanSchema.safeParse(call.arguments);
    if (!parsed.success) {
      this.messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `Plan rejected: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      });
      return 'error';
    }
    if (parsed.data.needsClarification) {
      await this.pauseForApproval('planning', call, 'clarification', parsed.data.clarificationQuestions.join('\n'), {
        questions: parsed.data.clarificationQuestions,
      });
      return 'paused';
    }
    this.plan = parsed.data;
    await this.store.updateTask(this.taskId, { plan: parsed.data, title: taskTitle(parsed.data.objective) });
    this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'Plan accepted' });
    await this.record({
      phase: 'planning',
      kind: 'plan',
      name: 'submit_plan',
      status: 'completed',
      input: parsed.data,
      output: { objective: parsed.data.objective },
      error: null,
      durationMs: null,
    });
    return 'ready';
  }

  private async toolLoop(phase: 'implementing' | 'repairing'): Promise<'finished' | 'paused' | 'refused'> {
    let nudges = 0;
    for (;;) {
      await this.assertContinue();
      const response = await this.complete('implement', IMPLEMENT_TOOLS, this.turnIndex);
      this.turnIndex += 1;
      if (response.toolCalls.length === 0) {
        nudges += 1;
        if (nudges > 2) throw new OpenEngineerError('Implementation stopped without finish or refuse', 'model_stopped');
        this.messages.push({ role: 'user', content: 'Call a tool, finish, or refuse. Do not claim verification succeeded.' });
        continue;
      }
      nudges = 0;
      for (const call of response.toolCalls) {
        const outcome = await this.executeImplementTool(phase, call);
        if (outcome === 'paused' || outcome === 'finished' || outcome === 'refused') return outcome;
      }
    }
  }

  private async executeImplementTool(
    phase: 'implementing' | 'repairing',
    call: ToolCall,
  ): Promise<'continue' | 'paused' | 'finished' | 'refused'> {
    this.usage.toolCalls += 1;
    await this.assertBudget();
    const started = Date.now();
    try {
      if (call.name === 'finish') {
        const summary = z.object({ summary: z.string().min(1) }).parse(call.arguments).summary;
        await this.record({
          phase,
          kind: 'tool',
          name: 'finish',
          status: 'completed',
          input: call.arguments,
          output: { summary },
          error: null,
          durationMs: Date.now() - started,
        });
        this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'Implementation marked ready for verification.' });
        return 'finished';
      }
      if (call.name === 'refuse') {
        const reason = z.object({ reason: z.string().min(1) }).parse(call.arguments).reason;
        await this.record({
          phase,
          kind: 'tool',
          name: 'refuse',
          status: 'completed',
          input: call.arguments,
          output: { reason },
          error: null,
          durationMs: Date.now() - started,
        });
        await this.failRefused(reason);
        return 'refused';
      }
      if (call.name === 'run_command') {
        return await this.runCommandTool(phase, call, started);
      }
      const content = await this.mutateOrRead(call);
      await this.record({
        phase,
        kind: 'tool',
        name: call.name,
        status: 'completed',
        input: redactToolInput(call.arguments),
        output: content.slice(0, 20_000),
        error: null,
        durationMs: Date.now() - started,
      });
      this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: content.slice(0, 12_000) });
      return 'continue';
    } catch (error) {
      if (isOpenEngineerError(error) && (error.code === 'cancelled' || error.code === 'budget_exceeded')) throw error;
      const message = errorMessage(error);
      const denied = isOpenEngineerError(error) && (error.code === 'path_escape' || error.code === 'protected_path' || error.code === 'command_denied');
      await this.record({
        phase,
        kind: 'tool',
        name: call.name,
        status: denied ? 'denied' : 'failed',
        input: redactToolInput(call.arguments),
        output: message,
        error: message,
        durationMs: Date.now() - started,
      });
      this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: message });
      return 'continue';
    }
  }

  private async runCommandTool(
    phase: 'implementing' | 'repairing',
    call: ToolCall,
    started: number,
  ): Promise<'continue' | 'paused'> {
    const parsed = z.object({ command: z.string().min(1), justification: z.string().optional() }).parse(call.arguments);
    const cwd = this.worktreePath;
    if (!cwd) throw new OpenEngineerError('Cannot run a command before the worktree exists', 'git_error');
    const decision = classifyCommand(parsed.command, cwd);
    if (decision.action === 'deny') {
      await this.record({
        phase,
        kind: 'command',
        name: parsed.command,
        status: 'denied',
        input: { command: parsed.command, justification: parsed.justification ?? null },
        output: decision.reason,
        error: decision.reason,
        durationMs: Date.now() - started,
      });
      this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: `Denied: ${decision.reason}` });
      return 'continue';
    }
    if (decision.action === 'approve') {
      if (this.approvalPolicy === 'deny') {
        const reason = `Denied by approval policy: ${decision.reason}`;
        await this.record({
          phase,
          kind: 'command',
          name: decision.display,
          status: 'denied',
          input: { command: parsed.command },
          output: reason,
          error: reason,
          durationMs: Date.now() - started,
        });
        this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: reason });
        return 'continue';
      }
      await this.pauseForApproval(phase, call, 'command', decision.reason, {
        command: parsed.command,
        argv: decision.argv,
        network: decision.network,
        display: decision.display,
      });
      return 'paused';
    }
    await this.ensureSandbox();
    const result = await this.sandbox!.run(
      { argv: decision.argv, cwd, timeoutMs: (await this.mustTask()).budget.commandTimeoutMs, network: false },
      this.abort.signal,
    );
    this.usage.commandCount += 1;
    await this.record({
      phase,
      kind: 'command',
      name: decision.display,
      status: result.exitCode === 0 && !result.timedOut ? 'completed' : 'failed',
      input: { argv: decision.argv },
      output: commandOutput(result),
      error: null,
      durationMs: result.durationMs,
    });
    this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: commandOutput(result) });
    return 'continue';
  }

  private async testAndRepair(): Promise<'continue' | 'paused' | 'refused'> {
    let checks = await this.runVerificationChecks('testing');
    const budget = (await this.mustTask()).budget;
    while (failedChecks(checks).length > 0 && this.repairAttempt < budget.maxRepairAttempts) {
      await this.assertContinue();
      this.repairAttempt += 1;
      this.usage.repairAttempts = this.repairAttempt;
      this.turnIndex = 0;
      await this.transition('repairing');
      this.messages.push({
        role: 'user',
        content: `Verification failed. Repair attempt ${this.repairAttempt} of ${budget.maxRepairAttempts}. Do not claim these checks passed.\n\n${formatFailures(failedChecks(checks))}`,
      });
      const outcome = await this.toolLoop('repairing');
      if (outcome === 'paused' || outcome === 'refused') return outcome;
      checks = await this.runVerificationChecks('testing');
    }
    return 'continue';
  }

  private async verify(): Promise<void> {
    if (this.paused) return;
    await this.assertContinue();
    await this.transition('verifying');
    const checks = await this.runVerificationChecks('verifying');
    const diff = await this.currentDiff();
    let aiReview = null;
    const notes: string[] = [];
    try {
      const response = await this.model.complete({
        purpose: 'review',
        repairAttempt: this.repairAttempt,
        turnIndex: 0,
        messages: [
          { role: 'system', content: REVIEW_SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              task: (await this.mustTask()).instruction,
              plan: this.plan,
              checks: checks.map((check) => ({ id: check.id, status: check.status, reason: check.reason })),
              diff: { filesChanged: diff.filesChanged, files: diff.files.map((file) => file.path) },
            }),
          },
        ],
        signal: this.abort.signal,
      });
      this.addUsage(response);
      aiReview = parseAiReview(response.content);
      if (!aiReview) notes.push('AI review was not valid JSON and was ignored.');
      await this.record({
        phase: 'verifying',
        kind: 'review',
        name: 'ai_review',
        status: aiReview ? 'completed' : 'failed',
        input: null,
        output: aiReview ?? response.content.slice(0, 4_000),
        error: aiReview ? null : 'AI review could not be parsed',
        durationMs: null,
      });
    } catch (error) {
      if (errorCode(error) === 'cancelled') throw error;
      notes.push(`AI review unavailable: ${errorMessage(error)}`);
      this.logger.warn({ err: errorMessage(error), taskId: this.taskId }, 'ai review failed');
      await this.record({
        phase: 'verifying',
        kind: 'review',
        name: 'ai_review',
        status: 'failed',
        input: null,
        output: null,
        error: errorMessage(error),
        durationMs: null,
      });
    }
    const sandbox = this.sandbox!;
    const report = finalizeReport({
      checks,
      aiReview,
      diff,
      acceptanceCriteria: this.plan?.acceptanceCriteria ?? [],
      sandbox: { mode: sandbox.mode, secure: sandbox.secure, warning: sandbox.warning },
      requireChanges: true,
      notes,
    });
    await this.finishFromReport(report);
  }

  private async finishFromReport(report: VerificationReport): Promise<void> {
    await this.assertContinue();
    const failed = report.checks.filter((check) => check.required && check.status !== 'passed');
    const status: TaskStatus = report.overall === 'passed' ? 'completed' : 'failed';
    this.usage.durationMs = Date.now() - this.startedMs;
    this.usage.estimatedCostUsd = this.costKnown ? roundCost(this.costUsd) : null;
    await this.store.updateTask(this.taskId, {
      status,
      verification: report,
      usage: this.usage,
      error: status === 'failed' ? failureSummary(failed) : null,
      errorCode: status === 'failed' ? 'verification_failed' : null,
      finishedAt: new Date(),
    });
    this.status = status;
    await this.record({
      phase: 'verifying',
      kind: 'state',
      name: status,
      status: 'completed',
      input: null,
      output: { overall: report.overall },
      error: null,
      durationMs: null,
    });
  }

  private async runVerificationChecks(phase: 'testing' | 'verifying'): Promise<CheckResult[]> {
    await this.ensureSandbox();
    await this.transition(phase === 'testing' ? 'testing' : 'verifying');
    if (this.worktreePath) await commitWorktree(this.worktreePath, `openengineer: ${phase} attempt ${this.repairAttempt}`);
    const task = await this.mustTask();
    const checks = task.repository.detection?.suggestedChecks ?? this.detection?.suggestedChecks ?? [];
    if (checks.length === 0) {
      const missing: CheckResult[] = [
        {
          id: 'tests',
          name: 'Tests',
          status: 'not_run',
          required: true,
          command: null,
          exitCode: null,
          durationMs: null,
          output: '',
          reason: 'No supported test command was detected',
        },
      ];
      await this.record({
        phase,
        kind: 'verification',
        name: 'checks',
        status: 'failed',
        input: null,
        output: missing,
        error: null,
        durationMs: null,
      });
      return missing;
    }
    const started = Date.now();
    const results = await runChecks({
      sandbox: this.sandbox!,
      checks,
      cwd: this.worktreePath!,
      timeoutMs: task.budget.commandTimeoutMs,
      signal: this.abort.signal,
    });
    this.usage.commandCount += results.length;
    await this.record({
      phase,
      kind: 'verification',
      name: 'checks',
      status: failedChecks(results).length === 0 ? 'completed' : 'failed',
      input: checks.map((check) => check.display),
      output: results.map((result) => ({ id: result.id, status: result.status, exitCode: result.exitCode, reason: result.reason })),
      error: null,
      durationMs: Date.now() - started,
    });
    return results;
  }

  private async failRefused(reason: string): Promise<void> {
    const diff = this.worktreePath && this.baseCommit ? await this.currentDiff() : emptyDiff();
    const sandbox = this.sandbox;
    const report = finalizeReport({
      checks: [
        {
          id: 'refusal',
          name: 'Safety refusal',
          status: 'failed' as const,
          required: true,
          command: null,
          exitCode: null,
          durationMs: null,
          output: reason,
          reason,
        },
        ...(this.detection?.suggestedChecks ?? []).map((check) => ({
          id: check.id,
          name: check.name,
          status: 'not_run' as const,
          required: false,
          command: check.display,
          exitCode: null,
          durationMs: null,
          output: '',
          reason: 'Not run because the agent refused the task',
        })),
      ],
      aiReview: null,
      diff,
      acceptanceCriteria: this.plan?.acceptanceCriteria ?? [reason],
      sandbox: sandbox
        ? { mode: sandbox.mode, secure: sandbox.secure, warning: sandbox.warning }
        : { mode: this.config.sandboxMode, secure: false, warning: 'Commands were not executed.' },
      requireChanges: false,
      notes: [`The agent refused the task: ${reason}`, 'Refusal is a failed task, not a successful completion.'],
    });
    this.usage.durationMs = Date.now() - this.startedMs;
    await this.store.updateTask(this.taskId, {
      status: 'failed',
      error: reason,
      errorCode: 'refused',
      verification: report,
      usage: this.usage,
      finishedAt: new Date(),
    });
    this.status = 'failed';
  }

  private async ensureSandbox(): Promise<void> {
    if (this.sandbox) return;
    this.sandbox = await createSandbox({
      mode: this.config.sandboxMode,
      allowProcessSandbox: this.config.allowProcessSandbox,
      dockerImage: this.config.dockerImage,
    });
    await this.store.updateTask(this.taskId, { sandboxMode: this.sandbox.mode });
  }

  private async ensureWorktree(): Promise<void> {
    if (this.worktreePath && this.baseCommit && this.branch) return;
    const task = await this.mustTask();
    const branch = `openengineer/${task.id}`;
    const created = await createTaskWorktree({
      repoPath: task.repository.rootPath,
      taskId: task.id,
      branch,
      ...(this.config.worktreeRoot ? { worktreeRoot: this.config.worktreeRoot } : {}),
    });
    this.worktreePath = created.worktreePath;
    this.baseCommit = created.baseCommit;
    this.branch = created.branch;
    await this.store.updateTask(this.taskId, {
      worktreePath: created.worktreePath,
      baseCommit: created.baseCommit,
      branch: created.branch,
    });
    await this.record({
      phase: 'implementing',
      kind: 'git',
      name: 'create_worktree',
      status: 'completed',
      input: { branch: created.branch, baseCommit: created.baseCommit },
      output: { worktreePath: created.worktreePath },
      error: null,
      durationMs: null,
    });
  }

  private async pauseForApproval(
    phase: Checkpoint['phase'],
    call: ToolCall,
    kind: string,
    prompt: string,
    payload: unknown,
  ): Promise<void> {
    const approval = await this.store.createApproval({ taskId: this.taskId, kind, prompt, payload });
    const checkpoint: Checkpoint = {
      phase,
      messages: this.messages,
      repairAttempt: this.repairAttempt,
      turnIndex: this.turnIndex,
      worktreePath: this.worktreePath,
      branch: this.branch,
      baseCommit: this.baseCommit,
      pendingToolCall: { id: call.id, name: call.name, arguments: call.arguments, approvalId: approval.id },
    };
    await this.store.updateTask(this.taskId, { status: 'awaiting_approval', checkpoint, usage: this.usage });
    this.status = 'awaiting_approval';
    this.paused = true;
    await this.record({
      phase,
      kind: 'approval',
      name: kind,
      status: 'pending',
      input: payload,
      output: { approvalId: approval.id, prompt },
      error: null,
      durationMs: null,
    });
  }

  private async persistCheckpoint(phase: Checkpoint['phase']): Promise<void> {
    const checkpoint: Checkpoint = {
      phase,
      messages: this.messages,
      repairAttempt: this.repairAttempt,
      turnIndex: this.turnIndex,
      worktreePath: this.worktreePath,
      branch: this.branch,
      baseCommit: this.baseCommit,
      pendingToolCall: null,
    };
    await this.store.updateTask(this.taskId, { checkpoint });
  }

  private async complete(
    purpose: 'plan' | 'implement' | 'review',
    tools: typeof PLAN_TOOLS,
    turnIndex = 0,
  ): Promise<ModelResponse> {
    await this.assertContinue();
    await this.assertBudget();
    const started = Date.now();
    const response = await this.model.complete({
      purpose,
      repairAttempt: this.repairAttempt,
      turnIndex,
      messages: this.messages,
      tools,
      signal: this.abort.signal,
    });
    this.addUsage(response);
    if (response.toolCalls.length > 0 || response.content) {
      this.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
    }
    await this.record({
      phase: this.status,
      kind: 'model',
      name: purpose,
      status: 'completed',
      input: { provider: this.model.provider, model: this.model.model, toolCalls: response.toolCalls.map((call) => call.name) },
      output: { usage: response.usage, tokenAccounting: response.tokenAccounting, finishReason: response.finishReason },
      error: null,
      durationMs: Date.now() - started,
    });
    await this.store.updateTask(this.taskId, { usage: this.snapshotUsage() });
    await this.assertBudget();
    return response;
  }

  private addUsage(response: ModelResponse): void {
    this.usage.modelCalls += 1;
    this.usage.inputTokens += response.usage.inputTokens;
    this.usage.outputTokens += response.usage.outputTokens;
    if (response.tokenAccounting === 'heuristic') this.usage.tokenAccounting = 'heuristic';
    const cost = estimateCostUsd(this.model.model, response.usage);
    if (cost === null) this.costKnown = false;
    else this.costUsd += cost;
  }

  private snapshotUsage(): Usage {
    return {
      ...this.usage,
      durationMs: Date.now() - this.startedMs,
      estimatedCostUsd: this.costKnown ? roundCost(this.costUsd) : null,
    };
  }

  private async assertBudget(): Promise<void> {
    const budget = (await this.mustTask()).budget;
    const elapsed = Date.now() - this.startedMs;
    if (elapsed > budget.maxDurationMs) {
      throw new OpenEngineerError(`Duration budget of ${budget.maxDurationMs}ms exceeded`, 'budget_exceeded');
    }
    if (this.usage.modelCalls > budget.maxModelCalls) {
      throw new OpenEngineerError(`Model call budget of ${budget.maxModelCalls} exceeded`, 'budget_exceeded');
    }
    if (this.usage.toolCalls > budget.maxToolCalls) {
      throw new OpenEngineerError(`Tool call budget of ${budget.maxToolCalls} exceeded`, 'budget_exceeded');
    }
    if (this.usage.inputTokens > budget.maxInputTokens || this.usage.outputTokens > budget.maxOutputTokens) {
      throw new OpenEngineerError('Token budget exceeded', 'budget_exceeded');
    }
  }

  private async assertContinue(): Promise<void> {
    if (this.abort.signal.aborted || (await this.store.isCancelRequested(this.taskId))) {
      throw new OpenEngineerError('Cancelled by user', 'cancelled');
    }
  }

  private async transition(status: TaskStatus): Promise<void> {
    if (this.status === status) return;
    const from = this.status;
    await this.store.updateTask(this.taskId, { status });
    this.status = status;
    await this.record({
      phase: status,
      kind: 'state',
      name: status,
      status: 'completed',
      input: { from },
      output: null,
      error: null,
      durationMs: null,
    });
  }

  private async handleFailure(error: unknown): Promise<void> {
    const latest = await this.store.getTask(this.taskId);
    if (!latest || isTerminalStatus(latest.status) || latest.status === 'awaiting_approval') return;
    const code = errorCode(error);
    const message = errorMessage(error);
    this.logger.error({ err: message, code, taskId: this.taskId }, 'task failed');
    if (code === 'cancelled') {
      await this.store.updateTask(this.taskId, {
        status: 'cancelled',
        error: 'Cancelled by user',
        errorCode: 'cancelled',
        usage: this.snapshotUsage(),
        finishedAt: new Date(),
      });
      return;
    }
    await this.store.updateTask(this.taskId, {
      status: 'failed',
      error: message,
      errorCode: code,
      usage: this.snapshotUsage(),
      finishedAt: new Date(),
    });
    await this.store.appendStep({
      taskId: this.taskId,
      phase: this.status,
      kind: 'error',
      name: code,
      status: 'failed',
      input: null,
      output: null,
      error: message,
      finishedAt: new Date(),
      durationMs: null,
    });
  }

  private async currentDiff(): Promise<DiffSummary> {
    if (!this.worktreePath || !this.baseCommit) return emptyDiff();
    return collectDiff(this.worktreePath, this.baseCommit);
  }

  private implementationPrompt(): string {
    return [
      `Instruction:\n${this.instruction}`,
      `Plan:\n${JSON.stringify(this.plan, null, 2)}`,
      'The verifier will run the detected project checks after you finish. Their results, not your summary, decide success.',
    ].join('\n\n');
  }

  private async readOnlyTool(root: string, call: ToolCall): Promise<string> {
    this.usage.toolCalls += 1;
    try {
      const content = await dispatchRead(root, call);
      await this.record({
        phase: 'planning',
        kind: 'tool',
        name: call.name,
        status: 'completed',
        input: call.arguments,
        output: content.slice(0, 8_000),
        error: null,
        durationMs: null,
      });
      return content.slice(0, 12_000);
    } catch (error) {
      const message = errorMessage(error);
      await this.record({
        phase: 'planning',
        kind: 'tool',
        name: call.name,
        status: 'failed',
        input: call.arguments,
        output: message,
        error: message,
        durationMs: null,
      });
      return message;
    }
  }

  private async mutateOrRead(call: ToolCall): Promise<string> {
    const root = this.worktreePath;
    if (!root) throw new OpenEngineerError('Worktree is not available', 'git_error');
    if (call.name === 'list_files' || call.name === 'read_file' || call.name === 'search_code') {
      return dispatchRead(root, call);
    }
    if (call.name === 'edit_file') {
      const args = z.object({ path: z.string(), oldString: z.string(), newString: z.string() }).parse(call.arguments);
      return editFile(root, args.path, args.oldString, args.newString);
    }
    if (call.name === 'write_file') {
      const args = z.object({ path: z.string(), content: z.string() }).parse(call.arguments);
      return writeTextFile(root, args.path, args.content);
    }
    if (call.name === 'inspect_diff') {
      const diff = await this.currentDiff();
      if (diff.files.length === 0) return 'No changes';
      return diff.files.map((file) => `${file.status} ${file.path}\n${file.patch.slice(0, 4_000)}`).join('\n');
    }
    throw new OpenEngineerError(`Unknown tool ${call.name}`, 'validation');
  }

  private async record(input: {
    phase: string;
    kind: string;
    name: string;
    status: string;
    input: unknown;
    output: unknown;
    error: string | null;
    durationMs: number | null;
  }): Promise<void> {
    const step = await this.store.appendStep({
      taskId: this.taskId,
      phase: input.phase,
      kind: input.kind,
      name: input.name,
      status: input.status,
      input: input.input,
      output: input.output,
      error: input.error,
      finishedAt: new Date(),
      durationMs: input.durationMs,
    });
    this.deps.onStep?.(step);
  }

  private async mustTask(): Promise<TaskRecord> {
    const task = await this.store.getTask(this.taskId);
    if (!task) throw new OpenEngineerError('Task not found', 'not_found');
    return task;
  }
}

async function dispatchRead(root: string, call: ToolCall): Promise<string> {
  if (call.name === 'list_files') return (await listFiles(root)).join('\n');
  if (call.name === 'read_file') {
    const args = z.object({ path: z.string().min(1) }).parse(call.arguments);
    return readTextFile(root, args.path);
  }
  if (call.name === 'search_code') {
    const args = z.object({ query: z.string().min(1) }).parse(call.arguments);
    return searchText(root, args.query);
  }
  throw new OpenEngineerError(`Unknown read tool ${call.name}`, 'validation');
}

async function excerptFiles(root: string, files: string[], instruction: string): Promise<string> {
  const words = instruction.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
  const ranked = [...files].sort((a, b) => score(b, words) - score(a, words));
  const chosen = ranked.filter((file) => score(file, words) > 0).slice(0, 4);
  const selected = chosen.length > 0 ? chosen : files.filter((file) => file.endsWith('package.json') || file.toLowerCase().endsWith('readme.md')).slice(0, 2);
  const parts: string[] = [];
  for (const file of selected) {
    try {
      parts.push(`----- ${file} -----\n${(await readTextFile(root, file)).slice(0, 4_000)}`);
    } catch (error) {
      if (isOpenEngineerError(error)) {
        parts.push(`----- ${file} -----\nSkipped (${error.code})`);
        continue;
      }
      throw error;
    }
  }
  return parts.join('\n\n');
}

function score(file: string, words: string[]): number {
  const lower = file.toLowerCase();
  return words.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0);
}

function commandOutput(result: CommandResult): string {
  return [
    `exitCode: ${result.exitCode}`,
    `timedOut: ${result.timedOut}`,
    `sandbox: ${result.sandboxMode}`,
    result.stdout ? `stdout:\n${result.stdout.slice(0, 12_000)}` : '',
    result.stderr ? `stderr:\n${result.stderr.slice(0, 12_000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatFailures(checks: CheckResult[]): string {
  return checks
    .map((check) => `## ${check.name} (${check.status})\ncommand: ${check.command ?? 'n/a'}\n${check.reason ?? ''}\n${check.output.slice(0, 8_000)}`)
    .join('\n\n');
}

function failureSummary(checks: CheckResult[]): string {
  if (checks.length === 0) return 'Verification did not pass';
  return checks.map((check) => `${check.name}: ${check.status}${check.reason ? ` (${check.reason})` : ''}`).join('; ');
}

function emptyDiff(): DiffSummary {
  return { filesChanged: 0, insertions: 0, deletions: 0, files: [] };
}

function redactToolInput(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.content === 'string' && record.content.length > 4_000) {
    record.content = `${record.content.slice(0, 4_000)}...`;
  }
  return record;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function defaultWorktreeBranch(taskId: string): string {
  return path.posix.join('openengineer', taskId);
}
