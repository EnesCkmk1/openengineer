import { cp, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const source = path.resolve('examples/session-app');
const dest = path.resolve(process.argv[2] ?? '.openengineer/session-app');
await mkdir(path.dirname(dest), { recursive: true });
await cp(source, dest, { recursive: true, force: true });
await git(dest, ['init']);
await git(dest, ['config', 'user.email', 'dev@example.com']);
await git(dest, ['config', 'user.name', 'Dev']);
await git(dest, ['add', '.']);
await git(dest, ['commit', '-m', 'initial session-app fixture']);
process.stdout.write(`${dest}\n`);

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed`))));
  });
}
