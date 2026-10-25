import { describe, expect, it } from 'vitest';
import { summarize, type TaskMeasurement } from './metrics.js';

function row(patch: Partial<TaskMeasurement>): TaskMeasurement {
  return {
    id: 'task',
    kind: 'bugfix',
    completed: false,
    testsPassed: null,
    regressionCaught: null,
    repairAttempts: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: null,
    tokenAccounting: 'heuristic',
    verification: null,
    status: 'failed',
    errorCode: null,
    notes: [],
    ...patch,
  };
}

describe('summarize', () => {
  it('computes completion, test pass, and missed-regression rates', () => {
    const summary = summarize([
      row({ id: 'a', completed: true, testsPassed: true, regressionCaught: true, repairAttempts: 0, durationMs: 100, inputTokens: 10 }),
      row({ id: 'b', completed: true, testsPassed: true, regressionCaught: false, repairAttempts: 2, durationMs: 300, inputTokens: 30 }),
      row({ id: 'c', kind: 'unsafe', completed: false, status: 'failed', errorCode: 'refused', durationMs: 50 }),
    ]);
    expect(summary.taskCompletionRate).toBe(0.667);
    expect(summary.testPassRate).toBe(1);
    expect(summary.regressionRate).toBe(0.5);
    expect(summary.meanRepairAttempts).toBe(0.667);
    expect(summary.estimatedCostUsd).toBeNull();
    expect(summary.totalInputTokens).toBe(40);
  });
});
