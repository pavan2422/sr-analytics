import { NextResponse } from 'next/server';
import fs from 'node:fs';
import * as fastcsv from 'fast-csv';
import { format, parse } from 'date-fns';
import { calculateSR } from '@/lib/utils';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';
import { classifyBankTier, classifyUPIFlow } from '@/lib/data-normalization';
import { getFailureLabel } from '@/lib/failure-utils';
import type { DailyTrend, FailureRCA, GroupedMetrics } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow up to 5 minutes for large file processing (Vercel Pro plan max)
export const maxDuration = 300;

type MetricsBody = {
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

function norm(v: any): string {
  return String(v ?? '').trim();
}
function upper(v: any): string {
  return String(v ?? '').toUpperCase().trim();
}

type GroupAgg = {
  group: string;
  volume: number;
  successCount: number;
  failedCount: number;
  userDroppedCount: number;
  daily: Map<string, { volume: number; successCount: number; failedCount: number; userDroppedCount: number }>;
};

function ensureAgg(map: Map<string, GroupAgg>, group: string) {
  let g = map.get(group);
  if (!g) {
    g = { group, volume: 0, successCount: 0, failedCount: 0, userDroppedCount: 0, daily: new Map() };
    map.set(group, g);
  }
  return g;
}

function bumpDaily(g: GroupAgg, date: string, txstatus: string) {
  let d = g.daily.get(date);
  if (!d) {
    d = { volume: 0, successCount: 0, failedCount: 0, userDroppedCount: 0 };
    g.daily.set(date, d);
  }
  d.volume += 1;
  if (txstatus === 'SUCCESS') d.successCount += 1;
  if (txstatus === 'FAILED') d.failedCount += 1;
  if (txstatus === 'USER_DROPPED') d.userDroppedCount += 1;
}

function toGroupedMetrics(map: Map<string, GroupAgg>): GroupedMetrics[] {
  const rows: GroupedMetrics[] = Array.from(map.values()).map((g) => {
    const dailyTrend: DailyTrend[] = Array.from(g.daily.entries())
      .map(([date, v]) => ({
        date,
        volume: v.volume,
        sr: calculateSR(v.successCount, v.volume),
        successCount: v.successCount,
        failedCount: v.failedCount,
        userDroppedCount: v.userDroppedCount,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      group: g.group,
      volume: g.volume,
      sr: calculateSR(g.successCount, g.volume),
      successCount: g.successCount,
      failedCount: g.failedCount,
      userDroppedCount: g.userDroppedCount,
      dailyTrend,
    };
  });
  rows.sort((a, b) => b.volume - a.volume);
  return rows;
}

export async function POST(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  try {
    const { uploadId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as MetricsBody | null;
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
      return NextResponse.json({ error: 'Stored file missing on disk' }, { status: 500 });
    }

    const startDate = body.startDate ? new Date(body.startDate) : null;
    const endDateRaw = body.endDate ? new Date(body.endDate) : null;
    const endDate = endDateRaw ? new Date(endDateRaw) : null;
    if (endDate) endDate.setHours(23, 59, 59, 999);

    const paymentModeSet = body.paymentModes?.length ? new Set(body.paymentModes.map((s) => upper(s))) : null;
    const merchantIdSet = body.merchantIds?.length ? new Set(body.merchantIds.map((s) => norm(s))) : null;
    const pgSet = body.pgs?.length ? new Set(body.pgs.map((s) => norm(s))) : null;
    const bankSet = body.banks?.length ? new Set(body.banks.map((s) => norm(s))) : null;
    const cardTypeSet = body.cardTypes?.length ? new Set(body.cardTypes.map((s) => norm(s))) : null;

    const pgAgg = new Map<string, GroupAgg>();
    const bankAgg = new Map<string, GroupAgg>();
    const bankTierAgg = new Map<string, GroupAgg>();

    const failureCounts = new Map<string, number>();
    let totalCount = 0;
    let successCount = 0;

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
        const pm = upper(row?.paymentmode);
        if (pm !== 'NET_BANKING') return;

        const mid = norm(row?.merchantid);
        const pg = norm(row?.pg);
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

        totalCount += 1;
        if (txstatus === 'SUCCESS') successCount += 1;
        const date = format(txtime, 'yyyy-MM-dd');

        const pgKey = (() => {
          const pgStr = String(pg || '').trim().toUpperCase();
          if (!pgStr || pgStr === 'N/A' || pgStr === 'NA') return 'Unknown';
          return String(pg).trim() || 'Unknown';
        })();
        const gPg = ensureAgg(pgAgg, pgKey);
        gPg.volume += 1;
        if (txstatus === 'SUCCESS') gPg.successCount += 1;
        if (txstatus === 'FAILED') gPg.failedCount += 1;
        if (txstatus === 'USER_DROPPED') gPg.userDroppedCount += 1;
        bumpDaily(gPg, date, txstatus);

        const gBank = ensureAgg(bankAgg, bankname);
        gBank.volume += 1;
        if (txstatus === 'SUCCESS') gBank.successCount += 1;
        if (txstatus === 'FAILED') gBank.failedCount += 1;
        if (txstatus === 'USER_DROPPED') gBank.userDroppedCount += 1;
        bumpDaily(gBank, date, txstatus);

        const tier = classifyBankTier(bankname);
        const gTier = ensureAgg(bankTierAgg, tier);
        gTier.volume += 1;
        if (txstatus === 'SUCCESS') gTier.successCount += 1;
        if (txstatus === 'FAILED') gTier.failedCount += 1;
        if (txstatus === 'USER_DROPPED') gTier.userDroppedCount += 1;
        bumpDaily(gTier, date, txstatus);

        if (txstatus === 'FAILED') {
          const txForLabel: any = {
            txstatus,
            isUserDropped: false,
            txmsg: norm(row?.txmsg),
            cf_errorcode: norm(row?.cf_errorcode),
            cf_errorreason: norm(row?.cf_errorreason),
            cf_errorsource: norm(row?.cf_errorsource),
            cf_errordescription: norm(row?.cf_errordescription),
            pg_errorcode: norm(row?.pg_errorcode),
            pg_errormessage: norm(row?.pg_errormessage),
          };
          const label = getFailureLabel(txForLabel) || 'Unknown';
          failureCounts.set(label, (failureCounts.get(label) || 0) + 1);
        }
      });

      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
    });

    const currentSR = calculateSR(successCount, totalCount);
    const failureRCA: FailureRCA[] = Array.from(failureCounts.entries())
      .map(([txmsg, failureCount]) => {
        const adjustedSR = calculateSR(successCount, Math.max(0, totalCount - failureCount));
        return {
          txmsg,
          failureCount,
          failurePercent: calculateSR(failureCount, totalCount),
          adjustedSR,
          impact: adjustedSR - currentSR,
        };
      })
      .sort((a, b) => b.failureCount - a.failureCount);

    return NextResponse.json(
      {
        pgLevel: toGroupedMetrics(pgAgg),
        bankLevel: toGroupedMetrics(bankAgg),
        bankTierLevel: toGroupedMetrics(bankTierAgg),
        failureRCA,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while computing netbanking metrics',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}


