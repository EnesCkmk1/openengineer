import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenEngineerError } from '@openengineer/shared';

export interface GitStatus {
  isRepo: boolean;
  headCommit: string | null;
  branch: string | null;
  dirty: boolean;
  porcelain: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new OpenEngineerError(
      `git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
      'git_error',
    );
  }
  return result.stdout;
}

async function runGit(cwd: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
  };
}

export async function assertGitRepo(repoPath: string): Promise<void> {
  const result = await runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (result.exitCode !== 0 || result.stdout.trim() !== 'true') {
    throw new OpenEngineerError(`${repoPath} is not a git repository`, 'not_a_git_repo');
  }
}

export async function inspectGit(repoPath: string): Promise<GitStatus> {
  await assertGitRepo(repoPath);
  const headResult = await runGit(repoPath, ['rev-parse', 'HEAD']);
  if (headResult.exitCode !== 0) {
    throw new OpenEngineerError('The repository has no commits yet. Commit a base revision before starting a task.', 'not_a_git_repo');
  }
  const branchResult = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = (await git(repoPath, ['status', '--porcelain'])).trimEnd();
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of porcelain.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === '??') untracked.push(file);
    else {
      if (code[0] !== ' ') staged.push(file);
      if (code[1] !== ' ') unstaged.push(file);
    }
  }
  return {
    isRepo: true,
    headCommit: headResult.stdout.trim(),
    branch: branchResult.stdout.trim(),
    dirty: porcelain.length > 0,
    porcelain,
    staged,
    unstaged,
    untracked,
  };
}

export function worktreePathFor(taskId: string, root = process.env.OPENENGINEER_WORKTREE_ROOT): string {
  const base = root && root.trim() ? root : path.join(os.homedir(), '.openengineer', 'worktrees');
  const safe = taskId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(base, safe);
}

export async function createTaskWorktree(input: {
  repoPath: string;
  taskId: string;
  branch: string;
  worktreeRoot?: string;
}): Promise<{ worktreePath: string; baseCommit: string; branch: string }> {
  const status = await inspectGit(input.repoPath);
  if (!status.headCommit) {
    throw new OpenEngineerError('Cannot create a worktree without a HEAD commit', 'not_a_git_repo');
  }
  const worktreePath = worktreePathFor(input.taskId, input.worktreeRoot);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await git(input.repoPath, ['worktree', 'add', '-b', input.branch, worktreePath, status.headCommit]);
  return { worktreePath, baseCommit: status.headCommit, branch: input.branch };
}

export async function commitWorktree(worktreePath: string, message: string): Promise<string | null> {
  const status = await git(worktreePath, ['status', '--porcelain']);
  const files = status
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((file) => !isUnsafeToCommit(file));
  if (files.length === 0) return null;
  await git(worktreePath, ['add', '--', ...files]);
  const staged = await git(worktreePath, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) return null;
  await git(worktreePath, [
    '-c',
    'user.email=openengineer@localhost',
    '-c',
    'user.name=OpenEngineer',
    'commit',
    '-m',
    message,
  ]);
  return (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
}

function isUnsafeToCommit(file: string): boolean {
  const norm = file.replaceAll('\\', '/');
  return (
    norm === '.env' ||
    norm.startsWith('.env.') ||
    norm.includes('/.ssh/') ||
    norm.endsWith('.pem') ||
    norm.includes('id_rsa') ||
    norm.startsWith('node_modules/') ||
    norm.includes('/node_modules/')
  );
}

export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{
    path: string;
    status: string;
    insertions: number;
    deletions: number;
    patch: string;
  }>;
}

export async function collectDiff(worktreePath: string, baseCommit: string): Promise<DiffSummary> {
  const nameStatus = (await git(worktreePath, ['diff', '--name-status', baseCommit])).trim();
  const numstat = (await git(worktreePath, ['diff', '--numstat', baseCommit])).trim();
  const counts = new Map<string, { insertions: number; deletions: number }>();
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [add, del, file] = line.split('\t');
    if (!file) continue;
    counts.set(file, {
      insertions: add === '-' ? 0 : Number(add),
      deletions: del === '-' ? 0 : Number(del),
    });
  }
  const files: DiffSummary['files'] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t');
    if (!status || !file) continue;
    const count = counts.get(file) ?? { insertions: 0, deletions: 0 };
    insertions += count.insertions;
    deletions += count.deletions;
    const patch = await git(worktreePath, ['diff', baseCommit, '--', file]);
    files.push({
      path: file,
      status,
      insertions: count.insertions,
      deletions: count.deletions,
      patch: patch.length > 80_000 ? `${patch.slice(0, 80_000)}\n... truncated` : patch,
    });
  }
  return { filesChanged: files.length, insertions, deletions, files };
}
