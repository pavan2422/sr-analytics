import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { getUploadSessionTmpDir, listReceivedParts } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
  const { prisma } = await import('@/lib/prisma');
  const session = await prisma.uploadSession.findUnique({
    where: { id: uploadId },
    include: { storedFile: true },
  });

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



