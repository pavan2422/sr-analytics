import { NextResponse } from 'next/server';
import fs from 'node:fs';
import csvParser from 'csv-parser';
import { format, parse } from 'date-fns';
import { calculateSR } from '@/lib/utils';
import { getFailureLabel } from '@/lib/failure-utils';
import { classifyUPIFlow } from '@/lib/data-normalization';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow up to 5 minutes for large file processing (Vercel Pro plan max)
export const maxDuration = 300;

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

    const formats = ['MMM d, yyyy, h:mm a', 'MM/dd/yyyy h:mm a', 'dd/MM/yyyy h:mm a', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd'];
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

function norm(v: any): string {
  return String(v ?? '').trim();
}

function upper(v: any): string {
  return String(v ?? '').toUpperCase().trim();
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function toSortedBarData(map: Map<string, { total: number; success: number }>) {
  const rows = Array.from(map.entries()).map(([name, v]) => ({
    name,
    volume: v.total,
    sr: calculateSR(v.success, v.total),
  }));
  rows.sort((a, b) => b.volume - a.volume);
  return rows;
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

    const paymentModeMap = new Map<string, { total: number; success: number }>();
    const pgMap = new Map<string, { total: number; success: number }>();
    const bankMap = new Map<string, { total: number; success: number }>();
    const hourly = Array.from({ length: 24 }, () => ({ total: 0, success: 0 }));
    const dayAgg = Array.from({ length: 7 }, () => ({ total: 0, success: 0 }));

    const failureCounts = new Map<string, number>();

    const amountBuckets = [
      { name: '₹0–100', min: 0, max: 100 },
      { name: '₹100–500', min: 100, max: 500 },
      { name: '₹500–1K', min: 500, max: 1000 },
      { name: '₹1K–5K', min: 1000, max: 5000 },
      { name: '₹5K–10K', min: 5000, max: 10000 },
      { name: '₹10K+', min: 10000, max: Infinity },
    ];
    const amountAgg = new Map<string, { total: number; success: number; gmv: number }>();
    amountBuckets.forEach((b) => amountAgg.set(b.name, { total: 0, success: 0, gmv: 0 }));

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
      const pm = upper(row?.paymentmode) || 'UNKNOWN';
      const mid = norm(row?.merchantid);
      const pg = norm(row?.pg) || 'Unknown';
      const bankname = norm(row?.bankname) || 'Unknown';
      const cardtype = norm(row?.cardtype);
      const txstatus = upper(row?.txstatus);
      const txtime = parseDate(row?.txtime);
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

      const isSuccess = txstatus === 'SUCCESS';
      const isFailed = txstatus === 'FAILED';
      const isUserDropped = txstatus === 'USER_DROPPED';

      const pmAgg = paymentModeMap.get(pm) || { total: 0, success: 0 };
      pmAgg.total += 1;
      if (isSuccess) pmAgg.success += 1;
      paymentModeMap.set(pm, pmAgg);

      const pgKey = (() => {
        const pgStr = String(pg || '').trim().toUpperCase();
        if (!pgStr || pgStr === 'N/A' || pgStr === 'NA') return 'Unknown';
        return String(pg).trim() || 'Unknown';
      })();
      const pgAgg = pgMap.get(pgKey) || { total: 0, success: 0 };
      pgAgg.total += 1;
      if (isSuccess) pgAgg.success += 1;
      pgMap.set(pgKey, pgAgg);

      const bankAgg = bankMap.get(bankname) || { total: 0, success: 0 };
      bankAgg.total += 1;
      if (isSuccess) bankAgg.success += 1;
      bankMap.set(bankname, bankAgg);

      const hour = txtime.getHours();
      hourly[hour].total += 1;
      if (isSuccess) hourly[hour].success += 1;

      const dow = txtime.getDay();
      dayAgg[dow].total += 1;
      if (isSuccess) dayAgg[dow].success += 1;

      if (isFailed) {
        const txForLabel: any = {
          txstatus,
          isUserDropped,
          txmsg: norm(row?.txmsg),
          cf_errorcode: norm(row?.cf_errorcode),
          cf_errorreason: norm(row?.cf_errorreason),
          cf_errorsource: norm(row?.cf_errorsource),
          cf_errordescription: norm(row?.cf_errordescription),
          pg_errorcode: norm(row?.pg_errorcode),
          pg_errormessage: norm(row?.pg_errormessage),
        };
        const label = getFailureLabel(txForLabel) || norm(row?.txmsg) || 'Unknown';
        failureCounts.set(label, (failureCounts.get(label) || 0) + 1);
      }

      const amt = parseNumber(row?.txamount);
      for (const bucket of amountBuckets) {
        if (amt >= bucket.min && amt < bucket.max) {
          const a = amountAgg.get(bucket.name)!;
          a.total += 1;
          if (isSuccess) a.success += 1;
          a.gmv += isSuccess ? amt : 0;
          break;
        }
      }
    });

    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });

  const paymentModeData = toSortedBarData(paymentModeMap);
  const pgData = toSortedBarData(pgMap);
  const banksData = toSortedBarData(bankMap).slice(0, 30);

  const hourlyData = hourly.map((h, hour) => ({
    name: `${hour.toString().padStart(2, '0')}:00`,
    volume: h.total,
    sr: calculateSR(h.success, h.total),
  }));

  const failureReasonsData = Array.from(failureCounts.entries())
    .map(([name, count]) => ({ name, volume: count }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 100);

  const amountDistributionData = amountBuckets
    .map((b) => {
      const a = amountAgg.get(b.name)!;
      return { name: b.name, volume: a.total, gmv: a.gmv, sr: calculateSR(a.success, a.total) };
    })
    .filter((d) => d.volume > 0);

  const scatterData = paymentModeData.map((d) => ({ name: d.name, volume: d.volume, sr: d.sr || 0 }));

  const dayOfWeekData = DAY_NAMES.map((name, idx) => ({
    name,
    volume: dayAgg[idx].total,
    sr: calculateSR(dayAgg[idx].success, dayAgg[idx].total),
  }));

    return NextResponse.json(
      {
        paymentModeData,
        hourlyData,
        pgData,
        failureReasonsData,
        dayOfWeekData,
        amountDistributionData,
        banksData,
        scatterData,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while computing overview breakdowns',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}


