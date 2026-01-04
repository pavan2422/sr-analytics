import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Transaction, FilterState, Metrics, DailyTrend, GroupedMetrics, FailureRCA, RCAInsight, PeriodComparison } from '@/types';
import { calculateSR, safeDivide } from '@/lib/utils';
import { normalizeData, classifyUPIFlow } from '@/lib/data-normalization';
import { indexedDBStorage } from './indexedDBStorage';
import { streamCSVFile, processExcelFile, ProcessingProgress } from '@/lib/file-processor';
import { WorkerManager } from '@/lib/worker-manager';
import { dbManager } from '@/lib/indexeddb-manager';
import { uploadFileInChunks } from '@/lib/upload-client';

interface StoreState {
  // Raw data metadata (not full transactions for large files)
  rawTransactions: Transaction[]; // Only kept for small datasets (<100k rows)
  transactionCount: number; // Total count of transactions in IndexedDB
  isLoading: boolean;
  error: string | null;
  fileNames: string[];
  fileSizes: number[];
  isSampledDataset: boolean; // True when we sampled a huge file instead of ingesting everything
  sampledFromBytes: number; // Original file size when sampling
  backendUploadId: string | null; // When using backend upload (multi-GB safe)
  backendStoredFileId: string | null; // StoredFile.id in Prisma (metadata + path)
  _skipPersistence: boolean; // Internal flag to skip persistence during large loads
  _useIndexedDB: boolean; // Flag to use IndexedDB instead of memory
  _useBackend: boolean; // Flag to use backend (server-side) instead of IndexedDB for large files
  progress: ProcessingProgress | null; // Progress tracking for large files
  hasHydrated: boolean; // True after Zustand persist rehydration completes
  analysisStage: 'FILTERING' | 'COMPUTING' | null; // UI hint for post-upload analysis work
  
  // Filters
  filters: FilterState;
  
  // Computed data (cached results)
  filteredTransactions: Transaction[]; // Only populated for small filtered sets
  filteredTransactionCount: number; // Count of filtered transactions
  globalMetrics: Metrics | null;
  dailyTrends: DailyTrend[];
  
  // Actions
  setRawTransactions: (transactions: Transaction[]) => void;
  loadDataFromFile: (file: File) => Promise<void>;
  addDataFromFile: (file: File) => Promise<void>;
  clearData: () => Promise<void>;
  restoreFromIndexedDB: () => Promise<{ status: 'restored' | 'missing' | 'error'; count?: number; error?: string }>;
  setFilters: (filters: Partial<FilterState>) => void;
  resetFilters: () => void;
  applyFilters: () => Promise<void>;
  computeMetrics: () => Promise<void>;
  
  // IndexedDB operations
  streamFilteredTransactions: (onChunk: (chunk: Transaction[]) => Promise<void>, chunkSize?: number) => Promise<void>;
  getSampleFilteredTransactions: (maxRows?: number, overrides?: Partial<{
    startDate?: Date;
    endDate?: Date;
    paymentModes?: string[];
    merchantIds?: string[];
    pgs?: string[];
    banks?: string[];
    cardTypes?: string[];
  }>) => Promise<Transaction[]>;
  getIndexedDBFilterOptions: () => Promise<{ paymentModes: string[]; merchantIds: string[] }>;
  getFilteredTimeBounds: () => Promise<{ min?: Date; max?: Date }>;
  
  // Computed selectors (memoized in components)
  getFilteredTransactions: () => Transaction[];
  getGlobalMetrics: () => Metrics | null;
  getDailyTrends: () => DailyTrend[];
}

const defaultFilters: FilterState = {
  dateRange: { start: null, end: null },
  paymentModes: [],
  merchantIds: [],
  pgs: [],
  banks: [],
  cardTypes: [],
};

// Worker manager instances (shared across store)
const workerManager = new WorkerManager();

async function fetchBackendSample(uploadId: string, maxRows: number) {
  const res = await fetch(`/api/uploads/${uploadId}/sample?maxRows=${maxRows}`);
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Failed to fetch sample from backend (${res.status}): ${msg}`);
  }
  const json = (await res.json()) as { transactions: Transaction[]; storedFileId: string };
  return json;
}

function buildBackendFilterQuery(filters: {
  startDate?: Date;
  endDate?: Date;
  paymentModes?: string[];
  merchantIds?: string[];
  pgs?: string[];
  banks?: string[];
  cardTypes?: string[];
}) {
  const params = new URLSearchParams();
  if (filters.startDate) params.set('startDate', filters.startDate.toISOString());
  if (filters.endDate) params.set('endDate', filters.endDate.toISOString());
  for (const pm of filters.paymentModes || []) params.append('paymentModes', pm);
  for (const id of filters.merchantIds || []) params.append('merchantIds', id);
  for (const pg of filters.pgs || []) params.append('pgs', pg);
  for (const b of filters.banks || []) params.append('banks', b);
  for (const ct of filters.cardTypes || []) params.append('cardTypes', ct);
  return params;
}

async function fetchBackendSampleFiltered(
  uploadId: string,
  maxRows: number,
  filters: Parameters<typeof buildBackendFilterQuery>[0]
) {
  const params = buildBackendFilterQuery(filters);
  params.set('maxRows', String(maxRows));
  const res = await fetch(`/api/uploads/${uploadId}/sample?${params.toString()}`);
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Failed to fetch filtered sample from backend (${res.status}): ${msg}`);
  }
  const json = (await res.json()) as { transactions: Transaction[]; storedFileId: string };
  return json;
}

