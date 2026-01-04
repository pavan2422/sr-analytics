import { prisma } from '@/lib/prisma';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
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
  // On Vercel/serverless, node_modules might be in a different location
  const bin = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
  
  // Try multiple possible locations
  const possiblePaths = [
    path.join(process.cwd(), 'node_modules', '.bin', bin),
    path.join(__dirname, '..', '..', 'node_modules', '.bin', bin),
    path.join(process.cwd(), '..', 'node_modules', '.bin', bin),
  ];
  
  // Return the first path that exists, or the default
  for (const possiblePath of possiblePaths) {
    try {
      if (fs.existsSync(possiblePath)) {
        return possiblePath;
      }
    } catch {
      // Continue to next path
    }
  }
  
  // Fallback to default
  return path.join(process.cwd(), 'node_modules', '.bin', bin);
}

async function runMigrations(): Promise<{ stdout: string; stderr: string }> {
  const cli = prismaCliPath();
  
  // Check if CLI exists before trying to run it
  if (!fs.existsSync(cli)) {
    // On Vercel, try using npx as fallback
    const isServerless = Boolean(process.env.VERCEL) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
    if (isServerless) {
      try {
        // Use npx to run prisma (should work if prisma is in dependencies)
        const { stdout, stderr } = await execFileAsync(
          'npx',
          ['prisma', 'migrate', 'deploy', '--schema', path.join(process.cwd(), 'prisma', 'schema.prisma')],
          {
            cwd: process.cwd(),
            env: process.env,
          }
        );
        return { stdout: String(stdout || ''), stderr: String(stderr || '') };
      } catch (npxErr: any) {
        throw new Error(
          `Prisma CLI not found. Tried: ${cli} and npx prisma. Make sure "prisma" is in dependencies. Error: ${npxErr?.message || 'Unknown error'}`,
          { cause: npxErr }
        );
      }
    }
    
    throw new Error(
      `Prisma CLI not found at ${cli}. Run "npm install" (or move "prisma" from devDependencies to dependencies for production installs).`,
    );
  }
  
  try {
    const { stdout, stderr } = await execFileAsync(
      cli,
      ['migrate', 'deploy', '--schema', path.join(process.cwd(), 'prisma', 'schema.prisma')],
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


