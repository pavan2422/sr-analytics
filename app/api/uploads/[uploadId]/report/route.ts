import { NextResponse } from 'next/server';
import fs from 'node:fs';
import csvParser from 'csv-parser';
import * as XLSX from 'xlsx';
import { format, startOfWeek } from 'date-fns';
import { extractUPIHandle } from '@/lib/data-normalization';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';
import { normalizeHeaderKey } from '@/lib/csv-headers';
import { parseTxTime } from '@/lib/tx-time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow up to 5 minutes for large file processing (Vercel Pro plan max)
export const maxDuration = 300;

type ReportType = 'daily' | 'weekly' | 'monthly';

type ReportRequestBody = {
  reportType: ReportType;
  selectedPaymentModes?: string[];
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

type Agg = {
  MerchantID: string;
  // dynamic grouping columns are stored separately in keyParts
  Volume: number;
  Success: number;
  UserDrops: number;
  Total_Value: number;
  GMV: number;
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

function upper(v: any): string {
  return String(v ?? '').toUpperCase().trim();
}
function norm(v: any): string {
  return String(v ?? '').trim();
}

function getTimeCol(reportType: ReportType): 'Day' | 'Week' | 'Month' {
  if (reportType === 'daily') return 'Day';
  if (reportType === 'weekly') return 'Week';
  return 'Month';
}

function timeValueFor(timeCol: 'Day' | 'Week' | 'Month', txtime: Date): string {
  if (timeCol === 'Day') return format(txtime, 'yyyy-MM-dd');
  if (timeCol === 'Week') return format(startOfWeek(txtime, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  return format(txtime, 'yyyy-MM');
}

function upsertAgg(map: Map<string, Agg>, key: string, merchantId: string) {
  let a = map.get(key);
  if (!a) {
    a = { MerchantID: merchantId, Volume: 0, Success: 0, UserDrops: 0, Total_Value: 0, GMV: 0 };
    map.set(key, a);
  }
  return a;
}

function computeSR(success: number, total: number) {
  return total > 0 ? Number((100 * success / total).toFixed(2)) : 0;
}

function addMoMChanges(rows: Record<string, any>[], groupCols: string[]): Record<string, any>[] {
  if (rows.length <= 1 || !groupCols.includes('Month')) return rows;
  const keyCols = groupCols.filter((c) => c !== 'Month');

  const rowsByKey = new Map<string, Record<string, any>[]>();
  for (const row of rows) {
    const key = keyCols.map((col) => (col === 'MerchantID' ? row.MerchantID : String(row[col] || ''))).join('|');
    const bucket = rowsByKey.get(key) || [];
    bucket.push(row);
    rowsByKey.set(key, bucket);
  }

  rowsByKey.forEach((groupRows) => {
    groupRows.sort((a, b) => String(a.Month || '').localeCompare(String(b.Month || '')));
    for (let i = 1; i < groupRows.length; i++) {
      const current = groupRows[i];
      const previous = groupRows[i - 1];
      current['Volume Δ'] = (current.Volume || 0) - (previous.Volume || 0);
      current['Volume % Change'] =
        (previous.Volume || 0) > 0 ? Number((100 * ((current.Volume || 0) - (previous.Volume || 0)) / (previous.Volume || 0)).toFixed(2)) : 0;
      current['SR (%) Δ'] = Number(((current['SR (%)'] || 0) - (previous['SR (%)'] || 0)).toFixed(2));
      current['SR (%) % Change'] =
        (previous['SR (%)'] || 0) > 0
          ? Number((100 * ((current['SR (%)'] || 0) - (previous['SR (%)'] || 0)) / (previous['SR (%)'] || 0)).toFixed(2))
          : 0;
    }
  });

  return rows;
}

export async function POST(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  try {
    const { uploadId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as ReportRequestBody | null;
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

    const { reportType } = body;
    const timeCol = getTimeCol(reportType);

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

  const startDate = body.filters.startDate ? new Date(body.filters.startDate) : null;
  const endDateRaw = body.filters.endDate ? new Date(body.filters.endDate) : null;
  const endDate = endDateRaw ? new Date(endDateRaw) : null;
  if (endDate) endDate.setHours(23, 59, 59, 999);

  const selectedPaymodes = (body.selectedPaymentModes || []).map((s) => upper(s)).filter(Boolean);
  const selectedPaymodeSet = selectedPaymodes.length ? new Set(selectedPaymodes) : null;

  const paymentModeSet = body.filters.paymentModes?.length ? new Set(body.filters.paymentModes.map((s) => upper(s))) : null;
  const merchantIdSet = body.filters.merchantIds?.length ? new Set(body.filters.merchantIds.map((s) => norm(s))) : null;
  const pgSet = body.filters.pgs?.length ? new Set(body.filters.pgs.map((s) => norm(s))) : null;
  const bankSet = body.filters.banks?.length ? new Set(body.filters.banks.map((s) => norm(s))) : null;
  const cardTypeSet = body.filters.cardTypes?.length ? new Set(body.filters.cardTypes.map((s) => norm(s))) : null;

  // Aggregation maps
  const srTime = new Map<string, Agg>(); // MerchantID|time
  const srPaymode = new Map<string, Agg>(); // MerchantID|paymentmode
  const srPaymodeTime = new Map<string, Agg>(); // MerchantID|time|paymentmode
  const srBank = new Map<string, Agg>(); // MerchantID|bankname
  const srPaymodeBank = new Map<string, Agg>(); // MerchantID|paymentmode|bankname
  const srCardNetwork = new Map<string, Agg>(); // MerchantID|paymentmode|cardtype
  const srCardTypeDaily = new Map<string, Agg>(); // MerchantID|Day|paymentmode|cardtype
  const srPsp = new Map<string, Agg>(); // MerchantID|upi_psp
  const srPspTime = new Map<string, Agg>(); // MerchantID|time|upi_psp
  const srHandle = new Map<string, Agg>(); // MerchantID|handle
  const srHandleTime = new Map<string, Agg>(); // MerchantID|time|handle

  const failuresByReason = new Map<string, number>(); // MerchantID|paymentmode|txmsg
  const failuresByTime = new Map<string, number>(); // MerchantID|time
  const failuresByPaymodeMonth = new Map<string, number>(); // MerchantID|paymentmode|Month

  const merchantTotals = new Map<string, number>();
  const months = new Set<string>();
  let totalVolume = 0;

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
      const upiPsp = norm(row?.upi_psp);
      const cardmasked = norm(row?.cardmasked);
      const txstatus = upper(row?.txstatus);
      const txtime = parseTxTime(row?.txtime);
      if (!txtime) return;

      if (startDate && txtime < startDate) return;
      if (endDate && txtime > endDate) return;
      if (paymentModeSet && !paymentModeSet.has(pm)) return;
      if (selectedPaymodeSet && !selectedPaymodeSet.has(pm)) return;
      if (merchantIdSet && !merchantIdSet.has(mid)) return;
      if (pgSet && !pgSet.has(pg)) return;
      if (bankSet && !bankSet.has(bankname)) return;
      if (cardTypeSet && !cardTypeSet.has(cardtype)) return;

      totalVolume += 1;
      merchantTotals.set(mid, (merchantTotals.get(mid) || 0) + 1);
      months.add(format(txtime, 'yyyy-MM'));

      const isSuccess = txstatus === 'SUCCESS';
      const isUserDropped = txstatus === 'USER_DROPPED';
      const amt = parseNumber(row?.txamount);

      const timeValue = timeValueFor(timeCol, txtime);
      const monthValue = format(txtime, 'yyyy-MM');

      const update = (map: Map<string, Agg>, key: string) => {
        const a = upsertAgg(map, key, mid);
        a.Volume += 1;
        if (isSuccess) a.Success += 1;
        if (isUserDropped) a.UserDrops += 1;
        a.Total_Value += amt;
        if (isSuccess) a.GMV += amt;
      };

      update(srTime, `${mid}|${timeValue}`);
      if (pm) update(srPaymode, `${mid}|${pm}`);
      if (pm) update(srPaymodeTime, `${mid}|${timeValue}|${pm}`);
      if (bankname) update(srBank, `${mid}|${bankname}`);
      if (pm && bankname) update(srPaymodeBank, `${mid}|${pm}|${bankname}`);

      if (['CREDIT_CARD', 'DEBIT_CARD'].includes(pm) && cardtype) {
        update(srCardNetwork, `${mid}|${pm}|${cardtype}`);
        if (timeCol === 'Day') update(srCardTypeDaily, `${mid}|${format(txtime, 'yyyy-MM-dd')}|${pm}|${cardtype}`);
      }

      if (['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'].includes(pm) && upiPsp) {
        update(srPsp, `${mid}|${upiPsp}`);
        update(srPspTime, `${mid}|${timeValue}|${upiPsp}`);
      }

      if (['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'].includes(pm)) {
        const handle = extractUPIHandle(cardmasked);
        if (handle) {
          update(srHandle, `${mid}|${handle}`);
          update(srHandleTime, `${mid}|${timeValue}|${handle}`);
        }
      }

      if (!isSuccess) {
        const txmsg = norm(row?.txmsg) || 'UNKNOWN';
        failuresByReason.set(`${mid}|${pm || 'UNKNOWN'}|${txmsg}`, (failuresByReason.get(`${mid}|${pm || 'UNKNOWN'}|${txmsg}`) || 0) + 1);
        failuresByTime.set(`${mid}|${timeValue}`, (failuresByTime.get(`${mid}|${timeValue}`) || 0) + 1);
        failuresByPaymodeMonth.set(
          `${mid}|${pm || 'UNKNOWN'}|${monthValue}`,
          (failuresByPaymodeMonth.get(`${mid}|${pm || 'UNKNOWN'}|${monthValue}`) || 0) + 1
        );
      }
    });

    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });

  const isMultiMonth = months.size > 1;

  const buildRows = (map: Map<string, Agg>, cols: string[]): Record<string, any>[] => {
    const out: Record<string, any>[] = [];
    for (const [key, a] of map.entries()) {
      const parts = key.split('|');
      const merchantId = parts[0];
      const values = parts.slice(1);
      const row: Record<string, any> = { MerchantID: merchantId };
      cols.forEach((c, idx) => {
        row[c] = values[idx] ?? '';
      });

      const nonDropTotal = Math.max(0, a.Volume - a.UserDrops);
      row.Volume = a.Volume;
      row.Success = a.Success;
      row['SR (%)'] = computeSR(a.Success, a.Volume);
      row['SR without User Drops (%)'] = computeSR(a.Success, nonDropTotal);
      row.UserDrops = a.UserDrops;
      row['Unsuccessful Count'] = a.Volume - a.Success;
      row['Total_Value'] = Number(a.Total_Value.toFixed(2));
      row.GMV = Number(a.GMV.toFixed(2));
      row['% of Volume (Global)'] = totalVolume > 0 ? Number((100 * a.Volume / totalVolume).toFixed(2)) : 0;
      const merchantTotal = merchantTotals.get(merchantId) || 0;
      row['% of Volume (Per Merchant)'] = merchantTotal > 0 ? Number((100 * a.Volume / merchantTotal).toFixed(2)) : 0;
      out.push(row);
    }
    // Sort by time cols first, then merchant
    out.sort((a, b) => {
      for (const c of cols) {
        const av = String(a[c] || '');
        const bv = String(b[c] || '');
        if (av !== bv) return av.localeCompare(bv);
      }
      return String(a.MerchantID).localeCompare(String(b.MerchantID));
    });
    return out;
  };

  const sheets = new Map<string, any[]>();

  // SR by time
  const timeRows = buildRows(srTime, [timeCol]);
  sheets.set(`SR ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`, reportType === 'monthly' && isMultiMonth ? addMoMChanges(timeRows, [timeCol]) : timeRows);

  // SR by paymode
  const paymodeRows = buildRows(srPaymode, ['paymentmode']);
  sheets.set('SR by Paymode', paymodeRows);
  const paymodeTimeRows = buildRows(srPaymodeTime, [timeCol, 'paymentmode']);
  sheets.set(
    `SR by Paymode ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`,
    reportType === 'monthly' && isMultiMonth ? addMoMChanges(paymodeTimeRows, [timeCol, 'paymentmode']) : paymodeTimeRows
  );

  // SR by bank + paymode+bank
  const bankRows = buildRows(srBank, ['bankname']);
  sheets.set('SR by Bank', bankRows);
  const paymodeBankRows = buildRows(srPaymodeBank, ['paymentmode', 'bankname']);
  sheets.set('Paymode+Bank', paymodeBankRows);

  // Card network and daily
  const cardNetworkRows = buildRows(srCardNetwork, ['paymentmode', 'cardtype']);
  if (cardNetworkRows.length > 0) sheets.set('Card Network', cardNetworkRows);
  if (timeCol === 'Day') {
    const cardDailyRows = buildRows(srCardTypeDaily, ['Day', 'paymentmode', 'cardtype']);
    if (cardDailyRows.length > 0) sheets.set('SR by Card Type Daily', cardDailyRows);
  }

  // UPI PSP
  const pspRows = buildRows(srPsp, ['upi_psp']);
  if (pspRows.length > 0) sheets.set('SR by PSP', pspRows);
  const pspTimeRows = buildRows(srPspTime, [timeCol, 'upi_psp']);
  if (pspTimeRows.length > 0) {
    sheets.set(
      `SR by PSP ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`,
      reportType === 'monthly' && isMultiMonth ? addMoMChanges(pspTimeRows, [timeCol, 'upi_psp']) : pspTimeRows
    );
  }

  // UPI Handle
  const handleRows = buildRows(srHandle, ['handle']);
  if (handleRows.length > 0) {
    handleRows.sort((a, b) => (b.Volume || 0) - (a.Volume || 0));
    sheets.set('SR by Handle', handleRows);
    const handleTimeRows = buildRows(srHandleTime, [timeCol, 'handle']);
    sheets.set(`SR by Handle ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`, handleTimeRows);
  }

  // Failures by Reason
  const failureReasonRows = Array.from(failuresByReason.entries())
    .map(([key, Volume]) => {
      const [MerchantID, paymentmode, txmsg] = key.split('|');
      return { MerchantID, paymentmode, txmsg, Volume };
    })
    .sort((a, b) => b.Volume - a.Volume);
  sheets.set('Failures by Reason', failureReasonRows);

  // Failures by time
  const failuresTimeName = timeCol === 'Day' ? 'Failures Daily' : timeCol === 'Week' ? 'Failures Weekly' : 'Failures Monthly';
  const failureTimeRows = Array.from(failuresByTime.entries())
    .map(([key, Volume]) => {
      const [MerchantID, timeValue] = key.split('|');
      return { MerchantID, [timeCol]: timeValue, Volume };
    })
    .sort((a, b) => String(a[timeCol] || '').localeCompare(String(b[timeCol] || '')));
  sheets.set(failuresTimeName, failureTimeRows);

  if (isMultiMonth && timeCol === 'Month') {
    const rows = Array.from(failuresByPaymodeMonth.entries())
      .map(([key, Volume]) => {
        const [MerchantID, paymentmode, Month] = key.split('|');
        return { MerchantID, paymentmode, Month, Volume };
      })
      .sort((a, b) => {
        if (a.Month !== b.Month) return (a.Month || '').localeCompare(b.Month || '');
        if (a.MerchantID !== b.MerchantID) return a.MerchantID.localeCompare(b.MerchantID);
        return 0;
      });

    // add MoM changes on Volume
    const rowsByKey = new Map<string, any[]>();
    rows.forEach((r) => {
      const k = `${r.MerchantID}|${r.paymentmode}`;
      const arr = rowsByKey.get(k) || [];
      arr.push(r);
      rowsByKey.set(k, arr);
    });
    rowsByKey.forEach((groupRows) => {
      groupRows.sort((a, b) => (a.Month || '').localeCompare(b.Month || ''));
      for (let i = 1; i < groupRows.length; i++) {
        const current = groupRows[i];
        const previous = groupRows[i - 1];
        current['Volume Δ'] = (current.Volume || 0) - (previous.Volume || 0);
        current['Volume % Change'] =
          (previous.Volume || 0) > 0 ? Number((100 * ((current.Volume || 0) - (previous.Volume || 0)) / (previous.Volume || 0)).toFixed(2)) : 0;
      }
    });

    sheets.set('Failures by Paymode Monthly', rows);
  }

    // Build xlsx
    const workbook = XLSX.utils.book_new();
    sheets.forEach((data, name) => {
      const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ Info: 'No data available' }]);
      XLSX.utils.book_append_sheet(workbook, ws, name);
    });
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const bytes = new Uint8Array(buffer);

    const today = format(new Date(), 'yyyyMMdd');
    const filename = `SR_Analysis_${reportType}_${today}.xlsx`;
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while generating report',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}


