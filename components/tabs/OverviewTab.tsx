'use client';

import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { KPICard } from '@/components/KPICard';
import { Chart } from '@/components/Chart';
import { OverviewChart } from '@/components/OverviewChart';
import { formatNumber, formatCurrency, calculateSR } from '@/lib/utils';
import { Transaction } from '@/types';

export function OverviewTab() {
  const { globalMetrics, dailyTrends, getFilteredTransactions } = useStore();
  const filteredTransactions = getFilteredTransactions();

  // 1. Transaction Status Distribution (Donut Chart)
  const statusDistribution = useMemo(() => {
    if (!globalMetrics) return [];
    return [
      { name: 'Success', value: globalMetrics.successCount },
      { name: 'Failed', value: globalMetrics.failedCount },
      { name: 'User Dropped', value: globalMetrics.userDroppedCount },
    ];
  }, [globalMetrics]);

  // 2. Payment Mode Performance
  const paymentModeData = useMemo(() => {
    const modeMap = new Map<string, { success: number; total: number }>();
    
    filteredTransactions.forEach((tx: Transaction) => {
      const mode = tx.paymentmode || 'Unknown';
      if (!modeMap.has(mode)) {
        modeMap.set(mode, { success: 0, total: 0 });
      }
      const stats = modeMap.get(mode)!;
      stats.total++;
      if (tx.isSuccess) stats.success++;
    });

    return Array.from(modeMap.entries())
      .map(([name, stats]) => ({
        name,
        volume: stats.total,
        sr: calculateSR(stats.success, stats.total),
      }))
      .sort((a, b) => b.volume - a.volume);
  }, [filteredTransactions]);

  // 3. Hourly Trend Analysis
  const hourlyData = useMemo(() => {
    const hourMap = new Map<number, { success: number; total: number }>();
    
    filteredTransactions.forEach((tx: Transaction) => {
      let hour = 0;
      if (tx.txtime instanceof Date) {
        hour = tx.txtime.getHours();
      } else if (tx.txtime) {
        // Fallback: try to parse if it's a string
        const date = new Date(tx.txtime);
        if (!isNaN(date.getTime())) {
          hour = date.getHours();
        }
      }
      
      if (!hourMap.has(hour)) {
        hourMap.set(hour, { success: 0, total: 0 });
      }
      const stats = hourMap.get(hour)!;
      stats.total++;
      if (tx.isSuccess) stats.success++;
    });

    return Array.from({ length: 24 }, (_, hour) => {
      const stats = hourMap.get(hour) || { success: 0, total: 0 };
      return {
        name: `${hour.toString().padStart(2, '0')}:00`,
        volume: stats.total,
        sr: calculateSR(stats.success, stats.total),
      };
    });
  }, [filteredTransactions]);

  // 4. Top PG Performance
  const pgData = useMemo(() => {
    const pgMap = new Map<string, { success: number; total: number }>();
    
    filteredTransactions.forEach((tx: Transaction) => {
      const pg = tx.pg || 'Unknown';
      if (pg === 'N/A' || pg === 'NA' || pg === '') return;
      
      if (!pgMap.has(pg)) {
        pgMap.set(pg, { success: 0, total: 0 });
      }
      const stats = pgMap.get(pg)!;
      stats.total++;
      if (tx.isSuccess) stats.success++;
    });

    return Array.from(pgMap.entries())
      .map(([name, stats]) => ({
        name,
        volume: stats.total,
        sr: calculateSR(stats.success, stats.total),
      }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10); // Top 10 PGs
  }, [filteredTransactions]);

  // 5. Top Failure Reasons
  const failureReasonsData = useMemo(() => {
    const failureMap = new Map<string, number>();
    
    filteredTransactions
      .filter((tx: Transaction) => tx.isFailed)
      .forEach((tx: Transaction) => {
        const reason = tx.txmsg || 'Unknown';
        failureMap.set(reason, (failureMap.get(reason) || 0) + 1);
      });

    return Array.from(failureMap.entries())
      .map(([name, count]) => ({
        name,
        volume: count,
      }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10); // Top 10 failure reasons
  }, [filteredTransactions]);

  // 6. Day of Week Analysis
  const dayOfWeekData = useMemo(() => {
    const dayMap = new Map<string, { success: number; total: number }>();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    filteredTransactions.forEach((tx: Transaction) => {
      let dayName = 'Unknown';
      if (tx.txtime instanceof Date) {
        dayName = dayNames[tx.txtime.getDay()];
      } else if (tx.txtime) {
        const date = new Date(tx.txtime);
        if (!isNaN(date.getTime())) {
          dayName = dayNames[date.getDay()];
        }
      }
      
      if (!dayMap.has(dayName)) {
        dayMap.set(dayName, { success: 0, total: 0 });
      }
      const stats = dayMap.get(dayName)!;
      stats.total++;
      if (tx.isSuccess) stats.success++;
    });

    return dayNames.map((day) => {
      const stats = dayMap.get(day) || { success: 0, total: 0 };
      return {
        name: day,
        volume: stats.total,
        sr: calculateSR(stats.success, stats.total),
      };
    });
  }, [filteredTransactions]);

  // 7. Transaction Amount Distribution
  const amountDistributionData = useMemo(() => {
    const ranges = [
      { name: '0-100', min: 0, max: 100 },
      { name: '100-500', min: 100, max: 500 },
      { name: '500-1000', min: 500, max: 1000 },
      { name: '1000-5000', min: 1000, max: 5000 },
      { name: '5000-10000', min: 5000, max: 10000 },
      { name: '10000+', min: 10000, max: Infinity },
    ];

    const rangeMap = new Map<string, { success: number; total: number; gmv: number }>();
    
    filteredTransactions.forEach((tx: Transaction) => {
      const amount = tx.txamount || 0;
      const range = ranges.find(r => amount >= r.min && amount < r.max) || ranges[ranges.length - 1];
      
      if (!rangeMap.has(range.name)) {
        rangeMap.set(range.name, { success: 0, total: 0, gmv: 0 });
      }
      const stats = rangeMap.get(range.name)!;
      stats.total++;
      if (tx.isSuccess) {
        stats.success++;
        stats.gmv += amount;
      }
    });

    return ranges.map((range) => {
      const stats = rangeMap.get(range.name) || { success: 0, total: 0, gmv: 0 };
      return {
        name: `₹${range.name}`,
        volume: stats.total,
        gmv: stats.gmv,
        sr: calculateSR(stats.success, stats.total),
      };
    });
  }, [filteredTransactions]);

  // 8. SR Trend Over Time (from daily trends)
  const srTrendData = useMemo(() => {
    return dailyTrends.map((trend) => ({
      name: new Date(trend.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      volume: trend.volume,
      sr: trend.sr,
    }));
  }, [dailyTrends]);

  // 9. Top Banks Performance
  const banksData = useMemo(() => {
    const bankMap = new Map<string, { success: number; total: number }>();
    
    filteredTransactions.forEach((tx: Transaction) => {
      const bank = tx.bankname || 'Unknown';
      if (bank === 'N/A' || bank === 'NA' || bank === '') return;
      
      if (!bankMap.has(bank)) {
        bankMap.set(bank, { success: 0, total: 0 });
      }
      const stats = bankMap.get(bank)!;
      stats.total++;
      if (tx.isSuccess) stats.success++;
    });

    return Array.from(bankMap.entries())
      .map(([name, stats]) => ({
        name,
        volume: stats.total,
        sr: calculateSR(stats.success, stats.total),
      }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10); // Top 10 banks
  }, [filteredTransactions]);

  // 10. Volume vs SR Correlation (by Payment Mode)
  const scatterData = useMemo(() => {
    return paymentModeData.map((d) => ({
      name: d.name,
      volume: d.volume,
      sr: d.sr || 0,
    }));
  }, [paymentModeData]);

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


