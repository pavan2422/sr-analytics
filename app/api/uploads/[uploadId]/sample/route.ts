import { NextResponse } from 'next/server';
import fs from 'node:fs';
import csvParser from 'csv-parser';
import { normalizeData } from '@/lib/data-normalization';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
  const { prisma } = await import('@/lib/prisma');

  const url = new URL(req.url);
  const maxRows = Math.min(Math.max(Number(url.searchParams.get('maxRows') || 100000), 1), 200000);

  const session = await prisma.uploadSession.findUnique({
    where: { id: uploadId },
    include: { storedFile: true },
  });

  if (!session) return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  if (session.status !== 'completed' || !session.storedFile) {
    return NextResponse.json({ error: 'Upload not completed yet' }, { status: 409 });
  }

  const filePath = resolveStoredFileAbsolutePath(session.storedFile.storagePath);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Stored file missing on disk' }, { status: 500 });
  }

  // Note: this endpoint is intentionally "sample only" to keep response times safe.
  // Full multi-GB analytics should be done server-side via ingestion + aggregation.
  const rows: any[] = [];

  await new Promise<void>((resolve, reject) => {
    const stream = fs
      .createReadStream(filePath)
      .pipe(
        csvParser({
          mapHeaders: ({ header }) => String(header || '').trim().toLowerCase(),
          skipLines: 0,
        })
      );

    stream.on('data', (data) => {
      rows.push(data);
      if (rows.length >= maxRows) {
        // Stop early once we have the sample.
        stream.destroy();
      }
    });
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });

  const transactions = normalizeData(rows);

  return NextResponse.json({
    uploadId,
    storedFileId: session.storedFile.id,
    sampled: true,
    maxRows,
    transactions,
  });
}



