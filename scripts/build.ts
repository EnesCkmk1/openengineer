import { chmod } from 'node:fs/promises';
import { build } from 'esbuild';

const external = ['@prisma/client', '@prisma/adapter-pg', 'pg', 'fastify', '@fastify/cors', '@fastify/static'];
const common = {
  bundle: true,
  platform: 'node' as const,
  target: 'node22',
  format: 'esm' as const,
  external,
};

await build({
  ...common,
  entryPoints: ['packages/cli/src/index.ts'],
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
});
await build({
  ...common,
  entryPoints: ['packages/api/src/main.ts'],
  outfile: 'dist/api.js',
});
await chmod('dist/cli.js', 0o755);
console.log('built dist/cli.js and dist/api.js');
