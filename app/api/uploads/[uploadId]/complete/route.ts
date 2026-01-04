import { NextResponse } from 'next/server';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  buildStoredFileRelativePath,
  ensureUploadDirs,
  getPartPath,
  getUploadSessionTmpDir,
  listReceivedParts,
  resolveStoredFileAbsolutePath,
} from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CompleteBody = {
  // For safety, client should echo back the total number of parts it uploaded.
  totalParts?: number;
};

export async function POST(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
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
  if (session.status === 'completed') {
    return NextResponse.json({ ok: true, uploadId, storedFileId: session.storedFileId }, { status: 200 });
  }

  const body = (await req.json().catch(() => ({}))) as CompleteBody;
  const sizeBytes = Number(session.sizeBytes);
  const chunkSizeBytes = session.chunkSizeBytes;
  const expectedParts = Math.ceil(sizeBytes / chunkSizeBytes);
  if (body.totalParts && Number(body.totalParts) !== expectedParts) {
    return NextResponse.json({ error: `totalParts mismatch. expected=${expectedParts}` }, { status: 400 });
  }

  const receivedParts = listReceivedParts(uploadId);
  if (receivedParts.length !== expectedParts) {
    const missing: number[] = [];
    for (let i = 1; i <= expectedParts; i++) {
      if (!receivedParts.includes(i)) missing.push(i);
    }
    return NextResponse.json(
      { error: 'Missing parts', expectedParts, receivedParts, missingParts: missing.slice(0, 200) },
      { status: 400 }
    );
  }

  try {
    ensureUploadDirs();
  } catch (e: any) {
    return NextResponse.json(
      { error: 'Failed to create upload directories', uploadId, code: e?.code, path: e?.path, message: e?.message },
      { status: 500 }
    );
  }

  // Create StoredFile metadata first so we can use its ID in the final filename.
  const storedFile = await prisma.storedFile.create({
    data: {
      originalName: session.originalName,
      storedName: session.originalName,
      contentType: session.contentType,
      sizeBytes: BigInt(sizeBytes),
      storageBackend: 'local_disk',
      storagePath: 'pending',
    },
  });

  const storagePath = buildStoredFileRelativePath(storedFile.id, session.originalName);
  const finalPath = resolveStoredFileAbsolutePath(storagePath);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });

  const hash = crypto.createHash('sha256');

  try {
    // Build final file by appending parts sequentially (streamed, no buffering).
    for (let part = 1; part <= expectedParts; part++) {
      const partPath = getPartPath(uploadId, part);
      const rs = fs.createReadStream(partPath);
      const ws = fs.createWriteStream(finalPath, { flags: part === 1 ? 'w' : 'a' });
      // NOTE: new Transform instance per pipeline; reusing can break backpressure.
      const partHashTransform = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      await pipeline(rs, partHashTransform, ws);
    }

    const finalSize = fs.statSync(finalPath).size;
    if (finalSize !== sizeBytes) {
      throw new Error(`Final file size mismatch. expected=${sizeBytes}, got=${finalSize}`);
    }
  } catch (e: any) {
    // Cleanup partial final file + mark failed.
    try {
      fs.rmSync(finalPath, { force: true });
    } catch {
      // ignore
    }
    await prisma.uploadSession.update({ where: { id: uploadId }, data: { status: 'failed' } });
    return NextResponse.json({ error: e?.message || 'Failed to finalize upload' }, { status: 500 });
  }

  const sha256Hex = hash.digest('hex');

  await prisma.storedFile.update({
    where: { id: storedFile.id },
    data: { storagePath, sha256Hex },
  });

  await prisma.uploadSession.update({
    where: { id: uploadId },
    data: {
      status: 'completed',
      receivedBytes: BigInt(sizeBytes),
      completedAt: new Date(),
      storedFileId: storedFile.id,
    },
  });

  // Best-effort cleanup of chunk parts.
  try {
    fs.rmSync(getUploadSessionTmpDir(uploadId), { recursive: true, force: true });
  } catch {
    // ignore
  }

  return NextResponse.json({ ok: true, uploadId, storedFileId: storedFile.id, sha256Hex });
}


