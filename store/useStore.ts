import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Transaction, FilterState, Metrics, DailyTrend, GroupedMetrics, FailureRCA, RCAInsight, PeriodComparison } from '@/types';
import { calculateSR, safeDivide } from '@/lib/utils';
import { normalizeData, classifyUPIFlow } from '@/lib/data-normalization';
import { indexedDBStorage } from './indexedDBStorage';
import { streamCSVFile, processExcelFile, ProcessingProgress } from '@/lib/file-processor';
import { WorkerManager } from '@/lib/worker-manager';

interface StoreState {
  // Raw data
  rawTransactions: Transaction[];
  isLoading: boolean;
  error: string | null;
  fileNames: string[];
  fileSizes: number[];
  _skipPersistence: boolean; // Internal flag to skip persistence during large loads
  progress: ProcessingProgress | null; // Progress tracking for large files
  
  // Filters
  filters: FilterState;
  
  // Computed data
  filteredTransactions: Transaction[];
  globalMetrics: Metrics | null;
  dailyTrends: DailyTrend[];
  
  // Actions
  setRawTransactions: (transactions: Transaction[]) => void;
  loadDataFromFile: (file: File) => Promise<void>;
  addDataFromFile: (file: File) => Promise<void>;
  clearData: () => void;
  setFilters: (filters: Partial<FilterState>) => void;
  resetFilters: () => void;
  applyFilters: () => void;
  computeMetrics: () => void;
  
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

// Worker manager instance (shared across store)
const workerManager = new WorkerManager();

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
  rawTransactions: [],
  isLoading: false,
  error: null,
  fileNames: [],
  fileSizes: [],
  _skipPersistence: false,
  progress: null,
  filters: defaultFilters,
  filteredTransactions: [],
  globalMetrics: null,
  dailyTrends: [],
  
  setRawTransactions: (transactions) => {
    set({ rawTransactions: transactions });
    get().applyFilters();
  },
  
  loadDataFromFile: async (file: File) => {
    set({ isLoading: true, error: null, progress: null });
    
    try {
      const fileSizeMB = file.size / 1024 / 1024;
      console.log('Loading file:', file.name, 'Size:', fileSizeMB.toFixed(2), 'MB');
      
      // Warn for very large files
      if (fileSizeMB > 500) {
        console.warn('Very large file detected. Processing may take several minutes.');
      }
      
      // Check browser memory limits (rough estimate)
      if (fileSizeMB > 2000) {
        throw new Error('File is too large (>2GB). Please split your data into smaller files (recommended: <500MB per file).');
      }
      
      const fileExtension = file.name.split('.').pop()?.toLowerCase();
      let rawData: any[] = [];
      
      // Use streaming for large files (>100MB)
      const isLargeFile = file.size > 100 * 1024 * 1024;
      const progressCallback = (progress: ProcessingProgress) => {
        set({ progress });
      };
      
      if (fileExtension === 'csv') {
        console.log('Parsing CSV file...', isLargeFile ? '(streaming mode)' : '(standard mode)');
        
        if (isLargeFile) {
          // Use streaming parser for large files
          rawData = await streamCSVFile(file, progressCallback);
        } else {
          // Standard parsing for smaller files
          const Papa = (await import('papaparse')).default;
          const text = await file.text();
          const result = Papa.parse(text, {
            header: true,
            skipEmptyLines: true,
            transformHeader: (header) => header.trim().toLowerCase(),
          });
          rawData = result.data as any[];
          set({ progress: { processed: rawData.length, total: rawData.length, percentage: 50, stage: 'parsing' } });
        }
        console.log('CSV parsed, rows:', rawData.length);
      } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
        console.log('Parsing Excel file...');
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
      
      // Process data in chunks using worker manager (which uses main thread with chunking)
      // This approach is memory-efficient and prevents UI blocking
      const isLargeDataset = rawData.length > 50000;
      let allNormalized: Transaction[] = [];
      
      try {
        // Use worker manager which handles chunking efficiently
        allNormalized = await workerManager.processData(
          rawData,
          (progress) => {
            // Adjust percentage to fit in 60-90% range
            progressCallback({
              ...progress,
              percentage: 60 + Math.round((progress.percentage / 100) * 30),
            });
          },
          isLargeDataset ? 10000 : 20000 // Smaller chunks for very large datasets
        );
      } catch (error: any) {
        console.error('Error processing data:', error);
        // If processing fails due to memory, provide helpful error
        if (error.message?.includes('memory') || error.message?.includes('quota')) {
          throw new Error('File is too large to process. Please try a smaller file or split your data into multiple files.');
        }
        throw error;
      }
      
      console.log('Data normalized, transactions:', allNormalized.length);
      
      // For large datasets, set a flag to skip immediate persistence
      const shouldSkipPersistence = allNormalized.length > 50000;
      
      if (shouldSkipPersistence) {
        set({ _skipPersistence: true });
      }
      
      // Set data - for large datasets, persistence will be deferred
      set({ 
        rawTransactions: allNormalized,
        fileNames: [file.name],
        fileSizes: [file.size],
        progress: { processed: allNormalized.length, total: allNormalized.length, percentage: 95, stage: 'complete' },
      });
      
      // For large datasets, persist asynchronously after a delay
      if (shouldSkipPersistence) {
        setTimeout(() => {
          set({ _skipPersistence: false });
          // Force a state update to trigger persistence
          const currentState = get();
          set({ rawTransactions: [...currentState.rawTransactions] });
        }, 1000);
      }
      
      // Apply filters after a short delay to let state settle
      setTimeout(() => {
        get().applyFilters();
        set({ progress: { processed: allNormalized.length, total: allNormalized.length, percentage: 100, stage: 'complete' } });
        console.log('File loaded and processed successfully');
      }, 100);
      
    } catch (error: any) {
      console.error('Error in loadDataFromFile:', error);
      set({ 
        error: error.message || 'Failed to load file. Please check the console for details.',
        progress: null,
      });
    } finally {
      set({ isLoading: false });
    }
  },
  
