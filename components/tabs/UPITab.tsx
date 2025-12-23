'use client';

import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { computeUPIMetrics } from '@/lib/metrics';
import { DataTable } from '@/components/DataTable';
import { Chart } from '@/components/Chart';
import { TabFilters } from '@/components/TabFilters';
import { ColumnDef } from '@tanstack/react-table';
import { GroupedMetrics, FailureRCA } from '@/types';
import { formatNumber } from '@/lib/utils';

export function UPITab() {
  // Use selector to only subscribe to filteredTransactions
  const filteredTransactions = useStore((state) => state.filteredTransactions);
  const upiPaymentModes = ['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'];

  const upiMetrics = useMemo(() => {
    return computeUPIMetrics(filteredTransactions);
  }, [filteredTransactions]);

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
      <TabFilters paymentMode={upiPaymentModes} />

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

