import { NextResponse } from 'next/server';
import fs from 'node:fs';
import * as fastcsv from 'fast-csv';
import { classifyUPIFlow } from '@/lib/data-normalization';
import { resolveStoredFileAbsolutePath } from '@/lib/server/storage';
import { ensureDatabaseReady } from '@/lib/server/db-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow up to 5 minutes for large file processing (Vercel Pro plan max)
export const maxDuration = 300;

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

    const paymentModeFilter = url.searchParams.getAll('paymentModes').map((s) => String(s).toUpperCase().trim()).filter(Boolean);
    const paymentModeSet = paymentModeFilter.length ? new Set(paymentModeFilter) : null;

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

    const paymentModes = new Set<string>();
    const merchantIds = new Set<string>();
    const pgs = new Set<string>();
    const banks = new Set<string>();
    const cardTypes = new Set<string>();

    const MAX_UNIQUE_MERCHANTS = 5000; // prevent UI + memory blowups
    const MAX_UNIQUE_PGS = 500;
    const MAX_UNIQUE_BANKS = 1000;
    const MAX_UNIQUE_CARDTYPES = 200;
    let truncated = false;
    let truncatedPgs = false;
    let truncatedBanks = false;
    let truncatedCardTypes = false;

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
        if (paymentModeSet && pm && !paymentModeSet.has(pm)) return;
        if (pm) paymentModes.add(pm);

        const mid = row?.merchantid ? String(row.merchantid).trim() : '';
        if (mid) {
          if (merchantIds.size < MAX_UNIQUE_MERCHANTS) {
            merchantIds.add(mid);
          } else {
            truncated = true;
          }
        }

        const pg = row?.pg ? String(row.pg).trim() : '';
        if (pg) {
          const pgUpper = pg.toUpperCase();
          if (pgUpper !== 'N/A' && pgUpper !== 'NA') {
            if (pgs.size < MAX_UNIQUE_PGS) pgs.add(pg);
            else truncatedPgs = true;
          }
        }

        const bankname = row?.bankname ? String(row.bankname).trim() : '';
        if (bankname) {
          const isUPI = pm.startsWith('UPI');
          const bankValue = isUPI ? classifyUPIFlow(bankname) : bankname;
          if (banks.size < MAX_UNIQUE_BANKS) banks.add(bankValue);
          else truncatedBanks = true;
        }

        const cardtype = row?.cardtype ? String(row.cardtype).trim() : '';
        if (cardtype) {
          if (cardTypes.size < MAX_UNIQUE_CARDTYPES) cardTypes.add(cardtype);
          else truncatedCardTypes = true;
        }
      });

      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
    });

    return NextResponse.json(
      {
        paymentModes: Array.from(paymentModes.values()).sort(),
        merchantIds: Array.from(merchantIds.values()).sort(),
        truncated,
        pgs: Array.from(pgs.values()).sort(),
        banks: Array.from(banks.values()).sort(),
        cardTypes: Array.from(cardTypes.values()).sort(),
        truncatedPgs,
        truncatedBanks,
        truncatedCardTypes,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while computing filter options',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}


