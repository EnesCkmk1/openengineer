import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OpenEngineerError, resolveBudget, type Budget } from '@openengineer/shared';
import { isInsideRoot } from './paths.js';

export interface EngineConfig {
  databaseUrl: string | null;
  host: string;
  port: number;
  sandboxMode: 'docker' | 'process';
  allowProcessSandbox: boolean;
  dockerImage: string;
  repoRoots: string[] | null;
  provider: 'openai' | 'anthropic' | 'scripted';
  openaiApiKey: string | null;
  openaiBaseUrl: string;
  openaiModel: string;
  anthropicApiKey: string | null;
  anthropicModel: string;
  scriptedFile: string | null;
  budget: Budget;
  worktreeRoot: string | null;
}

export async function loadDotEnv(file = '.env'): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const sandboxMode = env.OPENENGINEER_SANDBOX === 'process' ? 'process' : 'docker';
  const provider = env.OPENENGINEER_MODEL_PROVIDER ?? 'openai';
  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'scripted') {
    throw new OpenEngineerError(`Unsupported model provider: ${provider}`, 'validation');
  }
  const roots = env.OPENENGINEER_REPO_ROOTS?.split(':').map((item) => item.trim()).filter(Boolean);
  return {
    databaseUrl: env.DATABASE_URL ?? null,
    host: env.OPENENGINEER_HOST ?? '127.0.0.1',
    port: numberEnv(env.OPENENGINEER_PORT, 3001),
    sandboxMode,
    allowProcessSandbox: env.OPENENGINEER_ALLOW_PROCESS_SANDBOX === 'true',
    dockerImage: env.OPENENGINEER_DOCKER_IMAGE ?? 'node:22-bookworm-slim',
    repoRoots: roots && roots.length > 0 ? roots : null,
    provider,
    openaiApiKey: env.OPENAI_API_KEY || null,
    openaiBaseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    openaiModel: env.OPENAI_MODEL ?? 'gpt-4o-mini',
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
    scriptedFile: env.OPENENGINEER_SCRIPTED_FILE || null,
    budget: resolveBudget({
      maxDurationMs: numberEnv(env.OPENENGINEER_MAX_DURATION_MS, 900_000),
      maxRepairAttempts: numberEnv(env.OPENENGINEER_MAX_REPAIR_ATTEMPTS, 3),
      maxToolCalls: numberEnv(env.OPENENGINEER_MAX_TOOL_CALLS, 40),
      maxModelCalls: numberEnv(env.OPENENGINEER_MAX_MODEL_CALLS, 60),
      maxInputTokens: numberEnv(env.OPENENGINEER_MAX_INPUT_TOKENS, 2_000_000),
      maxOutputTokens: numberEnv(env.OPENENGINEER_MAX_OUTPUT_TOKENS, 200_000),
      commandTimeoutMs: numberEnv(env.OPENENGINEER_COMMAND_TIMEOUT_MS, 120_000),
    }),
    worktreeRoot: env.OPENENGINEER_WORKTREE_ROOT || null,
  };
}

export function assertRepoAllowed(config: EngineConfig, repoPath: string): string {
  const resolved = path.resolve(repoPath);
  if (!config.repoRoots) return resolved;
  const allowed = config.repoRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || isInsideRoot(resolvedRoot, resolved);
  });
  if (!allowed) {
    throw new OpenEngineerError(
      'Repository path is outside OPENENGINEER_REPO_ROOTS',
      'repo_not_allowed',
    );
  }
  return resolved;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new OpenEngineerError(`Invalid numeric environment value: ${value}`, 'validation');
  }
  return parsed;
}