async function fetchBackendMetrics(uploadId: string, filters: Parameters<typeof buildBackendFilterQuery>[0]) {
  const res = await fetch(`/api/uploads/${uploadId}/metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      startDate: filters.startDate ? filters.startDate.toISOString() : null,
      endDate: filters.endDate ? filters.endDate.toISOString() : null,
      paymentModes: filters.paymentModes || [],
      merchantIds: filters.merchantIds || [],
      pgs: filters.pgs || [],
      banks: filters.banks || [],
      cardTypes: filters.cardTypes || [],
    }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Failed to compute backend metrics (${res.status}): ${msg}`);
  }
  return (await res.json()) as {
    filteredTransactionCount: number;
    globalMetrics: Metrics;
    dailyTrends: DailyTrend[];
  };
}

async function fetchBackendFilterOptions(uploadId: string) {
  const res = await fetch(`/api/uploads/${uploadId}/filter-options`, { method: 'GET' });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Failed to load filter options from backend (${res.status}): ${msg}`);
  }
  return (await res.json()) as { paymentModes: string[]; merchantIds: string[]; truncated?: boolean };
}

async function fetchBackendTimeBounds(uploadId: string, filters: Parameters<typeof buildBackendFilterQuery>[0]) {
  const params = buildBackendFilterQuery(filters);
  const res = await fetch(`/api/uploads/${uploadId}/time-bounds?${params.toString()}`, { method: 'GET' });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Failed to load time bounds from backend (${res.status}): ${msg}`);
  }
  const json = (await res.json()) as { min?: string; max?: string };
  return {
    min: json.min ? new Date(json.min) : undefined,
    max: json.max ? new Date(json.max) : undefined,
  };
}

// Stream a HUGE CSV but stop after a fixed number of rows (sample mode).
async function streamCSVSampleToMemory(
  file: File,
  maxRows: number,
  progressCallback: (progress: ProcessingProgress) => void
): Promise<Transaction[]> {
  const Papa = (await import('papaparse')).default;
  const { normalizeData } = await import('@/lib/data-normalization');

  return new Promise<Transaction[]>((resolve, reject) => {
    let processedRows = 0;
    const collected: Transaction[] = [];
    const fileSize = file.size;
    let lastProgressUpdate = Date.now();

    progressCallback({
      processed: 0,
      total: maxRows,
      percentage: 0,
      stage: 'reading',
    });

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      // IMPORTANT: PapaParse `worker: true` does NOT support parser.pause()/resume()
      // (it throws "Not implemented"). We keep parsing on the main thread but
      // normalize in our own worker and use pause/resume for backpressure.
      worker: false,
      chunkSize: 2 * 1024 * 1024, // 2MB read chunks (bytes)
      chunk: async (chunkResults, parser) => {
        try {
          parser?.pause?.();
        } catch {
          // ignore (some PapaParse parser implementations don't support pause/resume)
        }
        try {
          const chunkData = chunkResults.data as any[];
          if (chunkData.length > 0) {
            const normalized = normalizeData(chunkData);
            const remaining = maxRows - collected.length;
            if (remaining > 0) {
              collected.push(...normalized.slice(0, remaining));
            }
            processedRows += chunkData.length;
          }

          const now = Date.now();
          if (now - lastProgressUpdate > 200) {
            const pct = Math.min((collected.length / maxRows) * 100, 99);
            progressCallback({
              processed: collected.length,
              total: maxRows,
              percentage: pct,
              stage: 'normalizing',
            });
            lastProgressUpdate = now;
          }

          if (collected.length >= maxRows) {
            parser.abort();
            progressCallback({
              processed: collected.length,
              total: maxRows,
              percentage: 100,
              stage: 'complete',
            });
            resolve(collected);
            return;
          }

          // Resume quickly
          setTimeout(() => {
            try {
              parser?.resume?.();
            } catch {
              // ignore
            }
          }, 0);
        } catch (e) {
          try {
            parser?.abort?.();
          } catch {
            // ignore
          }
          reject(e);
        }
      },
      complete: () => {
        progressCallback({
          processed: collected.length,
          total: maxRows,
          percentage: 100,
          stage: 'complete',
        });
        resolve(collected);
      },
      error: (error) => {
        reject(error);
      },
    });
  });
}

