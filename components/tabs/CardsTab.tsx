'use client';

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { computeCardMetrics } from '@/lib/metrics';
import { DataTable } from '@/components/DataTable';
import { Chart } from '@/components/Chart';
import { TabFilters } from '@/components/TabFilters';
import { ColumnDef } from '@tanstack/react-table';
import { GroupedMetrics, FailureRCA, Transaction } from '@/types';
import { formatNumber } from '@/lib/utils';

const CARD_PAYMENT_MODES = ['CREDIT_CARD', 'DEBIT_CARD', 'PREPAID_CARD'] as const;
const TAB_KEY = CARD_PAYMENT_MODES.join('|');

export function CardsTab() {
  // Use selector to only subscribe to filteredTransactions
  const filteredTransactions = useStore((state) => state.filteredTransactions);
  const _useIndexedDB = useStore((state) => state._useIndexedDB);
  const filteredTransactionCount = useStore((state) => state.filteredTransactionCount);
  const getSampleFilteredTransactions = useStore((state) => state.getSampleFilteredTransactions);
  const tabFilters = useStore((state) => state.tabFilters[TAB_KEY] || { pgs: [], banks: [], cardTypes: [] });

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
      const txs = await getSampleFilteredTransactions(100000, {
        paymentModes: CARD_PAYMENT_MODES as unknown as string[],
        pgs: tabFilters.pgs.length ? tabFilters.pgs : undefined,
        banks: tabFilters.banks.length ? tabFilters.banks : undefined,
        cardTypes: tabFilters.cardTypes.length ? tabFilters.cardTypes : undefined,
      });
      if (!cancelled) setSample(txs);
    })().catch(() => {
      if (!cancelled) setSample([]);
    });
    return () => {
      cancelled = true;
    };
  }, [
    _useIndexedDB,
    filteredTransactionCount,
    getSampleFilteredTransactions,
    tabFilters.pgs,
    tabFilters.banks,
    tabFilters.cardTypes,
  ]);

  const cardMetrics = useMemo(() => {
    const source = _useIndexedDB ? sample : filteredTransactions;
    const tabScoped = source
      .filter((tx) => (tabFilters.pgs.length ? tabFilters.pgs.includes(tx.pg) : true))
      .filter((tx) => (tabFilters.banks.length ? tabFilters.banks.includes(tx.bankname) : true))
      .filter((tx) => (tabFilters.cardTypes.length ? tabFilters.cardTypes.includes(tx.cardtype) : true));
    return computeCardMetrics(tabScoped);
  }, [filteredTransactions, _useIndexedDB, sample, tabFilters.pgs, tabFilters.banks, tabFilters.cardTypes]);

  const baseColumns: ColumnDef<GroupedMetrics>[] = useMemo(
    () => [
      {
        accessorKey: 'group',
        header: 'Group',
        cell: (info) => <span className="font-medium">{info.getValue() as string}</span>,
      },
      {
        accessorKey: 'volume',
        header: 'Volume',
        cell: (info) => formatNumber(info.getValue() as number),
      },
      {
        accessorKey: 'sr',
        header: 'SR %',
        cell: (info) => (
          <span className={Number(info.getValue()) >= 95 ? 'text-success' : Number(info.getValue()) >= 90 ? 'text-warning' : 'text-error'}>
            {(info.getValue() as number).toFixed(2)}%
          </span>
        ),
      },
      {
        accessorKey: 'failedCount',
        header: 'Failed',
        cell: (info) => formatNumber(info.getValue() as number),
      },
    ],
    []
  );

  const failureColumns: ColumnDef<FailureRCA>[] = useMemo(
    () => [
      {
        accessorKey: 'txmsg',
        header: 'Failure Message',
        cell: (info) => <span className="font-medium">{info.getValue() as string}</span>,
      },
      {
        accessorKey: 'failureCount',
        header: 'Failure Count',
        cell: (info) => formatNumber(info.getValue() as number),
      },
      {
        accessorKey: 'failurePercent',
        header: 'Failure %',
        cell: (info) => `${(info.getValue() as number).toFixed(2)}%`,
      },
      {
        accessorKey: 'adjustedSR',
        header: 'Adjusted SR',
        cell: (info) => (
          <span className="text-success">{(info.getValue() as number).toFixed(2)}%</span>
        ),
      },
      {
        accessorKey: 'impact',
        header: 'SR Impact',
        cell: (info) => {
          const impact = info.getValue() as number;
          return (
            <span className={impact > 0 ? 'text-success' : 'text-error'}>
              {impact > 0 ? '+' : ''}{impact.toFixed(2)}%
            </span>
          );
        },
      },
    ],
    []
  );

  return (
    <div className="space-y-8">
      {/* Tab-specific Filters */}
      <TabFilters paymentMode={CARD_PAYMENT_MODES as unknown as string[]} />

      {/* PG Level */}
      <div>
        <h3 className="text-lg font-semibold mb-4">PG Level Analysis</h3>
        <DataTable data={cardMetrics.pgLevel} columns={baseColumns} height={300} />
      </div>

      {/* Card Type */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Card Type Analysis</h3>
        <DataTable data={cardMetrics.cardTypeLevel} columns={baseColumns} height={300} />
      </div>

      {/* Domestic vs IPG */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Domestic vs International</h3>
        <DataTable data={cardMetrics.scopeLevel} columns={baseColumns} height={300} />
        {cardMetrics.scopeLevel.length >= 2 && (
          <div className="mt-4 bg-card border border-border rounded-lg p-6">
            <div className="grid grid-cols-2 gap-4 mb-4">
              {cardMetrics.scopeLevel.map((scope) => (
                <div key={scope.group} className="p-4 bg-muted rounded-lg">
                  <div className="text-sm text-muted-foreground">{scope.group}</div>
                  <div className="text-2xl font-bold mt-2">{scope.sr.toFixed(2)}%</div>
                  <div className="text-sm text-muted-foreground mt-1">
                    Volume: {formatNumber(scope.volume)}
                  </div>
                </div>
              ))}
            </div>
            {cardMetrics.scopeLevel.length >= 2 && (
              <div className="text-sm text-muted-foreground">
                SR Delta: {(cardMetrics.scopeLevel[0].sr - cardMetrics.scopeLevel[1].sr).toFixed(2)}%
              </div>
            )}
          </div>
        )}
      </div>

      {/* Authentication & Friction */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Authentication & Friction Analysis</h3>
        
        <div className="space-y-6">
          <div>
            <h4 className="text-md font-medium mb-2">Processing Card Type</h4>
            <DataTable data={cardMetrics.authLevels.processingCardType} columns={baseColumns} height={200} />
          </div>
          
          <div>
            <h4 className="text-md font-medium mb-2">Native OTP Eligible</h4>
            <DataTable data={cardMetrics.authLevels.nativeOtpEligible} columns={baseColumns} height={200} />
          </div>
          
          <div>
            <h4 className="text-md font-medium mb-2">Frictionless</h4>
            <DataTable data={cardMetrics.authLevels.isFrictionless} columns={baseColumns} height={200} />
          </div>
          
          <div>
            <h4 className="text-md font-medium mb-2">Native OTP Action</h4>
            <DataTable data={cardMetrics.authLevels.nativeOtpAction} columns={baseColumns} height={200} />
          </div>
          
          <div>
            <h4 className="text-md font-medium mb-2">Card PAR</h4>
            <DataTable data={cardMetrics.authLevels.cardPar} columns={baseColumns} height={200} />
          </div>
        </div>
      </div>

      {/* Failure RCA */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Failure Root Cause Analysis</h3>
        <DataTable<FailureRCA> data={cardMetrics.failureRCA} columns={failureColumns} height={400} />
      </div>
    </div>
  );
}

