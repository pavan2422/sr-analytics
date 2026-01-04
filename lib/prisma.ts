import { PrismaClient } from '@prisma/client';
import path from 'node:path';

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// Set DATABASE_URL if not already set
// On Vercel/serverless, use /tmp; otherwise use local dev.db
if (!process.env.DATABASE_URL) {
  const isServerless = Boolean(process.env.VERCEL) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (isServerless) {
    process.env.DATABASE_URL = 'file:/tmp/prisma/dev.db';
  } else {
    process.env.DATABASE_URL = `file:${path.join(process.cwd(), 'prisma', 'dev.db')}`;
  }
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') global.prisma = prisma;




