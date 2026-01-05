import { NextResponse } from 'next/server';
import fs from 'node:fs';
import * as fastcsv from 'fast-csv';
import { parse } from 'date-fns';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow up to 5 minutes for large file processing (Vercel Pro plan max)
export const maxDuration = 300;

function parseDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Optimized: Priority to native Date for speed
  const d = new Date(trimmed);
  if (!Number.isNaN(d.getTime())) return d;

  try {
    const formats = ['MMMM d, yyyy, h:mm a', 'MMM d, yyyy, h:mm a', 'MM/dd/yyyy h:mm a', 'dd/MM/yyyy h:mm a', 'yyyy-MM-dd HH:mm:ss'];
    for (const fmt of formats) {
      const p = parse(trimmed, fmt, new Date());
      if (!Number.isNaN(p.getTime())) return p;
    }
  } catch { /* ignore */ }
  return null;
}

function classifyUPIFlow(bankname: string | undefined): string {
  if (!bankname || bankname.trim() === '') return 'COLLECT';
  if (bankname.toLowerCase() === 'link') return 'INTENT';
  return bankname;
}

export async function GET(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  try {
    const { uploadId } = await ctx.params;
    const url = new URL(req.url);

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

    let minMs: number | null = null;
    let maxMs: number | null = null;

    await new Promise<void>((resolve, reject) => {
      const stream = fs
        .createReadStream(filePath, { highWaterMark: 1024 * 1024 })
        .pipe(
          fastcsv.parse({ headers: true, trim: true, ignoreEmpty: true })
            .transform((row: any) => {
              const lowercased: any = {};
              for (const k of Object.keys(row)) {
                lowercased[k.toLowerCase().trim()] = row[k];
              }
              return lowercased;
            })
        );

      stream.on('data', (row: any) => {
        const pm = row?.paymentmode ? String(row.paymentmode).toUpperCase().trim() : '';
        const mid = row?.merchantid ? String(row.merchantid).trim() : '';
        const pg = String(row?.pg || '').trim();
        const bankname = String(row?.bankname || '').trim();
        const cardtype = String(row?.cardtype || '').trim();
        const txtime = parseDate(row?.txtime);
        if (!txtime) return;
        const ms = txtime.getTime();

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

        if (minMs === null || ms < minMs) minMs = ms;
        if (maxMs === null || ms > maxMs) maxMs = ms;
      });

      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
    });

    return NextResponse.json(
      {
        min: minMs === null ? undefined : new Date(minMs).toISOString(),
        max: maxMs === null ? undefined : new Date(maxMs).toISOString(),
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while computing time bounds',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}


