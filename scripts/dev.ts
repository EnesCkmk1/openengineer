import { spawn } from 'node:child_process';

const env = process.env;
const api = spawn(process.execPath, ['--import', 'tsx', 'packages/api/src/main.ts'], { stdio: 'inherit', env });
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'packages/web/vite.config.ts'], {
  stdio: 'inherit',
  env,
});

const stop = () => {
  api.kill('SIGTERM');
  web.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', (code) => {
  web.kill('SIGTERM');
  process.exit(code ?? 0);
});
web.on('exit', (code) => {
  api.kill('SIGTERM');
  process.exit(code ?? 0);
});
