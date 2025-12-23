import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Transaction, FilterState, Metrics, DailyTrend, GroupedMetrics, FailureRCA, RCAInsight, PeriodComparison } from '@/types';
import { calculateSR, safeDivide } from '@/lib/utils';
import { normalizeData, classifyUPIFlow } from '@/lib/data-normalization';
import { indexedDBStorage } from './indexedDBStorage';

interface StoreState {
  // Raw data
  rawTransactions: Transaction[];
  isLoading: boolean;
  error: string | null;
  fileNames: string[];
  fileSizes: number[];
  _skipPersistence: boolean; // Internal flag to skip persistence during large loads
  
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

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
  rawTransactions: [],
  isLoading: false,
  error: null,
  fileNames: [],
  fileSizes: [],
  _skipPersistence: false,
  filters: defaultFilters,
  filteredTransactions: [],
  globalMetrics: null,
  dailyTrends: [],
  
  setRawTransactions: (transactions) => {
    set({ rawTransactions: transactions });
    get().applyFilters();
  },
  
  loadDataFromFile: async (file: File) => {
    set({ isLoading: true, error: null });
    
    try {
      console.log('Loading file:', file.name, 'Size:', file.size);
      const fileExtension = file.name.split('.').pop()?.toLowerCase();
      let rawData: any[] = [];
      
      if (fileExtension === 'csv') {
        console.log('Parsing CSV file...');
        const Papa = (await import('papaparse')).default;
        const text = await file.text();
        const result = Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (header) => header.trim().toLowerCase(),
        });
        rawData = result.data as any[];
        console.log('CSV parsed, rows:', rawData.length);
      } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
        console.log('Parsing Excel file...');
        const XLSX = (await import('xlsx')).default;
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet);
        // Normalize Excel headers to lowercase (like CSV)
        rawData = jsonData.map((row: any) => {
          const normalized: any = {};
          Object.keys(row).forEach((key) => {
            normalized[key.toLowerCase().trim()] = row[key];
          });
          return normalized;
        });
        console.log('Excel parsed, rows:', rawData.length);
      } else {
        throw new Error('Unsupported file format. Please upload CSV or XLSX file.');
      }
      
      if (rawData.length === 0) {
        throw new Error('File appears to be empty. Please check the file format.');
      }
      
      console.log('Normalizing data in chunks...');
      
      // Process data in chunks to avoid memory issues
      const CHUNK_SIZE = 10000; // Process 10k rows at a time
      const allNormalized: Transaction[] = [];
      
      for (let i = 0; i < rawData.length; i += CHUNK_SIZE) {
        const chunk = rawData.slice(i, i + CHUNK_SIZE);
        const normalizedChunk = normalizeData(chunk);
        allNormalized.push(...normalizedChunk);
        
        // Yield to browser to prevent blocking
        if (i + CHUNK_SIZE < rawData.length) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        
        console.log(`Processed ${Math.min(i + CHUNK_SIZE, rawData.length)}/${rawData.length} rows`);
      }
      
      console.log('Data normalized, transactions:', allNormalized.length);
      
      // For large datasets, set a flag to skip immediate persistence
      // and persist in background
      const isLargeDataset = allNormalized.length > 50000;
      
      if (isLargeDataset) {
        set({ _skipPersistence: true });
      }
      
      // Set data - for large datasets, persistence will be deferred
      set({ 
        rawTransactions: allNormalized,
        fileNames: [file.name],
        fileSizes: [file.size],
      });
      
      // For large datasets, persist asynchronously after a delay
      if (isLargeDataset) {
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
        console.log('File loaded and processed successfully');
      }, 100);
      
    } catch (error: any) {
      console.error('Error in loadDataFromFile:', error);
      set({ error: error.message || 'Failed to load file. Please check the console for details.' });
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
    
    let filtered = [...rawTransactions];
    
    // Remove records where PG = 'N/A'
    filtered = filtered.filter((tx) => {
      const pg = String(tx.pg || '').trim().toUpperCase();
      return pg !== 'N/A' && pg !== 'NA' && pg !== '';
    });
    
    // Date range filter
    if (filters.dateRange.start) {
      filtered = filtered.filter(
        (tx) => tx.txtime >= filters.dateRange.start!
      );
    }
    if (filters.dateRange.end) {
      const endDate = new Date(filters.dateRange.end);
      endDate.setHours(23, 59, 59, 999);
      filtered = filtered.filter((tx) => tx.txtime <= endDate);
    }
    
    // Payment mode filter
    if (filters.paymentModes.length > 0) {
      filtered = filtered.filter((tx) =>
        filters.paymentModes.includes(tx.paymentmode)
      );
    }
    
    // Merchant ID filter
    if (filters.merchantIds.length > 0) {
      filtered = filtered.filter((tx) => {
        const merchantId = String(tx.merchantid || '').trim();
        return filters.merchantIds.includes(merchantId);
      });
    }
    
    // PG filter
    if (filters.pgs.length > 0) {
      filtered = filtered.filter((tx) => filters.pgs.includes(tx.pg));
    }
    
    // Bank filter (for UPI, this filters by INTENT/COLLECT classification)
    if (filters.banks.length > 0) {
      filtered = filtered.filter((tx) => {
        const flow = classifyUPIFlow(tx.bankname);
        // Match if selected bank is the flow type (INTENT/COLLECT) or actual bankname
        return filters.banks.includes(flow) || filters.banks.includes(tx.bankname);
      });
    }
    
    // Card type filter
    if (filters.cardTypes.length > 0) {
      filtered = filtered.filter((tx) => filters.cardTypes.includes(tx.cardtype));
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
    
    // Compute global metrics
    const totalCount = filteredTransactions.length;
    const successCount = filteredTransactions.filter((tx) => tx.isSuccess).length;
    const failedCount = filteredTransactions.filter((tx) => tx.isFailed).length;
    const userDroppedCount = filteredTransactions.filter((tx) => tx.isUserDropped).length;
    const successGmv = filteredTransactions
      .filter((tx) => tx.isSuccess)
      .reduce((sum, tx) => sum + tx.txamount, 0);
    
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
    
    // Compute daily trends
    const dailyMap = new Map<string, DailyTrend>();
    
    filteredTransactions.forEach((tx) => {
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
    });
    
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
    set({ isLoading: true, error: null });
    
    try {
      console.log('Adding file:', file.name, 'Size:', file.size);
      const fileExtension = file.name.split('.').pop()?.toLowerCase();
      let rawData: any[] = [];
      
      if (fileExtension === 'csv') {
        console.log('Parsing CSV file...');
        const Papa = (await import('papaparse')).default;
        const text = await file.text();
        const result = Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (header) => header.trim().toLowerCase(),
        });
        rawData = result.data as any[];
        console.log('CSV parsed, rows:', rawData.length);
      } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
        console.log('Parsing Excel file...');
        const XLSX = (await import('xlsx')).default;
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet);
        // Normalize Excel headers to lowercase (like CSV)
        rawData = jsonData.map((row: any) => {
          const normalized: any = {};
          Object.keys(row).forEach((key) => {
            normalized[key.toLowerCase().trim()] = row[key];
          });
          return normalized;
        });
        console.log('Excel parsed, rows:', rawData.length);
      } else {
        throw new Error('Unsupported file format. Please upload CSV or XLSX file.');
      }
      
      if (rawData.length === 0) {
        throw new Error('File appears to be empty. Please check the file format.');
      }
      
      console.log('Normalizing data...');
      const normalizedData = normalizeData(rawData);
      console.log('Data normalized, transactions:', normalizedData.length);
      
      const { rawTransactions, fileNames, fileSizes } = get();
      set({ 
        rawTransactions: [...rawTransactions, ...normalizedData],
        fileNames: [...fileNames, file.name],
        fileSizes: [...fileSizes, file.size],
      });
      get().applyFilters();
      console.log('File added and processed successfully');
    } catch (error: any) {
      console.error('Error in addDataFromFile:', error);
      set({ error: error.message || 'Failed to add file. Please check the console for details.' });
    } finally {
      set({ isLoading: false });
    }
  },
  
  clearData: () => {
    set({
      rawTransactions: [],
      filteredTransactions: [],
      globalMetrics: null,
      dailyTrends: [],
      fileNames: [],
      fileSizes: [],
      error: null,
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

