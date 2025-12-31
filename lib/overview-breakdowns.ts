import { DailyTrend, Transaction } from '@/types';
import { calculateSR } from '@/lib/utils';
import { getFailureLabel } from '@/lib/failure-utils';

export interface OverviewBarData {
  name: string;
  volume: number;
  sr?: number;
}

export interface OverviewLineData {
  name: string;
  volume: number;
  sr: number;
}

export interface OverviewScatterData {
  name: string;
  volume: number;
  sr: number;
}

export interface OverviewAmountDistributionData {
  name: string;
  volume: number;
  gmv: number;
  sr: number;
}

export interface OverviewBreakdowns {
  paymentModeData: OverviewBarData[];
  hourlyData: OverviewLineData[];
  pgData: OverviewBarData[];
  failureReasonsData: OverviewBarData[];
  dayOfWeekData: OverviewBarData[];
  amountDistributionData: OverviewAmountDistributionData[];
  banksData: OverviewBarData[];
  scatterData: OverviewScatterData[];
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function toSortedBarData(
  map: Map<string, { total: number; success: number }>
): OverviewBarData[] {
  const rows = Array.from(map.entries()).map(([name, v]) => ({
    name,
    volume: v.total,
    sr: calculateSR(v.success, v.total),
  }));
  rows.sort((a, b) => b.volume - a.volume);
  return rows;
}

function emptyBreakdowns(): OverviewBreakdowns {
  return {
    paymentModeData: [],
    hourlyData: Array.from({ length: 24 }, (_, hour) => ({
      name: `${hour.toString().padStart(2, '0')}:00`,
      volume: 0,
      sr: 0,
    })),
    pgData: [],
    failureReasonsData: [],
    dayOfWeekData: DAY_NAMES.map((d) => ({ name: d, volume: 0, sr: 0 })),
    amountDistributionData: [],
    banksData: [],
    scatterData: [],
  };
}

export function computeOverviewBreakdowns(
  transactions: Transaction[],
  dailyTrends: DailyTrend[]
): OverviewBreakdowns {
  if (!transactions || transactions.length === 0) {
    // We still compute day-of-week from dailyTrends if available
    const base = emptyBreakdowns();
    if (dailyTrends && dailyTrends.length > 0) {
      base.dayOfWeekData = computeDayOfWeekFromDailyTrends(dailyTrends);
    }
    return base;
  }

  const paymentModeMap = new Map<string, { total: number; success: number }>();
  const pgMap = new Map<string, { total: number; success: number }>();
  const bankMap = new Map<string, { total: number; success: number }>();
  const failureMap = new Map<string, number>();
  const hourly = Array.from({ length: 24 }, () => ({ total: 0, success: 0 }));

  // Amount buckets (transaction amount)
  const amountBuckets = [
    { name: '₹0–100', min: 0, max: 100 },
    { name: '₹100–500', min: 100, max: 500 },
    { name: '₹500–1K', min: 500, max: 1000 },
    { name: '₹1K–5K', min: 1000, max: 5000 },
    { name: '₹5K–10K', min: 5000, max: 10000 },
    { name: '₹10K+', min: 10000, max: Infinity },
  ];
  const amountAgg = new Map<string, { total: number; success: number; gmv: number }>();
  amountBuckets.forEach((b) => amountAgg.set(b.name, { total: 0, success: 0, gmv: 0 }));

  for (const tx of transactions) {
    const pm = String(tx.paymentmode || 'Unknown').trim() || 'Unknown';
    const pg = String(tx.pg || 'Unknown').trim() || 'Unknown';
    const bank = String(tx.bankname || 'Unknown').trim() || 'Unknown';

    const pmAgg = paymentModeMap.get(pm) || { total: 0, success: 0 };
    pmAgg.total += 1;
    if (tx.isSuccess) pmAgg.success += 1;
    paymentModeMap.set(pm, pmAgg);

    const pgAgg = pgMap.get(pg) || { total: 0, success: 0 };
    pgAgg.total += 1;
    if (tx.isSuccess) pgAgg.success += 1;
    pgMap.set(pg, pgAgg);

    const bankAgg = bankMap.get(bank) || { total: 0, success: 0 };
    bankAgg.total += 1;
    if (tx.isSuccess) bankAgg.success += 1;
    bankMap.set(bank, bankAgg);

    const hour = tx.txtime instanceof Date ? tx.txtime.getHours() : new Date(tx.txtime).getHours();
    hourly[hour].total += 1;
    if (tx.isSuccess) hourly[hour].success += 1;

    if (tx.isFailed) {
      const label = getFailureLabel(tx) || tx.txmsg || 'Unknown';
      failureMap.set(label, (failureMap.get(label) || 0) + 1);
    }

    const amt = typeof tx.txamount === 'number' ? tx.txamount : 0;
    for (const bucket of amountBuckets) {
      if (amt >= bucket.min && amt < bucket.max) {
        const a = amountAgg.get(bucket.name)!;
        a.total += 1;
        if (tx.isSuccess) a.success += 1;
        a.gmv += amt;
        break;
      }
    }
  }

  const paymentModeData = toSortedBarData(paymentModeMap);
  const pgData = toSortedBarData(pgMap);
  const banksData = toSortedBarData(bankMap).slice(0, 30);

  const hourlyData: OverviewLineData[] = hourly.map((h, hour) => ({
    name: `${hour.toString().padStart(2, '0')}:00`,
    volume: h.total,
    sr: calculateSR(h.success, h.total),
  }));

  const failureReasonsData: OverviewBarData[] = Array.from(failureMap.entries())
    .map(([name, count]) => ({ name, volume: count }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 50);

  const amountDistributionData: OverviewAmountDistributionData[] = amountBuckets
    .map((b) => {
      const a = amountAgg.get(b.name)!;
      return {
        name: b.name,
        volume: a.total,
        gmv: a.gmv,
        sr: calculateSR(a.success, a.total),
      };
    })
    .filter((d) => d.volume > 0);

  const scatterData: OverviewScatterData[] = paymentModeData.map((d) => ({
    name: d.name,
    volume: d.volume,
    sr: d.sr || 0,
  }));

  const dayOfWeekData =
    dailyTrends && dailyTrends.length > 0
      ? computeDayOfWeekFromDailyTrends(dailyTrends)
      : computeDayOfWeekFromTransactions(transactions);

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
}

function computeDayOfWeekFromDailyTrends(dailyTrends: DailyTrend[]): OverviewBarData[] {
  const agg = Array.from({ length: 7 }, () => ({ total: 0, success: 0 }));
  for (const d of dailyTrends) {
    const day = new Date(d.date).getDay(); // 0=Sun
    agg[day].total += d.volume;
    agg[day].success += d.successCount;
  }
  return DAY_NAMES.map((name, idx) => ({
    name,
    volume: agg[idx].total,
    sr: calculateSR(agg[idx].success, agg[idx].total),
  }));
}

function computeDayOfWeekFromTransactions(transactions: Transaction[]): OverviewBarData[] {
  const agg = Array.from({ length: 7 }, () => ({ total: 0, success: 0 }));
  for (const tx of transactions) {
    const day = tx.txtime instanceof Date ? tx.txtime.getDay() : new Date(tx.txtime).getDay();
    agg[day].total += 1;
    if (tx.isSuccess) agg[day].success += 1;
  }
  return DAY_NAMES.map((name, idx) => ({
    name,
    volume: agg[idx].total,
    sr: calculateSR(agg[idx].success, agg[idx].total),
  }));
}


