import { NextResponse } from 'next/server';
import fs from 'node:fs';
import csvParser from 'csv-parser';
import { format, parse } from 'date-fns';
import { calculateSR } from '@/lib/utils';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';
import { classifyCardScope, classifyUPIFlow } from '@/lib/data-normalization';
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

    // Lazy import to avoid Prisma initialization during Next/Vercel build-time module evaluation.
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

  const CARD_MODES = new Set(['CREDIT_CARD', 'DEBIT_CARD', 'PREPAID_CARD']);

  const pgAgg = new Map<string, GroupAgg>();
  const cardTypeAgg = new Map<string, GroupAgg>();
  const scopeAgg = new Map<string, GroupAgg>();

  const authLevels = {
    processingCardType: new Map<string, GroupAgg>(),
    nativeOtpEligible: new Map<string, GroupAgg>(),
    isFrictionless: new Map<string, GroupAgg>(),
    nativeOtpAction: new Map<string, GroupAgg>(),
    cardPar: new Map<string, GroupAgg>(),
    cvvPresent: new Map<string, GroupAgg>(),
  };

  const failureCounts = new Map<string, number>();
  let totalCount = 0;
  let successCount = 0;

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
      const pm = upper(row?.paymentmode);
      if (!CARD_MODES.has(pm)) return;

      const mid = norm(row?.merchantid);
      const pg = norm(row?.pg);
      const bankname = norm(row?.bankname);
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

      const gCt = ensureAgg(cardTypeAgg, cardtype || 'Unknown');
      gCt.volume += 1;
      if (txstatus === 'SUCCESS') gCt.successCount += 1;
      if (txstatus === 'FAILED') gCt.failedCount += 1;
      if (txstatus === 'USER_DROPPED') gCt.userDroppedCount += 1;
      bumpDaily(gCt, date, txstatus);

      const scope = classifyCardScope(norm(row?.cardcountry));
      const gScope = ensureAgg(scopeAgg, scope);
      gScope.volume += 1;
      if (txstatus === 'SUCCESS') gScope.successCount += 1;
      if (txstatus === 'FAILED') gScope.failedCount += 1;
      if (txstatus === 'USER_DROPPED') gScope.userDroppedCount += 1;
      bumpDaily(gScope, date, txstatus);

      const procType = norm(row?.processingcardtype) || 'Unknown';
      const otpEligible = norm(row?.nativeotpurleligible) || 'Unknown';
      const frictionless = norm(row?.card_isfrictionless) || 'Unknown';
      const otpAction = norm(row?.card_nativeotpaction) || 'Unknown';
      const cardPar = norm(row?.card_par) || 'Unknown';
      const cvvPresent = norm(row?.iscvvpresent) || 'Unknown';

      for (const [key, map, value] of [
        ['processingCardType', authLevels.processingCardType, procType],
        ['nativeOtpEligible', authLevels.nativeOtpEligible, otpEligible],
        ['isFrictionless', authLevels.isFrictionless, frictionless],
        ['nativeOtpAction', authLevels.nativeOtpAction, otpAction],
        ['cardPar', authLevels.cardPar, cardPar],
        ['cvvPresent', authLevels.cvvPresent, cvvPresent],
      ] as const) {
        const g = ensureAgg(map, value);
        g.volume += 1;
        if (txstatus === 'SUCCESS') g.successCount += 1;
        if (txstatus === 'FAILED') g.failedCount += 1;
        if (txstatus === 'USER_DROPPED') g.userDroppedCount += 1;
        bumpDaily(g, date, txstatus);
        void key;
      }

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
        cardTypeLevel: toGroupedMetrics(cardTypeAgg),
        scopeLevel: toGroupedMetrics(scopeAgg),
        authLevels: {
          processingCardType: toGroupedMetrics(authLevels.processingCardType),
        nativeOtpEligible: toGroupedMetrics(authLevels.nativeOtpEligible),
        isFrictionless: toGroupedMetrics(authLevels.isFrictionless),
        nativeOtpAction: toGroupedMetrics(authLevels.nativeOtpAction),
        cardPar: toGroupedMetrics(authLevels.cardPar),
        cvvPresent: toGroupedMetrics(authLevels.cvvPresent),
      },
      failureRCA,
    },
    { status: 200 }
  );
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while computing card metrics',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}


