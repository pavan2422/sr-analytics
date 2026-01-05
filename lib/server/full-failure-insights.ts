import { format, subDays, differenceInDays, startOfDay } from 'date-fns';
import type { FailureInsight, SpikeType, TrendDirection } from '@/types';

type TimeWindow = {
  startDate: Date;
  endDate: Date;
  label: string;
};

type Windows = {
  current: TimeWindow;
  previous: TimeWindow;
  windowType: 'daily' | 'weekly' | 'monthly';
};

type TimeSeriesPoint = { date: string; count: number };

type FailureGroupAgg = {
  paymentMode: string;
  cfErrorDescription: string;
  totalVolume: number;
  currentVolume: number;
  previousVolume: number;
  // yyyy-MM-dd -> count
  dailyCounts: Map<string, number>;
};

function computeTimeWindows(startDate: Date, endDate: Date): Windows {
  const totalDays = differenceInDays(endDate, startDate) + 1;

  let windowType: 'daily' | 'weekly' | 'monthly';
  let windowDays: number;

  if (totalDays <= 7) {
    windowType = 'daily';
    windowDays = Math.max(1, Math.floor(totalDays / 2));
  } else if (totalDays <= 30) {
    windowType = 'weekly';
    windowDays = 7;
  } else {
    windowType = 'monthly';
    windowDays = 30;
  }

  const currentEnd = endDate;
  const currentStart = subDays(currentEnd, windowDays - 1);
  const previousEnd = subDays(currentStart, 1);
  const previousStart = subDays(previousEnd, windowDays - 1);

  return {
    current: {
      startDate: currentStart,
      endDate: currentEnd,
      label: `${format(currentStart, 'MMM d')} - ${format(currentEnd, 'MMM d')}`,
    },
    previous: {
      startDate: previousStart,
      endDate: previousEnd,
      label: `${format(previousStart, 'MMM d')} - ${format(previousEnd, 'MMM d')}`,
    },
    windowType,
  };
}

function determineTrendDirection(currentVolume: number, previousVolume: number): TrendDirection {
  if (previousVolume === 0) {
    return currentVolume > 0 ? 'INCREASING' : 'STABLE';
  }
  const changePercent = ((currentVolume - previousVolume) / previousVolume) * 100;
  if (changePercent > 10) return 'INCREASING';
  if (changePercent < -10) return 'DECREASING';
  return 'STABLE';
}