// Helper function to stream CSV directly to IndexedDB
async function streamCSVToIndexedDB(file: File, progressCallback: (progress: ProcessingProgress) => void): Promise<void> {
  const Papa = (await import('papaparse')).default;
  // IMPORTANT: For multi-GB files, normalizing on the main thread will freeze/crash the tab.
  // We normalize batches in our own Web Worker (`public/file-processor-worker.js`).
  
  return new Promise<void>((resolve, reject) => {
    let processedRows = 0;
    let normalizedChunk: Transaction[] = [];
    // Larger write batches drastically reduce IndexedDB transaction overhead for big files.
    const chunkSize = 50000;
    const fileSize = file.size;
    let lastProgressUpdate = Date.now();
    
    progressCallback({
      processed: 0,
      total: fileSize,
      percentage: 0,
      stage: 'reading',
    });

    // Dedicated normalizer worker for this upload.
    let normalizerWorker: Worker | null = null;
    const getNormalizerWorker = () => {
      if (normalizerWorker) return normalizerWorker;
      normalizerWorker = new Worker('/file-processor-worker.js');
      return normalizerWorker;
    };

    const normalizeInWorker = (batch: any[]): Promise<Transaction[]> => {
      return new Promise((res, rej) => {
        const w = getNormalizerWorker();
        const onMessage = (e: MessageEvent) => {
          if (e.data?.type === 'BATCH_NORMALIZED') {
            w.removeEventListener('message', onMessage);
            w.removeEventListener('error', onError);
            res(e.data.payload.normalized as Transaction[]);
          } else if (e.data?.type === 'BATCH_ERROR') {
            w.removeEventListener('message', onMessage);
            w.removeEventListener('error', onError);
            rej(new Error(String(e.data.payload?.error || 'Worker normalization failed')));
          }
        };
        const onError = (err: ErrorEvent) => {
          w.removeEventListener('message', onMessage);
          w.removeEventListener('error', onError);
          rej(err);
        };
        w.addEventListener('message', onMessage);
        w.addEventListener('error', onError);
        w.postMessage({ type: 'NORMALIZE_BATCH', payload: { batch } });
      });
    };
    
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      // IMPORTANT: PapaParse `worker: true` does NOT support parser.pause()/resume()
      // (it throws "Not implemented"). We keep parsing on the main thread but
      // normalize in our own worker and use pause/resume for backpressure.
      worker: false,
      chunkSize: 4 * 1024 * 1024, // 4MB read chunks (bytes)
      chunk: async (chunkResults, parser) => {
        // Important: pause/resume to avoid overlapping async writes and memory blowups.
        try {
          parser?.pause?.();
        } catch {
          // ignore
        }
        const chunkData = chunkResults.data as any[];
        processedRows += chunkData.length;
        
        // Normalize chunk in our worker (critical for stability on 1GB+ files)
        let normalized: Transaction[] = [];
        try {
          normalized = await normalizeInWorker(chunkData);
        } catch (error) {
          parser.abort();
          reject(error);
          return;
        }
        normalizedChunk.push(...normalized);
        
        // When chunk is large enough, write to IndexedDB
        if (normalizedChunk.length >= chunkSize) {
          const toStore = normalizedChunk.splice(0, chunkSize);
          try {
            await dbManager.addTransactions(toStore);
          } catch (error) {
            parser.abort();
            reject(error);
            return;
          }
          
          // Progress update
          const now = Date.now();
          if (now - lastProgressUpdate > 200) {
            // Estimate progress based on file size processed (more accurate for large files)
            // Assume average row size of ~500 bytes for CSV data
            const estimatedRowsFromFileSize = fileSize / 500;
            const progressPercentage = estimatedRowsFromFileSize > 0 
              ? Math.min((processedRows / estimatedRowsFromFileSize) * 90, 90)
              : Math.min((processedRows / 10000000) * 90, 90);
            progressCallback({
              processed: processedRows,
              total: fileSize,
              percentage: progressPercentage,
              stage: 'normalizing',
            });
            lastProgressUpdate = now;
          }
        }
        
        // Yield to browser and resume parsing
        setTimeout(() => {
          try {
            parser?.resume?.();
          } catch {
            // ignore
          }
        }, 0);
      },
      complete: async () => {
        // Store remaining chunk
        if (normalizedChunk.length > 0) {
          try {
            await dbManager.addTransactions(normalizedChunk);
          } catch (error) {
            reject(error);
            return;
          }
        }
        
        progressCallback({
          processed: processedRows,
          total: processedRows,
          percentage: 95,
          stage: 'normalizing',
        });
        if (normalizerWorker) {
          normalizerWorker.terminate();
          normalizerWorker = null;
        }
        resolve();
      },
      error: (error) => {
        progressCallback({
          processed: processedRows,
          total: fileSize,
          percentage: 0,
          stage: 'parsing',
          error: error.message,
        });
        if (normalizerWorker) {
          normalizerWorker.terminate();
          normalizerWorker = null;
        }
        reject(error);
      },
    });
  });
}

