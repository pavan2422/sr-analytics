import { Transaction, FailureInsight, TrendDirection, SpikeType } from '@/types';
import { format, subDays, differenceInDays, startOfDay, endOfDay } from 'date-fns';

interface TimeWindow {
  startDate: Date;
  endDate: Date;
  label: string;
}

interface FailureGroup {
  paymentMode: string;
  cfErrorDescription: string;
  transactions: Transaction[];
  volume: number;
}

interface TimeSeriesPoint {
  date: string;
  count: number;
}

/**
 * Main function to generate automated insights from failed transactions
 * Now async with chunking for large datasets to prevent blocking
 */
export async function generateFailureInsights(
  transactions: Transaction[],
  chunkSize: number = 50000
): Promise<FailureInsight[]> {
  // Filter only failed transactions in chunks if dataset is large
  // For 5GB files, this could be millions of transactions - must chunk
  let failedTxs: Transaction[];
  
  if (transactions.length > 50000) {
    // For large datasets (including 5GB files), filter in chunks with yielding
    failedTxs = [];
    for (let i = 0; i < transactions.length; i += chunkSize) {
      const chunk = transactions.slice(i, i + chunkSize);
      failedTxs.push(...chunk.filter((tx) => tx.isFailed));
      
      // Yield to browser every chunk - critical for 5GB files
      if (i + chunkSize < transactions.length) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      
      // Log progress for very large datasets
      if (i % (chunkSize * 10) === 0 && transactions.length > 500000) {
        console.log(`Processing insights: ${((i / transactions.length) * 100).toFixed(1)}%`);
      }
    }
  } else {
    failedTxs = transactions.filter((tx) => tx.isFailed);
  }
  
  if (failedTxs.length === 0) {
    return [];
  }

  // Determine the time range
  const timeRange = getTimeRange(failedTxs);
  if (!timeRange) {
    return [];
  }

  // Group failures by payment mode and CF error description (with chunking for large datasets)
  const failureGroups = await groupFailuresAsync(failedTxs, chunkSize);

  // Compute time windows for comparison
  const windows = computeTimeWindows(timeRange.startDate, timeRange.endDate);

  // Generate insights for each group (yield periodically)
  const insights: FailureInsight[] = [];
  
  const processGroups = async () => {
    for (let i = 0; i < failureGroups.length; i++) {
      const group = failureGroups[i];
      const insight = analyzeFailureGroup(group, windows, failedTxs.length);
      if (insight) {
        insights.push(insight);
      }
      
      // Yield every 10 groups to keep UI responsive
      if (i % 10 === 0 && i > 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  };
  
  await processGroups();

  // Sort by impact score (descending)
  insights.sort((a, b) => b.impactScore - a.impactScore);

  return insights;
}

/**
 * Get the time range from transactions
 */
function getTimeRange(transactions: Transaction[]): { startDate: Date; endDate: Date } | null {
  if (transactions.length === 0) return null;

  let minTime = Infinity;
  let maxTime = -Infinity;

  for (const tx of transactions) {
    const time = tx.txtime.getTime();
    if (time < minTime) minTime = time;
    if (time > maxTime) maxTime = time;
  }

  return {
    startDate: new Date(minTime),
    endDate: new Date(maxTime),
  };
}

/**
 * Group failures by payment mode and CF error description
 */
function groupFailures(transactions: Transaction[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();

  for (const tx of transactions) {
    const paymentMode = tx.paymentmode || 'Unknown';
    const cfErrorDescription = tx.cf_errordescription || 'Unknown Error';
    const key = `${paymentMode}::${cfErrorDescription}`;

    if (!groups.has(key)) {
      groups.set(key, {
        paymentMode,
        cfErrorDescription,
        transactions: [],
        volume: 0,
      });
    }

    const group = groups.get(key)!;
    group.transactions.push(tx);
    group.volume++;
  }

  // Convert to array and filter out very small groups (< 5 transactions)
  return Array.from(groups.values()).filter((g) => g.volume >= 5);
}

/**
 * Group failures asynchronously with chunking for large datasets
 */
async function groupFailuresAsync(
  transactions: Transaction[],
  chunkSize: number = 50000
): Promise<FailureGroup[]> {
  const groups = new Map<string, FailureGroup>();

  // Process in chunks to prevent blocking
  for (let i = 0; i < transactions.length; i += chunkSize) {
    const chunk = transactions.slice(i, i + chunkSize);
    
    for (const tx of chunk) {
      const paymentMode = tx.paymentmode || 'Unknown';
      const cfErrorDescription = tx.cf_errordescription || 'Unknown Error';
      const key = `${paymentMode}::${cfErrorDescription}`;

      if (!groups.has(key)) {
        groups.set(key, {
          paymentMode,
          cfErrorDescription,
          transactions: [],
          volume: 0,
        });
      }

      const group = groups.get(key)!;
      group.transactions.push(tx);
      group.volume++;
    }
    
    // Yield to browser every chunk
    if (i + chunkSize < transactions.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  // Convert to array and filter out very small groups (< 5 transactions)
  return Array.from(groups.values()).filter((g) => g.volume >= 5);
}

/**
 * Compute time windows for comparison (current vs previous)
 */
function computeTimeWindows(startDate: Date, endDate: Date): {
  current: TimeWindow;
  previous: TimeWindow;
  windowType: 'daily' | 'weekly' | 'monthly';
} {
  const totalDays = differenceInDays(endDate, startDate) + 1;

  // Determine window type based on data density
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

  // Current window: last N days
  const currentEnd = endDate;
  const currentStart = subDays(currentEnd, windowDays - 1);

  // Previous window: same duration before current window
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

/**
 * Analyze a failure group and generate insight
 */
function analyzeFailureGroup(
  group: FailureGroup,
  windows: ReturnType<typeof computeTimeWindows>,
  totalFailures: number
): FailureInsight | null {
  // Split transactions into current and previous windows
  const currentTxs = group.transactions.filter(
    (tx) => tx.txtime >= windows.current.startDate && tx.txtime <= windows.current.endDate
  );

  const previousTxs = group.transactions.filter(
    (tx) => tx.txtime >= windows.previous.startDate && tx.txtime <= windows.previous.endDate
  );

  const currentVolume = currentTxs.length;
  const previousVolume = previousTxs.length;

  // Skip if no current volume
  if (currentVolume === 0) {
    return null;
  }

  // Calculate failure share (% of total failures in current period)
  const failureShare = (currentVolume / totalFailures) * 100;

  // Calculate volume delta as absolute count change (not percentage)
  const volumeDelta = currentVolume - previousVolume;

  // Determine trend direction
  const trendDirection = determineTrendDirection(group.transactions, windows);

  // Detect spike type and anomaly period
  const { isAnomaly, spikeType, spikePeriod } = detectSpike(
    group.transactions,
    windows,
    currentVolume,
    previousVolume
  );

  // Calculate impact score (used for ranking)
  // Use absolute count change, not percentage
  const absoluteChange = currentVolume - previousVolume;
  const impactScore = calculateImpactScore(
    failureShare,
    Math.abs(absoluteChange), // Use absolute count change
    isAnomaly,
    currentVolume
  );

  // Generate human-readable summary
  const insightSummary = generateInsightSummary(
    group.paymentMode,
    group.cfErrorDescription,
    currentVolume,
    previousVolume,
    volumeDelta, // Now absolute count change
    trendDirection,
    spikeType,
    failureShare
  );

  // Generate actionable recommendation
  const actionableRecommendation = generateRecommendation(
    group.paymentMode,
    group.cfErrorDescription,
    spikeType,
    trendDirection,
    failureShare,
    volumeDelta
  );

  return {
    paymentMode: group.paymentMode,
    cfErrorDescription: group.cfErrorDescription,
    failureShare: parseFloat(failureShare.toFixed(2)),
    primarySpikePeriod: spikePeriod || windows.current.label,
    trendDirection,
    volumeDelta: volumeDelta, // Absolute count change (integer)
    insightSummary,
    actionableRecommendation,
    currentVolume,
    previousVolume,
    isAnomaly,
    spikeType,
    impactScore,
  };
}

/**
 * Determine trend direction over time
 */
function determineTrendDirection(
  transactions: Transaction[],
  windows: ReturnType<typeof computeTimeWindows>
): TrendDirection {
  // Get transactions in both windows
  const currentTxs = transactions.filter(
    (tx) => tx.txtime >= windows.current.startDate && tx.txtime <= windows.current.endDate
  );

  const previousTxs = transactions.filter(
    (tx) => tx.txtime >= windows.previous.startDate && tx.txtime <= windows.previous.endDate
  );

  const currentVolume = currentTxs.length;
  const previousVolume = previousTxs.length;

  if (previousVolume === 0) {
    return currentVolume > 0 ? 'INCREASING' : 'STABLE';
  }

  const changePercent = ((currentVolume - previousVolume) / previousVolume) * 100;

  // Use a threshold of 10% to determine if it's a significant change
  if (changePercent > 10) return 'INCREASING';
  if (changePercent < -10) return 'DECREASING';
  return 'STABLE';
}

/**
 * Detect if there's a spike or anomaly
 * Returns the actual date range where the spike occurred
 */
function detectSpike(
  transactions: Transaction[],
  windows: ReturnType<typeof computeTimeWindows>,
  currentVolume: number,
  previousVolume: number
): { isAnomaly: boolean; spikeType: SpikeType | null; spikePeriod: string | null } {
  // Create daily time series for the entire data range
  const timeSeries = createDailyTimeSeries(transactions, windows);

  if (timeSeries.length === 0) {
    return { isAnomaly: false, spikeType: null, spikePeriod: null };
  }

  // Calculate statistics based on counts (not percentages)
  const counts = timeSeries.map((p) => p.count);
  const mean = counts.reduce((sum, c) => sum + c, 0) / counts.length;
  const stdDev = Math.sqrt(
    counts.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / counts.length
  );

  // Detect anomaly: current volume > mean + 2*stdDev (using absolute counts)
  const isAnomaly = currentVolume > mean + 2 * stdDev;

  // Find the actual spike period by analyzing daily counts
  const spikePeriod = findActualSpikePeriod(timeSeries, mean, stdDev);

  // Determine spike type based on absolute counts, not ratios
  let spikeType: SpikeType | null = null;

  if (previousVolume === 0 && currentVolume > 0) {
    // New error that didn't exist before
    spikeType = currentVolume >= 10 ? 'SUDDEN' : 'GRADUAL';
  } else if (previousVolume > 0) {
    // Use absolute count difference instead of ratio
    const absoluteIncrease = currentVolume - previousVolume;
    
    if (absoluteIncrease >= previousVolume * 2) {
      // Doubled or more = sudden spike
      spikeType = 'SUDDEN';
    } else if (absoluteIncrease >= previousVolume * 0.5) {
      // 50%+ increase = gradual spike
      spikeType = 'GRADUAL';
    } else if (isRecurring(timeSeries)) {
      spikeType = 'RECURRING';
    } else if (isPersistent(timeSeries, mean)) {
      spikeType = 'PERSISTENT';
    }
  }

  return { isAnomaly, spikeType, spikePeriod };
}

/**
 * Find the actual date range where failures increased abnormally
 * Uses absolute counts to identify spike periods
 * Returns the period where the increase was most significant
 */
function findActualSpikePeriod(
  timeSeries: TimeSeriesPoint[],
  mean: number,
  stdDev: number
): string | null {
  if (timeSeries.length === 0) return null;

  // Calculate baseline (median or mean, whichever is more stable)
  const sortedCounts = timeSeries.map(p => p.count).sort((a, b) => a - b);
  const median = sortedCounts[Math.floor(sortedCounts.length / 2)];
  const baseline = Math.max(median, mean);

  // Threshold: baseline + 1.5*stdDev (spike threshold)
  const spikeThreshold = baseline + 1.5 * stdDev;

  // Find days where count exceeds threshold
  const spikeDays: { date: string; count: number }[] = [];
  
  for (const point of timeSeries) {
    if (point.count > spikeThreshold) {
      spikeDays.push({ date: point.date, count: point.count });
    }
  }

  // If no clear spikes above threshold, find the period with highest increase
  if (spikeDays.length === 0) {
    // Find the day with highest count
    const maxPoint = timeSeries.reduce((max, p) => (p.count > max.count ? p : max), timeSeries[0]);
    
    // Check if this is part of a multi-day increase
    const maxIndex = timeSeries.findIndex(p => p.date === maxPoint.date);
    const spikePeriod = findIncreasePeriod(timeSeries, maxIndex, baseline);
    
    if (spikePeriod.start === spikePeriod.end) {
      return format(new Date(spikePeriod.start), 'MMM d, yyyy');
    }
    return `${format(new Date(spikePeriod.start), 'MMM d, yyyy')} - ${format(new Date(spikePeriod.end), 'MMM d, yyyy')}`;
  }

  if (spikeDays.length === 1) {
    // Single day spike - but check if surrounding days also had increases
    const spikeDate = spikeDays[0].date;
    const spikeIndex = timeSeries.findIndex(p => p.date === spikeDate);
    
    if (spikeIndex >= 0) {
      const spikePeriod = findIncreasePeriod(timeSeries, spikeIndex, baseline);
      
      if (spikePeriod.start === spikePeriod.end) {
        return format(new Date(spikePeriod.start), 'MMM d, yyyy');
      }
      return `${format(new Date(spikePeriod.start), 'MMM d, yyyy')} - ${format(new Date(spikePeriod.end), 'MMM d, yyyy')}`;
    }
    
    return format(new Date(spikeDays[0].date), 'MMM d, yyyy');
  }

  // Multiple spike days - find continuous periods
  spikeDays.sort((a, b) => a.date.localeCompare(b.date));

  // Group consecutive dates
  const periods: { start: string; end: string; count: number }[] = [];
  let currentPeriod: { start: string; end: string; count: number } | null = null;

  for (const day of spikeDays) {
    if (!currentPeriod) {
      currentPeriod = { start: day.date, end: day.date, count: day.count };
    } else {
      const prevDate = new Date(currentPeriod.end);
      const currDate = new Date(day.date);
      const daysDiff = differenceInDays(currDate, prevDate);

      if (daysDiff <= 3) {
        // Consecutive or within 3 days - extend period
        currentPeriod.end = day.date;
        currentPeriod.count = Math.max(currentPeriod.count, day.count);
      } else {
        // Gap detected - save current period and start new one
        periods.push(currentPeriod);
        currentPeriod = { start: day.date, end: day.date, count: day.count };
      }
    }
  }

  if (currentPeriod) {
    periods.push(currentPeriod);
  }

  if (periods.length === 0) {
    return null;
  }

  // Return the period with highest count, or longest period if tied
  const bestPeriod = periods.reduce((best, p) => {
    if (p.count > best.count) return p;
    if (p.count === best.count) {
      const bestDays = differenceInDays(new Date(best.end), new Date(best.start));
      const pDays = differenceInDays(new Date(p.end), new Date(p.start));
      return pDays > bestDays ? p : best;
    }
    return best;
  }, periods[0]);

  const startDate = format(new Date(bestPeriod.start), 'MMM d, yyyy');
  const endDate = format(new Date(bestPeriod.end), 'MMM d, yyyy');

  if (bestPeriod.start === bestPeriod.end) {
    return startDate;
  }

  return `${startDate} - ${endDate}`;
}

/**
 * Find the period where failures increased, starting from a spike day
 * Looks backward and forward to find the full increase period
 */
function findIncreasePeriod(
  timeSeries: TimeSeriesPoint[],
  spikeIndex: number,
  baseline: number
): { start: string; end: string } {
  if (spikeIndex < 0 || spikeIndex >= timeSeries.length) {
    return { start: timeSeries[0]?.date || '', end: timeSeries[0]?.date || '' };
  }

  const spikeDate = timeSeries[spikeIndex].date;
  let startIndex = spikeIndex;
  let endIndex = spikeIndex;

  // Look backward to find when the increase started
  for (let i = spikeIndex - 1; i >= 0; i--) {
    const prevCount = timeSeries[i].count;
    const currCount = timeSeries[i + 1].count;
    
    // If previous day is significantly lower, we found the start
    if (prevCount < baseline * 0.5 || prevCount < currCount * 0.5) {
      break;
    }
    
    // If count is still elevated, extend period backward
    if (prevCount > baseline) {
      startIndex = i;
    } else {
      break;
    }
  }

  // Look forward to find when the increase ended
  for (let i = spikeIndex + 1; i < timeSeries.length; i++) {
    const prevCount = timeSeries[i - 1].count;
    const currCount = timeSeries[i].count;
    
    // If current day is significantly lower, we found the end
    if (currCount < baseline * 0.5 || currCount < prevCount * 0.5) {
      break;
    }
    
    // If count is still elevated, extend period forward
    if (currCount > baseline) {
      endIndex = i;
    } else {
      break;
    }
  }

  return {
    start: timeSeries[startIndex].date,
    end: timeSeries[endIndex].date,
  };
}

/**
 * Create daily time series from transactions
 * Includes ALL transactions to find actual spike periods across entire dataset
 */
function createDailyTimeSeries(
  transactions: Transaction[],
  windows: ReturnType<typeof computeTimeWindows>
): TimeSeriesPoint[] {
  const dateMap = new Map<string, number>();

  // Include ALL transactions to find actual spike periods in the data
  // Don't limit to windows - we want to see the full picture
  for (const tx of transactions) {
    const dateKey = format(startOfDay(tx.txtime), 'yyyy-MM-dd');
    dateMap.set(dateKey, (dateMap.get(dateKey) || 0) + 1);
  }

  return Array.from(dateMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Check if pattern is recurring
 */
function isRecurring(timeSeries: TimeSeriesPoint[]): boolean {
  if (timeSeries.length < 7) return false;

  // Look for weekly pattern (peaks on similar days)
  const counts = timeSeries.map((p) => p.count);
  const mean = counts.reduce((sum, c) => sum + c, 0) / counts.length;

  // Check if there are multiple peaks
  const peaks = counts.filter((c) => c > mean * 1.5);
  return peaks.length >= 3;
}

/**
 * Detect recurring pattern period
 */
function detectRecurringPattern(timeSeries: TimeSeriesPoint[]): string {
  const counts = timeSeries.map((p) => p.count);
  const mean = counts.reduce((sum, c) => sum + c, 0) / counts.length;

  const peakIndices: number[] = [];
  counts.forEach((count, idx) => {
    if (count > mean * 1.5) {
      peakIndices.push(idx);
    }
  });

  if (peakIndices.length >= 2) {
    const intervals = [];
    for (let i = 1; i < peakIndices.length; i++) {
      intervals.push(peakIndices[i] - peakIndices[i - 1]);
    }
    const avgInterval = intervals.reduce((sum, i) => sum + i, 0) / intervals.length;

    if (avgInterval >= 6 && avgInterval <= 8) {
      return 'Weekly pattern detected';
    } else if (avgInterval >= 1 && avgInterval <= 3) {
      return 'Daily pattern detected';
    }
  }

  return 'Multiple spikes detected';
}

/**
 * Check if error is persistent (consistently high)
 */
function isPersistent(timeSeries: TimeSeriesPoint[], mean: number): boolean {
  if (timeSeries.length < 5) return false;

  const recentCounts = timeSeries.slice(-5).map((p) => p.count);
  const recentAvg = recentCounts.reduce((sum, c) => sum + c, 0) / recentCounts.length;

  // Persistent if recent average is consistently above overall mean
  return recentAvg > mean * 1.2 && recentCounts.filter((c) => c > mean).length >= 4;
}

/**
 * Calculate impact score for ranking
 * Uses absolute count changes, not percentages
 */
function calculateImpactScore(
  failureShare: number,
  absoluteChange: number, // Absolute count change
  isAnomaly: boolean,
  currentVolume: number
): number {
  let score = 0;

  // Failure share contribution (0-50 points)
  score += Math.min(failureShare * 5, 50);

  // Volume delta contribution (0-30 points)
  // Scale based on absolute count: 100+ failures = max points
  score += Math.min((absoluteChange / 100) * 30, 30);

  // Anomaly bonus (20 points)
  if (isAnomaly) {
    score += 20;
  }

  // Volume magnitude contribution (0-20 points)
  score += Math.min(Math.log10(currentVolume + 1) * 5, 20);

  return parseFloat(score.toFixed(2));
}

/**
 * Generate human-readable insight summary
 * volumeDelta is now absolute count change (not percentage)
 */
function generateInsightSummary(
  paymentMode: string,
  cfErrorDescription: string,
  currentVolume: number,
  previousVolume: number,
  volumeDelta: number, // Absolute count change
  trendDirection: TrendDirection,
  spikeType: SpikeType | null,
  failureShare: number
): string {
  const parts: string[] = [];

  // Start with the error type
  parts.push(`"${cfErrorDescription}" failures`);

  // Add spike information using absolute numbers
  if (spikeType === 'SUDDEN') {
    if (previousVolume === 0) {
      parts.push(`suddenly appeared with ${currentVolume} failures`);
    } else {
      parts.push(`suddenly increased by ${volumeDelta} failures`);
    }
  } else if (spikeType === 'GRADUAL') {
    if (previousVolume === 0) {
      parts.push(`gradually increased to ${currentVolume} failures`);
    } else {
      parts.push(`gradually increased by ${volumeDelta} failures`);
    }
  } else if (spikeType === 'RECURRING') {
    parts.push(`show a recurring pattern`);
  } else if (spikeType === 'PERSISTENT') {
    parts.push(`remain persistently high`);
  } else if (previousVolume === 0 && currentVolume > 0) {
    parts.push(`appeared with ${currentVolume} failures`);
  } else if (volumeDelta > 0) {
    parts.push(`increased by ${volumeDelta} failures`);
  } else if (volumeDelta < 0) {
    parts.push(`decreased by ${Math.abs(volumeDelta)} failures`);
  } else {
    parts.push(`remain stable`);
  }

  // Add current impact
  parts.push(`and now account for ${failureShare.toFixed(1)}% of all ${paymentMode} failures`);

  // Add volume context
  if (previousVolume === 0) {
    parts.push(`(${currentVolume} failures, previously 0)`);
  } else {
    parts.push(`(${currentVolume} failures vs ${previousVolume} previously)`);
  }

  return parts.join(' ');
}

/**
 * Generate actionable recommendation based on failure analysis
 */
function generateRecommendation(
  paymentMode: string,
  cfErrorDescription: string,
  spikeType: SpikeType | null,
  trendDirection: TrendDirection,
  failureShare: number,
  volumeDelta: number
): string {
  const errorLower = cfErrorDescription.toLowerCase();

  // Bank/Issuer related errors
  if (
    errorLower.includes('bank') ||
    errorLower.includes('issuer') ||
    errorLower.includes('declined') ||
    errorLower.includes('insufficient')
  ) {
    if (spikeType === 'SUDDEN' || volumeDelta > 50) {
      return `URGENT: Escalate to ${paymentMode} bank/issuer partner immediately. Check for service disruptions or policy changes.`;
    }
    return `Investigate with ${paymentMode} bank/issuer. Review recent changes in decline patterns and identify root cause.`;
  }

  // Network/Timeout errors
  if (
    errorLower.includes('timeout') ||
    errorLower.includes('network') ||
    errorLower.includes('connection')
  ) {
    if (failureShare > 10) {
      return `Critical routing issue: Review ${paymentMode} gateway health and network connectivity. Consider failover routing.`;
    }
    return `Monitor ${paymentMode} gateway performance metrics. Set up alerts for timeout rate thresholds.`;
  }

  // Authentication/OTP errors
  if (
    errorLower.includes('otp') ||
    errorLower.includes('authentication') ||
    errorLower.includes('3ds') ||
    errorLower.includes('verification')
  ) {
    return `Optimize ${paymentMode} authentication flow. Consider implementing retry logic with better UX guidance for users.`;
  }

  // Limit/Risk errors
  if (
    errorLower.includes('limit') ||
    errorLower.includes('risk') ||
    errorLower.includes('fraud') ||
    errorLower.includes('restricted')
  ) {
    return `Review ${paymentMode} risk rules and transaction limits. Coordinate with fraud/risk team to adjust policies if needed.`;
  }

  // Routing errors
  if (
    errorLower.includes('routing') ||
    errorLower.includes('gateway') ||
    errorLower.includes('unavailable')
  ) {
    return `Optimize ${paymentMode} payment routing logic. Consider adding backup gateways or adjusting routing rules.`;
  }

  // Technical/System errors
  if (
    errorLower.includes('error') ||
    errorLower.includes('failed') ||
    errorLower.includes('invalid') ||
    errorLower.includes('system')
  ) {
    if (spikeType === 'SUDDEN') {
      return `Deploy immediate hotfix for ${paymentMode}. Rollback recent changes if applicable and notify engineering team.`;
    }
    if (spikeType === 'RECURRING') {
      return `Investigate recurring ${paymentMode} system issue. Set up monitoring and implement automated retry/fallback mechanisms.`;
    }
    return `Technical investigation needed for ${paymentMode}. Review logs, identify common patterns, and implement a fix.`;
  }

  // Default recommendation based on trend
  if (trendDirection === 'INCREASING' && failureShare > 5) {
    return `High-priority ${paymentMode} issue. Perform root cause analysis and engage relevant stakeholders for resolution.`;
  }

  if (spikeType === 'PERSISTENT') {
    return `Long-standing ${paymentMode} issue detected. Schedule deep-dive analysis with product and engineering teams.`;
  }

  return `Monitor ${paymentMode} failure trends closely. Set up alerts and prepare escalation plan if volume continues to grow.`;
}

