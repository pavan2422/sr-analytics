'use client';

import type { ProcessingProgress } from '@/lib/file-processor';

type InitResponse = {
  uploadId: string;
  expectedParts: number;
};

type CompleteResponse = {
  ok: boolean;
  uploadId: string;
  storedFileId: string;
  sha256Hex?: string;
};

export async function uploadFileInChunks(
  file: File,
  onProgress: (p: ProcessingProgress) => void,
  opts?: {
    chunkSizeBytes?: number;
    signal?: AbortSignal;
    /**
     * If provided, the client will try to resume this existing upload session
     * by skipping parts the server already has.
     */
    uploadId?: string;
    /**
     * Called as soon as we know the uploadId (both for new and resumed sessions).
     * Useful to persist the uploadId for recovery/resume.
     */
    onUploadId?: (uploadId: string) => void;
    /**
     * If true, the client will attempt to delete the upload session on fatal error.
     * Default: false (keep partial upload so user can resume).
     */
    cleanupOnError?: boolean;
  }
): Promise<{ uploadId: string; storedFileId: string; sha256Hex?: string }> {
  const chunkSizeBytes = opts?.chunkSizeBytes ?? 16 * 1024 * 1024; // 16MB default
  const totalBytes = file.size;

  onProgress({ processed: 0, total: totalBytes, percentage: 0, stage: 'uploading' });

  // Resume or init
  let uploadId = opts?.uploadId?.trim() || '';
  let expectedParts: number | null = null;
  let receivedParts = new Set<number>();
  let alreadyUploadedBytes = 0;

  if (uploadId) {
    const sessionRes = await fetch(`/api/uploads/${uploadId}`, { method: 'GET', signal: opts?.signal });
    if (!sessionRes.ok) {
      // If the server doesn't know this uploadId, fall back to a fresh init.
      uploadId = '';
    } else {
      const s = (await sessionRes.json()) as any;
      if (Number(s?.sizeBytes) !== totalBytes) {
        throw new Error('Cannot resume upload: file size does not match the existing upload session.');
      }
      if (Number(s?.chunkSizeBytes) !== chunkSizeBytes) {
        throw new Error('Cannot resume upload: chunk size does not match the existing upload session.');
      }
      expectedParts = Number(s?.expectedParts);
      receivedParts = new Set<number>((s?.receivedParts || []).map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n)));
      alreadyUploadedBytes = Number(s?.receivedBytes || 0);
      opts?.onUploadId?.(uploadId);
    }
  }

  if (!uploadId) {
    const initRes = await fetch('/api/uploads/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        originalName: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: totalBytes,
        chunkSizeBytes,
      }),
      signal: opts?.signal,
    });
    if (!initRes.ok) {
      let errorMsg = `Upload init failed (${initRes.status})`;
      try {
        const errorJson = await initRes.json();
        errorMsg = errorJson.error || errorJson.message || errorMsg;
        if (errorJson.message) {
          errorMsg += `: ${errorJson.message}`;
        }
      } catch {
        // If JSON parsing fails, try text
        try {
          const errorText = await initRes.text();
          if (errorText) errorMsg += `: ${errorText}`;
        } catch {
          // Ignore if text parsing also fails
        }
      }
      throw new Error(errorMsg);
    }
    const initJson = (await initRes.json()) as InitResponse;
    uploadId = initJson.uploadId;
    expectedParts = initJson.expectedParts;
    receivedParts = new Set<number>();
    alreadyUploadedBytes = 0;
    opts?.onUploadId?.(uploadId);
  }

  if (!expectedParts || !Number.isFinite(expectedParts) || expectedParts < 1) {
    throw new Error('Upload init failed: expectedParts is invalid.');
  }

  let uploaded = Math.max(0, alreadyUploadedBytes);
  if (uploaded > 0) {
    const pct = Math.min((uploaded / totalBytes) * 90, 90);
    onProgress({ processed: uploaded, total: totalBytes, percentage: pct, stage: 'uploading' });
  }

  try {
    for (let part = 1; part <= expectedParts; part++) {
      if (receivedParts.has(part)) continue;

      const start = (part - 1) * chunkSizeBytes;
      const end = Math.min(part * chunkSizeBytes, totalBytes);
      const blob = file.slice(start, end);

      const partRes = await fetch(`/api/uploads/${uploadId}/part/${part}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: blob,
        signal: opts?.signal,
      });
      if (!partRes.ok) {
        let errorMsg = `Upload chunk ${part}/${expectedParts} failed (${partRes.status})`;
        try {
          const errorJson = await partRes.json();
          errorMsg = errorJson.error || errorJson.message || errorMsg;
          if (errorJson.message) {
            errorMsg += `: ${errorJson.message}`;
          }
        } catch {
          try {
            const errorText = await partRes.text();
            if (errorText) errorMsg += `: ${errorText}`;
          } catch {
            // Ignore if parsing fails
          }
        }
        throw new Error(errorMsg);
      }

      uploaded += blob.size;
      const pct = Math.min((uploaded / totalBytes) * 90, 90);
      onProgress({ processed: uploaded, total: totalBytes, percentage: pct, stage: 'uploading' });
    }
  } catch (err) {
    // Optional cleanup; default is to keep partial upload so we can resume.
    if (opts?.cleanupOnError) {
      try {
        await fetch(`/api/uploads/${uploadId}`, { method: 'DELETE' });
      } catch {
        // ignore
      }
    }
    throw err;
  }

  const completeRes = await fetch(`/api/uploads/${uploadId}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ totalParts: expectedParts }),
    signal: opts?.signal,
  });
  if (!completeRes.ok) {
    let errorMsg = `Upload finalize failed (${completeRes.status})`;
    try {
      const errorJson = await completeRes.json();
      errorMsg = errorJson.error || errorJson.message || errorMsg;
      if (errorJson.message) {
        errorMsg += `: ${errorJson.message}`;
      }
    } catch {
      try {
        const errorText = await completeRes.text();
        if (errorText) errorMsg += `: ${errorText}`;
      } catch {
        // Ignore if parsing fails
      }
    }
    throw new Error(errorMsg);
  }

  const completeJson = (await completeRes.json()) as CompleteResponse;
  onProgress({ processed: totalBytes, total: totalBytes, percentage: 100, stage: 'complete' });

  return { uploadId, storedFileId: completeJson.storedFileId, sha256Hex: completeJson.sha256Hex };
}