// Helper function to process and store data in chunks
async function processAndStoreChunks(rawData: any[], progressCallback: (progress: ProcessingProgress) => void): Promise<void> {
  const chunkSize = 10000;
  const { normalizeData } = await import('@/lib/data-normalization');
  
  for (let i = 0; i < rawData.length; i += chunkSize) {
    const chunk = rawData.slice(i, i + chunkSize);
    const normalized = normalizeData(chunk);
    
    await dbManager.addTransactions(normalized);
    
    progressCallback({
      processed: Math.min(i + chunkSize, rawData.length),
      total: rawData.length,
      percentage: 60 + Math.round(((i + chunkSize) / rawData.length) * 35),
      stage: 'normalizing',
    });
    
    // Yield to browser
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

// Debounce and defer heavy computations
let filterTimeout: ReturnType<typeof setTimeout> | null = null;
let metricsTimeout: ReturnType<typeof setTimeout> | number | null = null;
let isComputing = false;

// Cancel pending filter computations
const cancelPendingFilter = () => {
  if (filterTimeout) {
    clearTimeout(filterTimeout);
    filterTimeout = null;
  }
};

// Cancel pending metrics computations
const cancelPendingMetrics = () => {
  if (metricsTimeout) {
    if (typeof metricsTimeout === 'number') {
      // It's a requestAnimationFrame ID
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(metricsTimeout);
      }
    } else {
      // It's a setTimeout ID
      clearTimeout(metricsTimeout);
    }
    metricsTimeout = null;
  }
};

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
  rawTransactions: [],
  transactionCount: 0,
  isLoading: false,
  error: null,
  fileNames: [],
  fileSizes: [],
  isSampledDataset: false,
  sampledFromBytes: 0,
  backendUploadId: null,
  backendStoredFileId: null,
  _skipPersistence: false,
  _useIndexedDB: false,
  _useBackend: false,
  progress: null,
  hasHydrated: false,
  analysisStage: null,
  filters: defaultFilters,
  filteredTransactions: [],
  filteredTransactionCount: 0,
  globalMetrics: null,
  dailyTrends: [],
  
  streamFilteredTransactions: async (onChunk, chunkSize = 50000) => {
    const { filters, _useIndexedDB } = get();
    
    if (!_useIndexedDB) {
      // For small datasets, use in-memory transactions
      const { filteredTransactions } = get();
      for (let i = 0; i < filteredTransactions.length; i += chunkSize) {
        await onChunk(filteredTransactions.slice(i, i + chunkSize));
        if (i + chunkSize < filteredTransactions.length) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      return;
    }
    
    // For large datasets, stream from IndexedDB
    if (get()._useBackend) {
      throw new Error('Streaming full filtered transactions is not supported in backend mode yet. Use sampling APIs instead.');
    }
    await dbManager.init();
    await dbManager.streamTransactions(
      onChunk,
      chunkSize,
      {
        startDate: filters.dateRange.start || undefined,
        endDate: filters.dateRange.end || undefined,
        paymentModes: filters.paymentModes.length > 0 ? filters.paymentModes : undefined,
        merchantIds: filters.merchantIds.length > 0 ? filters.merchantIds : undefined,
        pgs: filters.pgs.length > 0 ? filters.pgs : undefined,
        banks: filters.banks.length > 0 ? filters.banks : undefined,
        cardTypes: filters.cardTypes.length > 0 ? filters.cardTypes : undefined,
      }
    );
  },

  getSampleFilteredTransactions: async (maxRows = 50000, overrides) => {
    const { filters, _useBackend, backendUploadId } = get();
    const eff = {
      startDate: overrides?.startDate ?? filters.dateRange.start ?? undefined,
      endDate: overrides?.endDate ?? filters.dateRange.end ?? undefined,
      paymentModes: overrides?.paymentModes ?? (filters.paymentModes.length > 0 ? filters.paymentModes : undefined),
      merchantIds: overrides?.merchantIds ?? (filters.merchantIds.length > 0 ? filters.merchantIds : undefined),
      pgs: overrides?.pgs ?? (filters.pgs.length > 0 ? filters.pgs : undefined),
      banks: overrides?.banks ?? (filters.banks.length > 0 ? filters.banks : undefined),
      cardTypes: overrides?.cardTypes ?? (filters.cardTypes.length > 0 ? filters.cardTypes : undefined),
    };

    if (_useBackend) {
      if (!backendUploadId) throw new Error('Missing backend upload id');
      const json = await fetchBackendSampleFiltered(backendUploadId, maxRows, eff);
      return json.transactions;
    }

    await dbManager.init();
    return dbManager.sampleTransactions(maxRows, eff);
  },

      getIndexedDBFilterOptions: async () => {
        const { _useBackend, backendUploadId } = get();
        if (_useBackend) {
          if (!backendUploadId) throw new Error('Missing backend upload id');
          const opts = await fetchBackendFilterOptions(backendUploadId);
          return {
            paymentModes: (opts.paymentModes || []).filter(Boolean).sort(),
            merchantIds: (opts.merchantIds || []).map((v) => String(v || '').trim()).filter(Boolean).sort(),
          };
        }
        await dbManager.init();
        const [paymentModes, merchantIds] = await Promise.all([
          dbManager.getDistinctIndexValues('paymentmode'),
          dbManager.getDistinctIndexValues('merchantid'),
        ]);
        return {
          paymentModes: paymentModes.filter(Boolean).sort(),
          merchantIds: merchantIds.map((v) => String(v || '').trim()).filter(Boolean).sort(),
        };
      },

  getFilteredTimeBounds: async () => {
    const { filters, _useBackend, backendUploadId } = get();
    const eff = {
      startDate: filters.dateRange.start || undefined,
      endDate: filters.dateRange.end || undefined,
      paymentModes: filters.paymentModes.length > 0 ? filters.paymentModes : undefined,
      merchantIds: filters.merchantIds.length > 0 ? filters.merchantIds : undefined,
      pgs: filters.pgs.length > 0 ? filters.pgs : undefined,
      banks: filters.banks.length > 0 ? filters.banks : undefined,
      cardTypes: filters.cardTypes.length > 0 ? filters.cardTypes : undefined,
    };
    if (_useBackend) {
      if (!backendUploadId) throw new Error('Missing backend upload id');
      return fetchBackendTimeBounds(backendUploadId, eff);
    }
    await dbManager.init();
    return dbManager.getFilteredTimeBounds(eff);
  },
  
  setRawTransactions: (transactions) => {
    set({ rawTransactions: transactions });
    void get().applyFilters();
  },
  
  loadDataFromFile: async (file: File) => {
    set({ isLoading: true, error: null, progress: null, analysisStage: null });
    
    try {
      await dbManager.init();
      await dbManager.clear(); // Clear previous data
      
      const fileSizeMB = file.size / 1024 / 1024;
      console.log('Loading file:', file.name, 'Size:', fileSizeMB.toFixed(2), 'MB');

      const fileExtension = file.name.split('.').pop()?.toLowerCase();

      // For large files we always do a backend-resumable chunked upload first.
      // Then we *always* try to ingest into IndexedDB for full interactivity (all features).
      // IndexedDB can handle multi-GB files (browsers typically allow 50% of disk space).
      // If browser quota/memory can't handle it, we fall back to a bounded sample (still stable).
      const backendUploadThresholdBytes = 100 * 1024 * 1024; // 100MB
      // Removed size limit - IndexedDB can handle very large files (2GB+)
      // Browser quota limits will be handled gracefully with error messages
      const shouldUseBackendUpload = fileExtension === 'csv' && file.size >= backendUploadThresholdBytes;
      
      // For files > 100MB, use IndexedDB streaming mode
      const useIndexedDBMode = !shouldUseBackendUpload && (file.size > 100 * 1024 * 1024 || fileSizeMB > 100);
      let totalRows = 0;
      
      const progressCallback = (progress: ProcessingProgress) => {
        set({ progress });
      };

      if (shouldUseBackendUpload) {
        // For CSVs >= 100MB: use backend mode (upload + server-side metrics/sampling).
        // This avoids browser storage/quota issues entirely.
        const maxSampleRows = 100000;
        set({
          // Keep `_useIndexedDB: true` so existing UI treats this as "large dataset mode".
          // Under the hood we branch on `_useBackend` for all large-mode operations.
          _useIndexedDB: true,
          _useBackend: true,
          _skipPersistence: true,
          isSampledDataset: false,
          sampledFromBytes: 0,
          backendUploadId: null,
          backendStoredFileId: null,
        });

        // For now, backend sampling expects CSV. (XLSX cannot be streamed safely in Node without full load.)
        if (fileExtension !== 'csv') {
          throw new Error('Large files must be uploaded as CSV for safe streaming. Please export as CSV and try again.');
        }

        // Try to resume an existing partial upload if we have one persisted and it matches the file.
        const { fileNames, fileSizes, backendUploadId } = get();
        const canResume =
          Boolean(backendUploadId) &&
          fileNames?.[0] === file.name &&
          fileSizes?.[0] === file.size;

        const { uploadId, storedFileId } = await uploadFileInChunks(file, progressCallback, {
          // Use 3MB chunks for Vercel compatibility (Vercel has 4.5MB body size limit)
          chunkSizeBytes: 3 * 1024 * 1024,
          uploadId: canResume ? backendUploadId! : undefined,
          onUploadId: (id) => {
            // Persist early so a refresh/crash can resume.
            set({ backendUploadId: id, fileNames: [file.name], fileSizes: [file.size] });
          },
          cleanupOnError: false,
        });

        // Kick off a backend-side full-file analysis in the background (best-effort).
        // The UI can continue instantly on a bounded sample while analysis runs.
        void fetch(`/api/uploads/${uploadId}/analysis`, { method: 'POST' }).catch(() => {});

        // Always persist backend ids.
        set({
          backendUploadId: uploadId,
          backendStoredFileId: storedFileId,
        });

        // Pull a bounded sample from the stored file for tab-specific charts/tables.
        // Aggregates (global + trends) will come from backend metrics.
        const sample = await fetchBackendSample(uploadId, maxSampleRows);
        set({
          _useIndexedDB: true,
          _useBackend: true,
          rawTransactions: sample.transactions,
          // We'll update transactionCount from backend metrics (full-file count),
          // but keep sample length as a temporary non-zero value for UI readiness.
          transactionCount: sample.transactions.length,
          fileNames: [file.name],
          fileSizes: [file.size],
          backendUploadId: uploadId,
          backendStoredFileId: storedFileId || sample.storedFileId,
          isSampledDataset: true,
          sampledFromBytes: file.size,
          progress: { processed: sample.transactions.length, total: sample.transactions.length, percentage: 100, stage: 'complete' },
          _skipPersistence: false,
        });

        await get().applyFilters();

        // Best-effort: update full-file metrics in the background (so totals are accurate).
        // This may take time for multi-GB files; we keep the UI responsive.
        void (async () => {
          try {
            const eff = {
              startDate: get().filters.dateRange.start || undefined,
              endDate: get().filters.dateRange.end || undefined,
              paymentModes: get().filters.paymentModes.length > 0 ? get().filters.paymentModes : undefined,
              merchantIds: get().filters.merchantIds.length > 0 ? get().filters.merchantIds : undefined,
              pgs: get().filters.pgs.length > 0 ? get().filters.pgs : undefined,
              banks: get().filters.banks.length > 0 ? get().filters.banks : undefined,
              cardTypes: get().filters.cardTypes.length > 0 ? get().filters.cardTypes : undefined,
            };
            const m = await fetchBackendMetrics(uploadId, eff);
            set({
              transactionCount: m.filteredTransactionCount,
              filteredTransactionCount: m.filteredTransactionCount,
              globalMetrics: m.globalMetrics,
              dailyTrends: m.dailyTrends,
            });
          } catch {
            // ignore
          }
        })();
        return;
      }

      // Process and stream directly to IndexedDB for large files
      if (useIndexedDBMode) {
        console.log('Using IndexedDB streaming mode for large file');
        set({ _useIndexedDB: true, _useBackend: false, _skipPersistence: true, isSampledDataset: false, sampledFromBytes: 0, backendUploadId: null, backendStoredFileId: null });
        
        if (fileExtension === 'csv') {
          // Stream CSV and write directly to IndexedDB
          await streamCSVToIndexedDB(file, progressCallback);
        } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
          // For Excel, we still need to load it, but process in chunks
          const rawData = await processExcelFile(file, progressCallback);
          totalRows = rawData.length;
          
          // Process and write in chunks
          set({ progress: { processed: 0, total: rawData.length, percentage: 60, stage: 'normalizing' } });
          await processAndStoreChunks(rawData, progressCallback);
        } else {
          throw new Error('Unsupported file format. Please upload CSV or XLSX file.');
        }
      } else {
        // Small file mode - load into memory
        set({ _useIndexedDB: false, _useBackend: false, isSampledDataset: false, sampledFromBytes: 0, backendUploadId: null, backendStoredFileId: null });
        let rawData: any[] = [];
        
        if (fileExtension === 'csv') {
          const Papa = (await import('papaparse')).default;
          const text = await file.text();
          const result = Papa.parse(text, {
            header: true,
            skipEmptyLines: true,
            transformHeader: (header) => header.trim().toLowerCase(),
          });
          rawData = result.data as any[];
          set({ progress: { processed: rawData.length, total: rawData.length, percentage: 50, stage: 'parsing' } });
        } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
          rawData = await processExcelFile(file, progressCallback);
        } else {
          throw new Error('Unsupported file format. Please upload CSV or XLSX file.');
        }
        
        if (rawData.length === 0) {
          throw new Error('File appears to be empty. Please check the file format.');
        }
        
        totalRows = rawData.length;
        console.log('Normalizing data...');
        set({ progress: { processed: 0, total: rawData.length, percentage: 60, stage: 'normalizing' } });
        
        const allNormalized = await workerManager.processData(
          rawData,
          (progress) => {
            progressCallback({
              ...progress,
              percentage: 60 + Math.round((progress.percentage / 100) * 30),
            });
          },
          20000
        );
        
        set({ 
          rawTransactions: allNormalized,
          transactionCount: allNormalized.length,
        });
      }
      
      // Get final count from IndexedDB if using IndexedDB mode
      const finalCount = useIndexedDBMode ? await dbManager.getCount() : totalRows;

      if (finalCount === 0) {
        throw new Error(
          'No rows were written to browser storage (IndexedDB). Please re-export the file and re-upload. ' +
          'If your CSV contains an "id" column, this app uses its own internal primary key and should handle it, ' +
          'but an empty count usually indicates a parsing or storage failure.'
        );
      }
      
      set({ 
        fileNames: [file.name],
        fileSizes: [file.size],
        transactionCount: finalCount,
        progress: { processed: finalCount, total: finalCount, percentage: 100, stage: 'complete' },
        _skipPersistence: false,
      });
      
      console.log('File loaded and processed successfully, transactions:', finalCount);
      
      // Apply filters
      setTimeout(() => {
        get().applyFilters().catch((error) => {
          console.error('Error applying filters after file load:', error);
        });
      }, 50);
      
    } catch (error: any) {
      console.error('Error in loadDataFromFile:', error);
      set({ 
        error: error.message || 'Failed to load file. Please check the console for details.',
        progress: null,
      });
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },
  
  restoreFromIndexedDB: async () => {
    try {
      const { _useBackend, backendUploadId } = get();
      if (_useBackend) {
        // Backend mode: no browser DB restore needed; just recompute aggregates.
        if (!backendUploadId) return { status: 'missing', count: 0 };
        await get().applyFilters();
        return { status: 'restored', count: get().transactionCount };
      }

      await dbManager.init();
      const count = await dbManager.getCount();
      if (count > 0) {
        set({ _useIndexedDB: true, transactionCount: count });
        await get().applyFilters();
        return { status: 'restored', count };
      }
      return { status: 'missing', count: 0 };
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'Failed to access IndexedDB';
      set({ error: msg });
      return { status: 'error', error: msg };
    }
  },
  
  setFilters: (newFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
    }));
    
    // Debounce filter application to prevent excessive recomputations
    cancelPendingFilter();
    filterTimeout = setTimeout(() => {
      void get().applyFilters();
      filterTimeout = null;
    }, 100); // 100ms debounce for faster response
  },
  
  resetFilters: () => {
    set({ filters: defaultFilters });
    cancelPendingFilter();
    // Apply immediately for reset - handle async properly
    void get().applyFilters().catch((error) => {
      console.error('Error applying filters after reset:', error);
    });
  },
  
  applyFilters: async () => {
    const { rawTransactions, filters, _useIndexedDB, transactionCount, _useBackend, backendUploadId } = get();
    
    const totalCount = _useIndexedDB ? transactionCount : rawTransactions.length;
    
    // Backend mode can have transactionCount=0 after rehydrate; we still have data server-side.
    if (!_useBackend && totalCount === 0) {
      set({ filteredTransactions: [], filteredTransactionCount: 0, globalMetrics: null, dailyTrends: [], analysisStage: null });
      return;
    }
    if (_useBackend && !backendUploadId) {
      set({ filteredTransactions: [], filteredTransactionCount: 0, globalMetrics: null, dailyTrends: [], analysisStage: null });
      return;
    }

    // Signal UI that we're doing heavy work post-upload / post-filter change
    set({ analysisStage: 'FILTERING' });

    if (_useIndexedDB) {
      // For large datasets in IndexedDB, compute count + metrics in ONE streaming pass
      // to avoid double-scanning and to prevent loading huge arrays into memory.
      set({ analysisStage: 'COMPUTING', filteredTransactions: [] });
      const effFilters = {
        startDate: filters.dateRange.start || undefined,
        endDate: filters.dateRange.end || undefined,
        paymentModes: filters.paymentModes.length > 0 ? filters.paymentModes : undefined,
        merchantIds: filters.merchantIds.length > 0 ? filters.merchantIds : undefined,
        pgs: filters.pgs.length > 0 ? filters.pgs : undefined,
        banks: filters.banks.length > 0 ? filters.banks : undefined,
        cardTypes: filters.cardTypes.length > 0 ? filters.cardTypes : undefined,
      };

      if (_useBackend) {
        if (!backendUploadId) throw new Error('Missing backend upload id');
        const m = await fetchBackendMetrics(backendUploadId, effFilters);
        set({
          filteredTransactionCount: m.filteredTransactionCount,
          globalMetrics: m.globalMetrics,
          dailyTrends: m.dailyTrends,
          analysisStage: null,
        });
        return;
      }

      await dbManager.init();
      const agg = await dbManager.aggregateMetrics(effFilters);

      const globalMetrics = {
        totalCount: agg.totalCount,
        successCount: agg.successCount,
        failedCount: agg.failedCount,
        userDroppedCount: agg.userDroppedCount,
        sr: calculateSR(agg.successCount, agg.totalCount),
        successGmv: agg.successGmv,
        failedPercent: calculateSR(agg.failedCount, agg.totalCount),
        userDroppedPercent: calculateSR(agg.userDroppedCount, agg.totalCount),
      };

      const dailyTrends = agg.dailyTrends.map((d) => ({
        ...d,
        sr: calculateSR(d.successCount, d.volume),
      }));

      set({
        filteredTransactionCount: agg.totalCount,
        globalMetrics,
        dailyTrends,
        analysisStage: null,
      });
      return;
    } else {
      // Small dataset - filter in memory
      const filtered: Transaction[] = [];

      const endDate = filters.dateRange.end ? new Date(filters.dateRange.end) : null;
      if (endDate) endDate.setHours(23, 59, 59, 999);

      const paymentModeSet = filters.paymentModes.length > 0 ? new Set(filters.paymentModes) : null;
      const merchantIdSet = filters.merchantIds.length > 0 ? new Set(filters.merchantIds) : null;
      const pgSet = filters.pgs.length > 0 ? new Set(filters.pgs) : null;
      const bankSet = filters.banks.length > 0 ? new Set(filters.banks) : null;
      const cardTypeSet = filters.cardTypes.length > 0 ? new Set(filters.cardTypes) : null;

      const yieldEvery = rawTransactions.length > 200000 ? 5000 : 10000;

      for (let i = 0; i < rawTransactions.length; i++) {
        const tx = rawTransactions[i];

        const pg = String(tx.pg || '').trim().toUpperCase();
        if (pg === 'N/A' || pg === 'NA' || pg === '') continue;

        if (filters.dateRange.start && tx.txtime < filters.dateRange.start) continue;
        if (endDate && tx.txtime > endDate) continue;

        if (paymentModeSet && !paymentModeSet.has(tx.paymentmode)) continue;

        if (merchantIdSet) {
          const merchantId = String(tx.merchantid || '').trim();
          if (!merchantIdSet.has(merchantId)) continue;
        }

        if (pgSet && !pgSet.has(tx.pg)) continue;

        if (bankSet) {
          const flow = classifyUPIFlow(tx.bankname);
          if (!bankSet.has(flow) && !bankSet.has(tx.bankname)) continue;
        }

        if (cardTypeSet && !cardTypeSet.has(tx.cardtype)) continue;

        filtered.push(tx);

        if (i % yieldEvery === 0) {
          // Yield to keep UI responsive
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }

      set({ filteredTransactions: filtered, filteredTransactionCount: filtered.length });
    }

    // Defer metrics computation
    cancelPendingMetrics();
    set({ analysisStage: 'COMPUTING' });
    if (typeof requestAnimationFrame !== 'undefined') {
      const rafId = requestAnimationFrame(() => {
        if (!isComputing) {
          isComputing = true;
          void get().computeMetrics().finally(() => {
            isComputing = false;
          });
        }
        metricsTimeout = null;
      });
      metricsTimeout = rafId;
    } else {
      metricsTimeout = setTimeout(() => {
        if (!isComputing) {
          isComputing = true;
          void get().computeMetrics().finally(() => {
            isComputing = false;
          });
        }
        metricsTimeout = null;
      }, 0);
    }
  },
  
  computeMetrics: async () => {
    const { filteredTransactions, _useIndexedDB, filteredTransactionCount, _useBackend } = get();
    
    const hasData = _useIndexedDB ? filteredTransactionCount > 0 : filteredTransactions.length > 0;
    
    if (!hasData) {
      set({ globalMetrics: null, dailyTrends: [], analysisStage: null });
      return;
    }
    
    // Compute metrics on main thread
    const { computeMetricsSync } = await import('@/lib/filter-utils');

    if (_useIndexedDB) {
      // Keep as a safe fallback: in IndexedDB mode, metrics are computed in applyFilters()
      // via dbManager.aggregateMetrics(), so we just clear the stage here.
      set({ analysisStage: null });
    } else {
      // Small dataset - compute directly
      const result = computeMetricsSync(filteredTransactions);
      set({ globalMetrics: result.globalMetrics, dailyTrends: result.dailyTrends, analysisStage: null });
    }
  },
  
  addDataFromFile: async (file: File) => {
    set({ isLoading: true, error: null, progress: null });
    
    try {
      const fileSizeMB = file.size / 1024 / 1024;
      console.log('Adding file:', file.name, 'Size:', fileSizeMB.toFixed(2), 'MB');

      // Adding very large files on top of an existing dataset is not supported safely.
      // Use Replace so we can stream/ingest deterministically (and/or use backend upload path).
      if (file.size >= 100 * 1024 * 1024) {
        throw new Error('For files ≥100MB, please use Replace (top right) instead of Add. Large files are uploaded via backend chunked upload and may exceed safe in-browser merge limits.');
      }
      
      // Allow multi-GB files, but warn: these should be CSV and will stream through IndexedDB.
      if (fileSizeMB > 6000) {
        throw new Error('File is too large (>6GB). Please split your data into smaller files.');
      }
      
      const fileExtension = file.name.split('.').pop()?.toLowerCase();
      let rawData: any[] = [];
      
      const progressCallback = (progress: ProcessingProgress) => {
        set({ progress });
      };
      
      if (fileExtension === 'csv') {
        const Papa = (await import('papaparse')).default;
        const text = await file.text();
        const result = Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (header) => header.trim().toLowerCase(),
        });
        rawData = result.data as any[];
        set({ progress: { processed: rawData.length, total: rawData.length, percentage: 50, stage: 'parsing' } });
        console.log('CSV parsed, rows:', rawData.length);
      } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
        rawData = await processExcelFile(file, progressCallback);
        console.log('Excel parsed, rows:', rawData.length);
      } else {
        throw new Error('Unsupported file format. Please upload CSV or XLSX file.');
      }
      
      if (rawData.length === 0) {
        throw new Error('File appears to be empty. Please check the file format.');
      }
      
      console.log('Normalizing data...');
      set({ progress: { processed: 0, total: rawData.length, percentage: 60, stage: 'normalizing' } });
      
      // Process in chunks
      const normalizedData = await workerManager.processData(
        rawData,
        (progress) => {
          progressCallback({
            ...progress,
            percentage: 60 + Math.round((progress.percentage / 100) * 30),
          });
        },
        rawData.length > 50000 ? 10000 : 20000
      );
      
      console.log('Data normalized, transactions:', normalizedData.length);
      
      const { rawTransactions, fileNames, fileSizes } = get();
      set({ 
        rawTransactions: [...rawTransactions, ...normalizedData],
        fileNames: [...fileNames, file.name],
        fileSizes: [...fileSizes, file.size],
        progress: { processed: normalizedData.length, total: normalizedData.length, percentage: 100, stage: 'complete' },
      });
      
      setTimeout(() => {
        get().applyFilters();
        console.log('File added and processed successfully');
      }, 100);
    } catch (error: any) {
      console.error('Error in addDataFromFile:', error);
      set({ 
        error: error.message || 'Failed to add file. Please check the console for details.',
        progress: null,
      });
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },
  
  clearData: async () => {
    // Cancel any ongoing worker processing
    workerManager.cancel();
    await dbManager.init();
    await dbManager.clear();
    set({
      rawTransactions: [],
      filteredTransactions: [],
      transactionCount: 0,
      filteredTransactionCount: 0,
      globalMetrics: null,
      dailyTrends: [],
      fileNames: [],
      fileSizes: [],
      isSampledDataset: false,
      sampledFromBytes: 0,
      backendUploadId: null,
      backendStoredFileId: null,
      error: null,
      progress: null,
      filters: defaultFilters,
      analysisStage: null,
      _skipPersistence: false,
      _useIndexedDB: false,
      _useBackend: false,
    });
  },
  
  getFilteredTransactions: () => get().filteredTransactions,
  getGlobalMetrics: () => get().globalMetrics,
  getDailyTrends: () => get().dailyTrends,
    }),
    {
      name: 'sr-analytics-storage',
      storage: createJSONStorage(() => indexedDBStorage),
      partialize: (state) => {
        // Skip persistence if flag is set (during large file loads)
        if (state._skipPersistence) {
          return {
            fileNames: state.fileNames,
            fileSizes: state.fileSizes,
            _useIndexedDB: state._useIndexedDB,
            _useBackend: state._useBackend,
            transactionCount: state.transactionCount,
            backendUploadId: state.backendUploadId,
            backendStoredFileId: state.backendStoredFileId,
          };
        }
        return {
          rawTransactions: state.rawTransactions,
          fileNames: state.fileNames,
          fileSizes: state.fileSizes,
          _useIndexedDB: state._useIndexedDB,
          _useBackend: state._useBackend,
          transactionCount: state.transactionCount,
          backendUploadId: state.backendUploadId,
          backendStoredFileId: state.backendStoredFileId,
        };
      },
      merge: (persistedState: any, currentState: StoreState) => {
        if (persistedState && persistedState.rawTransactions) {
          // Convert Date strings back to Date objects in chunks to avoid blocking
          const transactions = persistedState.rawTransactions.map((tx: any) => ({
            ...tx,
            txtime: tx.txtime instanceof Date ? tx.txtime : new Date(tx.txtime),
          }));
          return {
            ...currentState,
            ...persistedState,
            rawTransactions: transactions,
            // Preserve IndexedDB flags if present
            _useIndexedDB: persistedState._useIndexedDB ?? currentState._useIndexedDB,
            _useBackend: persistedState._useBackend ?? currentState._useBackend,
            transactionCount: persistedState.transactionCount ?? currentState.transactionCount,
            backendUploadId: persistedState.backendUploadId ?? currentState.backendUploadId,
            backendStoredFileId: persistedState.backendStoredFileId ?? currentState.backendStoredFileId,
          };
        }
        // For IndexedDB mode (no rawTransactions but has fileNames)
        if (persistedState && persistedState.fileNames && persistedState.fileNames.length > 0) {
          return {
            ...currentState,
            ...persistedState,
            // Preserve IndexedDB flags if present
            _useIndexedDB: persistedState._useIndexedDB ?? currentState._useIndexedDB,
            _useBackend: persistedState._useBackend ?? currentState._useBackend,
            transactionCount: persistedState.transactionCount ?? currentState.transactionCount,
            backendUploadId: persistedState.backendUploadId ?? currentState.backendUploadId,
            backendStoredFileId: persistedState.backendStoredFileId ?? currentState.backendStoredFileId,
          };
        }
        return { ...currentState, ...persistedState };
      },
      onRehydrateStorage: () => (state) => {
        // Mark hydration complete regardless of persisted state presence
        useStore.setState({ hasHydrated: true });

        // After rehydration, check for data and restore state
        setTimeout(async () => {
          const store = useStore.getState();
          
          // If we already have IndexedDB mode restored from persistence, verify and apply filters
          if (store._useIndexedDB && store.transactionCount > 0) {
            // State already restored, just apply filters
            void store.applyFilters().catch((e) => {
              console.error('Error applying filters after rehydrate:', e);
            });
            return;
          }

          // Backend mode: we may not have a local transactionCount, but we can recompute from server.
          if (store._useBackend && store.backendUploadId) {
            void store.applyFilters().catch((e) => {
              console.error('Error applying filters after rehydrate (backend mode):', e);
            });
            return;
          }
          
          // If we have file metadata but no in-memory data, attempt to restore from IndexedDB.
          const hasFileMeta = Boolean(state && state.fileNames && state.fileNames.length > 0);
          const hasInMemory = Boolean(state && state.rawTransactions && state.rawTransactions.length > 0);
          if (hasFileMeta && !hasInMemory && store.transactionCount === 0) {
            const res = await store.restoreFromIndexedDB();
            if (res.status === 'missing') {
              // Don't spin forever: surface an actionable error (user can hit Replace/Clear).
              useStore.setState({
                error: 'No dataset found in browser storage. Please click Replace and re-upload the file.',
              });
            }
            return;
          }
          
          // For small files with in-memory data
          if (state && state.rawTransactions && state.rawTransactions.length > 0) {
            if (store.rawTransactions.length > 0) {
              void store.applyFilters().catch((e) => {
                console.error('Error applying filters after rehydrate:', e);
              });
            }
          }
        }, 100);
      },
      // Skip persistence during loading to avoid blocking
      skipHydration: false,
    }
  )
);

