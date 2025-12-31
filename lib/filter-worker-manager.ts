// Manager for filter and metrics Web Worker
// Handles worker lifecycle and communication

import { FilterState, Transaction, Metrics, DailyTrend } from '@/types';

interface WorkerMessage {
  type: string;
  payload: any;
}

export class FilterWorkerManager {
  private worker: Worker | null = null;
  private isProcessing = false;
  private messageQueue: Array<{ resolve: Function; reject: Function; message: WorkerMessage }> = [];
  private currentRequestId = 0;

  constructor() {
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker('/filter-worker.js');
        this.worker.onmessage = this.handleMessage.bind(this);
        this.worker.onerror = this.handleError.bind(this);
      } catch (error) {
        console.warn('Web Worker not available, falling back to main thread', error);
      }
    }
  }

  private handleMessage(e: MessageEvent) {
    const { type, payload } = e.data;
    const request = this.messageQueue.shift();
    
    if (!request) return;

    if (type === 'FILTERED_RESULT') {
      request.resolve(payload);
    } else if (type === 'METRICS_RESULT') {
      request.resolve(payload);
    } else {
      request.reject(new Error(`Unknown message type: ${type}`));
    }
    
    this.isProcessing = false;
    this.processQueue();
  }

  private handleError(error: ErrorEvent) {
    console.error('Worker error:', error);
    const request = this.messageQueue.shift();
    if (request) {
      request.reject(error);
      this.isProcessing = false;
    }
    this.processQueue();
  }

  private processQueue() {
    if (this.isProcessing || this.messageQueue.length === 0) return;
    
    const request = this.messageQueue[0];
    this.isProcessing = true;
    
    if (this.worker) {
      this.worker.postMessage(request.message);
    } else {
      // Fallback to main thread
      this.processInMainThread(request);
    }
  }

  private async processInMainThread(request: { resolve: Function; reject: Function; message: WorkerMessage }) {
    try {
      const { type, payload } = request.message;
      
      if (type === 'FILTER_TRANSACTIONS') {
        const { transactions, filters } = payload;
        const { filterTransactions } = await import('./filter-utils');
        const filtered = filterTransactions(transactions, filters);
        request.resolve(filtered);
      } else if (type === 'COMPUTE_METRICS') {
        const { transactions } = payload;
        const { computeMetricsSync } = await import('./filter-utils');
        const metrics = computeMetricsSync(transactions);
        request.resolve(metrics);
      }
    } catch (error) {
      request.reject(error);
    } finally {
      this.isProcessing = false;
      this.messageQueue.shift();
      this.processQueue();
    }
  }

  async filterTransactions(transactions: Transaction[], filters: FilterState): Promise<Transaction[]> {
    return new Promise((resolve, reject) => {
      this.messageQueue.push({
        resolve,
        reject,
        message: {
          type: 'FILTER_TRANSACTIONS',
          payload: { transactions, filters },
        },
      });
      this.processQueue();
    });
  }

  async computeMetrics(transactions: Transaction[]): Promise<{ globalMetrics: Metrics | null; dailyTrends: DailyTrend[] }> {
    return new Promise((resolve, reject) => {
      this.messageQueue.push({
        resolve,
        reject,
        message: {
          type: 'COMPUTE_METRICS',
          payload: { transactions },
        },
      });
      this.processQueue();
    });
  }

  cleanup() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.messageQueue = [];
    this.isProcessing = false;
  }
}






