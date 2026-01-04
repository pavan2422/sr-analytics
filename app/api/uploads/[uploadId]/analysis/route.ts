import { NextResponse } from 'next/server';
import { ensureDatabaseReady } from '@/lib/server/db-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow up to 5 minutes for large file processing (Vercel Pro plan max)
export const maxDuration = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  try {
    const { uploadId } = await ctx.params;
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
      include: { storedFile: { include: { analysis: true } } },
    });

    if (!session) return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
    if (!session.storedFile) return NextResponse.json({ error: 'No stored file for this upload yet' }, { status: 409 });

    const analysis = session.storedFile.analysis;
    if (!analysis) {
      return NextResponse.json({ status: 'not_started' }, { status: 200 });
    }

    return NextResponse.json(
      {
        status: analysis.status,
        processedRows: analysis.processedRows,
        totalRows: analysis.totalRows,
        startedAt: analysis.startedAt,
        completedAt: analysis.completedAt,
        error: analysis.error,
        resultJson:
          analysis.status === 'completed' && analysis.resultJson
            ? (() => {
                try {
                  return JSON.parse(analysis.resultJson);
                } catch {
                  return null;
                }
              })()
            : null,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while fetching analysis status',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  try {
    const { uploadId } = await ctx.params;
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
    if (session.status !== 'completed' || !session.storedFileId) {
      return NextResponse.json({ error: 'Upload not completed yet' }, { status: 409 });
    }

    // Lazy import to keep the route module light during build-time evaluation on Vercel.
    const { startStoredFileAnalysis } = await import('@/lib/server/stored-file-analysis');
    const started = await startStoredFileAnalysis(session.storedFileId);
    return NextResponse.json({ ok: true, ...started }, { status: 200 });
  } catch (e: any) {
    const msg = String(e?.message || 'Unknown error');
    return NextResponse.json(
      {
        error: 'Internal server error while starting analysis',
        message: msg,
        code: e?.code,
        stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
      },
      { status: 500 }
    );
  }
}



