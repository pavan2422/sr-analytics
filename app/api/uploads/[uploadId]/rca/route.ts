import { NextResponse } from 'next/server';
import fs from 'node:fs';
import csvParser from 'csv-parser';
import { format, parse } from 'date-fns';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';
import { classifyUPIFlow } from '@/lib/data-normalization';
import { computePeriodComparison, computeUserDroppedAnalysis } from '@/lib/rca';
import { compareCustomerSegments, detectProblematicCustomers } from '@/lib/customer-analytics';
import type { Transaction } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PaymentMode = 'ALL' | 'UPI' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'PREPAID_CARD' | 'NETBANKING';

type RCABody = {
  periodDays: number;
  selectedPaymentMode: PaymentMode;
  filters: {
    startDate: string | null;
    endDate: string | null;
    paymentModes: string[];
    merchantIds: string[];
    pgs: string[];
    banks: string[];
    cardTypes: string[];
  };
};

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

export async function POST(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as RCABody | null;
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

  const startDate = body.filters.startDate ? new Date(body.filters.startDate) : null;
  const endDateRaw = body.filters.endDate ? new Date(body.filters.endDate) : null;
  const endDate = endDateRaw ? new Date(endDateRaw) : null;
  if (endDate) endDate.setHours(23, 59, 59, 999);

  const paymentModeSet = body.filters.paymentModes?.length ? new Set(body.filters.paymentModes.map((s) => upper(s))) : null;
  const merchantIdSet = body.filters.merchantIds?.length ? new Set(body.filters.merchantIds.map((s) => norm(s))) : null;
  const pgSet = body.filters.pgs?.length ? new Set(body.filters.pgs.map((s) => norm(s))) : null;
  const bankSet = body.filters.banks?.length ? new Set(body.filters.banks.map((s) => norm(s))) : null;
  const cardTypeSet = body.filters.cardTypes?.length ? new Set(body.filters.cardTypes.map((s) => norm(s))) : null;

  // Pass 1: find max time in filtered dataset
  let maxMs: number | null = null;

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
      const mid = norm(row?.merchantid);
      const pg = norm(row?.pg);
      const bankname = norm(row?.bankname);
      const cardtype = norm(row?.cardtype);
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

      const ms = txtime.getTime();
      if (maxMs === null || ms > maxMs) maxMs = ms;
    });

    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });

  if (maxMs === null) {
    return NextResponse.json({ comparison: null }, { status: 200 });
  }

  const periodDays = Math.max(1, Math.min(30, Number(body.periodDays) || 7));
  const currentPeriodEnd = new Date(maxMs);
  const currentPeriodStart = new Date(currentPeriodEnd);
  currentPeriodStart.setDate(currentPeriodStart.getDate() - periodDays);
  const previousPeriodEnd = new Date(currentPeriodStart);
  previousPeriodEnd.setDate(previousPeriodEnd.getDate() - 1);
  const previousPeriodStart = new Date(previousPeriodEnd);
  previousPeriodStart.setDate(previousPeriodStart.getDate() - periodDays);

  const current: Transaction[] = [];
  const previous: Transaction[] = [];

  // Pass 2: collect full transactions for the two periods
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

      const t = txtime.getTime();
      const inCurrent = t >= currentPeriodStart.getTime() && t <= currentPeriodEnd.getTime();
      const inPrevious = t >= previousPeriodStart.getTime() && t <= previousPeriodEnd.getTime();
      if (!inCurrent && !inPrevious) return;

      const tx: Transaction = {
        txstatus,
        paymentmode: pm,
        pg: norm(row?.pg),
        bankname,
        cardnumber: norm(row?.cardnumber),
        cardmasked: norm(row?.cardmasked),
        cardtype: cardtype,
        cardcountry: norm(row?.cardcountry),
        processingcardtype: norm(row?.processingcardtype),
        nativeotpurleligible: norm(row?.nativeotpurleligible),
        card_isfrictionless: norm(row?.card_isfrictionless),
        card_nativeotpaction: norm(row?.card_nativeotpaction),
        card_par: norm(row?.card_par),
        iscvvpresent: norm(row?.iscvvpresent),
        upi_psp: norm(row?.upi_psp),
        txmsg: norm(row?.txmsg),
        cf_errorcode: norm(row?.cf_errorcode),
        cf_errorreason: norm(row?.cf_errorreason),
        cf_errorsource: norm(row?.cf_errorsource),
        cf_errordescription: norm(row?.cf_errordescription),
        pg_errorcode: norm(row?.pg_errorcode),
        pg_errormessage: norm(row?.pg_errormessage),
        txtime,
        txamount: parseNumber(row?.txamount),
        orderamount: parseNumber(row?.orderamount),
        capturedamount: parseNumber(row?.capturedamount),
        transactionDate: format(txtime, 'yyyy-MM-dd'),
        isSuccess: txstatus === 'SUCCESS',
        isFailed: txstatus === 'FAILED',
        isUserDropped: txstatus === 'USER_DROPPED',
        merchantid: mid,
      };

      if (inCurrent) current.push(tx);
      else if (inPrevious) previous.push(tx);
    });

    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });

  const comparison = computePeriodComparison(current, previous, body.selectedPaymentMode);
  const userDroppedAnalysis = computeUserDroppedAnalysis(current, previous, body.selectedPaymentMode);
  const customerAnalytics = compareCustomerSegments(current, previous);
  const problematicCustomers = detectProblematicCustomers(current);

  return NextResponse.json(
    {
      comparison,
      userDroppedAnalysis,
      customerAnalytics,
      problematicCustomers,
      periods: {
        current: { start: currentPeriodStart.toISOString(), end: currentPeriodEnd.toISOString() },
        previous: { start: previousPeriodStart.toISOString(), end: previousPeriodEnd.toISOString() },
      },
    },
    { status: 200 }
  );
}


