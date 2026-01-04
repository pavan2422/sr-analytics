import { prisma } from '@/lib/prisma';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

function prismaCliPath(): string {
  // On Windows, npm creates prisma.cmd in node_modules/.bin.
  const bin = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
  return path.join(process.cwd(), 'node_modules', '.bin', bin);
}

async function runMigrations(): Promise<{ stdout: string; stderr: string }> {
  const cli = prismaCliPath();
  try {
    const { stdout, stderr } = await execFileAsync(
      cli,
      ['migrate', 'deploy', '--schema', path.join('prisma', 'schema.prisma')],
      {
        cwd: process.cwd(),
        env: process.env,
      }
    );
    return { stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new Error(
        `Prisma CLI not found at ${cli}. Run "npm install" (or move "prisma" from devDependencies to dependencies for production installs).`,
        { cause: err }
      );
    }
    throw err;
  }
}

/**
 * Ensures the SQLite DB file exists and required tables are present.
 *
 * If tables are missing, it will attempt to apply migrations (`prisma migrate deploy`)
 * and then retry a lightweight query.
 *
 * NOTE: This is intentionally "best effort" and primarily meant to prevent opaque 500s
 * when a fresh checkout runs without `prisma migrate ...`.
 */
export async function ensureDatabaseReady(): Promise<void> {
  if (global.__srDbReadyPromise) return global.__srDbReadyPromise;

  global.__srDbReadyPromise = (async () => {
    try {
      // Touch the DB via a model query so missing tables surface (SELECT 1 would not).
      await prisma.uploadSession.findFirst({ select: { id: true } });
      return;
    } catch (err: any) {
      // Don't try to "fix" locked DB; caller can surface retry guidance.
      if (isSqliteBusyError(err)) throw err;

      if (!isMissingTableOrSchemaError(err)) throw err;

      // Apply migrations once, then re-check.
      await runMigrations();
      await prisma.uploadSession.findFirst({ select: { id: true } });
    }
  })().catch((err) => {
    // If we failed, allow subsequent requests to retry (don't keep a permanently rejected promise).
    global.__srDbReadyPromise = undefined;
    throw err;
  });

  return global.__srDbReadyPromise;
}


