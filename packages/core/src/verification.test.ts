import { describe, expect, it } from 'vitest';
import type { CheckResult } from '@openengineer/shared';
import { finalizeReport } from './verification.js';

const sandbox = {
  mode: 'process' as const,
  secure: false,
  warning: 'Process sandbox is not a security boundary.',
};

function check(status: CheckResult['status'], required = true): CheckResult {
  return {
    id: 'test',
    name: 'Tests',
    status,
    required,
    command: 'npm test',
    exitCode: status === 'passed' ? 0 : 1,
    durationMs: 10,
    output: status === 'passed' ? 'ok' : 'assertion failed',
    reason: status === 'passed' ? null : 'Exited 1',
  };
}

describe('finalizeReport', () => {
  it('keeps a failed test failed when the model review claims success', () => {
    const report = finalizeReport({
      checks: [check('failed')],
      aiReview: { summary: 'All tests passed and the patch is correct.', concerns: [], confidence: 'high' },
      diff: { filesChanged: 1, insertions: 1, deletions: 1, files: [] },
      acceptanceCriteria: ['Expired sessions are rejected'],
      sandbox,
      requireChanges: true,
    });
    expect(report.overall).toBe('failed');
    expect(report.acceptance[0]?.status).toBe('inconclusive');
    expect(report.aiReview?.confidence).toBe('high');
  });

  it('does not pass when the diff is empty', () => {
    const report = finalizeReport({
      checks: [check('passed')],
      aiReview: null,
      diff: { filesChanged: 0, insertions: 0, deletions: 0, files: [] },
      acceptanceCriteria: ['Change the behavior'],
      sandbox,
      requireChanges: true,
    });
    expect(report.overall).toBe('failed');
    expect(report.checks.find((item) => item.id === 'diff')?.status).toBe('failed');
  });

  it('passes only when every required mechanical check passed', () => {
    const report = finalizeReport({
      checks: [check('passed'), check('not_run', false)],
      aiReview: null,
      diff: {
        filesChanged: 1,
        insertions: 1,
        deletions: 1,
        files: [{ path: 'src/session.js', status: 'M', insertions: 1, deletions: 1, patch: '@@' }],
      },
      acceptanceCriteria: ['Tests pass'],
      sandbox,
      requireChanges: true,
    });
    expect(report.overall).toBe('passed');
  });
});
