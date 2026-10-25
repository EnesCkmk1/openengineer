import path from 'node:path';
import { OpenEngineerError } from '@openengineer/shared';
import { isInsideRoot } from './paths.js';

export type PolicyDecision =
  | { action: 'allow'; argv: string[]; network: false; display: string }
  | { action: 'approve'; argv: string[]; network: boolean; display: string; reason: string }
  | { action: 'deny'; reason: string };

const ALLOWED_NPM_SCRIPTS = new Set(['test', 'lint', 'typecheck', 'build', 'check']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show']);

export function classifyCommand(command: string, cwd: string): PolicyDecision {
  const argv = tokenize(command);
  if (!argv) {
    return {
      action: 'deny',
      reason: 'Command contains shell syntax. OpenEngineer only runs a single argv without pipes, substitutions, or separators.',
    };
  }
  const display = argv.join(' ');
  const [bin, ...args] = argv;
  if (!bin) return { action: 'deny', reason: 'Empty command' };

  if (bin === 'sudo' || bin === 'su' || bin === 'doas') {
    return { action: 'deny', reason: 'Privileged escalation is not available to the agent' };
  }
  if (bin === 'git' && args.some((arg) => arg === '-C' || arg === '--git-dir' || arg === '--work-tree' || arg.startsWith('--git-dir=') || arg.startsWith('--work-tree='))) {
    return { action: 'deny', reason: 'git commands that retarget the repository are denied' };
  }
  if (bin === 'git' && args[0] === 'push' && args.some((arg) => arg === '--force' || arg === '--force-with-lease' || arg.startsWith('-f'))) {
    return { action: 'deny', reason: 'Force pushing is denied' };
  }
  if (bin === 'rm' && (args.includes('/') || args.some((arg) => arg === '/.' || arg.startsWith('/*')))) {
    return { action: 'deny', reason: 'Refusing a deletion that targets the filesystem root' };
  }
  if (bin === 'git' && args[0] === 'reset' && args.includes('--hard')) {
    return { action: 'deny', reason: 'git reset --hard is denied because it discards work' };
  }

  const pathError = pathArgumentsStayInside(cwd, bin, args);
  if (pathError) return { action: 'deny', reason: pathError };

  if (isAllowlisted(bin, args)) {
    return { action: 'allow', argv, network: false, display };
  }

  const approval = approvalReason(bin, args);
  if (approval) {
    return { action: 'approve', argv, network: approval.network, display, reason: approval.reason };
  }

  return {
    action: 'deny',
    reason: `Command is not on the allowlist: ${display}. Allowed commands are project test, lint, typecheck, build, and read-only git inspection.`,
  };
}

function isAllowlisted(bin: string, args: string[]): boolean {
  if ((bin === 'npm' || bin === 'pnpm') && args[0] === 'test') return true;
  if ((bin === 'npm' || bin === 'pnpm') && args[0] === 'run' && ALLOWED_NPM_SCRIPTS.has(args[1] ?? '')) return true;
  if (bin === 'yarn' && ALLOWED_NPM_SCRIPTS.has(args[0] ?? '')) return true;
  if (bin === 'node' && args[0] === '--test') return true;
  if (bin === 'node' && args[0] === '--check' && args.length === 2) return true;
  if (bin === 'git' && READ_ONLY_GIT.has(args[0] ?? '')) return true;
  if (bin === 'npx' && (args[0] === 'vitest' || args[0] === 'tsc' || args[0] === 'eslint')) return true;
  return false;
}

function approvalReason(bin: string, args: string[]): { network: boolean; reason: string } | null {
  if (['curl', 'wget', 'ssh', 'scp', 'nc', 'ping', 'dig'].includes(bin)) {
    return { network: true, reason: `${bin} requires network access` };
  }
  if ((bin === 'npm' || bin === 'pnpm' || bin === 'yarn') && ['install', 'ci', 'add', 'update', 'i'].includes(args[0] ?? '')) {
    return { network: true, reason: 'Package installation can access the network and mutate dependencies' };
  }
  if (bin === 'git' && args[0] === 'push') {
    return { network: true, reason: 'git push publishes commits and is never done automatically' };
  }
  if (bin === 'git' && ['reset', 'clean', 'checkout', 'switch'].includes(args[0] ?? '')) {
    return { network: false, reason: 'This git command can discard or move work' };
  }
  if (bin === 'rm' || bin === 'chmod' || bin === 'chown' || bin === 'docker') {
    return { network: false, reason: `${bin} is a potentially destructive or privileged operation` };
  }
  return null;
}

function pathArgumentsStayInside(cwd: string, bin: string, args: string[]): string | null {
  for (const arg of args) {
    if (arg.startsWith('-') && !arg.startsWith('./') && !arg.startsWith('../')) continue;
    if (!(arg.includes('/') || arg.startsWith('.'))) continue;
    if (bin === 'git' && (arg.includes('..') && !arg.startsWith('.'))) continue;
    const resolved = path.resolve(cwd, arg);
    if (!isInsideRoot(cwd, resolved)) {
      return `Argument ${arg} resolves outside the task worktree`;
    }
  }
  return null;
}

export function tokenize(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (/[;&|`$<>\\\n\r]/.test(trimmed)) return null;
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of trimmed) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (current) {
        argv.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote) return null;
  if (current) argv.push(current);
  return argv.length > 0 ? argv : null;
}

export function assertArgvInside(cwd: string, argv: string[]): void {
  const decision = classifyCommand(argv.join(' '), cwd);
  if (decision.action === 'deny') {
    throw new OpenEngineerError(decision.reason, 'command_denied');
  }
}
