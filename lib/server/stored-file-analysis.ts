import fs from 'node:fs';
import * as fastcsv from 'fast-csv';
import { format, parse } from 'date-fns';
import { prisma } from '@/lib/prisma';
import { calculateSR } from '@/lib/utils';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';

type AnalysisStatus = 'queued' | 'running' | 'completed' | 'failed';

type AnalysisResultJson = {
  global: {
    totalCount: number;
    successCount: number;
    failedCount: number;
    userDroppedCount: number;
    sr: number;
    successGmv: number;
    failedPercent: number;
    userDroppedPercent: number;
  };
  dailyTrends: Array<{
    date: string;
    volume: number;
    successCount: number;
    failedCount: number;
    userDroppedCount: number;
    sr: number;
  }>;
  meta: {
    processedRows: number;
    invalidDateRows: number;
    startedAt: string;
    completedAt: string;
  };
};

declare global {
  // eslint-disable-next-line no-var
  var __srStoredFileAnalysisLocks: Map<string, boolean> | undefined;
}

function getLocks() {
  if (!global.__srStoredFileAnalysisLocks) {
    global.__srStoredFileAnalysisLocks = new Map<string, boolean>();
  }
  return global.__srStoredFileAnalysisLocks;
}

// Helper function to parse numbers with commas (kept consistent with lib/data-normalization.ts)
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

// Helper function to parse various date formats (kept consistent with lib/data-normalization.ts)
function parseDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  // OPTIMIZATION: Try native Date first (V8 handles common formats liek "October 1, 2025" very fast)
  const isoParsed = new Date(trimmed);
  if (!Number.isNaN(isoParsed.getTime())) return isoParsed;

  try {
    const parsedA = parse(trimmed, 'MMMM d, yyyy, h:mm a', new Date());
    if (!Number.isNaN(parsedA.getTime())) return parsedA;

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

  return null;
}

function normalizeRow(raw: Record<string, any>) {
  // OPTIMIZATION: headers are already lowercased by the parser transform. 
  // We access properties directly to avoid expensive object iteration/creation.
  // We use fallback to 'undefined' which matches the logic of finding keys.

  const txstatus = raw.txstatus ? String(raw.txstatus).toUpperCase().trim() : '';
  // Note: we just pass the raw value to parseDate/parseNumber which trim strings anyway
  const txtime = parseDate(raw.txtime);
  const txamount = parseNumber(raw.txamount);

  return { txstatus, txtime, txamount };
}

export async function startStoredFileAnalysis(storedFileId: string): Promise<{ started: boolean }> {
  const locks = getLocks();
  if (locks.get(storedFileId)) return { started: false };

  const analysis = await prisma.storedFileAnalysis.findUnique({ where: { storedFileId } });
  if (analysis && (analysis.status === 'running' || analysis.status === 'completed')) {
    return { started: false };
  }

  await prisma.storedFileAnalysis.upsert({
    where: { storedFileId },
    create: { storedFileId, status: 'queued' },
    update: { status: 'queued', error: null },
  });

  locks.set(storedFileId, true);
  setTimeout(() => {
    void runStoredFileAnalysis(storedFileId).finally(() => {
      locks.delete(storedFileId);
    });
  }, 0);

  return { started: true };
}

