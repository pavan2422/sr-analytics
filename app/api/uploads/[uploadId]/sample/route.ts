import { NextResponse } from 'next/server';
import fs from 'node:fs';
import csvParser from 'csv-parser';
import { parse } from 'date-fns';
import { normalizeData } from '@/lib/data-normalization';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsedA = parse(trimmed, 'MMMM d, yyyy, h:mm a', new Date());
    if (!Number.isNaN(parsedA.getTime())) return parsedA;

    const isoParsed = new Date(trimmed);
    if (!Number.isNaN(isoParsed.getTime())) return isoParsed;

    const formats = [
      'MMM d, yyyy, h:mm a',
      'MM/dd/yyyy h:mm a',
      'dd/MM/yyyy h:mm a',
      'yyyy-MM-dd HH:mm:ss',
      'yyyy-MM-dd',
    ];
    for (const fmt of formats) {
      try {
        const p = parse(trimmed, fmt, new Date());
        if (!Number.isNaN(p.getTime())) return p;
      } catch {
        // continue
      }
    }
  } catch {
    // fall through
  }

  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function classifyUPIFlow(bankname: string | undefined): string {
  if (!bankname || bankname.trim() === '') return 'COLLECT';
  if (bankname.toLowerCase() === 'link') return 'INTENT';
  return bankname;
}

export async function GET(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  try {
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

    const url = new URL(req.url);
    const maxRows = Math.min(Math.max(Number(url.searchParams.get('maxRows') || 100000), 1), 200000);
    const startDate = url.searchParams.get('startDate') ? new Date(String(url.searchParams.get('startDate'))) : null;
    const endDateRaw = url.searchParams.get('endDate') ? new Date(String(url.searchParams.get('endDate'))) : null;
    const endDate = endDateRaw ? new Date(endDateRaw) : null;
    if (endDate) endDate.setHours(23, 59, 59, 999);

    const paymentModeParams = url.searchParams.getAll('paymentModes').map((s) => String(s).toUpperCase().trim()).filter(Boolean);
    const merchantIdParams = url.searchParams.getAll('merchantIds').map((s) => String(s).trim()).filter(Boolean);
    const pgParams = url.searchParams.getAll('pgs').map((s) => String(s).trim()).filter(Boolean);
    const bankParams = url.searchParams.getAll('banks').map((s) => String(s).trim()).filter(Boolean);
    const cardTypeParams = url.searchParams.getAll('cardTypes').map((s) => String(s).trim()).filter(Boolean);

    const paymentModeSet = paymentModeParams.length ? new Set(paymentModeParams) : null;
    const merchantIdSet = merchantIdParams.length ? new Set(merchantIdParams) : null;
    const pgSet = pgParams.length ? new Set(pgParams) : null;
    const bankSet = bankParams.length ? new Set(bankParams) : null;
    const cardTypeSet = cardTypeParams.length ? new Set(cardTypeParams) : null;

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
      return NextResponse.json({ 
        error: 'Stored file missing on disk',
        storagePath: session.storedFile.storagePath,
        resolvedPath: filePath,
        uploadId
      }, { status: 500 });
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
      if (startDate || endDate || paymentModeSet || merchantIdSet || pgSet || bankSet || cardTypeSet) {
        const pm = data?.paymentmode ? String(data.paymentmode).toUpperCase().trim() : '';
        const mid = data?.merchantid ? String(data.merchantid).trim() : '';
        const pg = String(data?.pg || '').trim();
        const bankname = String(data?.bankname || '').trim();
        const cardtype = String(data?.cardtype || '').trim();
        const txtime = parseDate(data?.txtime);
        if (!txtime) return;

        if (startDate && txtime < startDate) return;
        if (endDate && txtime > endDate) return;
        if (paymentModeSet && !paymentModeSet.has(pm)) return;
        if (merchantIdSet && !merchantIdSet.has(mid)) return;
        if (pgSet && !pgSet.has(pg)) return;
        if (bankSet) {
          const flow = classifyUPIFlow(bankname);
          if (!bankSet.has(flow) && !bankSet.has(bankname)) return;
        }
        if (cardTypeSet && !cardTypeSet.has(cardtype)) return;
      }

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
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while sampling data',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}



