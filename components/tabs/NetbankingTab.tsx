'use client';

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { computeNetbankingMetrics } from '@/lib/metrics';
import { DataTable } from '@/components/DataTable';
import { Chart } from '@/components/Chart';
import { TabFilters } from '@/components/TabFilters';
import { ColumnDef } from '@tanstack/react-table';
import { GroupedMetrics, FailureRCA, Transaction } from '@/types';
import { formatNumber } from '@/lib/utils';

const NETBANKING_PAYMENT_MODES = ['NET_BANKING'] as const;

export function NetbankingTab() {
  // Use selector to only subscribe to filteredTransactions
  const filteredTransactions = useStore((state) => state.filteredTransactions);
  const _useIndexedDB = useStore((state) => state._useIndexedDB);
  const _useBackend = useStore((state) => state._useBackend);
  const backendUploadId = useStore((state) => state.backendUploadId);
  const filteredTransactionCount = useStore((state) => state.filteredTransactionCount);
  const getSampleFilteredTransactions = useStore((state) => state.getSampleFilteredTransactions);
  const filters = useStore((state) => state.filters);

  const [sample, setSample] = useState<Transaction[]>([]);
  const [backendMetrics, setBackendMetrics] = useState<ReturnType<typeof computeNetbankingMetrics> | null>(null);
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
          const res = await fetch(`/api/uploads/${backendUploadId}/netbanking-metrics`, {
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
            throw new Error(`Failed to load netbanking metrics (${res.status}): ${msg}`);
          }
          const json = (await res.json()) as ReturnType<typeof computeNetbankingMetrics>;
          if (!cancelled) setBackendMetrics(json);
        });
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
      const txs = await getSampleFilteredTransactions(100000, { paymentModes: NETBANKING_PAYMENT_MODES as unknown as string[] });
      if (!cancelled) setSample(txs);
    })().catch(() => {
      if (!cancelled) setSample([]);
    });
    return () => {
      cancelled = true;
    };
  }, [_useIndexedDB, _useBackend, backendUploadId, filteredTransactionCount, getSampleFilteredTransactions, filters]);

  const nbMetrics = useMemo(() => {
    if (_useIndexedDB && _useBackend) {
      return (
        backendMetrics || {
          pgLevel: [],
          bankLevel: [],
          bankTierLevel: [],
          failureRCA: [],
        }
      );
    }
    const source = _useIndexedDB ? sample : filteredTransactions;
    return computeNetbankingMetrics(source);
  }, [filteredTransactions, _useIndexedDB, _useBackend, sample, backendMetrics]);

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
      <TabFilters paymentMode={NETBANKING_PAYMENT_MODES as unknown as string[]} />

      {_useIndexedDB && _useBackend && isLoadingBackend && (
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Computing Netbanking tab metrics from the full dataset…</p>
        </div>
      )}

      {/* PG Level */}
      <div>
        <h3 className="text-lg font-semibold mb-4">PG Level Analysis</h3>
        <DataTable data={nbMetrics.pgLevel} columns={baseColumns} height={300} />
      </div>

      {/* Bank Level */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Bank Level Analysis</h3>
        <DataTable data={nbMetrics.bankLevel} columns={baseColumns} height={400} />
        {nbMetrics.bankLevel.length > 0 && nbMetrics.bankLevel[0].dailyTrend && (
          <div className="mt-4 bg-card border border-border rounded-lg p-6">
            <Chart data={nbMetrics.bankLevel[0].dailyTrend} type="dual" height={300} />
          </div>
        )}
      </div>

      {/* Bank Tier Wise SR */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Bank Tier Wise SR</h3>
        <DataTable data={nbMetrics.bankTierLevel} columns={baseColumns} height={300} />
        {nbMetrics.bankTierLevel.length > 0 && nbMetrics.bankTierLevel[0].dailyTrend && (
          <div className="mt-4 bg-card border border-border rounded-lg p-6">
            <Chart data={nbMetrics.bankTierLevel[0].dailyTrend} type="dual" height={300} />
          </div>
        )}
      </div>

      {/* Failure RCA */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Failure Root Cause Analysis</h3>
        <DataTable<FailureRCA> data={nbMetrics.failureRCA} columns={failureColumns} height={400} />
      </div>
    </div>
  );
}

