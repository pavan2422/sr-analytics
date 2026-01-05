'use client';

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { cn } from '@/lib/utils';
import { MultiSelect } from '@/components/MultiSelect';
import { classifyUPIFlow } from '@/lib/data-normalization';
import { Transaction } from '@/types';

interface TabFiltersProps {
  paymentMode: string[];
}

export function TabFilters({ paymentMode }: TabFiltersProps) {
  const rawTransactions = useStore((s) => s.rawTransactions);
  const tabKey = paymentMode.join('|');
  const local = useStore((s) => s.tabFilters[tabKey] || { pgs: [], banks: [], cardTypes: [] });
  const setTabFilters = useStore((s) => s.setTabFilters);
  const _useIndexedDB = useStore((s) => s._useIndexedDB);
  const filteredTransactionCount = useStore((s) => s.filteredTransactionCount);
  const getSampleFilteredTransactions = useStore((s) => s.getSampleFilteredTransactions);

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
        // Sample only relevant payment modes for this tab so options are meaningful.
        const txs = await getSampleFilteredTransactions(50000, { paymentModes: paymentMode });
        if (!cancelled) setSample(txs);
      } catch {
        if (!cancelled) setSample([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [_useIndexedDB, filteredTransactionCount, getSampleFilteredTransactions, tabKey, paymentMode]);

  // Filter transactions by payment mode
  const filteredTxs = useMemo(() => {
    const source = _useIndexedDB ? sample : rawTransactions;
    if (paymentMode.length === 0) return source;
    return source.filter((tx) => paymentMode.includes(tx.paymentmode));
  }, [_useIndexedDB, sample, rawTransactions, paymentMode]);

  const pgs = useMemo(() => {
    return Array.from(
      new Set(
        filteredTxs
          .map((tx) => tx.pg)
          .filter((pg) => {
            const pgStr = String(pg || '').trim().toUpperCase();
            return pg && pgStr !== 'N/A' && pgStr !== 'NA' && pgStr !== '';
          })
      )
    ).sort();
  }, [filteredTxs]);

  // For UPI, show INTENT/COLLECT instead of raw bankname
  const isUPITab = paymentMode.some((pm) => ['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'].includes(pm));
  
  const banks = useMemo(() => {
    if (isUPITab) {
      // For UPI, classify flows and show INTENT/COLLECT
      const flows = new Set<string>();
      filteredTxs.forEach((tx) => {
        const flow = classifyUPIFlow(tx.bankname);
        flows.add(flow);
      });
      return Array.from(flows).sort();
    } else {
      // For other tabs, show actual bank names
      return Array.from(new Set(filteredTxs.map((tx) => tx.bankname).filter(Boolean))).sort();
    }
  }, [filteredTxs, isUPITab]);

  const cardTypes = useMemo(() => {
    return Array.from(new Set(filteredTxs.map((tx) => tx.cardtype).filter(Boolean))).sort();
  }, [filteredTxs]);

  const hasAnyOptions = pgs.length > 0 || banks.length > 0 || cardTypes.length > 0;
  if (!hasAnyOptions) {
    return null;
  }

  return (
    <div className="bg-card border border-border rounded-lg p-4 mb-6">
      <h3 className="text-sm font-semibold mb-4">Tab Filters</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* PG Filter */}
        {pgs.length > 0 && (
          <div>
            <MultiSelect
              label="PG"
              options={pgs}
              value={local.pgs}
              onChange={(selected) => setTabFilters(tabKey, { pgs: selected })}
              placeholder="Select PG..."
            />
          </div>
        )}

        {/* Bank Filter */}
        {banks.length > 0 && (
          <div>
            <MultiSelect
              label={isUPITab ? "Flow Type" : "Bank"}
              options={banks}
              value={local.banks}
              onChange={(selected) => setTabFilters(tabKey, { banks: selected })}
              placeholder={isUPITab ? "Select Flow Type..." : "Select Bank..."}
            />
          </div>
        )}

        {/* Card Type Filter (only for Cards tab) */}
        {cardTypes.length > 0 && paymentMode.some((pm) => ['CREDIT_CARD', 'DEBIT_CARD', 'PREPAID_CARD'].includes(pm)) && (
          <div>
            <label className="block text-sm font-medium mb-2">Card Type</label>
            <div className="flex flex-wrap gap-2">
              {cardTypes.map((cardType) => (
                <button
                  key={cardType}
                  onClick={() => {
                    const isSelected = local.cardTypes.includes(cardType);
                    setTabFilters(tabKey, {
                      cardTypes: isSelected
                        ? local.cardTypes.filter((ct) => ct !== cardType)
                        : [...local.cardTypes, cardType],
                    });
                  }}
                  className={cn(
                    'px-3 py-1 rounded-lg text-sm transition-colors',
                    local.cardTypes.includes(cardType)
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  )}
                >
                  {cardType}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

