import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// Set DATABASE_URL if not already set and ensure database directory exists
// On Vercel/serverless, use /tmp; otherwise use local dev.db
if (!process.env.DATABASE_URL) {
  const isServerless = Boolean(process.env.VERCEL) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  let dbPath: string;
  let dbDir: string;
  
  if (isServerless) {
    dbPath = '/tmp/prisma/dev.db';
    dbDir = '/tmp/prisma';
  } else {
    dbPath = path.join(process.cwd(), 'prisma', 'dev.db');
    dbDir = path.dirname(dbPath);
  }
  
  // CRITICAL: Create directory BEFORE setting DATABASE_URL
  // Prisma will try to open the database file immediately, so the directory must exist
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (e: any) {
    // Ignore if directory already exists
    if (e?.code !== 'EEXIST' && !e?.message?.includes('already exists')) {
      // Only throw if it's a real error (not just "already exists")
      if (!fs.existsSync(dbDir)) {
        throw e;
      }
    }
  }
  
  process.env.DATABASE_URL = `file:${dbPath}`;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') global.prisma = prisma;




