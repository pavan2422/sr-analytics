import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { ensureUploadDirs, ensureUploadSessionTmpDir } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type InitBody = {
  originalName: string;
  contentType?: string;
  sizeBytes: number;
  chunkSizeBytes: number;
};

export async function POST(req: Request) {
  const { prisma } = await import('@/lib/prisma');
  const body = (await req.json().catch(() => null)) as InitBody | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const originalName = String(body.originalName || '').trim();
  const contentType = body.contentType ? String(body.contentType) : undefined;
  const sizeBytes = Number(body.sizeBytes);
  const chunkSizeBytes = Number(body.chunkSizeBytes);

  if (!originalName) return NextResponse.json({ error: 'originalName is required' }, { status: 400 });
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return NextResponse.json({ error: 'sizeBytes must be > 0' }, { status: 400 });
  }
  // Keep chunks reasonably sized to avoid request overhead & server limits.
  if (!Number.isFinite(chunkSizeBytes) || chunkSizeBytes < 1 * 1024 * 1024 || chunkSizeBytes > 128 * 1024 * 1024) {
    return NextResponse.json({ error: 'chunkSizeBytes must be between 1MB and 128MB' }, { status: 400 });
  }

  ensureUploadDirs();
  const uploadId = crypto.randomUUID();
  ensureUploadSessionTmpDir(uploadId);

  await prisma.uploadSession.create({
    data: {
      id: uploadId,
      status: 'initiated',
      originalName,
      contentType,
      sizeBytes: BigInt(sizeBytes),
      chunkSizeBytes,
      receivedBytes: BigInt(0),
    },
  });

  return NextResponse.json({
    uploadId,
    expectedParts: Math.ceil(sizeBytes / chunkSizeBytes),
  });
}