function createDailyTimeSeries(dailyCounts: Map<string, number>): TimeSeriesPoint[] {
  return Array.from(dailyCounts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function isRecurring(timeSeries: TimeSeriesPoint[]): boolean {
  if (timeSeries.length < 7) return false;
  const counts = timeSeries.map((p) => p.count);
  const mean = counts.reduce((sum, c) => sum + c, 0) / counts.length;
  const peaks = counts.filter((c) => c > mean * 1.5);
  return peaks.length >= 3;
}

function isPersistent(timeSeries: TimeSeriesPoint[], mean: number): boolean {
  if (timeSeries.length < 5) return false;
  const recentCounts = timeSeries.slice(-5).map((p) => p.count);
  const recentAvg = recentCounts.reduce((sum, c) => sum + c, 0) / recentCounts.length;
  return recentAvg > mean * 1.2 && recentCounts.filter((c) => c > mean).length >= 4;
}

function findIncreasePeriod(
  timeSeries: TimeSeriesPoint[],
  spikeIndex: number,
  baseline: number
): { start: string; end: string } {
  if (spikeIndex < 0 || spikeIndex >= timeSeries.length) {
    return { start: timeSeries[0]?.date || '', end: timeSeries[0]?.date || '' };
  }

  let startIndex = spikeIndex;
  let endIndex = spikeIndex;

  for (let i = spikeIndex - 1; i >= 0; i--) {
    const prevCount = timeSeries[i].count;
    const currCount = timeSeries[i + 1].count;
    if (prevCount < baseline * 0.5 || prevCount < currCount * 0.5) break;
    if (prevCount > baseline) startIndex = i;
    else break;
  }

  for (let i = spikeIndex + 1; i < timeSeries.length; i++) {
    const prevCount = timeSeries[i - 1].count;
    const currCount = timeSeries[i].count;
    if (currCount < baseline * 0.5 || currCount < prevCount * 0.5) break;
    if (currCount > baseline) endIndex = i;
    else break;
  }

  return {
    start: timeSeries[startIndex].date,
    end: timeSeries[endIndex].date,
  };
}

function findActualSpikePeriod(timeSeries: TimeSeriesPoint[], mean: number, stdDev: number): string | null {
  if (timeSeries.length === 0) return null;

  const sortedCounts = timeSeries.map((p) => p.count).sort((a, b) => a - b);
  const median = sortedCounts[Math.floor(sortedCounts.length / 2)];
  const baseline = Math.max(median, mean);
  const spikeThreshold = baseline + 1.5 * stdDev;

  const spikeDays: { date: string; count: number }[] = [];
  for (const point of timeSeries) {
    if (point.count > spikeThreshold) spikeDays.push({ date: point.date, count: point.count });
  }

  if (spikeDays.length === 0) {
    const maxPoint = timeSeries.reduce((max, p) => (p.count > max.count ? p : max), timeSeries[0]);
    const maxIndex = timeSeries.findIndex((p) => p.date === maxPoint.date);
    const spikePeriod = findIncreasePeriod(timeSeries, maxIndex, baseline);
    if (spikePeriod.start === spikePeriod.end) return format(new Date(spikePeriod.start), 'MMM d, yyyy');
    return `${format(new Date(spikePeriod.start), 'MMM d, yyyy')} - ${format(new Date(spikePeriod.end), 'MMM d, yyyy')}`;
  }

  if (spikeDays.length === 1) {
    const spikeDate = spikeDays[0].date;
    const spikeIndex = timeSeries.findIndex((p) => p.date === spikeDate);
    if (spikeIndex >= 0) {
      const spikePeriod = findIncreasePeriod(timeSeries, spikeIndex, baseline);
      if (spikePeriod.start === spikePeriod.end) return format(new Date(spikePeriod.start), 'MMM d, yyyy');
      return `${format(new Date(spikePeriod.start), 'MMM d, yyyy')} - ${format(new Date(spikePeriod.end), 'MMM d, yyyy')}`;
    }
    return format(new Date(spikeDate), 'MMM d, yyyy');
  }

  spikeDays.sort((a, b) => a.date.localeCompare(b.date));
  const periods: { start: string; end: string; count: number }[] = [];
  let current: { start: string; end: string; count: number } | null = null;

  for (const day of spikeDays) {
    if (!current) {
      current = { start: day.date, end: day.date, count: day.count };
      continue;
    }
    const prevDate = new Date(current.end);
    const currDate = new Date(day.date);
    const daysDiff = differenceInDays(currDate, prevDate);
    if (daysDiff <= 3) {
      current.end = day.date;
      current.count = Math.max(current.count, day.count);
    } else {
      periods.push(current);
      current = { start: day.date, end: day.date, count: day.count };
    }
  }
  if (current) periods.push(current);
  if (periods.length === 0) return null;

  const best = periods.reduce((bestPeriod, p) => {
    if (p.count > bestPeriod.count) return p;
    if (p.count === bestPeriod.count) {
      const bestDays = differenceInDays(new Date(bestPeriod.end), new Date(bestPeriod.start));
      const pDays = differenceInDays(new Date(p.end), new Date(p.start));
      return pDays > bestDays ? p : bestPeriod;
    }
    return bestPeriod;
  }, periods[0]);

  const startText = format(new Date(best.start), 'MMM d, yyyy');
  const endText = format(new Date(best.end), 'MMM d, yyyy');
  if (best.start === best.end) return startText;
  return `${startText} - ${endText}`;
}

function detectSpike(
  group: FailureGroupAgg,
  windows: Windows
): { isAnomaly: boolean; spikeType: SpikeType | null; spikePeriod: string | null } {
  const timeSeries = createDailyTimeSeries(group.dailyCounts);
  if (timeSeries.length === 0) return { isAnomaly: false, spikeType: null, spikePeriod: null };

  const counts = timeSeries.map((p) => p.count);
  const mean = counts.reduce((sum, c) => sum + c, 0) / counts.length;
  const stdDev = Math.sqrt(counts.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / counts.length);

  const isAnomaly = group.currentVolume > mean + 2 * stdDev;
  const spikePeriod = findActualSpikePeriod(timeSeries, mean, stdDev);

  let spikeType: SpikeType | null = null;
  if (group.previousVolume === 0 && group.currentVolume > 0) {
    spikeType = group.currentVolume >= 10 ? 'SUDDEN' : 'GRADUAL';
  } else if (group.previousVolume > 0) {
    const absoluteIncrease = group.currentVolume - group.previousVolume;
    if (absoluteIncrease >= group.previousVolume * 2) spikeType = 'SUDDEN';
    else if (absoluteIncrease >= group.previousVolume * 0.5) spikeType = 'GRADUAL';
    else if (isRecurring(timeSeries)) spikeType = 'RECURRING';
    else if (isPersistent(timeSeries, mean)) spikeType = 'PERSISTENT';
  }

  return { isAnomaly, spikeType, spikePeriod: spikePeriod || windows.current.label };
}

function calculateImpactScore(failureShare: number, absoluteChange: number, isAnomaly: boolean, currentVolume: number): number {
  let score = 0;
  score += Math.min(failureShare * 5, 50);
  score += Math.min((absoluteChange / 100) * 30, 30);
  if (isAnomaly) score += 20;
  score += Math.min(Math.log10(currentVolume + 1) * 5, 20);
  return Number(score.toFixed(2));
}

function generateInsightSummary(
  paymentMode: string,
  cfErrorDescription: string,
  currentVolume: number,
  previousVolume: number,
  volumeDelta: number,
  trendDirection: TrendDirection,
  spikeType: SpikeType | null,
  failureShare: number
): string {
  const parts: string[] = [];
  parts.push(`"${cfErrorDescription}" failures`);

  if (spikeType === 'SUDDEN') {
    if (previousVolume === 0) parts.push(`suddenly appeared with ${currentVolume} failures`);
    else parts.push(`suddenly increased by ${volumeDelta} failures`);
  } else if (spikeType === 'GRADUAL') {
    if (previousVolume === 0) parts.push(`gradually increased to ${currentVolume} failures`);
    else parts.push(`gradually increased by ${volumeDelta} failures`);
  } else if (spikeType === 'RECURRING') {
    parts.push('show a recurring pattern');
  } else if (spikeType === 'PERSISTENT') {
    parts.push('remain persistently high');
  } else if (previousVolume === 0 && currentVolume > 0) {
    parts.push(`appeared with ${currentVolume} failures`);
  }

  if (trendDirection === 'INCREASING') parts.push('and are increasing');
  else if (trendDirection === 'DECREASING') parts.push('and are decreasing');

  parts.push(`(${failureShare.toFixed(1)}% of total failures)`);
  parts.push(`in ${paymentMode}`);
  return parts.join(' ');
}

function generateRecommendation(
  paymentMode: string,
  cfErrorDescription: string,
  spikeType: SpikeType | null,
  trendDirection: TrendDirection,
  failureShare: number,
  volumeDelta: number
): string {
  // Keep this intentionally pragmatic and short; detailed taxonomy can be added later.
  if (failureShare >= 10) {
    return `High-impact issue: prioritize investigating "${cfErrorDescription}" for ${paymentMode} (Δ ${volumeDelta} failures).`;
  }
  if (spikeType === 'SUDDEN') {
    return `Sudden spike: check recent changes affecting ${paymentMode} around "${cfErrorDescription}".`;
  }
  if (trendDirection === 'INCREASING') {
    return `Monitor and drill down by PG/bank for ${paymentMode} to identify where "${cfErrorDescription}" is rising.`;
  }
  return `Review "${cfErrorDescription}" for ${paymentMode} and validate if it is expected behavior or a new regression.`;
}

export function computeFailureInsightsFromAggregates(groups: FailureGroupAgg[], totalFailures: number, windows: Windows): FailureInsight[] {
  const insights: FailureInsight[] = [];

  for (const g of groups) {
    if (g.totalVolume < 5) continue;
    if (g.currentVolume === 0) continue;

    const failureShare = totalFailures > 0 ? (g.currentVolume / totalFailures) * 100 : 0;
    const volumeDelta = g.currentVolume - g.previousVolume;
    const trendDirection = determineTrendDirection(g.currentVolume, g.previousVolume);
    const { isAnomaly, spikeType, spikePeriod } = detectSpike(g, windows);

    const impactScore = calculateImpactScore(failureShare, Math.abs(volumeDelta), isAnomaly, g.currentVolume);
    const insightSummary = generateInsightSummary(
      g.paymentMode,
      g.cfErrorDescription,
      g.currentVolume,
      g.previousVolume,
      volumeDelta,
      trendDirection,
      spikeType,
      failureShare
    );
    const actionableRecommendation = generateRecommendation(
      g.paymentMode,
      g.cfErrorDescription,
      spikeType,
      trendDirection,
      failureShare,
      volumeDelta
    );

    insights.push({
      paymentMode: g.paymentMode,
      cfErrorDescription: g.cfErrorDescription,
      failureShare: Number(failureShare.toFixed(2)),
      primarySpikePeriod: spikePeriod || windows.current.label,
      trendDirection,
      volumeDelta,
      insightSummary,
      actionableRecommendation,
      currentVolume: g.currentVolume,
      previousVolume: g.previousVolume,
      isAnomaly,
      spikeType,
      impactScore,
    });
  }

  insights.sort((a, b) => b.impactScore - a.impactScore);
  return insights;
}

export function computeInsightWindowsFromFailedRange(minMs: number, maxMs: number): Windows {
  return computeTimeWindows(new Date(minMs), new Date(maxMs));
}

export function dateKeyForTime(d: Date): string {
  return format(startOfDay(d), 'yyyy-MM-dd');
}



