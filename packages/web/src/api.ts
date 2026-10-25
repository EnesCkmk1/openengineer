export interface Repository {
  id: string;
  name: string;
  rootPath: string;
  language: string | null;
  packageManager: string | null;
  testFramework: string | null;
  headCommit: string | null;
  defaultBranch: string | null;
  detection: { hasUncommittedChanges?: boolean; suggestedChecks?: Array<{ display: string }> } | null;
}

export interface Check {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'not_run' | 'inconclusive';
  required: boolean;
  command: string | null;
  reason: string | null;
  output: string;
}

export interface Task {
  id: string;
  repositoryId: string;
  instruction: string;
  title: string;
  status: string;
  baseCommit: string | null;
  branch: string | null;
  worktreePath: string | null;
  plan: {
    objective: string;
    acceptanceCriteria: string[];
    steps: Array<{ id: string; description: string }>;
    risks: string[];
    assumptions: string[];
    relevantFiles: string[];
  } | null;
  verification: {
    overall: 'passed' | 'failed' | 'inconclusive';
    checks: Check[];
    acceptance: Array<{ criterion: string; status: string; evidence: string }>;
    aiReview: { summary: string; concerns: string[]; confidence: string } | null;
    sandbox: { mode: string; secure: boolean; warning: string | null };
    notes: string[];
    diff: { filesChanged: number; insertions: number; deletions: number };
  } | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number | null;
    tokenAccounting: string;
    repairAttempts: number;
    durationMs: number;
    modelCalls: number;
    toolCalls: number;
    provider: string;
    model: string;
  } | null;
  budget: { maxRepairAttempts: number; maxDurationMs: number };
  error: string | null;
  errorCode: string | null;
  sandboxMode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pendingApproval: { phase: string; tool: string; approvalId: string } | null;
  repository: { id: string; name: string; rootPath: string };
}

export interface Step {
  id: string;
  sequence: number;
  phase: string;
  kind: string;
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  durationMs: number | null;
}

export interface Approval {
  id: string;
  kind: string;
  prompt: string;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  payload: unknown;
}

export interface DiffFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  patch: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError('The API is not reachable. Start it with npm run dev or openengineer serve.', 0);
  }
  const text = await response.text();
  const body = text ? (JSON.parse(text) as { error?: { message?: string } }) : {};
  if (!response.ok) {
    throw new ApiError(body.error?.message ?? `Request failed (${response.status})`, response.status);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; sandbox: string; provider: string }>('/api/health'),
  repositories: () => request<{ repositories: Repository[] }>('/api/repositories'),
  addRepository: (repoPath: string) => request<Repository>('/api/repositories', { method: 'POST', body: JSON.stringify({ path: repoPath }) }),
  tasks: (repositoryId?: string) =>
    request<{ tasks: Task[] }>(repositoryId ? `/api/tasks?repositoryId=${repositoryId}` : '/api/tasks'),
  task: (id: string) => request<{ task: Task; approvals: Approval[] }>(`/api/tasks/${id}`),
  steps: (id: string) => request<{ steps: Step[] }>(`/api/tasks/${id}/steps`),
  diff: (id: string) => request<{ files: DiffFile[]; filesChanged: number; insertions: number; deletions: number; branch: string | null }>(`/api/tasks/${id}/diff`),
  createTask: (repositoryId: string, instruction: string) =>
    request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify({ repositoryId, instruction }) }),
  cancel: (id: string) => request<{ task: Task }>(`/api/tasks/${id}/cancel`, { method: 'POST', body: '{}' }),
  approval: (taskId: string, approvalId: string, decision: 'approve' | 'deny', answers: string[]) =>
    request<{ task: Task }>(`/api/tasks/${taskId}/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision, answers }),
    }),
};

export function isActive(status: string): boolean {
  return !['completed', 'failed', 'cancelled'].includes(status);
}
