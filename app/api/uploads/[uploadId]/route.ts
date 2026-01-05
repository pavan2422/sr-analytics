import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { getUploadSessionTmpDir, listReceivedParts } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
  const { prisma } = await import('@/lib/prisma');

  try {
    await ensureDatabaseReady();
  } catch (e: any) {
    const msg = String(e?.message || '');
    const isLocked = msg.includes('SQLITE_BUSY') || /database is locked/i.test(msg);
    return NextResponse.json(
      { error: isLocked ? 'Database is locked. Please retry.' : 'Database not ready', prismaCode: e?.code, message: msg },
      { status: isLocked ? 503 : 500 }
    );
  }

  // Retry logic to handle race conditions on serverless platforms where
  // session creation might not be immediately visible
  let session = null;
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    session = await prisma.uploadSession.findUnique({
      where: { id: uploadId },
      include: { storedFile: true },
    });

    if (session) {
      break; // Session found, exit retry loop
    }

    // If not found and we have retries left, wait a bit before retrying
    if (attempt < maxRetries - 1) {
      // Exponential backoff: 100ms, 200ms, 400ms, 800ms
      await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
    }
  }

  if (!session) return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });

  const receivedParts = listReceivedParts(uploadId);
  const tmpDirExists = fs.existsSync(getUploadSessionTmpDir(uploadId));

  return NextResponse.json({
    id: session.id,
    status: session.status,
    originalName: session.originalName,
    contentType: session.contentType,
    sizeBytes: Number(session.sizeBytes),
    chunkSizeBytes: session.chunkSizeBytes,
    receivedBytes: Number(session.receivedBytes),
    expectedParts: Math.ceil(Number(session.sizeBytes) / session.chunkSizeBytes),
    receivedParts,
    tmpDirExists,
    storedFileId: session.storedFileId,
    storedFile: session.storedFile
      ? {
          id: session.storedFile.id,
          originalName: session.storedFile.originalName,
          sizeBytes: Number(session.storedFile.sizeBytes),
          sha256Hex: session.storedFile.sha256Hex,
          storageBackend: session.storedFile.storageBackend,
          storagePath: session.storedFile.storagePath,
          createdAt: session.storedFile.createdAt,
        }
      : null,
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
  const { prisma } = await import('@/lib/prisma');

  try {
    await ensureDatabaseReady();
  } catch (e: any) {
    const msg = String(e?.message || '');
    const isLocked = msg.includes('SQLITE_BUSY') || /database is locked/i.test(msg);
    return NextResponse.json(
      { error: isLocked ? 'Database is locked. Please retry.' : 'Database not ready', prismaCode: e?.code, message: msg },
      { status: isLocked ? 503 : 500 }
    );
  }

  const session = await prisma.uploadSession.findUnique({ where: { id: uploadId } });
  if (!session) return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });

  // Best-effort cleanup of temp dir; we still mark the session failed.
  try {
    fs.rmSync(getUploadSessionTmpDir(uploadId), { recursive: true, force: true });
  } catch {
    // ignore
  }

  await prisma.uploadSession.update({
    where: { id: uploadId },
    data: { status: 'failed' },
  });

  return NextResponse.json({ ok: true });
}



