// IndexedDB Manager for large transaction datasets
// Handles streaming writes and cursor-based reads to avoid loading all data into memory

import { Transaction } from '@/types';

const DB_NAME = 'sr-analytics-transactions';
const STORE_NAME = 'transactions';
const DB_VERSION = 3; // Increment when schema changes (v3: removed keyPath to fix storage issues)

interface DBManager {
  init(): Promise<void>;
  clear(): Promise<void>;
  getCount(): Promise<number>;
  addTransactions(transactions: Transaction[]): Promise<void>;
  streamTransactions(
    onChunk: (chunk: Transaction[]) => Promise<void>,
    chunkSize?: number,
    filters?: {
      startDate?: Date;
      endDate?: Date;
      paymentModes?: string[];
      merchantIds?: string[];
      pgs?: string[];
      banks?: string[];
      cardTypes?: string[];
    }
  ): Promise<void>;
  getAllTransactions(filters?: any): Promise<Transaction[]>;
}

class IndexedDBTransactionManager implements DBManager {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    // Check if IndexedDB is available
    if (typeof window === 'undefined' || !window.indexedDB) {
      const error = new Error('IndexedDB is not available in this browser. Please use a modern browser that supports IndexedDB.');
      this.initPromise = null;
      throw error;
    }

    this.initPromise = new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error: any) {
        this.initPromise = null;
        reject(new Error(`Failed to open IndexedDB: ${error?.message || 'Unknown error'}`));
        return;
      }

      request.onerror = (event) => {
        this.initPromise = null;
        const error = (event.target as IDBRequest)?.error;
        const errorMessage = error?.message || 'Unknown error';
        const errorName = error?.name || 'UnknownError';
        
        // Provide more specific error messages
        let userMessage = 'Failed to open IndexedDB';
        if (errorName === 'QuotaExceededError') {
          userMessage = 'IndexedDB quota exceeded. Please clear some browser storage or use a smaller file.';
        } else if (errorName === 'VersionError') {
          userMessage = 'IndexedDB version conflict. Please refresh the page or clear browser storage.';
        } else if (errorName === 'InvalidStateError') {
          userMessage = 'IndexedDB is in an invalid state. Please refresh the page.';
        } else if (errorName === 'AbortError') {
          userMessage = 'IndexedDB operation was aborted. Please try again.';
        } else {
          userMessage = `Failed to open IndexedDB: ${errorMessage}`;
        }
        
        console.error('IndexedDB open error:', errorName, errorMessage, error);
        reject(new Error(userMessage));
      };

      request.onblocked = () => {
        console.warn('IndexedDB upgrade blocked. Please close other tabs using this database.');
        // Don't reject here - the upgrade might complete later
      };

      request.onsuccess = () => {
        this.db = request.result;
        
        // Handle database close events
        this.db.onerror = (event) => {
          console.error('IndexedDB error:', event);
        };
        
        this.db.onclose = () => {
          console.warn('IndexedDB connection closed');
          this.db = null;
          this.initPromise = null;
        };
        
        this.db.onversionchange = () => {
          console.warn('IndexedDB version change detected. Please refresh the page.');
          this.db?.close();
          this.db = null;
          this.initPromise = null;
        };
        
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const database = (event.target as IDBOpenDBRequest).result;
        
        try {
          // Delete old object store if it exists
          if (database.objectStoreNames.contains(STORE_NAME)) {
            database.deleteObjectStore(STORE_NAME);
          }

          // Create object store with indexes for efficient querying
          // Use autoIncrement without keyPath - IndexedDB will generate numeric keys automatically
          const objectStore = database.createObjectStore(STORE_NAME, {
            autoIncrement: true,
          });

          // Create indexes for filtering
          objectStore.createIndex('txtime', 'txtime', { unique: false });
          objectStore.createIndex('paymentmode', 'paymentmode', { unique: false });
          objectStore.createIndex('merchantid', 'merchantid', { unique: false });
          objectStore.createIndex('pg', 'pg', { unique: false });
          objectStore.createIndex('bankname', 'bankname', { unique: false });
          objectStore.createIndex('cardtype', 'cardtype', { unique: false });
          objectStore.createIndex('transactionDate', 'transactionDate', { unique: false });
        } catch (upgradeError: any) {
          console.error('IndexedDB upgrade error:', upgradeError);
          reject(new Error(`Failed to upgrade IndexedDB: ${upgradeError?.message || 'Unknown error'}`));
        }
      };
    });

    return this.initPromise;
  }

  async clear(): Promise<void> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getCount(): Promise<number> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.count();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async addTransactions(transactions: Transaction[]): Promise<void> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    // Process in chunks to avoid blocking
    const chunkSize = 10000;
    for (let i = 0; i < transactions.length; i += chunkSize) {
      const chunk = transactions.slice(i, i + chunkSize);
      
      await new Promise<void>((resolve, reject) => {
        const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => resolve();

        chunk.forEach((tx) => {
          store.add(tx);
        });
      });

      // Yield to browser after each chunk
      if (i + chunkSize < transactions.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }

  async streamTransactions(
    onChunk: (chunk: Transaction[]) => Promise<void>,
    chunkSize: number = 50000,
    filters?: {
      startDate?: Date;
      endDate?: Date;
      paymentModes?: string[];
      merchantIds?: string[];
      pgs?: string[];
      banks?: string[];
      cardTypes?: string[];
    }
  ): Promise<void> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      
      let chunk: Transaction[] = [];
      let pendingChunks: Transaction[][] = [];
      let hasError = false;

      // Process all pending chunks asynchronously (outside transaction)
      const processAllPendingChunks = async (): Promise<void> => {
        for (const chunkToProcess of pendingChunks) {
          if (hasError) return;
          try {
            await onChunk(chunkToProcess);
            // Yield to browser periodically
            await new Promise(resolve => setTimeout(resolve, 0));
          } catch (error) {
            hasError = true;
            reject(error);
            return;
          }
        }
      };

      request.onerror = () => {
        hasError = true;
        reject(request.error);
      };

      request.onsuccess = (event) => {
        if (hasError) return;

        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        
        if (!cursor) {
          // Queue last chunk if any
          if (chunk.length > 0) {
            pendingChunks.push([...chunk]);
            chunk = [];
          }
          
          // Process all pending chunks after transaction completes
          transaction.oncomplete = async () => {
            try {
              await processAllPendingChunks();
              if (!hasError) resolve();
            } catch (error) {
              if (!hasError) {
                hasError = true;
                reject(error);
              }
            }
          };
          
          return;
        }

        const tx = cursor.value as Transaction;

        // Apply filters synchronously (must be fast, no async)
        let include = true;
        
        if (filters) {
          if (filters.startDate && tx.txtime < filters.startDate) include = false;
          if (filters.endDate && tx.txtime > filters.endDate) include = false;
          if (filters.paymentModes && filters.paymentModes.length > 0) {
            if (!filters.paymentModes.includes(tx.paymentmode)) include = false;
          }
          if (filters.merchantIds && filters.merchantIds.length > 0) {
            const merchantId = String(tx.merchantid || '').trim();
            if (!filters.merchantIds.includes(merchantId)) include = false;
          }
          if (filters.pgs && filters.pgs.length > 0) {
            if (!filters.pgs.includes(tx.pg)) include = false;
          }
          if (filters.banks && filters.banks.length > 0) {
            const flow = tx.bankname || '';
            if (!filters.banks.includes(flow) && !filters.banks.includes(tx.bankname || '')) include = false;
          }
          if (filters.cardTypes && filters.cardTypes.length > 0) {
            if (!filters.cardTypes.includes(tx.cardtype)) include = false;
          }
        }

        if (include) {
          chunk.push(tx);
        }

        // When chunk is large enough, queue it for async processing (after transaction)
        if (chunk.length >= chunkSize) {
          const chunkToProcess = [...chunk];
          chunk = [];
          pendingChunks.push(chunkToProcess);
        }

        // Continue cursor synchronously (transaction still active)
        // Must call continue() before any async operations
        cursor.continue();
      };

      // Handle transaction errors
      transaction.onerror = () => {
        hasError = true;
        reject(transaction.error);
      };
    });
  }

  async getAllTransactions(filters?: any): Promise<Transaction[]> {
    const results: Transaction[] = [];
    
    await this.streamTransactions(
      async (chunk) => {
        results.push(...chunk);
      },
      50000,
      filters
    );

    return results;
  }

  async sampleTransactions(maxRows: number, filters?: {
    startDate?: Date;
    endDate?: Date;
    paymentModes?: string[];
    merchantIds?: string[];
    pgs?: string[];
    banks?: string[];
    cardTypes?: string[];
  }): Promise<Transaction[]> {
    const results: Transaction[] = [];
    
    await this.streamTransactions(
      async (chunk) => {
        if (results.length < maxRows) {
          const remaining = maxRows - results.length;
          results.push(...chunk.slice(0, remaining));
        }
      },
      50000,
      filters
    );

    return results;
  }

  async getFilteredTimeBounds(filters?: {
    startDate?: Date;
    endDate?: Date;
    paymentModes?: string[];
    merchantIds?: string[];
    pgs?: string[];
    banks?: string[];
    cardTypes?: string[];
  }): Promise<{ min?: Date; max?: Date }> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    await this.streamTransactions(
      async (chunk) => {
        for (const tx of chunk) {
          const txTime = tx.txtime instanceof Date ? tx.txtime : new Date(tx.txtime);
          if (!minDate || txTime < minDate) minDate = txTime;
          if (!maxDate || txTime > maxDate) maxDate = txTime;
        }
      },
      50000,
      filters
    );

    return { 
      min: minDate || undefined, 
      max: maxDate || undefined 
    };
  }

  async aggregateMetrics(filters?: {
    startDate?: Date;
    endDate?: Date;
    paymentModes?: string[];
    merchantIds?: string[];
    pgs?: string[];
    banks?: string[];
    cardTypes?: string[];
  }): Promise<{
    totalCount: number;
    successCount: number;
    failedCount: number;
    userDroppedCount: number;
    successGmv: number;
    dailyTrends: Array<{
      date: string;
      volume: number;
      successCount: number;
      failedCount: number;
      userDroppedCount: number;
    }>;
  }> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    let totalCount = 0;
    let successCount = 0;
    let failedCount = 0;
    let userDroppedCount = 0;
    let successGmv = 0;
    const dailyMap = new Map<string, {
      date: string;
      volume: number;
      successCount: number;
      failedCount: number;
      userDroppedCount: number;
    }>();

    await this.streamTransactions(
      async (chunk) => {
        for (const tx of chunk) {
          totalCount++;
          
          if (tx.isSuccess) {
            successCount++;
            successGmv += tx.txamount || 0;
          } else if (tx.isFailed) {
            failedCount++;
          } else if (tx.isUserDropped) {
            userDroppedCount++;
          }
          
          const date = tx.transactionDate;
          if (!dailyMap.has(date)) {
            dailyMap.set(date, {
              date,
              volume: 0,
              successCount: 0,
              failedCount: 0,
              userDroppedCount: 0,
            });
          }
          
          const trend = dailyMap.get(date)!;
          trend.volume++;
          if (tx.isSuccess) trend.successCount++;
          if (tx.isFailed) trend.failedCount++;
          if (tx.isUserDropped) trend.userDroppedCount++;
        }
      },
      50000,
      filters
    );

    const dailyTrends = Array.from(dailyMap.values())
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      totalCount,
      successCount,
      failedCount,
      userDroppedCount,
      successGmv,
      dailyTrends,
    };
  }
}

export const dbManager = new IndexedDBTransactionManager();

