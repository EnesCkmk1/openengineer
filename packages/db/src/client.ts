import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client/client.js';

const globalForPrisma = globalThis as unknown as { openengineerPrisma?: PrismaClient };

export function createPrismaClient(databaseUrl = process.env.DATABASE_URL): PrismaClient {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to create a Prisma client');
  }
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({
    adapter,
    log: process.env.OPENENGINEER_PRISMA_LOG === '1' ? ['error', 'warn'] : ['error'],
  });
}

export function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.openengineerPrisma) {
    globalForPrisma.openengineerPrisma = createPrismaClient();
  }
  return globalForPrisma.openengineerPrisma;
}
