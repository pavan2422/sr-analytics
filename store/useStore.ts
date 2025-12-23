import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Transaction, FilterState, Metrics, DailyTrend, GroupedMetrics, FailureRCA, RCAInsight, PeriodComparison } from '@/types';
import { calculateSR, safeDivide } from '@/lib/utils';
import { normalizeData, classifyUPIFlow } from '@/lib/data-normalization';
import { indexedDBStorage } from './indexedDBStorage';
import { streamCSVFile, processExcelFile, ProcessingProgress } from '@/lib/file-processor';
import { WorkerManager } from '@/lib/worker-manager';
import { FilterWorkerManager } from '@/lib/filter-worker-manager';

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
  applyFilters: () => Promise<void>;
  computeMetrics: () => Promise<void>;
  
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
const filterWorkerManager = new FilterWorkerManager();

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
      
      // Set progress first
      set({ progress: { processed: allNormalized.length, total: allNormalized.length, percentage: 100, stage: 'complete' } });
      console.log('File loaded and processed successfully');
      
      // Apply filters immediately - use setTimeout to ensure state is set first
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
    } finally {
      set({ isLoading: false });
    }
  },
  
  setFilters: (newFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
    }));
    
    // Debounce filter application to prevent excessive recomputations
    cancelPendingFilter();
    filterTimeout = setTimeout(() => {
      get().applyFilters();
      filterTimeout = null;
    }, 100); // 100ms debounce for faster response
  },
  
  resetFilters: () => {
    set({ filters: defaultFilters });
    cancelPendingFilter();
    // Apply immediately for reset - handle async properly
    get().applyFilters().catch((error) => {
      console.error('Error applying filters after reset:', error);
    });
  },
  
  applyFilters: async () => {
    const { rawTransactions, filters } = get();
    
    if (rawTransactions.length === 0) {
      set({ filteredTransactions: [], globalMetrics: null, dailyTrends: [] });
      return;
    }
    
    // Use Web Worker for filtering large datasets (>10k rows) to prevent UI blocking
    const useWorker = rawTransactions.length > 10000;
    
    try {
      let filtered: Transaction[];
      
      if (useWorker) {
        // Use Web Worker for large datasets
        filtered = await filterWorkerManager.filterTransactions(rawTransactions, filters);
      } else {
        // Use main thread for small datasets (faster for small data)
        const { filterTransactions } = await import('@/lib/filter-utils');
        filtered = filterTransactions(rawTransactions, filters);
      }
      
      set({ filteredTransactions: filtered });
      
      // Compute metrics using Web Worker for large datasets
      cancelPendingMetrics();
      
      if (typeof requestAnimationFrame !== 'undefined') {
        const rafId = requestAnimationFrame(async () => {
          if (!isComputing) {
            isComputing = true;
            try {
              await get().computeMetrics();
            } catch (error) {
              console.error('Error computing metrics:', error);
            } finally {
              isComputing = false;
            }
          }
          metricsTimeout = null;
        });
        metricsTimeout = rafId;
      } else {
        metricsTimeout = setTimeout(async () => {
          if (!isComputing) {
            isComputing = true;
            try {
              await get().computeMetrics();
            } catch (error) {
              console.error('Error computing metrics:', error);
            } finally {
              isComputing = false;
            }
          }
          metricsTimeout = null;
        }, 0);
      }
    } catch (error) {
      console.error('Error applying filters:', error);
      // Fallback to main thread - ensure we always set filtered transactions
      try {
        const { filterTransactions } = await import('@/lib/filter-utils');
        const filtered = filterTransactions(rawTransactions, filters);
        set({ filteredTransactions: filtered });
        await get().computeMetrics();
      } catch (fallbackError) {
        console.error('Fallback filter also failed:', fallbackError);
        // Last resort: set empty array to prevent infinite loading
        set({ filteredTransactions: [], globalMetrics: null, dailyTrends: [] });
      }
    }
  },
  
  computeMetrics: async () => {
    const { filteredTransactions } = get();
    
    if (filteredTransactions.length === 0) {
      set({ globalMetrics: null, dailyTrends: [] });
      return;
    }
    
    // Use Web Worker for large datasets (>10k rows)
    const useWorker = filteredTransactions.length > 10000;
    
    try {
      let result: { globalMetrics: Metrics | null; dailyTrends: DailyTrend[] };
      
      if (useWorker) {
        // Use Web Worker for large datasets
        result = await filterWorkerManager.computeMetrics(filteredTransactions);
      } else {
        // Use main thread for small datasets
        const { computeMetricsSync } = await import('@/lib/filter-utils');
        result = computeMetricsSync(filteredTransactions);
      }
      
      set({ globalMetrics: result.globalMetrics, dailyTrends: result.dailyTrends });
    } catch (error) {
      console.error('Error computing metrics:', error);
      // Fallback to main thread
      const { computeMetricsSync } = await import('@/lib/filter-utils');
      const result = computeMetricsSync(filteredTransactions);
      set({ globalMetrics: result.globalMetrics, dailyTrends: result.dailyTrends });
    }
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