async function runStoredFileAnalysis(storedFileId: string) {
  const storedFile = await prisma.storedFile.findUnique({ where: { id: storedFileId } });
  if (!storedFile) {
    await prisma.storedFileAnalysis.upsert({
      where: { storedFileId },
      create: { storedFileId, status: 'failed', error: 'StoredFile not found' },
      update: { status: 'failed', error: 'StoredFile not found', completedAt: new Date() },
    });
    return;
  }

  const startedAt = new Date();
  await prisma.storedFileAnalysis.update({
    where: { storedFileId },
    data: { status: 'running', startedAt, processedRows: 0, totalRows: null, error: null },
  });

  const filePath = resolveStoredFileAbsolutePath(storedFile.storagePath);
  if (!fs.existsSync(filePath)) {
    await prisma.storedFileAnalysis.update({
      where: { storedFileId },
      data: { status: 'failed', error: 'Stored file missing on disk', completedAt: new Date() },
    });
    return;
  }

  let processedRows = 0;
  let invalidDateRows = 0;

  let totalCount = 0;
  let successCount = 0;
  let failedCount = 0;
  let userDroppedCount = 0;
  let successGmv = 0;

  const dailyMap = new Map<
    string,
    { date: string; volume: number; successCount: number; failedCount: number; userDroppedCount: number }
  >();

  const progressEveryRows = 50_000;
  let nextProgressUpdateAt = progressEveryRows;

  try {
    await new Promise<void>((resolve, reject) => {
      const stream = fs
        .createReadStream(filePath, {
          highWaterMark: 1024 * 1024, // 1MB buffer to prevent premature stream end
        })
        .pipe(
          fastcsv.parse({ headers: true, trim: true, ignoreEmpty: true })
            .transform((row: any) => {
              // Lowercase all keys to match previous normalization
              const lowercased: any = {};
              for (const k of Object.keys(row)) {
                lowercased[k.toLowerCase().trim()] = row[k];
              }
              return lowercased;
            })
        );

      stream.on('data', (row: any) => {
        processedRows++;
        totalCount++;

        const { txstatus, txtime, txamount } = normalizeRow(row as Record<string, any>);

        if (txstatus === 'SUCCESS') {
          successCount++;
          successGmv += txamount || 0;
        } else if (txstatus === 'FAILED') {
          failedCount++;
        } else if (txstatus === 'USER_DROPPED') {
          userDroppedCount++;
        }

        if (!txtime) {
          invalidDateRows++;
        } else {
          const date = format(txtime, 'yyyy-MM-dd');
          if (!dailyMap.has(date)) {
            dailyMap.set(date, { date, volume: 0, successCount: 0, failedCount: 0, userDroppedCount: 0 });
          }
          const d = dailyMap.get(date)!;
          d.volume++;
          if (txstatus === 'SUCCESS') d.successCount++;
          if (txstatus === 'FAILED') d.failedCount++;
          if (txstatus === 'USER_DROPPED') d.userDroppedCount++;
        }

        if (processedRows >= nextProgressUpdateAt) {
          nextProgressUpdateAt += progressEveryRows;
          // Best-effort progress update; don't await inside the stream.
          void prisma.storedFileAnalysis
            .update({ where: { storedFileId }, data: { processedRows } })
            .catch(() => { });
        }
      });

      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
    });
  } catch (e: any) {
    await prisma.storedFileAnalysis.update({
      where: { storedFileId },
      data: {
        status: 'failed',
        processedRows,
        totalRows: totalCount,
        error: e?.message || 'Failed to analyze CSV',
        completedAt: new Date(),
      },
    });
    return;
  }

  const completedAt = new Date();
  const dailyTrends = Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      ...d,
      sr: calculateSR(d.successCount, d.volume),
    }));

  const resultJson: AnalysisResultJson = {
    global: {
      totalCount,
      successCount,
      failedCount,
      userDroppedCount,
      sr: calculateSR(successCount, totalCount),
      successGmv,
      failedPercent: calculateSR(failedCount, totalCount),
      userDroppedPercent: calculateSR(userDroppedCount, totalCount),
    },
    dailyTrends,
    meta: {
      processedRows,
      invalidDateRows,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    },
  };

  await prisma.storedFileAnalysis.update({
    where: { storedFileId },
    data: {
      status: 'completed' as AnalysisStatus,
      processedRows,
      totalRows: totalCount,
      resultJson: JSON.stringify(resultJson), // Serialize to string for SQLite
      error: null,
      completedAt,
    },
  });
}



