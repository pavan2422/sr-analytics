import { NextResponse } from 'next/server';
import fs from 'node:fs';
import csvParser from 'csv-parser';
import { prisma } from '@/lib/prisma';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;

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

  const paymentModes = new Set<string>();
  const merchantIds = new Set<string>();
  const MAX_UNIQUE_MERCHANTS = 5000; // prevent UI + memory blowups
  let truncated = false;

  await new Promise<void>((resolve, reject) => {
    const stream = fs
      .createReadStream(filePath)
      .pipe(
        csvParser({
          mapHeaders: ({ header }) => String(header || '').trim().toLowerCase(),
          skipLines: 0,
        })
      );

    stream.on('data', (row: any) => {
      const pm = row?.paymentmode ? String(row.paymentmode).toUpperCase().trim() : '';
      if (pm) paymentModes.add(pm);

      const mid = row?.merchantid ? String(row.merchantid).trim() : '';
      if (mid) {
        if (merchantIds.size < MAX_UNIQUE_MERCHANTS) {
          merchantIds.add(mid);
        } else {
          truncated = true;
        }
      }
    });

    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });

  return NextResponse.json(
    {
      paymentModes: Array.from(paymentModes.values()).sort(),
      merchantIds: Array.from(merchantIds.values()).sort(),
      truncated,
    },
    { status: 200 }
  );
}


