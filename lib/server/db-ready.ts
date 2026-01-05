import { prisma } from '@/lib/prisma';
import fs from 'node:fs';
import path from 'node:path';

declare global {
  // eslint-disable-next-line no-var
  var __srDbReadyPromise: Promise<void> | undefined;
}

function isPostgresUrl(dbUrl: string | undefined): boolean {
  const u = String(dbUrl || '').trim().toLowerCase();
  return u.startsWith('postgres://') || u.startsWith('postgresql://');
}

function isSqliteUrl(dbUrl: string | undefined): boolean {
  const u = String(dbUrl || '').trim().toLowerCase();
  // Prisma SQLite URLs are typically: file:./dev.db or file:../...
  return u.startsWith('file:') || u.includes('sqlite');
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
  // Postgres surface area: "relation \"UploadSession\" does not exist"
  if (/relation .* does not exist/i.test(msg)) return true;
  return false;
}


/**
 * Creates database tables directly using raw SQL.
 * This avoids needing the Prisma CLI at runtime, which doesn't work on Vercel.
 * 
 * Note: Prisma's $executeRawUnsafe doesn't support multiple statements in one call for SQLite,
 * so we execute each statement separately.
 */
async function createTablesDirectly(): Promise<void> {
  // Execute each statement separately - Prisma doesn't support multiple statements in one call for SQLite
  
  // 1. Create StoredFile table first (no dependencies)
  await prisma.$executeRawUnsafe(`
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
    )
  `);

  // 2. Create UploadSession table (depends on StoredFile)
  await prisma.$executeRawUnsafe(`
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
    )
  `);

  // 3. Create StoredFileAnalysis table (depends on StoredFile)
  await prisma.$executeRawUnsafe(`
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
    )
  `);

  // 4. Create indexes
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StoredFile_createdAt_idx" ON "StoredFile"("createdAt")`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "StoredFileAnalysis_storedFileId_key" ON "StoredFileAnalysis"("storedFileId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StoredFileAnalysis_status_idx" ON "StoredFileAnalysis"("status")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StoredFileAnalysis_createdAt_idx" ON "StoredFileAnalysis"("createdAt")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "UploadSession_status_idx" ON "UploadSession"("status")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "UploadSession_createdAt_idx" ON "UploadSession"("createdAt")`);
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
    const dbUrl = process.env.DATABASE_URL;
    const usingPostgres = isPostgresUrl(dbUrl);
    const usingSqlite = isSqliteUrl(dbUrl) || !dbUrl; // default local sqlite dev.db when unset

    try {
      // Ensure the database directory exists
      // On serverless, use /tmp; otherwise use project directory
      const isServerless = Boolean(process.env.VERCEL) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
      let dbDir: string;
      
      // Only relevant for SQLite file DBs.
      if (usingSqlite && isServerless) {
        dbDir = '/tmp/prisma';
      } else if (usingSqlite) {
        const dbPath = path.join(process.cwd(), 'prisma', 'dev.db');
        dbDir = path.dirname(dbPath);
      } else {
        dbDir = '';
      }
      
      if (dbDir) {
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
      }

      // Touch the DB via a model query so missing tables surface (SELECT 1 would not).
      await prisma.uploadSession.findFirst({ select: { id: true } });
      return;
    } catch (err: any) {
      // Don't try to "fix" locked DB; caller can surface retry guidance.
      if (isSqliteBusyError(err)) throw err;

      if (!isMissingTableOrSchemaError(err)) throw err;

      // If we're on Postgres (recommended for Vercel), do NOT attempt SQLite raw SQL table creation.
      // The correct fix is to run Prisma migrations (prisma migrate deploy/dev).
      if (usingPostgres) {
        throw new Error(
          `Database tables are missing. Run Prisma migrations for Postgres (e.g. "prisma migrate deploy"). ` +
          `Original error: ${String(err?.message || 'Unknown')}`
        );
      }

      // SQLite only: create tables directly using raw SQL (helps on fresh deploys without migrations).
      try {
        await createTablesDirectly();
      } catch (createErr: any) {
        throw new Error(
          `Failed to create SQLite database tables: ${createErr?.message || 'Unknown error'}. ` +
          `Original error: ${err?.message || 'Unknown'}`,
          { cause: createErr }
        );
      }
      
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


