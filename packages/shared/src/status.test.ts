import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, isTerminalStatus } from './status.js';
import { OpenEngineerError } from './errors.js';
import { PlanSchema, resolveBudget } from './schemas.js';

describe('task status', () => {
  it('allows the documented forward path', () => {
    const path = [
      'queued',
      'inspecting',
      'planning',
      'implementing',
      'testing',
      'repairing',
      'testing',
      'verifying',
      'completed',
    ] as const;
    for (let i = 1; i < path.length; i += 1) {
      expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it('rejects skipping from queued to completed', () => {
    expect(() => assertTransition('queued', 'completed')).toThrow(OpenEngineerError);
  });

  it('treats completed, failed, and cancelled as terminal', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('testing')).toBe(false);
  });
});

describe('plan schema', () => {
  it('rejects a plan that asks for clarification without questions', () => {
    const parsed = PlanSchema.safeParse({
      objective: 'Unclear',
      acceptanceCriteria: [],
      relevantFiles: [],
      dependencies: [],
      steps: [],
      validationCommands: [],
      risks: [],
      assumptions: [],
      needsClarification: true,
      clarificationQuestions: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('budget', () => {
  it('fills defaults and rejects an excessive repair limit', () => {
    expect(resolveBudget({ maxRepairAttempts: 1 }).maxToolCalls).toBe(40);
    expect(() => resolveBudget({ maxRepairAttempts: 99 })).toThrow();
  });
});
