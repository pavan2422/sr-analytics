import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureUploadDirs, ensureUploadSessionTmpDir, getPartPath } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: Request, ctx: { params: Promise<{ uploadId: string; partNumber: string }> }) {
  const { uploadId, partNumber: partNumberStr } = await ctx.params;
  const { prisma } = await import('@/lib/prisma');
  const partNumber = Number(partNumberStr);
  if (!Number.isFinite(partNumber) || partNumber < 1) {
    return NextResponse.json({ error: 'Invalid partNumber' }, { status: 400 });
  }

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
  if (session.status === 'completed') return NextResponse.json({ error: 'Upload already completed' }, { status: 409 });

  const sizeBytes = Number(session.sizeBytes);
  const chunkSizeBytes = session.chunkSizeBytes;
  const expectedParts = Math.ceil(sizeBytes / chunkSizeBytes);
  if (partNumber > expectedParts) {
    return NextResponse.json({ error: `partNumber exceeds expectedParts (${expectedParts})` }, { status: 400 });
  }

  const contentLengthHeader = req.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return NextResponse.json({ error: 'Missing/invalid Content-Length' }, { status: 411 });
  }

  const isLastPart = partNumber === expectedParts;
  const maxAllowedForPart = isLastPart ? (sizeBytes - (expectedParts - 1) * chunkSizeBytes) : chunkSizeBytes;
  if (contentLength > maxAllowedForPart) {
    return NextResponse.json(
      { error: `Chunk too large. Got ${contentLength}, max ${maxAllowedForPart} for part ${partNumber}` },
      { status: 413 }
    );
  }

  try {
    ensureUploadDirs();
    ensureUploadSessionTmpDir(uploadId);
  } catch (e: any) {
    return NextResponse.json(
      { error: 'Failed to prepare upload directories', uploadId, code: e?.code, path: e?.path, message: e?.message },
      { status: 500 }
    );
  }
  const partPath = getPartPath(uploadId, partNumber);

  // Idempotency: if client retries a part, accept only if size matches.
  if (fs.existsSync(partPath)) {
    const existingSize = fs.statSync(partPath).size;
    if (existingSize === contentLength) {
      return NextResponse.json({ ok: true, alreadyHadPart: true, bytesWritten: 0 });
    }
    return NextResponse.json(
      { error: `Part already exists with different size (existing=${existingSize}, new=${contentLength})` },
      { status: 409 }
    );
  }

  if (!req.body) return NextResponse.json({ error: 'Missing request body' }, { status: 400 });

  const nodeStream = Readable.fromWeb(req.body as any);
  const out = fs.createWriteStream(partPath, { flags: 'wx' });

  try {
    await pipeline(nodeStream, out);
  } catch (e: any) {
    try {
      out.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      // ignore
    }
    return NextResponse.json({ error: e?.message || 'Failed to write chunk' }, { status: 500 });
  }

  await prisma.uploadSession.update({
    where: { id: uploadId },
    data: {
      status: 'uploading',
      receivedBytes: { increment: BigInt(contentLength) },
    },
  });

  return NextResponse.json({ ok: true, alreadyHadPart: false, bytesWritten: contentLength });
}



