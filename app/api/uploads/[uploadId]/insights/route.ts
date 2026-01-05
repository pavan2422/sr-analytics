import { NextResponse } from 'next/server';
import fs from 'node:fs';
import * as fastcsv from 'fast-csv';
import { parse } from 'date-fns';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';
import { classifyUPIFlow } from '@/lib/data-normalization';
import { computeFailureInsightsFromAggregates, computeInsightWindowsFromFailedRange, dateKeyForTime } from '@/lib/server/full-failure-insights';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow up to 5 minutes for large file processing (Vercel Pro plan max)
export const maxDuration = 300;

type InsightsBody = {
  startDate: string | null;
  endDate: string | null;
  paymentModes: string[];
  merchantIds: string[];
  pgs: string[];
  banks: string[];
  cardTypes: string[];
};

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

function normalizeKey(v: any): string {
  return String(v ?? '').trim();
}

function normalizeUpper(v: any): string {
  return String(v ?? '').toUpperCase().trim();
}

type GroupAgg = {
  paymentMode: string;
  cfErrorDescription: string;
  totalVolume: number;
  currentVolume: number;
  previousVolume: number;
  dailyCounts: Map<string, number>;
};

function groupKey(pm: string, cfDesc: string) {
  return `${pm}::${cfDesc}`;
}

export async function POST(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  try {
    const { uploadId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as InsightsBody | null;
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

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

    const startDate = body.startDate ? new Date(body.startDate) : null;
    const endDateRaw = body.endDate ? new Date(body.endDate) : null;
    const endDate = endDateRaw ? new Date(endDateRaw) : null;
    if (endDate) endDate.setHours(23, 59, 59, 999);

    const paymentModeSet = body.paymentModes?.length ? new Set(body.paymentModes.map((s) => normalizeUpper(s))) : null;
    const merchantIdSet = body.merchantIds?.length ? new Set(body.merchantIds.map((s) => normalizeKey(s))) : null;
    const pgSet = body.pgs?.length ? new Set(body.pgs.map((s) => normalizeKey(s))) : null;
    const bankSet = body.banks?.length ? new Set(body.banks.map((s) => normalizeKey(s))) : null;
    const cardTypeSet = body.cardTypes?.length ? new Set(body.cardTypes.map((s) => normalizeKey(s))) : null;

    // Pass 1: find min/max time across FAILED txs (after filters).
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
        const pm = normalizeUpper(row?.paymentmode);
        const mid = normalizeKey(row?.merchantid);
        const pg = normalizeKey(row?.pg);
        const bankname = normalizeKey(row?.bankname);
        const cardtype = normalizeKey(row?.cardtype);
        const txstatus = normalizeUpper(row?.txstatus);
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

        if (txstatus !== 'FAILED') return;

        const ms = txtime.getTime();
        if (minMs === null || ms < minMs) minMs = ms;
        if (maxMs === null || ms > maxMs) maxMs = ms;
      });

      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
    });

    if (minMs === null || maxMs === null) {
      return NextResponse.json({ insights: [], totalFailures: 0 }, { status: 200 });
    }

    const windows = computeInsightWindowsFromFailedRange(minMs, maxMs);

    // Pass 2: aggregate by (paymentMode, cf_errordescription) with daily series.
    const groups = new Map<string, GroupAgg>();
    let totalFailures = 0;

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
        const pm = normalizeUpper(row?.paymentmode) || 'UNKNOWN';
        const mid = normalizeKey(row?.merchantid);
        const pg = normalizeKey(row?.pg);
        const bankname = normalizeKey(row?.bankname);
        const cardtype = normalizeKey(row?.cardtype);
        const txstatus = normalizeUpper(row?.txstatus);
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

        if (txstatus !== 'FAILED') return;

        totalFailures += 1;

        const cfDesc = normalizeKey(row?.cf_errordescription) || normalizeKey(row?.txmsg) || 'Unknown Error';
        const key = groupKey(pm, cfDesc);
        let g = groups.get(key);
        if (!g) {
          g = { paymentMode: pm, cfErrorDescription: cfDesc, totalVolume: 0, currentVolume: 0, previousVolume: 0, dailyCounts: new Map() };
          groups.set(key, g);
        }

        g.totalVolume += 1;

        const t = txtime.getTime();
        if (t >= windows.current.startDate.getTime() && t <= windows.current.endDate.getTime()) g.currentVolume += 1;
        if (t >= windows.previous.startDate.getTime() && t <= windows.previous.endDate.getTime()) g.previousVolume += 1;

        const dkey = dateKeyForTime(txtime);
        g.dailyCounts.set(dkey, (g.dailyCounts.get(dkey) || 0) + 1);
      });

      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
    });

    const insights = computeFailureInsightsFromAggregates(Array.from(groups.values()), totalFailures, windows);
    return NextResponse.json(
      {
        totalFailures,
        windows: {
          current: {
            start: windows.current.startDate.toISOString(),
            end: windows.current.endDate.toISOString(),
            label: windows.current.label,
          },
          previous: {
            start: windows.previous.startDate.toISOString(),
            end: windows.previous.endDate.toISOString(),
            label: windows.previous.label,
          },
          windowType: windows.windowType,
        },
        insights,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while computing insights',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}


