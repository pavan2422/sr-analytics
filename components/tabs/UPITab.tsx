'use client';

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { computeUPIMetrics } from '@/lib/metrics';
import { DataTable } from '@/components/DataTable';
import { Chart } from '@/components/Chart';
import { TabFilters } from '@/components/TabFilters';
import { ColumnDef } from '@tanstack/react-table';
import { GroupedMetrics, FailureRCA, Transaction } from '@/types';
import { formatNumber } from '@/lib/utils';
import { classifyUPIFlow } from '@/lib/data-normalization';

const UPI_PAYMENT_MODES = ['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'] as const;
const TAB_KEY = UPI_PAYMENT_MODES.join('|');

export function UPITab() {
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
        paymentModes: UPI_PAYMENT_MODES as unknown as string[],
      });
      if (!cancelled) setSample(txs);
    })().catch(() => {
      if (!cancelled) setSample([]);
    });
    return () => {
      cancelled = true;
    };
  }, [_useIndexedDB, filteredTransactionCount, getSampleFilteredTransactions]);

  const upiMetrics = useMemo(() => {
    const source = _useIndexedDB ? sample : filteredTransactions;
    const tabScoped = source
      .filter((tx) => (tabFilters.pgs.length ? tabFilters.pgs.includes(tx.pg) : true))
      .filter((tx) => {
        if (!tabFilters.banks.length) return true;
        const flow = classifyUPIFlow(tx.bankname);
        return tabFilters.banks.includes(flow) || tabFilters.banks.includes(tx.bankname);
      });
    return computeUPIMetrics(tabScoped);
  }, [filteredTransactions, _useIndexedDB, sample, tabFilters.pgs, tabFilters.banks]);

  const pgColumns: ColumnDef<GroupedMetrics>[] = useMemo(
    () => [
      {
        accessorKey: 'group',
        header: 'PG',
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
      {
        accessorKey: 'userDroppedCount',
        header: 'User Dropped',
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
      <TabFilters paymentMode={UPI_PAYMENT_MODES as unknown as string[]} />

      {/* PG Level */}
      <div>
        <h3 className="text-lg font-semibold mb-4">PG Level Analysis</h3>
        <DataTable data={upiMetrics.pgLevel} columns={pgColumns} height={300} />
        {upiMetrics.pgLevel.length > 0 && upiMetrics.pgLevel[0].dailyTrend && (
          <div className="mt-4 bg-card border border-border rounded-lg p-6">
            <Chart data={upiMetrics.pgLevel[0].dailyTrend} type="dual" height={300} />
          </div>
        )}
      </div>

      {/* Intent vs Collect */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Intent vs Collect</h3>
        <DataTable data={upiMetrics.flowLevel} columns={pgColumns} height={300} />
        {upiMetrics.flowLevel.length > 0 && upiMetrics.flowLevel[0].dailyTrend && (
          <div className="mt-4 bg-card border border-border rounded-lg p-6">
            <Chart data={upiMetrics.flowLevel[0].dailyTrend} type="sr" height={300} />
          </div>
        )}
      </div>

      {/* Handle Level */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Handle Level Analysis</h3>
        <DataTable data={upiMetrics.handleLevel} columns={pgColumns} height={400} />
      </div>

      {/* PSP Level */}
      <div>
        <h3 className="text-lg font-semibold mb-4">PSP Level Analysis</h3>
        <DataTable data={upiMetrics.pspLevel} columns={pgColumns} height={300} />
        {upiMetrics.pspLevel.length > 0 && upiMetrics.pspLevel[0].dailyTrend && (
          <div className="mt-4 bg-card border border-border rounded-lg p-6">
            <Chart data={upiMetrics.pspLevel[0].dailyTrend} type="dual" height={300} />
          </div>
        )}
      </div>

      {/* Failure RCA */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Failure Root Cause Analysis</h3>
        <DataTable<FailureRCA> data={upiMetrics.failureRCA} columns={failureColumns} height={400} />
      </div>
    </div>
  );
}

