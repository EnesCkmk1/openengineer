import { spawn } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenEngineerError } from '@openengineer/shared';
import { isInsideRoot } from './paths.js';

export interface CommandRequest {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  network: boolean;
  maxOutputBytes?: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  sandboxMode: 'docker' | 'process';
}

export interface Sandbox {
  mode: 'docker' | 'process';
  secure: boolean;
  warning: string | null;
  run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult>;
}

const PROCESS_WARNING =
  'Process sandbox is not a security boundary. Commands run as the current OS user with a filtered environment, an allowlist, and a timeout. Install Docker and use OPENENGINEER_SANDBOX=docker before running untrusted repositories.';

export async function createSandbox(options: {
  mode: 'docker' | 'process';
  allowProcessSandbox: boolean;
  dockerImage: string;
}): Promise<Sandbox> {
  if (options.mode === 'process') {
    if (!options.allowProcessSandbox) {
      throw new OpenEngineerError(
        'Refusing to execute commands in process mode. Set OPENENGINEER_ALLOW_PROCESS_SANDBOX=true only if you accept that this mode does not isolate code from the host.',
        'sandbox_unavailable',
      );
    }
    return new ProcessSandbox();
  }
  if (!(await commandExists('docker'))) {
    throw new OpenEngineerError(
      'Docker is not available, so OpenEngineer will not run commands on the host. Install Docker, pull the configured image, or explicitly opt in to the non-isolating process sandbox.',
      'sandbox_unavailable',
    );
  }
  const sandbox = new DockerSandbox(options.dockerImage);
  await sandbox.assertImage();
  return sandbox;
}

class ProcessSandbox implements Sandbox {
  readonly mode = 'process' as const;
  readonly secure = false;
  readonly warning = PROCESS_WARNING;

  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    const cwd = await realpath(request.cwd);
    const home = await mkdtemp(path.join(os.tmpdir(), 'oe-home-'));
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'oe-tmp-'));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HOME: home,
      TMPDIR: tmp,
      NODE_ENV: 'test',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      NO_COLOR: '1',
    };
    return spawnCaptured(request.argv, { cwd, env, timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes ?? 200_000, signal, mode: 'process' });
  }
}

class DockerSandbox implements Sandbox {
  readonly mode = 'docker' as const;
  readonly secure = false;
  readonly warning =
    'Docker isolates the command mount, network, and capabilities, but it is not a complete security boundary. Containers share the host kernel, and repository contents inside the mount are still readable by the command.';

  constructor(private readonly image: string) {}

  async assertImage(): Promise<void> {
    const result = await spawnCaptured(['docker', 'image', 'inspect', this.image], {
      cwd: os.tmpdir(),
      env: process.env,
      timeoutMs: 20_000,
      maxOutputBytes: 20_000,
      mode: 'docker',
    });
    if (result.exitCode !== 0) {
      throw new OpenEngineerError(
        `Docker image ${this.image} is not available locally. Pull it before running tasks. OpenEngineer does not pull images implicitly.`,
        'sandbox_unavailable',
      );
    }
  }

  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    const cwd = await realpath(request.cwd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    const argv = [
      'docker',
      'run',
      '--rm',
      '--init',
      '--network',
      request.network ? 'bridge' : 'none',
      '--memory',
      '1g',
      '--cpus',
      '1',
      '--pids-limit',
      '256',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=128m',
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
      '-v',
      `${cwd}:/workspace:rw`,
      '-w',
      '/workspace',
      '--user',
      `${uid}:${gid}`,
      this.image,
      ...request.argv,
    ];
    return spawnCaptured(argv, {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH ?? '', HOME: os.homedir(), LANG: 'C.UTF-8' },
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes ?? 200_000,
      signal,
      mode: 'docker',
    });
  }
}

async function spawnCaptured(
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    mode: 'docker' | 'process';
  },
): Promise<CommandResult> {
  const started = Date.now();
  const [bin, ...args] = argv;
  if (!bin) throw new OpenEngineerError('Cannot execute an empty command', 'command_denied');
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const take = (chunk: Buffer, target: Buffer[]) => {
      if (size >= options.maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = options.maxOutputBytes - size;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (slice.length < chunk.length) truncated = true;
      target.push(slice);
      size += slice.length;
    };
    child.stdout?.on('data', (chunk: Buffer) => take(chunk, stdout));
    child.stderr?.on('data', (chunk: Buffer) => take(chunk, stderr));
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => {
      timedOut = true;
      kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const stderrText = Buffer.concat(stderr).toString('utf8');
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: truncated ? `${stderrText}\n[output truncated]` : stderrText,
        durationMs: Date.now() - started,
        timedOut,
        truncated,
        sandboxMode: options.mode,
      });
    });
  });
}

export async function commandExists(bin: string): Promise<boolean> {
  const result = await spawnCaptured(['sh', '-c', `command -v ${bin}`], {
    cwd: os.tmpdir(),
    env: process.env,
    timeoutMs: 5_000,
    maxOutputBytes: 2_000,
    mode: 'process',
  }).catch(() => null);
  return Boolean(result && result.exitCode === 0 && result.stdout.trim());
}

export function assertCwdInside(root: string, cwd: string): void {
  if (!isInsideRoot(root, cwd) && path.resolve(root) !== path.resolve(cwd)) {
    throw new OpenEngineerError(`Refusing to execute outside ${root}`, 'path_escape');
  }
}
