import { z } from 'zod';
import { TASK_STATUSES } from './status.js';

export const TaskStatusSchema = z.enum(TASK_STATUSES);

export const BudgetSchema = z.object({
  maxDurationMs: z.number().int().positive().max(3_600_000),
  maxRepairAttempts: z.number().int().min(0).max(10),
  maxToolCalls: z.number().int().positive().max(200),
  maxModelCalls: z.number().int().positive().max(200),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  commandTimeoutMs: z.number().int().positive().max(600_000),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const DEFAULT_BUDGET: Budget = {
  maxDurationMs: 900_000,
  maxRepairAttempts: 3,
  maxToolCalls: 40,
  maxModelCalls: 60,
  maxInputTokens: 2_000_000,
  maxOutputTokens: 200_000,
  commandTimeoutMs: 120_000,
};

export function resolveBudget(override?: Partial<Budget>): Budget {
  return BudgetSchema.parse({ ...DEFAULT_BUDGET, ...stripUndefined(override ?? {}) });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key as keyof T] = entry as T[keyof T];
  }
  return out;
}

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});

export const PlanSchema = z
  .object({
    objective: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)),
    relevantFiles: z.array(z.string()),
    dependencies: z.array(z.string()),
    steps: z.array(PlanStepSchema),
    validationCommands: z.array(z.string()),
    risks: z.array(z.string()),
    assumptions: z.array(z.string()),
    needsClarification: z.boolean(),
    clarificationQuestions: z.array(z.string().min(1)),
  })
  .superRefine((plan, ctx) => {
    if (plan.needsClarification && plan.clarificationQuestions.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Clarification requires at least one question',
        path: ['clarificationQuestions'],
      });
    }
    if (!plan.needsClarification) {
      if (plan.acceptanceCriteria.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'A plan needs at least one acceptance criterion',
          path: ['acceptanceCriteria'],
        });
      }
      if (plan.steps.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'A plan needs at least one implementation step',
          path: ['steps'],
        });
      }
    }
  });
export type Plan = z.infer<typeof PlanSchema>;

export const CheckStatusSchema = z.enum(['passed', 'failed', 'not_run', 'inconclusive']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CheckResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: CheckStatusSchema,
  required: z.boolean(),
  command: z.string().nullable(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  output: z.string(),
  reason: z.string().nullable(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const AiReviewSchema = z.object({
  summary: z.string(),
  concerns: z.array(z.string()),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type AiReview = z.infer<typeof AiReviewSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  insertions: z.number(),
  deletions: z.number(),
  patch: z.string(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const VerificationReportSchema = z.object({
  overall: z.enum(['passed', 'failed', 'inconclusive']),
  checks: z.array(CheckResultSchema),
  acceptance: z.array(
    z.object({
      criterion: z.string(),
      status: CheckStatusSchema,
      evidence: z.string(),
    }),
  ),
  aiReview: AiReviewSchema.nullable(),
  diff: z.object({
    filesChanged: z.number(),
    insertions: z.number(),
    deletions: z.number(),
    files: z.array(DiffFileSchema),
  }),
  sandbox: z.object({
    mode: z.enum(['docker', 'process']),
    secure: z.boolean(),
    warning: z.string().nullable(),
  }),
  notes: z.array(z.string()),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nullable(),
  tokenAccounting: z.enum(['provider', 'heuristic']),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  repairAttempts: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  commandCount: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ModelMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export const CheckpointSchema = z.object({
  phase: z.enum(['planning', 'implementing', 'repairing']),
  messages: z.array(ModelMessageSchema),
  repairAttempt: z.number().int().nonnegative(),
  turnIndex: z.number().int().nonnegative(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  pendingToolCall: z
    .object({
      id: z.string(),
      name: z.string(),
      arguments: z.unknown(),
      approvalId: z.string(),
    })
    .nullable(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const SuggestedCheckSchema = z.object({
  id: z.string(),
  name: z.string(),
  argv: z.array(z.string()).min(1),
  display: z.string(),
  required: z.boolean(),
});
export type SuggestedCheck = z.infer<typeof SuggestedCheckSchema>;

export const RepoDetectionSchema = z.object({
  languages: z.array(z.string()),
  packageManager: z.string(),
  testFramework: z.string().nullable(),
  scripts: z.record(z.string(), z.string()),
  suggestedChecks: z.array(SuggestedCheckSchema),
  hasUncommittedChanges: z.boolean(),
  headCommit: z.string().nullable(),
  branch: z.string().nullable(),
  statusPorcelain: z.string(),
  notes: z.array(z.string()),
});
export type RepoDetection = z.infer<typeof RepoDetectionSchema>;

export const ApprovalResolutionSchema = z.object({
  decision: z.enum(['approved', 'denied']),
  note: z.string().optional(),
  answers: z.array(z.string()).optional(),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

export function emptyUsage(provider: string, model: string): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: null,
    tokenAccounting: 'heuristic',
    modelCalls: 0,
    toolCalls: 0,
    repairAttempts: 0,
    durationMs: 0,
    commandCount: 0,
    provider,
    model,
  };
}
