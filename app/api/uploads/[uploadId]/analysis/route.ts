import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { startStoredFileAnalysis } from '@/lib/server/stored-file-analysis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
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
      resultJson: analysis.status === 'completed' && analysis.resultJson 
        ? JSON.parse(analysis.resultJson) 
        : null,
    },
    { status: 200 }
  );
}

export async function POST(_req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
  const session = await prisma.uploadSession.findUnique({
    where: { id: uploadId },
    include: { storedFile: true },
  });

  if (!session) return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
  if (session.status !== 'completed' || !session.storedFileId) {
    return NextResponse.json({ error: 'Upload not completed yet' }, { status: 409 });
  }

  const started = await startStoredFileAnalysis(session.storedFileId);
  return NextResponse.json({ ok: true, ...started }, { status: 200 });
}



