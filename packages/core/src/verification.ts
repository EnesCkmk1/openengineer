import {
  AiReviewSchema,
  type AiReview,
  type CheckResult,
  type VerificationReport,
} from '@openengineer/shared';
import type { CommandResult, Sandbox } from './sandbox.js';
import type { SuggestedCheck } from '@openengineer/shared';
import type { DiffSummary } from './git.js';

export async function runChecks(input: {
  sandbox: Sandbox;
  checks: SuggestedCheck[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of input.checks) {
    const started = Date.now();
    try {
      const result = await input.sandbox.run(
        {
          argv: check.argv,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          network: false,
        },
        input.signal,
      );
      results.push(checkFromCommand(check, result, Date.now() - started));
    } catch (error) {
      results.push({
        id: check.id,
        name: check.name,
        status: 'inconclusive',
        required: check.required,
        command: check.display,
        exitCode: null,
        durationMs: Date.now() - started,
        output: error instanceof Error ? error.message : String(error),
        reason: 'The check could not be started',
      });
    }
  }
  return results;
}

export function checkFromCommand(
  check: Pick<SuggestedCheck, 'id' | 'name' | 'display' | 'required'>,
  result: CommandResult,
  durationMs: number,
): CheckResult {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 20_000);
  if (result.timedOut) {
    return {
      id: check.id,
      name: check.name,
      status: 'failed',
      required: check.required,
      command: check.display,
      exitCode: result.exitCode,
      durationMs,
      output,
      reason: `Timed out after ${durationMs}ms`,
    };
  }
  if (result.exitCode === 0) {
    return {
      id: check.id,
      name: check.name,
      status: 'passed',
      required: check.required,
      command: check.display,
      exitCode: 0,
      durationMs,
      output,
      reason: null,
    };
  }
  if (result.exitCode === null) {
    return {
      id: check.id,
      name: check.name,
      status: 'inconclusive',
      required: check.required,
      command: check.display,
      exitCode: null,
      durationMs,
      output,
      reason: 'The command ended without an exit code',
    };
  }
  return {
    id: check.id,
    name: check.name,
    status: 'failed',
    required: check.required,
    command: check.display,
    exitCode: result.exitCode,
    durationMs,
    output,
    reason: `Exited ${result.exitCode}`,
  };
}

export function finalizeReport(input: {
  checks: CheckResult[];
  aiReview: AiReview | null;
  diff: DiffSummary;
  acceptanceCriteria: string[];
  sandbox: VerificationReport['sandbox'];
  requireChanges: boolean;
  notes?: string[];
}): VerificationReport {
  const checks = [...input.checks];
  if (input.requireChanges) {
    checks.push({
      id: 'diff',
      name: 'Diff inspection',
      status: input.diff.filesChanged > 0 ? 'passed' : 'failed',
      required: true,
      command: null,
      exitCode: null,
      durationMs: null,
      output: input.diff.files.map((file) => `${file.status}\t${file.path}`).join('\n'),
      reason: input.diff.filesChanged > 0 ? null : 'The worktree has no changes relative to the base commit',
    });
  }
  const required = checks.filter((check) => check.required);
  const anyFailed = required.some((check) => check.status === 'failed');
  const anyInconclusive = required.some((check) => check.status === 'inconclusive' || check.status === 'not_run');
  const overall = anyFailed ? 'failed' : anyInconclusive || required.length === 0 ? 'inconclusive' : 'passed';
  const notes = [
    'Overall status is computed only from required mechanical checks. A model review cannot change it.',
    'Acceptance criteria that are not executable checks stay inconclusive.',
    ...(input.sandbox.warning ? [input.sandbox.warning] : []),
    ...(input.notes ?? []),
  ];
  return {
    overall,
    checks,
    acceptance: input.acceptanceCriteria.map((criterion) => ({
      criterion,
      status: 'inconclusive' as const,
      evidence: 'No mechanical check is bound to this criterion. Model commentary is stored separately and is not proof.',
    })),
    aiReview: input.aiReview,
    diff: {
      filesChanged: input.diff.filesChanged,
      insertions: input.diff.insertions,
      deletions: input.diff.deletions,
      files: input.diff.files,
    },
    sandbox: input.sandbox,
    notes,
  };
}

export function parseAiReview(content: string): AiReview | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = AiReviewSchema.safeParse(JSON.parse(content.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function failedChecks(checks: CheckResult[]): CheckResult[] {
  return checks.filter((check) => check.required && (check.status === 'failed' || check.status === 'inconclusive'));
}
