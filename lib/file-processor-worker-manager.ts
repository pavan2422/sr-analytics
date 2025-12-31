// Manager for file processing Web Worker
// Handles CSV parsing and normalization in background threads

import { ProcessingProgress } from './file-processor';

export class FileProcessorWorkerManager {
  private workers: Worker[] = [];
  private maxWorkers: number;
  private isProcessing = false;
  private activeWorkers = 0;

  constructor() {
    // Use number of CPU cores, but cap at 4 to prevent overwhelming the system
    this.maxWorkers = typeof navigator !== 'undefined' && (navigator as any).hardwareConcurrency
      ? Math.min((navigator as any).hardwareConcurrency, 4)
      : 2;
  }

  async processChunksInParallel(
    chunks: any[][],
    onProgress: (progress: ProcessingProgress) => void,
    totalRows: number
  ): Promise<any[]> {
    if (this.isProcessing) {
      throw new Error('Worker is already processing data');
    }

    this.isProcessing = true;
    const results: any[] = [];
    let processedCount = 0;
    const totalChunks = chunks.length;

    try {
      // Create workers
      for (let i = 0; i < this.maxWorkers; i++) {
        try {
          const worker = new Worker('/file-processor-worker.js');
          this.workers.push(worker);
        } catch (error) {
          console.warn('Failed to create worker, falling back to main thread:', error);
          // Fallback to main thread processing
          return this.processInMainThread(chunks, onProgress, totalRows);
        }
      }

      // Process chunks in parallel using workers
      const workerQueue: Array<{ worker: Worker; resolve: (value: any[]) => void; reject: (error: any) => void }> = [];
      let chunkIndex = 0;

      // Create a queue system for workers
      const processChunkWithWorker = (chunk: any[], index: number): Promise<any[]> => {
        return new Promise((resolve, reject) => {
          const worker = this.workers[index % this.workers.length];
          
          const handleMessage = (e: MessageEvent) => {
            if (e.data.type === 'BATCH_NORMALIZED') {
              worker.removeEventListener('message', handleMessage);
              worker.removeEventListener('error', handleError);
              
              processedCount += e.data.payload.normalized.length;
              
              // Update progress
              const percentage = Math.min((processedCount / totalRows) * 90, 90);
              onProgress({
                processed: processedCount,
                total: totalRows,
                percentage,
                stage: 'normalizing',
              });
              
              resolve(e.data.payload.normalized);
            } else if (e.data.type === 'BATCH_ERROR') {
              worker.removeEventListener('message', handleMessage);
              worker.removeEventListener('error', handleError);
              reject(new Error(e.data.payload.error));
            }
          };

          const handleError = (error: ErrorEvent) => {
            worker.removeEventListener('message', handleMessage);
            worker.removeEventListener('error', handleError);
            reject(error);
          };

          worker.addEventListener('message', handleMessage);
          worker.addEventListener('error', handleError);

          // Send chunk to worker
          worker.postMessage({
            type: 'NORMALIZE_BATCH',
            payload: { batch: chunk },
          });
        });
      };

      // Process all chunks in parallel (limited by number of workers)
      const chunkPromises = chunks.map((chunk, idx) => 
        processChunkWithWorker(chunk, idx)
      );

      const workerResults = await Promise.all(chunkPromises);
      results.push(...workerResults.flat());

      return results;
    } finally {
      this.cleanup();
    }
  }

  private async processInMainThread(
    chunks: any[][],
    onProgress: (progress: ProcessingProgress) => void,
    totalRows: number
  ): Promise<any[]> {
    const { normalizeData } = await import('./data-normalization');
    const results: any[] = [];
    let processedCount = 0;

    for (const chunk of chunks) {
      const normalized = normalizeData(chunk);
      results.push(...normalized);
      processedCount += normalized.length;

      const percentage = Math.min((processedCount / totalRows) * 90, 90);
      onProgress({
        processed: processedCount,
        total: totalRows,
        percentage,
        stage: 'normalizing',
      });

      // Yield to browser
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    return results;
  }

  cancel() {
    this.cleanup();
  }

  private cleanup() {
    this.workers.forEach(worker => worker.terminate());
    this.workers = [];
    this.isProcessing = false;
    this.activeWorkers = 0;
  }

  isActive(): boolean {
    return this.isProcessing;
  }
}