  setFilters: (newFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
    }));
    get().applyFilters();
  },
  
  resetFilters: () => {
    set({ filters: defaultFilters });
    get().applyFilters();
  },
  
  applyFilters: () => {
    const { rawTransactions, filters } = get();
    
    // Optimize: Use single pass filtering instead of multiple filter calls
    // This avoids creating multiple intermediate arrays
    const filtered: Transaction[] = [];
    const endDate = filters.dateRange.end ? new Date(filters.dateRange.end) : null;
    if (endDate) {
      endDate.setHours(23, 59, 59, 999);
    }
    
    // Pre-compute filter sets for O(1) lookup
    const paymentModeSet = filters.paymentModes.length > 0 
      ? new Set(filters.paymentModes) 
      : null;
    const merchantIdSet = filters.merchantIds.length > 0 
      ? new Set(filters.merchantIds) 
      : null;
    const pgSet = filters.pgs.length > 0 
      ? new Set(filters.pgs) 
      : null;
    const bankSet = filters.banks.length > 0 
      ? new Set(filters.banks) 
      : null;
    const cardTypeSet = filters.cardTypes.length > 0 
      ? new Set(filters.cardTypes) 
      : null;
    
    // Single pass filtering
    for (const tx of rawTransactions) {
      // Remove records where PG = 'N/A'
      const pg = String(tx.pg || '').trim().toUpperCase();
      if (pg === 'N/A' || pg === 'NA' || pg === '') {
        continue;
      }
      
      // Date range filter
      if (filters.dateRange.start && tx.txtime < filters.dateRange.start) {
        continue;
      }
      if (endDate && tx.txtime > endDate) {
        continue;
      }
      
      // Payment mode filter
      if (paymentModeSet && !paymentModeSet.has(tx.paymentmode)) {
        continue;
      }
      
      // Merchant ID filter
      if (merchantIdSet) {
        const merchantId = String(tx.merchantid || '').trim();
        if (!merchantIdSet.has(merchantId)) {
          continue;
        }
      }
      
      // PG filter
      if (pgSet && !pgSet.has(tx.pg)) {
        continue;
      }
      
      // Bank filter (for UPI, this filters by INTENT/COLLECT classification)
      if (bankSet) {
        const flow = classifyUPIFlow(tx.bankname);
        if (!bankSet.has(flow) && !bankSet.has(tx.bankname)) {
          continue;
        }
      }
      
      // Card type filter
      if (cardTypeSet && !cardTypeSet.has(tx.cardtype)) {
        continue;
      }
      
      filtered.push(tx);
    }
    
    set({ filteredTransactions: filtered });
    get().computeMetrics();
  },
  
  computeMetrics: () => {
    const { filteredTransactions } = get();
    
    if (filteredTransactions.length === 0) {
      set({ globalMetrics: null, dailyTrends: [] });
      return;
    }
    
    // Optimize: Single pass computation instead of multiple filter/reduce calls
    let successCount = 0;
    let failedCount = 0;
    let userDroppedCount = 0;
    let successGmv = 0;
    const dailyMap = new Map<string, DailyTrend>();
    
    // Single pass through transactions
    for (const tx of filteredTransactions) {
      // Count statuses
      if (tx.isSuccess) {
        successCount++;
        successGmv += tx.txamount;
      } else if (tx.isFailed) {
        failedCount++;
      } else if (tx.isUserDropped) {
        userDroppedCount++;
      }
      
      // Aggregate daily trends
      const date = tx.transactionDate;
      if (!dailyMap.has(date)) {
        dailyMap.set(date, {
          date,
          volume: 0,
          sr: 0,
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
    
    const totalCount = filteredTransactions.length;
    
    const metrics: Metrics = {
      totalCount,
      successCount,
      failedCount,
      userDroppedCount,
      sr: calculateSR(successCount, totalCount),
      successGmv,
      failedPercent: calculateSR(failedCount, totalCount),
      userDroppedPercent: calculateSR(userDroppedCount, totalCount),
    };
    
    // Calculate SR for each day
    const dailyTrends = Array.from(dailyMap.values())
      .map((trend) => ({
        ...trend,
        sr: calculateSR(trend.successCount, trend.volume),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    
    set({ globalMetrics: metrics, dailyTrends });
  },
  
  addDataFromFile: async (file: File) => {
    set({ isLoading: true, error: null, progress: null });
    
    try {
      const fileSizeMB = file.size / 1024 / 1024;
      console.log('Adding file:', file.name, 'Size:', fileSizeMB.toFixed(2), 'MB');
      
      if (fileSizeMB > 2000) {
        throw new Error('File is too large (>2GB). Please split your data into smaller files.');
      }
      
      const fileExtension = file.name.split('.').pop()?.toLowerCase();
      let rawData: any[] = [];
      
      const progressCallback = (progress: ProcessingProgress) => {
        set({ progress });
      };
      
      if (fileExtension === 'csv') {
        const isLargeFile = file.size > 100 * 1024 * 1024;
        if (isLargeFile) {
          rawData = await streamCSVFile(file, progressCallback);
        } else {
          const Papa = (await import('papaparse')).default;
          const text = await file.text();
          const result = Papa.parse(text, {
            header: true,
            skipEmptyLines: true,
            transformHeader: (header) => header.trim().toLowerCase(),
          });
          rawData = result.data as any[];
          set({ progress: { processed: rawData.length, total: rawData.length, percentage: 50, stage: 'parsing' } });
        }
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
    } finally {
      set({ isLoading: false });
    }
  },
  
  clearData: () => {
    // Cancel any ongoing worker processing
    workerManager.cancel();
    set({
      rawTransactions: [],
      filteredTransactions: [],
      globalMetrics: null,
      dailyTrends: [],
      fileNames: [],
      fileSizes: [],
      error: null,
      progress: null,
      filters: defaultFilters,
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
          };
        }
        return {
          rawTransactions: state.rawTransactions,
          fileNames: state.fileNames,
          fileSizes: state.fileSizes,
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
          };
        }
        return { ...currentState, ...persistedState };
      },
      onRehydrateStorage: () => (state) => {
        // After rehydration, apply filters to recompute metrics
        if (state && state.rawTransactions && state.rawTransactions.length > 0) {
          // Use setTimeout to ensure state is fully rehydrated
          setTimeout(() => {
            const store = useStore.getState();
            if (store.rawTransactions.length > 0) {
              store.applyFilters();
            }
          }, 100);
        }
      },
      // Skip persistence during loading to avoid blocking
      skipHydration: false,
    }
  )
);

