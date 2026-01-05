import { NextResponse } from 'next/server';
import fs from 'node:fs';
import csvParser from 'csv-parser';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';
import { classifyCardScope, classifyUPIFlow, extractUPIHandle } from '@/lib/data-normalization';
import { getFailureCategory, getFailureLabel } from '@/lib/failure-utils';
import type { Transaction } from '@/types';
import { normalizeHeaderKey } from '@/lib/csv-headers';
import { parseTxTime } from '@/lib/tx-time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow up to 5 minutes for large file processing (Vercel Pro plan max)
export const maxDuration = 300;

type BreakdownBody = {
  analysisType: 'FAILED' | 'USER_DROPPED';
  dimension: string;
  dimensionValue: string;
  period: { start: string; end: string };
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

function norm(v: any): string {
  return String(v ?? '').trim();
}
function upper(v: any): string {
  return String(v ?? '').toUpperCase().trim();
}

function getDimensionValue(tx: Transaction, dimName: string): string {
  if (dimName === 'CF Error Description') return tx.cf_errordescription || 'Unknown';
  if (dimName === 'CF Error Code') return tx.cf_errorcode || 'Unknown';
  if (dimName === 'CF Error Source') return tx.cf_errorsource || 'Unknown';
  if (dimName === 'CF Error Reason') return tx.cf_errorreason || 'Unknown';
  if (dimName === 'PG Error Code') return tx.pg_errorcode || 'Unknown';
  if (dimName === 'PG Error Message') return tx.pg_errormessage || 'Unknown';
  if (dimName === 'Failure Category') return getFailureCategory(tx);
  if (dimName === 'Failure Reason') return getFailureLabel(tx) || 'Unknown';

  if (dimName === 'PG') return tx.pg || 'Unknown';
  if (dimName === 'Payment Mode') return tx.paymentmode || 'Unknown';

  if (dimName === 'Flow Type') return classifyUPIFlow(tx.bankname);
  if (dimName === 'Handle') return extractUPIHandle(tx.cardmasked) || 'Unknown';
  if (dimName === 'PSP') return tx.upi_psp || 'Unknown';

  if (dimName === 'Card Type') return tx.cardtype || 'Unknown';
  if (dimName === 'Card Scope') return classifyCardScope(tx.cardcountry);
  if (dimName === 'Processing Card Type') return tx.processingcardtype || 'Unknown';
  if (dimName === 'Native OTP Eligible') return tx.nativeotpurleligible || 'Unknown';
  if (dimName === 'Frictionless') return tx.card_isfrictionless || 'Unknown';

  if (dimName === 'Bank') return tx.bankname || 'Unknown';
  return 'Unknown';
}

export async function POST(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  try {
    const { uploadId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as BreakdownBody | null;
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

  const globalStart = body.filters.startDate ? new Date(body.filters.startDate) : null;
  const globalEndRaw = body.filters.endDate ? new Date(body.filters.endDate) : null;
  const globalEnd = globalEndRaw ? new Date(globalEndRaw) : null;
  if (globalEnd) globalEnd.setHours(23, 59, 59, 999);

  const periodStart = new Date(body.period.start);
  const periodEnd = new Date(body.period.end);

  const paymentModeSet = body.filters.paymentModes?.length ? new Set(body.filters.paymentModes.map((s) => upper(s))) : null;
  const merchantIdSet = body.filters.merchantIds?.length ? new Set(body.filters.merchantIds.map((s) => norm(s))) : null;
  const pgSet = body.filters.pgs?.length ? new Set(body.filters.pgs.map((s) => norm(s))) : null;
  const bankSet = body.filters.banks?.length ? new Set(body.filters.banks.map((s) => norm(s))) : null;
  const cardTypeSet = body.filters.cardTypes?.length ? new Set(body.filters.cardTypes.map((s) => norm(s))) : null;

  const paymentModeMap = new Map<string, number>();
  const pgMap = new Map<string, number>();

  await new Promise<void>((resolve, reject) => {
    const stream = fs
      .createReadStream(filePath)
      .pipe(
        csvParser({
          mapHeaders: ({ header }) => normalizeHeaderKey(String(header || '')),
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
      const txtime = parseTxTime(row?.txtime);
      if (!txtime) return;

      if (globalStart && txtime < globalStart) return;
      if (globalEnd && txtime > globalEnd) return;
      if (paymentModeSet && !paymentModeSet.has(pm)) return;
      if (merchantIdSet && !merchantIdSet.has(mid)) return;
      if (pgSet && !pgSet.has(pg)) return;
      if (bankSet) {
        const flow = classifyUPIFlow(bankname);
        if (!bankSet.has(flow) && !bankSet.has(bankname)) return;
      }
      if (cardTypeSet && !cardTypeSet.has(cardtype)) return;

      if (txtime < periodStart || txtime > periodEnd) return;

      const tx: Transaction = {
        txstatus,
        paymentmode: pm,
        pg,
        bankname,
        cardnumber: norm(row?.cardnumber),
        cardmasked: norm(row?.cardmasked),
        cardtype,
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
        transactionDate: '',
        isSuccess: txstatus === 'SUCCESS',
        isFailed: txstatus === 'FAILED',
        isUserDropped: txstatus === 'USER_DROPPED',
        merchantid: mid,
      };

      const statusMatch = body.analysisType === 'FAILED' ? tx.isFailed : tx.isUserDropped;
      if (!statusMatch) return;

      const dimValue = getDimensionValue(tx, body.dimension);
      if (dimValue !== body.dimensionValue) return;

      paymentModeMap.set(pm || 'Unknown', (paymentModeMap.get(pm || 'Unknown') || 0) + 1);
      pgMap.set(pg || 'Unknown', (pgMap.get(pg || 'Unknown') || 0) + 1);
    });

    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });

    const total = Array.from(paymentModeMap.values()).reduce((s, n) => s + n, 0);
    const paymentModes = Array.from(paymentModeMap.entries())
      .map(([name, count]) => ({ name, count, percent: total > 0 ? (count / total) * 100 : 0 }))
      .sort((a, b) => b.count - a.count);
    const pgs = Array.from(pgMap.entries())
      .map(([name, count]) => ({ name, count, percent: total > 0 ? (count / total) * 100 : 0 }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({ paymentModes, pgs }, { status: 200 });
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while computing RCA breakdown',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}


