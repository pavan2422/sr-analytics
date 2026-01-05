'use client';

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { KPICard } from '@/components/KPICard';
import { Chart } from '@/components/Chart';
import { OverviewChart } from '@/components/OverviewChart';
import { formatNumber, formatCurrency } from '@/lib/utils';
import { Transaction } from '@/types';
import { computeOverviewBreakdowns, type OverviewBreakdowns } from '@/lib/overview-breakdowns';

export function OverviewTab() {
  // Use selectors to only subscribe to needed state slices
  const globalMetrics = useStore((state) => state.globalMetrics);
  const dailyTrends = useStore((state) => state.dailyTrends);
  const _useIndexedDB = useStore((state) => state._useIndexedDB);
  const _useBackend = useStore((state) => state._useBackend);
  const backendUploadId = useStore((state) => state.backendUploadId);
  const filteredTransactions = useStore((state) => state.filteredTransactions);
  const filteredTransactionCount = useStore((state) => state.filteredTransactionCount);
  const getSampleFilteredTransactions = useStore((state) => state.getSampleFilteredTransactions);
  const filters = useStore((state) => state.filters);

  // Sample used for breakdown charts. For IndexedDB mode this is a bounded sample (memory-safe).
  const [sample, setSample] = useState<Transaction[]>([]);
  const [sampleStatus, setSampleStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [breakdowns, setBreakdowns] = useState<OverviewBreakdowns>(() => computeOverviewBreakdowns([], []));

  useEffect(() => {
    // If there's no data, clear sample
    if (!globalMetrics || filteredTransactionCount === 0) {
      setSample([]);
      setSampleStatus('idle');
      setBreakdowns(computeOverviewBreakdowns([], dailyTrends));
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        setSampleStatus('loading');
        if (_useIndexedDB && _useBackend) {
          if (!backendUploadId) throw new Error('Missing backend upload id');
          const params = new URLSearchParams();
          if (filters.dateRange.start) params.set('startDate', filters.dateRange.start.toISOString());
          if (filters.dateRange.end) params.set('endDate', filters.dateRange.end.toISOString());
          for (const pm of filters.paymentModes || []) params.append('paymentModes', pm);
          for (const id of filters.merchantIds || []) params.append('merchantIds', id);
          for (const pg of filters.pgs || []) params.append('pgs', pg);
          for (const b of filters.banks || []) params.append('banks', b);
          for (const ct of filters.cardTypes || []) params.append('cardTypes', ct);

          const { retryApiCall } = await import('@/lib/retry-api');
          const res = await retryApiCall(async () => {
            const r = await fetch(`/api/uploads/${backendUploadId}/overview-breakdowns?${params.toString()}`);
            if (!r.ok) {
              const msg = await r.text().catch(() => '');
              throw new Error(`Failed to load breakdowns (${r.status}): ${msg}`);
            }
            return r;
          });
          const json = (await res.json()) as OverviewBreakdowns;
          if (!cancelled) {
            setSample([]); // not used in backend mode
            setBreakdowns(json);
            setSampleStatus('ready');
          }
        } else if (_useIndexedDB) {
          // For large datasets, compute from a bounded sample.
          const txs = await getSampleFilteredTransactions(50000);
          if (!cancelled) {
            setSample(txs);
            setBreakdowns(computeOverviewBreakdowns(txs, dailyTrends));
            setSampleStatus('ready');
          }
        } else {
          // For small datasets, use the filtered in-memory set (cap to keep UI responsive).
          const capped = filteredTransactions.length > 200000 ? filteredTransactions.slice(0, 200000) : filteredTransactions;
          if (!cancelled) {
            setSample(capped);
            setBreakdowns(computeOverviewBreakdowns(capped, dailyTrends));
            setSampleStatus('ready');
          }
        }
      } catch (e) {
        if (!cancelled) {
          setSample([]);
          setBreakdowns(computeOverviewBreakdowns([], dailyTrends));
          setSampleStatus('ready');
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [
    _useIndexedDB,
    _useBackend,
    backendUploadId,
    filteredTransactionCount,
    filteredTransactions,
    getSampleFilteredTransactions,
    globalMetrics,
    filters,
    dailyTrends,
  ]);

  // Transaction Status Distribution (from globalMetrics - no need to recompute)
  const statusDistribution = useMemo(() => {
    if (!globalMetrics) return [];
    return [
      { name: 'Success', value: globalMetrics.successCount },
      { name: 'Failed', value: globalMetrics.failedCount },
      { name: 'User Dropped', value: globalMetrics.userDroppedCount },
    ];
  }, [globalMetrics]);

  // SR Trend Over Time (from daily trends - already computed)
  const srTrendData = useMemo(() => {
    return dailyTrends.map((trend) => ({
      name: new Date(trend.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      volume: trend.volume,
      sr: trend.sr,
    }));
  }, [dailyTrends]);

  const {
    paymentModeData,
    hourlyData,
    pgData,
    failureReasonsData,
    dayOfWeekData,
    amountDistributionData,
    banksData,
    scatterData,
  } = breakdowns;

  // Show loading state if data is being computed
  if (!globalMetrics) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        <p className="text-muted-foreground ml-4">Computing metrics...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <KPICard
          title="Total Volume"
          value={formatNumber(globalMetrics.totalCount)}
          variant="default"
        />
        <KPICard
          title="Overall SR %"
          value={`${globalMetrics.sr}%`}
          variant={globalMetrics.sr >= 95 ? 'success' : globalMetrics.sr >= 90 ? 'warning' : 'error'}
        />
        <KPICard
          title="Success GMV"
          value={formatCurrency(globalMetrics.successGmv)}
          variant="success"
        />
        <KPICard
          title="Failed %"
          value={`${globalMetrics.failedPercent}%`}
          variant={globalMetrics.failedPercent < 5 ? 'success' : globalMetrics.failedPercent < 10 ? 'warning' : 'error'}
        />
        <KPICard
          title="User Dropped %"
          value={`${globalMetrics.userDroppedPercent}%`}
          variant={globalMetrics.userDroppedPercent < 5 ? 'success' : globalMetrics.userDroppedPercent < 10 ? 'warning' : 'error'}
        />
      </div>

      {/* Daily Trend Chart */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Daily Trend</h3>
        <Chart data={dailyTrends} type="dual" height={400} />
      </div>

      {/* New Visualizations */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 1. Transaction Status Distribution */}
        <div className="bg-card border border-border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Transaction Status Distribution</h3>
          <OverviewChart type="donut" data={statusDistribution} height={350} />
        </div>

        {/* 2. Payment Mode Performance */}
        <div className="bg-card border border-border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Payment Mode Performance</h3>
          {_useIndexedDB && sampleStatus === 'loading' && (
            <p className="text-xs text-muted-foreground mb-2">Loading breakdowns from browser storage (sampled)…</p>
          )}
          <OverviewChart type="paymentMode" data={paymentModeData} height={350} />
        </div>

        {/* 3. Hourly Trend Analysis */}
        <div className="bg-card border border-border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Hourly Trend Analysis</h3>
          <OverviewChart type="hourly" data={hourlyData} height={350} />
        </div>

        {/* 4. Top PG Performance */}
        <div className="bg-card border border-border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Top PG Performance</h3>
          <OverviewChart type="pg" data={pgData} height={350} />
        </div>
      </div>

      {/* 5. Top Failure Reasons - Full Width */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Top Failure Reasons</h3>
        <OverviewChart type="failureReasons" data={failureReasonsData} height={400} />
      </div>

      {/* Additional Visualizations - Second Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 6. Day of Week Analysis */}
        <div className="bg-card border border-border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Day of Week Analysis</h3>
          <OverviewChart type="dayOfWeek" data={dayOfWeekData} height={350} />
        </div>

        {/* 7. Transaction Amount Distribution */}
        <div className="bg-card border border-border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Transaction Amount Distribution</h3>
          <OverviewChart type="amountDistribution" data={amountDistributionData} height={350} />
        </div>

        {/* 8. SR Trend Over Time */}
        <div className="bg-card border border-border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">SR Trend Over Time</h3>
          <OverviewChart type="srTrend" data={srTrendData} height={350} />
        </div>

        {/* 9. Top Banks Performance */}
        <div className="bg-card border border-border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Top Banks Performance</h3>
          <OverviewChart type="banks" data={banksData} height={350} />
        </div>
      </div>

      {/* 10. Volume vs SR Correlation - Full Width */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Volume vs SR Correlation (by Payment Mode)</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Bubble size represents volume. Color indicates SR performance (Green: ≥95%, Orange: 90-95%, Red: &lt;90%)
        </p>
        <OverviewChart type="scatter" data={scatterData} height={400} />
      </div>
    </div>
  );
}


