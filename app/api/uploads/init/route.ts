import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { ensureUploadDirs, ensureUploadSessionTmpDir } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type InitBody = {
  originalName: string;
  contentType?: string;
  sizeBytes: number;
  chunkSizeBytes: number;
};

export async function POST(req: Request) {
  try {
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
  // Vercel has a 4.5MB body size limit, so we cap at 4MB to be safe
  const maxChunkSize = process.env.VERCEL ? 4 * 1024 * 1024 : 128 * 1024 * 1024;
  if (!Number.isFinite(chunkSizeBytes) || chunkSizeBytes < 1 * 1024 * 1024 || chunkSizeBytes > maxChunkSize) {
    return NextResponse.json({ 
      error: `chunkSizeBytes must be between 1MB and ${Math.floor(maxChunkSize / 1024 / 1024)}MB`,
      maxChunkSize,
      vercel: Boolean(process.env.VERCEL)
    }, { status: 400 });
  }

    try {
      ensureUploadDirs();
    } catch (e: any) {
      return NextResponse.json(
        {
          error: 'Failed to create upload directories',
          code: e?.code,
          path: e?.path,
          message: e?.message,
        },
        { status: 500 }
      );
    }

    const uploadId = crypto.randomUUID();
    try {
      ensureUploadSessionTmpDir(uploadId);
    } catch (e: any) {
      return NextResponse.json(
        {
          error: 'Failed to create upload temp directory',
          uploadId,
          code: e?.code,
          path: e?.path,
          message: e?.message,
        },
        { status: 500 }
      );
    }

    try {
      await ensureDatabaseReady();
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
    } catch (e: any) {
      const msg = String(e?.message || '');
      const isLocked = msg.includes('SQLITE_BUSY') || /database is locked/i.test(msg);
      const status = isLocked ? 503 : 500;
      return NextResponse.json(
        {
          error: isLocked ? 'Database is locked. Please retry.' : 'Failed to initialize upload session',
          uploadId,
          prismaCode: e?.code,
          message: msg || undefined,
        },
        { status }
      );
    }

    return NextResponse.json({
      uploadId,
      expectedParts: Math.ceil(sizeBytes / chunkSizeBytes),
    });
  } catch (e: any) {
    // Catch any unhandled errors
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error during upload initialization',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}



