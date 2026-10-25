import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

const envFile = path.resolve('.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
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

export default defineConfig({
  schema: 'packages/db/prisma/schema.prisma',
  migrations: {
    path: 'packages/db/prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
