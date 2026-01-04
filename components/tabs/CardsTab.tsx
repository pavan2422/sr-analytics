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

export function CardsTab() {
  // Use selector to only subscribe to filteredTransactions
  const filteredTransactions = useStore((state) => state.filteredTransactions);
  const _useIndexedDB = useStore((state) => state._useIndexedDB);
  const _useBackend = useStore((state) => state._useBackend);
  const backendUploadId = useStore((state) => state.backendUploadId);
  const filteredTransactionCount = useStore((state) => state.filteredTransactionCount);
  const getSampleFilteredTransactions = useStore((state) => state.getSampleFilteredTransactions);
  const filters = useStore((state) => state.filters);

  const [sample, setSample] = useState<Transaction[]>([]);
  const [backendMetrics, setBackendMetrics] = useState<ReturnType<typeof computeCardMetrics> | null>(null);
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
        const res = await fetch(`/api/uploads/${backendUploadId}/card-metrics`, {
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
        if (!res.ok) throw new Error(`Failed to load card metrics (${res.status})`);
        const json = (await res.json()) as ReturnType<typeof computeCardMetrics>;
        if (!cancelled) setBackendMetrics(json);
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
      const txs = await getSampleFilteredTransactions(100000, { paymentModes: CARD_PAYMENT_MODES as unknown as string[] });
      if (!cancelled) setSample(txs);
    })().catch(() => {
      if (!cancelled) setSample([]);
    });
    return () => {
      cancelled = true;
    };
  }, [_useIndexedDB, _useBackend, backendUploadId, filteredTransactionCount, getSampleFilteredTransactions, filters]);

  const cardMetrics = useMemo(() => {
    if (_useIndexedDB && _useBackend) {
      return (
        backendMetrics || {
          pgLevel: [],
          cardTypeLevel: [],
          scopeLevel: [],
          authLevels: {
            processingCardType: [],
            nativeOtpEligible: [],
            isFrictionless: [],
            nativeOtpAction: [],
            cardPar: [],
            cvvPresent: [],
          },
          failureRCA: [],
        }
      );
    }
    const source = _useIndexedDB ? sample : filteredTransactions;
    return computeCardMetrics(source);
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
      <TabFilters paymentMode={CARD_PAYMENT_MODES as unknown as string[]} />

      {_useIndexedDB && _useBackend && isLoadingBackend && (
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Computing Cards tab metrics from the full dataset…</p>
        </div>
      )}

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

