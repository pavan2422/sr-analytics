import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// This app now uses Postgres (recommended for Vercel). Require DATABASE_URL.
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. This app requires a Postgres connection string. ' +
      'Set DATABASE_URL (and optionally DIRECT_URL) in your environment.'
  );
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') global.prisma = prisma;




