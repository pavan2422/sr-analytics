'use client';

import { useMemo, useCallback, memo, useState, useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { MultiSelect } from '@/components/MultiSelect';
import { Transaction } from '@/types';

interface FiltersProps {
  activeTab?: string;
  paymentModeOptions?: string[];
}

function FiltersComponent({ activeTab, paymentModeOptions }: FiltersProps) {
  // Use selectors to only subscribe to needed state
  const rawTransactions = useStore((state) => state.rawTransactions);
  const _useIndexedDB = useStore((state) => state._useIndexedDB);
  const filteredTransactionCount = useStore((state) => state.filteredTransactionCount);
  const getSampleFilteredTransactions = useStore((state) => state.getSampleFilteredTransactions);
  const filters = useStore((state) => state.filters);
  const setFilters = useStore((state) => state.setFilters);
  const resetFilters = useStore((state) => state.resetFilters);
  
  // For IndexedDB mode, load a sample to extract filter options
  const [sample, setSample] = useState<Transaction[]>([]);
  
  useEffect(() => {
    if (!_useIndexedDB) {
      setSample([]);
      return;
    }
    if (filteredTransactionCount === 0) {
      setSample([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const txs = await getSampleFilteredTransactions(50000);
        if (!cancelled) setSample(txs);
      } catch {
        if (!cancelled) setSample([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [_useIndexedDB, filteredTransactionCount, getSampleFilteredTransactions]);
  
  // Cleanup timeout on unmount
  const [dateTimeout, setDateTimeout] = useState<NodeJS.Timeout | null>(null);
  useEffect(() => {
    return () => {
      if (dateTimeout) {
        clearTimeout(dateTimeout);
      }
    };
  }, [dateTimeout]);

  // Extract unique values for filters
  const filterOptions = useMemo(() => {
    const source = _useIndexedDB ? sample : rawTransactions;
    
    if (source.length === 0) {
      return {
        paymentModes: [],
        merchantIds: [],
      };
    }

    // If paymentModeOptions provided (tab-specific), use those; otherwise show all
    let paymentModes: string[];
    if (paymentModeOptions && paymentModeOptions.length > 0) {
      // Filter to only show payment modes that exist in data and match tab options
      const availableModes = Array.from(
        new Set(source.map((tx) => tx.paymentmode).filter(Boolean))
      );
      paymentModes = paymentModeOptions.filter((mode) => availableModes.includes(mode));
    } else {
      // Overview/RCA: show all payment modes
      paymentModes = Array.from(
        new Set(source.map((tx) => tx.paymentmode).filter(Boolean))
      ).sort();
    }

    // Extract unique merchant IDs
    const merchantIds = Array.from(
      new Set(
        source
          .map((tx) => String(tx.merchantid || '').trim())
          .filter((id) => id !== '')
      )
    ).sort();

    return { paymentModes, merchantIds };
  }, [rawTransactions, _useIndexedDB, sample, paymentModeOptions]);

  const hasActiveFilters = useMemo(
    () =>
      filters.dateRange.start ||
      filters.dateRange.end ||
      filters.paymentModes.length > 0 ||
      filters.merchantIds.length > 0,
    [filters.dateRange.start, filters.dateRange.end, filters.paymentModes.length, filters.merchantIds.length]
  );

  // Memoize callbacks to prevent unnecessary re-renders
  const handlePaymentModeChange = useCallback(
    (selected: string[]) => {
      setFilters({ paymentModes: selected });
    },
    [setFilters]
  );

  const handleMerchantIdChange = useCallback(
    (selected: string[]) => {
      setFilters({ merchantIds: selected });
    },
    [setFilters]
  );

  // Debounced date change handlers to prevent excessive filter updates
  const handleStartDateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Clear existing timeout
      if (dateTimeout) {
        clearTimeout(dateTimeout);
      }
      
      // Debounce date changes (200ms for date inputs)
      const timeout = setTimeout(() => {
        setFilters({
          dateRange: {
            ...filters.dateRange,
            start: e.target.value ? new Date(e.target.value) : null,
          },
        });
        setDateTimeout(null);
      }, 200);
      
      setDateTimeout(timeout);
    },
    [setFilters, filters.dateRange, dateTimeout]
  );

  const handleEndDateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Clear existing timeout
      if (dateTimeout) {
        clearTimeout(dateTimeout);
      }
      
      // Debounce date changes (200ms for date inputs)
      const timeout = setTimeout(() => {
        setFilters({
          dateRange: {
            ...filters.dateRange,
            end: e.target.value ? new Date(e.target.value) : null,
          },
        });
        setDateTimeout(null);
      }, 200);
      
      setDateTimeout(timeout);
    },
    [setFilters, filters.dateRange, dateTimeout]
  );

  return (
    <div className="sticky top-0 z-50 bg-card border-b border-border p-4 shadow-lg">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Filters</h2>
          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear All
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Date Range */}
          <div>
            <label className="block text-sm font-medium mb-2">Start Date</label>
            <input
              type="date"
              value={
                filters.dateRange.start
                  ? format(filters.dateRange.start, 'yyyy-MM-dd')
                  : ''
              }
              onChange={handleStartDateChange}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">End Date</label>
            <input
              type="date"
              value={
                filters.dateRange.end
                  ? format(filters.dateRange.end, 'yyyy-MM-dd')
                  : ''
              }
              onChange={handleEndDateChange}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {/* Payment Mode */}
          <div>
            <MultiSelect
              label="Payment Mode"
              options={filterOptions.paymentModes}
              value={filters.paymentModes}
              onChange={handlePaymentModeChange}
              placeholder="Select payment mode..."
            />
          </div>

          {/* Merchant ID */}
          <div>
            <MultiSelect
              label="Merchant ID"
              options={filterOptions.merchantIds}
              value={filters.merchantIds}
              onChange={handleMerchantIdChange}
              placeholder="Select merchant ID..."
            />
          </div>

        </div>
      </div>
    </div>
  );
}

// Memoize Filters component to prevent unnecessary re-renders
export const Filters = memo(FiltersComponent);


