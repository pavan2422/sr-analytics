'use client';

import { useMemo, useDeferredValue } from 'react';
import { useStore } from '@/store/useStore';
import { KPICard } from '@/components/KPICard';
import { Chart } from '@/components/Chart';
import { OverviewChart } from '@/components/OverviewChart';
import { formatNumber, formatCurrency, calculateSR } from '@/lib/utils';
import { Transaction } from '@/types';

export function OverviewTab() {
  // Use selectors to only subscribe to needed state slices
  const globalMetrics = useStore((state) => state.globalMetrics);
  const dailyTrends = useStore((state) => state.dailyTrends);
  const filteredTransactions = useStore((state) => state.filteredTransactions);
  
  // Defer heavy computation to prevent blocking
  const deferredTransactions = useDeferredValue(filteredTransactions);

  // OPTIMIZED: Single pass computation for all metrics
  // This replaces 9 separate useMemo hooks that each iterated through all transactions
  const allMetrics = useMemo(() => {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    if (!deferredTransactions || deferredTransactions.length === 0) {
      return {
        statusDistribution: [],
        paymentModeData: [],
        hourlyData: Array.from({ length: 24 }, (_, hour) => ({
          name: `${hour.toString().padStart(2, '0')}:00`,
          volume: 0,
          sr: 0,
        })),
        pgData: [],
        failureReasonsData: [],
        dayOfWeekData: dayNames.map((day: string) => ({ name: day, volume: 0, sr: 0 })),
        amountDistributionData: [],
        banksData: [],
        scatterData: [],
      };
    }

    try {
      // Initialize all data structures
      const modeMap = new Map<string, { success: number; total: number }>();
      const hourMap = new Map<number, { success: number; total: number }>();
      const pgMap = new Map<string, { success: number; total: number }>();
      const failureMap = new Map<string, number>();
      const dayMap = new Map<string, { success: number; total: number }>();
      const bankMap = new Map<string, { success: number; total: number }>();
      
      const ranges = [
        { name: '0-5000', min: 0, max: 5000 },
        { name: '5000-10000', min: 5000, max: 10000 },
        { name: '10000-25000', min: 10000, max: 25000 },
        { name: '25000-100000', min: 25000, max: 100000 },
        { name: '100000-200000', min: 100000, max: 200000 },
      ];
      const rangeMap = new Map<string, { success: number; total: number; gmv: number }>();

      // SINGLE PASS through all transactions
      for (const tx of deferredTransactions) {
        // Parse date once and reuse
        let txDate: Date | null = null;
        let hour = 0;
        let dayName = 'Unknown';
        
        if (tx.txtime instanceof Date) {
          txDate = tx.txtime;
          hour = txDate.getHours();
          dayName = dayNames[txDate.getDay()];
        } else if (tx.txtime) {
          txDate = new Date(tx.txtime);
          if (!isNaN(txDate.getTime())) {
            hour = txDate.getHours();
            dayName = dayNames[txDate.getDay()];
          }
        }

        // 1. Payment Mode Performance
        const mode = tx.paymentmode || 'Unknown';
        if (!modeMap.has(mode)) {
          modeMap.set(mode, { success: 0, total: 0 });
        }
        const modeStats = modeMap.get(mode)!;
        modeStats.total++;
        if (tx.isSuccess) modeStats.success++;

        // 2. Hourly Trend Analysis
        if (!hourMap.has(hour)) {
          hourMap.set(hour, { success: 0, total: 0 });
        }
        const hourStats = hourMap.get(hour)!;
        hourStats.total++;
        if (tx.isSuccess) hourStats.success++;

        // 3. Top PG Performance
        const pg = tx.pg || 'Unknown';
        if (pg !== 'N/A' && pg !== 'NA' && pg !== '') {
          if (!pgMap.has(pg)) {
            pgMap.set(pg, { success: 0, total: 0 });
          }
          const pgStats = pgMap.get(pg)!;
          pgStats.total++;
          if (tx.isSuccess) pgStats.success++;
        }

        // 4. Top Failure Reasons
        if (tx.isFailed) {
          const reason = tx.txmsg || 'Unknown';
          failureMap.set(reason, (failureMap.get(reason) || 0) + 1);
        }

        // 5. Day of Week Analysis
        if (!dayMap.has(dayName)) {
          dayMap.set(dayName, { success: 0, total: 0 });
        }
        const dayStats = dayMap.get(dayName)!;
        dayStats.total++;
        if (tx.isSuccess) dayStats.success++;

        // 6. Transaction Amount Distribution
        const amount = tx.txamount || 0;
        const range = ranges.find(r => amount >= r.min && amount < r.max);
        const rangeName = range ? range.name : '200000+';
        if (!rangeMap.has(rangeName)) {
          rangeMap.set(rangeName, { success: 0, total: 0, gmv: 0 });
        }
        const rangeStats = rangeMap.get(rangeName)!;
        rangeStats.total++;
        if (tx.isSuccess) {
          rangeStats.success++;
          rangeStats.gmv += amount;
        }

        // 7. Top Banks Performance
        const bank = tx.bankname || 'Unknown';
        if (bank !== 'N/A' && bank !== 'NA' && bank !== '') {
          if (!bankMap.has(bank)) {
            bankMap.set(bank, { success: 0, total: 0 });
          }
          const bankStats = bankMap.get(bank)!;
          bankStats.total++;
          if (tx.isSuccess) bankStats.success++;
        }
      }

      // Build results from maps
      const paymentModeData = Array.from(modeMap.entries())
        .map(([name, stats]) => ({
          name,
          volume: stats.total,
          sr: calculateSR(stats.success, stats.total),
        }))
        .sort((a, b) => b.volume - a.volume);

      const hourlyData = Array.from({ length: 24 }, (_, hour) => {
        const stats = hourMap.get(hour) || { success: 0, total: 0 };
        return {
          name: `${hour.toString().padStart(2, '0')}:00`,
          volume: stats.total,
          sr: calculateSR(stats.success, stats.total),
        };
      });

      const pgData = Array.from(pgMap.entries())
        .map(([name, stats]) => ({
          name,
          volume: stats.total,
          sr: calculateSR(stats.success, stats.total),
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 10);

      const failureReasonsData = Array.from(failureMap.entries())
        .map(([name, count]) => ({
          name,
          volume: count,
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 10);

      const dayOfWeekData = dayNames.map((day) => {
        const stats = dayMap.get(day) || { success: 0, total: 0 };
        return {
          name: day,
          volume: stats.total,
          sr: calculateSR(stats.success, stats.total),
        };
      });

      const allRanges = [...ranges];
      if (rangeMap.has('200000+')) {
        allRanges.push({ name: '200000+', min: 200000, max: Infinity });
      }
      const amountDistributionData = allRanges.map((range) => {
        const stats = rangeMap.get(range.name) || { success: 0, total: 0, gmv: 0 };
        return {
          name: `₹${range.name}`,
          volume: stats.total,
          gmv: stats.gmv,
          sr: calculateSR(stats.success, stats.total),
        };
      });

      const banksData = Array.from(bankMap.entries())
        .map(([name, stats]) => ({
          name,
          volume: stats.total,
          sr: calculateSR(stats.success, stats.total),
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 10);

      const scatterData = paymentModeData.map((d) => ({
        name: d.name,
        volume: d.volume,
        sr: d.sr || 0,
      }));

      return {
        paymentModeData,
        hourlyData,
        pgData,
        failureReasonsData,
        dayOfWeekData,
        amountDistributionData,
        banksData,
        scatterData,
      };
    } catch (error) {
      console.error('Error computing metrics:', error);
      // Return empty data on error to prevent crash
      return {
        statusDistribution: [],
        paymentModeData: [],
        hourlyData: Array.from({ length: 24 }, (_, hour) => ({
          name: `${hour.toString().padStart(2, '0')}:00`,
          volume: 0,
          sr: 0,
        })),
        pgData: [],
        failureReasonsData: [],
        dayOfWeekData: dayNames.map((day: string) => ({ name: day, volume: 0, sr: 0 })),
        amountDistributionData: [],
        banksData: [],
        scatterData: [],
      };
    }
  }, [deferredTransactions]);

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
  } = allMetrics;

  // Show loading state if data is being computed
  if (!globalMetrics && filteredTransactions.length > 0) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        <p className="text-muted-foreground ml-4">Computing metrics...</p>
      </div>
    );
  }
  
  if (!globalMetrics) {
    return (
      <div className="flex items-center justify-center p-12">
        <p className="text-muted-foreground">No data available. Please upload a file.</p>
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


