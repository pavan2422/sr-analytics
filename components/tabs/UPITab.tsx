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

const UPI_PAYMENT_MODES = ['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'] as const;

export function UPITab() {
  // Use selector to only subscribe to filteredTransactions
  const filteredTransactions = useStore((state) => state.filteredTransactions);
  const _useIndexedDB = useStore((state) => state._useIndexedDB);
  const _useBackend = useStore((state) => state._useBackend);
  const backendUploadId = useStore((state) => state.backendUploadId);
  const filteredTransactionCount = useStore((state) => state.filteredTransactionCount);
  const getSampleFilteredTransactions = useStore((state) => state.getSampleFilteredTransactions);
  const filters = useStore((state) => state.filters);

  const [sample, setSample] = useState<Transaction[]>([]);
  const [backendMetrics, setBackendMetrics] = useState<ReturnType<typeof computeUPIMetrics> | null>(null);
  const [isLoadingBackend, setIsLoadingBackend] = useState(false);

  useEffect(() => {
    if (_useIndexedDB && _useBackend) {
      setSample([]);
      if (filteredTransactionCount === 0) {
        setBackendMetrics(null);
        return;
      }
      if (!backendUploadId) {
        setBackendMetrics(null);
        return;
      }
      let cancelled = false;
      setIsLoadingBackend(true);
      (async () => {
        const { retryApiCall } = await import('@/lib/retry-api');
        await retryApiCall(async () => {
          const res = await fetch(`/api/uploads/${backendUploadId}/upi-metrics`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              startDate: filters.dateRange.start ? filters.dateRange.start.toISOString() : null,
              endDate: filters.dateRange.end ? filters.dateRange.end.toISOString() : null,
              paymentModes: filters.paymentModes || [],
              merchantIds: filters.merchantIds || [],
              pgs: filters.pgs || [],
              banks: filters.banks || [],
              cardTypes: filters.cardTypes || [],
            }),
          });
          if (!res.ok) {
            const msg = await res.text().catch(() => '');
            throw new Error(`Failed to load UPI metrics (${res.status}): ${msg}`);
          }
          const json = (await res.json()) as ReturnType<typeof computeUPIMetrics>;
          if (!cancelled) setBackendMetrics(json);
        }, 5, undefined, backendUploadId);
      })()
        .catch(() => {
          if (!cancelled) setBackendMetrics(null);
        })
        .finally(() => {
          if (!cancelled) setIsLoadingBackend(false);
        });
      return () => {
        cancelled = true;
      };
    }

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
      const txs = await getSampleFilteredTransactions(100000, { paymentModes: UPI_PAYMENT_MODES as unknown as string[] });
      if (!cancelled) setSample(txs);
    })().catch(() => {
      if (!cancelled) setSample([]);
    });
    return () => {
      cancelled = true;
    };
  }, [_useIndexedDB, _useBackend, backendUploadId, filteredTransactionCount, getSampleFilteredTransactions, filters]);

  const upiMetrics = useMemo(() => {
    if (_useIndexedDB && _useBackend) {
      return (
        backendMetrics || {
          pgLevel: [],
          flowLevel: [],
          handleLevel: [],
          pspLevel: [],
          failureRCA: [],
        }
      );
    }
    const source = _useIndexedDB ? sample : filteredTransactions;
    return computeUPIMetrics(source);
  }, [filteredTransactions, _useIndexedDB, _useBackend, sample, backendMetrics]);

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

      {_useIndexedDB && _useBackend && isLoadingBackend && (
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Computing UPI tab metrics from the full dataset…</p>
        </div>
      )}

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

