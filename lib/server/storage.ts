import fs from 'node:fs';
import path from 'node:path';

/**
 * Centralized server-side storage paths for uploads.
 *
 * We store large files on disk (not in DB) and only keep metadata in Prisma.
 * This avoids buffering multi-GB files in memory and avoids DB bloat.
 */

const DATA_DIR = path.join(process.cwd(), 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const UPLOADS_TMP_DIR = path.join(UPLOADS_DIR, 'tmp');
const UPLOADS_FILES_DIR = path.join(UPLOADS_DIR, 'files');

export function ensureUploadDirs() {
  fs.mkdirSync(UPLOADS_TMP_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_FILES_DIR, { recursive: true });
}

export function getUploadSessionTmpDir(uploadId: string) {
  return path.join(UPLOADS_TMP_DIR, uploadId);
}

export function ensureUploadSessionTmpDir(uploadId: string) {
  const dir = getUploadSessionTmpDir(uploadId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getPartPath(uploadId: string, partNumber: number) {
  return path.join(getUploadSessionTmpDir(uploadId), `part-${partNumber}.bin`);
}

export function safeFilename(originalName: string) {
  // Keep it filesystem-safe and deterministic. (No path traversal, no weird chars.)
  const base = path.basename(originalName);
  return base.replace(/[^\w.\-()+\s]/g, '_').slice(0, 180);
}

export function buildStoredFileRelativePath(storedFileId: string, originalName: string) {
  // Stored as relative path so it works across OSes & deployments.
  const name = safeFilename(originalName);
  return path.join('data', 'uploads', 'files', `${storedFileId}-${name}`);
}

export function resolveStoredFileAbsolutePath(storagePath: string) {
  // `storagePath` is stored as relative path (from project root).
  return path.join(process.cwd(), storagePath);
}

export function listReceivedParts(uploadId: string): number[] {
  const dir = getUploadSessionTmpDir(uploadId);
  try {
    const files = fs.readdirSync(dir);
    return files
      .map((f) => {
        const m = /^part-(\d+)\.bin$/.exec(f);
        return m ? Number(m[1]) : null;
      })
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}



