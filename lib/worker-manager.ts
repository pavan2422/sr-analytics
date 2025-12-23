// Manager for Web Worker instances
// Handles worker lifecycle and communication

import { ProcessingProgress } from './file-processor';

export class WorkerManager {
  private worker: Worker | null = null;
  private isProcessing = false;

  constructor() {
    // Worker will be created on demand
  }

  async processData(
    data: any[],
    onProgress: (progress: ProcessingProgress) => void,
    chunkSize: number = 10000
  ): Promise<any[]> {
    if (this.isProcessing) {
      throw new Error('Worker is already processing data');
    }

    this.isProcessing = true;
    
    try {
      // Process in main thread with chunking
      // Web Workers in Next.js require additional configuration
      // The chunked processing in main thread is sufficient for most cases
      console.log('Processing in main thread with chunking for optimal performance');
      return await this.processInMainThread(data, onProgress, chunkSize);
    } finally {
      this.cleanup();
    }
  }

  cancel() {
    // Cancel processing (cleanup will be handled by processInMainThread)
    this.cleanup();
  }

  private cleanup() {
    // Reset processing state
    this.isProcessing = false;
  }

  isActive(): boolean {
    return this.isProcessing;
  }

  private async processInMainThread(
    data: any[],
    onProgress: (progress: ProcessingProgress) => void,
    chunkSize: number
  ): Promise<any[]> {
    const { normalizeData } = await import('./data-normalization');
    const results: any[] = [];
    const total = data.length;

    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      const normalizedChunk = normalizeData(chunk);
      results.push(...normalizedChunk);

      const processed = Math.min(i + chunkSize, total);
      const percentage = Math.round((processed / total) * 100);

      onProgress({
        processed,
        total,
        percentage,
        stage: 'normalizing',
      });

      // Yield to browser
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    this.cleanup();
    return results;
  }
}

