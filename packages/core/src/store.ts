import type {
  ApprovalResolution,
  Budget,
  Checkpoint,
  Plan,
  RepoDetection,
  TaskStatus,
  Usage,
  VerificationReport,
} from '@openengineer/shared';

export interface RepositoryRecord {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string | null;
  headCommit: string | null;
  language: string | null;
  packageManager: string | null;
  testFramework: string | null;
  detection: RepoDetection | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRecord {
  id: string;
  repositoryId: string;
  instruction: string;
  title: string;
  status: TaskStatus;
  baseCommit: string | null;
  branch: string | null;
  worktreePath: string | null;
  plan: Plan | null;
  checkpoint: Checkpoint | null;
  verification: VerificationReport | null;
  usage: Usage | null;
  budget: Budget;
  error: string | null;
  errorCode: string | null;
  cancelRequested: boolean;
  runnerId: string | null;
  heartbeatAt: Date | null;
  sandboxMode: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  repository: RepositoryRecord;
}

export interface AgentStepRecord {
  id: string;
  taskId: string;
  sequence: number;
  phase: string;
  kind: string;
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  kind: string;
  prompt: string;
  payload: unknown;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  resolution: ApprovalResolution | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface RepositoryPatch {
  defaultBranch?: string | null;
  headCommit?: string | null;
  language?: string | null;
  packageManager?: string | null;
  testFramework?: string | null;
  detection?: RepoDetection | null;
  name?: string;
}

export interface TaskPatch {
  status?: TaskStatus;
  title?: string;
  baseCommit?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  plan?: Plan | null;
  checkpoint?: Checkpoint | null;
  verification?: VerificationReport | null;
  usage?: Usage | null;
  error?: string | null;
  errorCode?: string | null;
  cancelRequested?: boolean;
  runnerId?: string | null;
  heartbeatAt?: Date | null;
  sandboxMode?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export interface TaskStore {
  createRepository(input: { name: string; rootPath: string }): Promise<RepositoryRecord>;
  listRepositories(): Promise<RepositoryRecord[]>;
  getRepository(id: string): Promise<RepositoryRecord | null>;
  getRepositoryByPath(rootPath: string): Promise<RepositoryRecord | null>;
  updateRepository(id: string, patch: RepositoryPatch): Promise<RepositoryRecord>;
  createTask(input: {
    repositoryId: string;
    instruction: string;
    title: string;
    budget: Budget;
  }): Promise<TaskRecord>;
  getTask(id: string): Promise<TaskRecord | null>;
  listTasks(repositoryId?: string): Promise<TaskRecord[]>;
  updateTask(id: string, patch: TaskPatch): Promise<TaskRecord>;
  claim(id: string, runnerId: string, staleMs: number): Promise<void>;
  heartbeat(id: string, runnerId: string): Promise<void>;
  release(id: string, runnerId: string): Promise<void>;
  listStale(cutoff: Date): Promise<TaskRecord[]>;
  isCancelRequested(id: string): Promise<boolean>;
  appendStep(input: {
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
  }): Promise<AgentStepRecord>;
  listSteps(taskId: string): Promise<AgentStepRecord[]>;
  createApproval(input: {
    taskId: string;
    kind: string;
    prompt: string;
    payload: unknown;
  }): Promise<ApprovalRecord>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  listApprovals(taskId: string): Promise<ApprovalRecord[]>;
  resolveApproval(id: string, resolution: ApprovalResolution): Promise<ApprovalRecord>;
  closeApprovalStep(taskId: string, approvalId: string, status: 'approved' | 'denied' | 'cancelled'): Promise<void>;
  cancelOpenApprovals(taskId: string): Promise<void>;
}
