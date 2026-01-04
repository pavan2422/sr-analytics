import { NextResponse } from 'next/server';
import fs from 'node:fs';
import csvParser from 'csv-parser';
import { format, parse } from 'date-fns';
import { calculateSR } from '@/lib/utils';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseNumber(value: any): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    const parsedNum = parseFloat(cleaned);
    return Number.isNaN(parsedNum) ? 0 : parsedNum;
  }
  return 0;
}

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

function normalizeRow(raw: Record<string, any>) {
  const normalized: Record<string, any> = {};
  for (const k of Object.keys(raw)) {
    const lowerKey = String(k).toLowerCase().trim();
    let v = raw[k];
    if (typeof v === 'string') v = v.trim();
    normalized[lowerKey] = v;
  }

  const txstatus = normalized.txstatus ? String(normalized.txstatus).toUpperCase().trim() : '';
  const paymentmode = normalized.paymentmode ? String(normalized.paymentmode).toUpperCase().trim() : '';
  const merchantid = String(normalized.merchantid || '').trim();
  const pg = String(normalized.pg || '').trim();
  const bankname = String(normalized.bankname || '').trim();
  const cardtype = String(normalized.cardtype || '').trim();

  const txtime = parseDate(normalized.txtime);
  const txamount = parseNumber(normalized.txamount);

  return { txstatus, paymentmode, merchantid, pg, bankname, cardtype, txtime, txamount };
}

type MetricsBody = {
  startDate: string | null;
  endDate: string | null;
  paymentModes: string[];
  merchantIds: string[];
  pgs: string[];
  banks: string[];
  cardTypes: string[];
};

export async function POST(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as MetricsBody | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const { prisma } = await import('@/lib/prisma');

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

  const startDate = body.startDate ? new Date(body.startDate) : null;
  const endDateRaw = body.endDate ? new Date(body.endDate) : null;
  const endDate = endDateRaw ? new Date(endDateRaw) : null;
  if (endDate) endDate.setHours(23, 59, 59, 999);

  const paymentModeSet = body.paymentModes?.length ? new Set(body.paymentModes.map((s) => String(s).toUpperCase().trim())) : null;
  const merchantIdSet = body.merchantIds?.length ? new Set(body.merchantIds.map((s) => String(s).trim())) : null;
  const pgSet = body.pgs?.length ? new Set(body.pgs.map((s) => String(s).trim())) : null;
  const bankSet = body.banks?.length ? new Set(body.banks.map((s) => String(s).trim())) : null;
  const cardTypeSet = body.cardTypes?.length ? new Set(body.cardTypes.map((s) => String(s).trim())) : null;

  let totalCount = 0;
  let successCount = 0;
  let failedCount = 0;
  let userDroppedCount = 0;
  let successGmv = 0;

  const dailyMap = new Map<string, { date: string; volume: number; successCount: number; failedCount: number; userDroppedCount: number }>();

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
      const { txstatus, paymentmode, merchantid, pg, bankname, cardtype, txtime, txamount } = normalizeRow(
        row as Record<string, any>
      );

      if (startDate || endDate || paymentModeSet || merchantIdSet || pgSet || bankSet || cardTypeSet) {
        if (!txtime) return;
        if (startDate && txtime < startDate) return;
        if (endDate && txtime > endDate) return;
        if (paymentModeSet && !paymentModeSet.has(paymentmode)) return;
        if (merchantIdSet && !merchantIdSet.has(merchantid)) return;
        if (pgSet && !pgSet.has(pg)) return;
        if (bankSet) {
          const flow = classifyUPIFlow(bankname);
          if (!bankSet.has(flow) && !bankSet.has(bankname)) return;
        }
        if (cardTypeSet && !cardTypeSet.has(cardtype)) return;
      }

      totalCount++;

      const isSuccess = txstatus === 'SUCCESS';
      const isFailed = txstatus === 'FAILED';
      const isUserDropped = txstatus === 'USER_DROPPED';

      if (isSuccess) {
        successCount++;
        successGmv += txamount || 0;
      } else if (isFailed) {
        failedCount++;
      } else if (isUserDropped) {
        userDroppedCount++;
      }

      if (txtime) {
        const date = format(txtime, 'yyyy-MM-dd');
        if (!dailyMap.has(date)) {
          dailyMap.set(date, { date, volume: 0, successCount: 0, failedCount: 0, userDroppedCount: 0 });
        }
        const d = dailyMap.get(date)!;
        d.volume++;
        if (isSuccess) d.successCount++;
        if (isFailed) d.failedCount++;
        if (isUserDropped) d.userDroppedCount++;
      }
    });

    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });

  const dailyTrends = Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      ...d,
      sr: calculateSR(d.successCount, d.volume),
    }));

  const globalMetrics = {
    totalCount,
    successCount,
    failedCount,
    userDroppedCount,
    sr: calculateSR(successCount, totalCount),
    successGmv,
    failedPercent: calculateSR(failedCount, totalCount),
    userDroppedPercent: calculateSR(userDroppedCount, totalCount),
  };

  return NextResponse.json(
    {
      filteredTransactionCount: totalCount,
      globalMetrics,
      dailyTrends,
    },
    { status: 200 }
  );
}


