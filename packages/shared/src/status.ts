import { OpenEngineerError } from './errors.js';

export const TASK_STATUSES = [
  'queued',
  'inspecting',
  'planning',
  'implementing',
  'testing',
  'repairing',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'awaiting_approval',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['inspecting', 'cancelled', 'failed'],
  inspecting: ['planning', 'cancelled', 'failed'],
  planning: ['implementing', 'awaiting_approval', 'cancelled', 'failed'],
  awaiting_approval: ['planning', 'implementing', 'repairing', 'testing', 'cancelled', 'failed'],
  implementing: ['testing', 'awaiting_approval', 'cancelled', 'failed'],
  testing: ['repairing', 'verifying', 'cancelled', 'failed'],
  repairing: ['testing', 'awaiting_approval', 'cancelled', 'failed'],
  verifying: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function isRunningStatus(status: TaskStatus): boolean {
  return (
    status === 'inspecting' ||
    status === 'planning' ||
    status === 'implementing' ||
    status === 'testing' ||
    status === 'repairing' ||
    status === 'verifying'
  );
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new OpenEngineerError(`Cannot transition a task from ${from} to ${to}`, 'invalid_transition', {
      from,
      to,
    });
  }
}
