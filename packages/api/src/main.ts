import { existsSync } from 'node:fs';
import path from 'node:path';
import { createModel, loadConfig, loadDotEnv, recoverInterruptedTasks } from '@openengineer/core';
import { getPrismaClient, PrismaTaskStore } from '@openengineer/db';
import { buildServer } from './server.js';

const staticCandidates = [
  process.env.OPENENGINEER_STATIC_DIR,
  path.resolve('packages/web/dist'),
].filter((dir): dir is string => Boolean(dir));

async function main(): Promise<void> {
  await loadDotEnv(process.env.OPENENGINEER_ENV_FILE ?? '.env');
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required. Copy .env.example to .env and start PostgreSQL.');
  }
  process.env.DATABASE_URL = config.databaseUrl;
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'OpenEngineer has no authentication. Do not expose this port beyond localhost.',
        host: config.host,
      }),
    );
  }
  const store = new PrismaTaskStore(getPrismaClient());
  const recovered = await recoverInterruptedTasks(store);
  if (recovered.length > 0) {
    console.log(JSON.stringify({ msg: 'marked interrupted tasks as failed', tasks: recovered }));
  }
  const staticDir = staticCandidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? null;
  const app = await buildServer({
    store,
    config,
    modelFactory: () => createModel(config),
    logger: true,
    staticDir,
  });
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
