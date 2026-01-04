import { prisma } from '@/lib/prisma';
import fs from 'node:fs';
import path from 'node:path';

declare global {
  // eslint-disable-next-line no-var
  var __srDbReadyPromise: Promise<void> | undefined;
}

function isSqliteBusyError(err: any): boolean {
  const msg = String(err?.message || '');
  return msg.includes('SQLITE_BUSY') || /database is locked/i.test(msg);
}

function isMissingTableOrSchemaError(err: any): boolean {
  const msg = String(err?.message || '');
  // Prisma known request error code for "table does not exist" (commonly seen after missing migrations)
  if (err?.code === 'P2021') return true;
  // SQLite surface area: "no such table: UploadSession"
  if (/no such table/i.test(msg)) return true;
  // Sometimes shows up as "The table `main.UploadSession` does not exist"
  if (/table .* does not exist/i.test(msg)) return true;
  return false;
}


/**
 * Creates database tables directly using raw SQL.
 * This avoids needing the Prisma CLI at runtime, which doesn't work on Vercel.
 */
async function createTablesDirectly(): Promise<void> {
  // SQL from the migration file, with IF NOT EXISTS to be idempotent
  // Note: SQLite uses INTEGER for BigInt values
  const sql = `
    CREATE TABLE IF NOT EXISTS "StoredFile" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "originalName" TEXT NOT NULL,
        "storedName" TEXT NOT NULL,
        "contentType" TEXT,
        "sizeBytes" INTEGER NOT NULL,
        "sha256Hex" TEXT,
        "storageBackend" TEXT NOT NULL,
        "storagePath" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS "StoredFileAnalysis" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "status" TEXT NOT NULL,
        "processedRows" INTEGER NOT NULL DEFAULT 0,
        "totalRows" INTEGER,
        "resultJson" TEXT,
        "error" TEXT,
        "startedAt" DATETIME,
        "completedAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "storedFileId" TEXT NOT NULL,
        CONSTRAINT "StoredFileAnalysis_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "StoredFile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "UploadSession" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "status" TEXT NOT NULL,
        "originalName" TEXT NOT NULL,
        "contentType" TEXT,
        "sizeBytes" INTEGER NOT NULL,
        "chunkSizeBytes" INTEGER NOT NULL,
        "receivedBytes" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "completedAt" DATETIME,
        "storedFileId" TEXT,
        CONSTRAINT "UploadSession_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "StoredFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );

    CREATE INDEX IF NOT EXISTS "StoredFile_createdAt_idx" ON "StoredFile"("createdAt");
    CREATE UNIQUE INDEX IF NOT EXISTS "StoredFileAnalysis_storedFileId_key" ON "StoredFileAnalysis"("storedFileId");
    CREATE INDEX IF NOT EXISTS "StoredFileAnalysis_status_idx" ON "StoredFileAnalysis"("status");
    CREATE INDEX IF NOT EXISTS "StoredFileAnalysis_createdAt_idx" ON "StoredFileAnalysis"("createdAt");
    CREATE INDEX IF NOT EXISTS "UploadSession_status_idx" ON "UploadSession"("status");
    CREATE INDEX IF NOT EXISTS "UploadSession_createdAt_idx" ON "UploadSession"("createdAt");
  `;

  // Execute the SQL using Prisma's $executeRawUnsafe
  await prisma.$executeRawUnsafe(sql);
}

/**
 * Ensures the SQLite DB file exists and required tables are present.
 *
 * If tables are missing, it will create them directly using raw SQL.
 * This avoids needing the Prisma CLI at runtime (which doesn't work on Vercel).
 *
 * NOTE: This is intentionally "best effort" and primarily meant to prevent opaque 500s
 * when a fresh deployment runs without pre-migrated database.
 */
export async function ensureDatabaseReady(): Promise<void> {
  if (global.__srDbReadyPromise) return global.__srDbReadyPromise;

  global.__srDbReadyPromise = (async () => {
    try {
      // Ensure the database directory exists
      // On serverless, use /tmp; otherwise use project directory
      const isServerless = Boolean(process.env.VERCEL) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
      let dbDir: string;
      
      if (isServerless) {
        dbDir = '/tmp/prisma';
      } else {
        const dbPath = path.join(process.cwd(), 'prisma', 'dev.db');
        dbDir = path.dirname(dbPath);
      }
      
      try {
        fs.mkdirSync(dbDir, { recursive: true });
      } catch (e: any) {
        // Ignore if directory already exists
        if (e?.code !== 'EEXIST') {
          // Only throw if it's a different error
          if (!e?.message?.includes('already exists')) {
            throw e;
          }
        }
      }

      // Touch the DB via a model query so missing tables surface (SELECT 1 would not).
      await prisma.uploadSession.findFirst({ select: { id: true } });
      return;
    } catch (err: any) {
      // Don't try to "fix" locked DB; caller can surface retry guidance.
      if (isSqliteBusyError(err)) throw err;

      if (!isMissingTableOrSchemaError(err)) throw err;

      // Tables are missing - create them directly using raw SQL
      // This avoids needing Prisma CLI which doesn't work on Vercel
      await createTablesDirectly();
      
      // Verify tables were created by trying the query again
      await prisma.uploadSession.findFirst({ select: { id: true } });
    }
  })().catch((err) => {
    // If we failed, allow subsequent requests to retry (don't keep a permanently rejected promise).
    global.__srDbReadyPromise = undefined;
    throw err;
  });

  return global.__srDbReadyPromise;
}


