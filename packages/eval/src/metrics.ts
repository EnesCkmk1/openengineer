export interface TaskMeasurement {
  id: string;
  kind: string;
  completed: boolean;
  testsPassed: boolean | null;
  regressionCaught: boolean | null;
  repairAttempts: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  tokenAccounting: 'provider' | 'heuristic' | null;
  verification: 'passed' | 'failed' | 'inconclusive' | null;
  status: string;
  errorCode: string | null;
  notes: string[];
}

export interface EvalSummary {
  tasks: number;
  taskCompletionRate: number;
  testPassRate: number | null;
  regressionRate: number | null;
  meanRepairAttempts: number;
  meanDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number | null;
}

export function summarize(results: TaskMeasurement[]): EvalSummary {
  const tested = results.filter((result) => result.testsPassed !== null);
  const regression = results.filter((result) => result.regressionCaught !== null);
  const costs = results.map((result) => result.estimatedCostUsd);
  return {
    tasks: results.length,
    taskCompletionRate: ratio(results.filter((result) => result.completed).length, results.length),
    testPassRate: tested.length === 0 ? null : ratio(tested.filter((result) => result.testsPassed).length, tested.length),
    regressionRate:
      regression.length === 0 ? null : ratio(regression.filter((result) => result.regressionCaught === false).length, regression.length),
    meanRepairAttempts: round3(mean(results.map((result) => result.repairAttempts))),
    meanDurationMs: Math.round(mean(results.map((result) => result.durationMs))),
    totalInputTokens: results.reduce((sum, result) => sum + result.inputTokens, 0),
    totalOutputTokens: results.reduce((sum, result) => sum + result.outputTokens, 0),
    estimatedCostUsd: costs.some((cost) => cost === null) ? null : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
  };
}

function ratio(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 1000) / 1000;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
