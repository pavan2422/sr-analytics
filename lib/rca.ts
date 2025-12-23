import { Transaction, Metrics, RCAInsight, PeriodComparison, DimensionAnalysis, SRMovementType, PrimaryCause, VolumeMixChange } from '@/types';
import { calculateSR } from '@/lib/utils';
import { classifyUPIFlow, classifyCardScope, extractUPIHandle } from '@/lib/data-normalization';
import { detectProblematicCustomers } from '@/lib/customer-analytics';
import { analyzeVolumeMixChanges } from '@/lib/volume-mix-analysis';

// Configuration thresholds
const SR_DROP_THRESHOLD = 0.5; // 0.5% drop is significant
const VOLUME_CHANGE_THRESHOLD = 10; // 10% volume change is significant
const VOLUME_SHARE_SPIKE_THRESHOLD = 5; // 5% increase in share
const SR_DEGRADATION_THRESHOLD = 2; // 2% SR drop in a segment
const MIN_VOLUME_SHARE_FOR_ANALYSIS = 1; // 1% minimum volume share to analyze

type PaymentMode = 'ALL' | 'UPI' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'PREPAID_CARD' | 'NETBANKING';

interface DimensionConfig {
  name: string;
  getValue: (tx: Transaction) => string;
}

function getDimensionsForPaymentMode(paymentMode: PaymentMode): DimensionConfig[] {
  switch (paymentMode) {
    case 'UPI':
      return [
        { name: 'PG', getValue: (tx) => tx.pg || 'Unknown' },
        { name: 'Flow Type', getValue: (tx) => classifyUPIFlow(tx.bankname) },
        { name: 'Handle', getValue: (tx) => extractUPIHandle(tx.cardmasked) || 'Unknown' },
        { name: 'PSP', getValue: (tx) => tx.upi_psp || 'Unknown' },
        { name: 'Failure Reason', getValue: (tx) => tx.txmsg || 'Unknown' },
      ];
    case 'CREDIT_CARD':
    case 'DEBIT_CARD':
    case 'PREPAID_CARD':
      return [
        { name: 'PG', getValue: (tx) => tx.pg || 'Unknown' },
        { name: 'Card Type', getValue: (tx) => tx.cardtype || 'Unknown' },
        { name: 'Card Scope', getValue: (tx) => classifyCardScope(tx.cardcountry) },
        { name: 'Bank', getValue: (tx) => tx.bankname || 'Unknown' },
        { name: 'Processing Card Type', getValue: (tx) => tx.processingcardtype || 'Unknown' },
        { name: 'Native OTP Eligible', getValue: (tx) => tx.nativeotpurleligible || 'Unknown' },
        { name: 'Frictionless', getValue: (tx) => tx.card_isfrictionless || 'Unknown' },
        { name: 'Failure Reason', getValue: (tx) => tx.txmsg || 'Unknown' },
      ];
    case 'NETBANKING':
      return [
        { name: 'PG', getValue: (tx) => tx.pg || 'Unknown' },
        { name: 'Bank', getValue: (tx) => tx.bankname || 'Unknown' },
        { name: 'Failure Reason', getValue: (tx) => tx.txmsg || 'Unknown' },
      ];
    case 'ALL':
      return [
        { name: 'Payment Mode', getValue: (tx) => tx.paymentmode || 'Unknown' },
        { name: 'PG', getValue: (tx) => tx.pg || 'Unknown' },
        { name: 'Failure Reason', getValue: (tx) => tx.txmsg || 'Unknown' },
      ];
    default:
      return [];
  }
}

function filterByPaymentMode(transactions: Transaction[], paymentMode: PaymentMode): Transaction[] {
  if (paymentMode === 'ALL') return transactions;
  
  if (paymentMode === 'UPI') {
    return transactions.filter((tx) => 
      tx.paymentmode === 'UPI' || 
      tx.paymentmode === 'UPI_CREDIT_CARD' || 
      tx.paymentmode === 'UPI_PPI'
    );
  }
  
  return transactions.filter((tx) => tx.paymentmode === paymentMode);
}

function computeMetrics(txs: Transaction[]): Metrics {
    if (txs.length === 0) {
      return {
        totalCount: 0,
        successCount: 0,
        failedCount: 0,
        userDroppedCount: 0,
        sr: 0,
        successGmv: 0,
        failedPercent: 0,
        userDroppedPercent: 0,
      };
    }

    const totalCount = txs.length;
    const successCount = txs.filter((tx) => tx.isSuccess).length;
    const failedCount = txs.filter((tx) => tx.isFailed).length;
    const userDroppedCount = txs.filter((tx) => tx.isUserDropped).length;
    const successGmv = txs
      .filter((tx) => tx.isSuccess)
      .reduce((sum, tx) => sum + tx.txamount, 0);

    return {
      totalCount,
      successCount,
      failedCount,
      userDroppedCount,
      sr: calculateSR(successCount, totalCount),
      successGmv,
      failedPercent: calculateSR(failedCount, totalCount),
      userDroppedPercent: calculateSR(userDroppedCount, totalCount),
    };
}

function classifySRMovement(srDelta: number): SRMovementType {
  if (srDelta < -SR_DROP_THRESHOLD) return 'SR_DROP';
  if (srDelta > SR_DROP_THRESHOLD) return 'SR_IMPROVEMENT';
  return 'NO_SIGNIFICANT_CHANGE';
}

function analyzeDimension(
  dimension: DimensionConfig,
  currentPeriod: Transaction[], // Only failure transactions
  previousPeriod: Transaction[], // Only failure transactions
  overallCurrentSR: number,
  overallPreviousSR: number,
  overallCurrentVolume: number, // Total volume (all transactions) for context
  overallPreviousVolume: number // Total volume (all transactions) for context
): DimensionAnalysis[] {
  // Calculate total failure counts
  const totalCurrentFailures = currentPeriod.length;
  const totalPreviousFailures = previousPeriod.length;

  // Group failure transactions by dimension value
  const currentGroups = new Map<string, Transaction[]>();
  const previousGroups = new Map<string, Transaction[]>();

  currentPeriod.forEach((tx) => {
    const value = dimension.getValue(tx);
    if (!currentGroups.has(value)) {
      currentGroups.set(value, []);
    }
    currentGroups.get(value)!.push(tx);
  });

  previousPeriod.forEach((tx) => {
    const value = dimension.getValue(tx);
    if (!previousGroups.has(value)) {
      previousGroups.set(value, []);
    }
    previousGroups.get(value)!.push(tx);
  });

  const analyses: DimensionAnalysis[] = [];

  // Analyze each dimension value
  const allValues = new Set([...currentGroups.keys(), ...previousGroups.keys()]);
  
  allValues.forEach((value) => {
    const currentTxs = currentGroups.get(value) || [];
    const previousTxs = previousGroups.get(value) || [];

    // Skip if both periods have no data
    if (currentTxs.length === 0 && previousTxs.length === 0) return;

    // Since we're only looking at failures, currentTxs.length = failure count for this dimension
    const currentFailureCount = currentTxs.length;
    const previousFailureCount = previousTxs.length;

    // Calculate failure share (% of total failures)
    const failureShareCurrent = totalCurrentFailures > 0 
      ? (currentFailureCount / totalCurrentFailures) * 100 
      : 0;
    const failureSharePrevious = totalPreviousFailures > 0 
      ? (previousFailureCount / totalPreviousFailures) * 100 
      : 0;

    // Calculate what % of total transactions these failures represent
    const volumeShareCurrent = overallCurrentVolume > 0 
      ? (currentFailureCount / overallCurrentVolume) * 100 
      : 0;
    const volumeSharePrevious = overallPreviousVolume > 0 
      ? (previousFailureCount / overallPreviousVolume) * 100 
      : 0;

    const volumeDelta = volumeShareCurrent - volumeSharePrevious;
    const failureShareDelta = failureShareCurrent - failureSharePrevious;

    // Calculate SR for this dimension by looking at all transactions with this dimension value
    // We need to get all transactions (not just failures) for this dimension to calculate SR
    // For now, we'll use a simplified approach: calculate failure rate change
    const currentFailureRate = volumeShareCurrent;
    const previousFailureRate = volumeSharePrevious;
    const failureRateDelta = currentFailureRate - previousFailureRate;
    
    // For SR calculation, we'll estimate based on failure rate
    // If failure rate increased, SR decreased
    const srDelta = -failureRateDelta; // Inverse relationship

    // Determine if this dimension value should be flagged
    let flagged = false;
    let flagReason: 'VOLUME_SPIKE' | 'SR_DEGRADATION' | 'FAILURE_EXPLOSION' | null = null;

    // Failure Spike Detector - detect if failures increased significantly
    if (
      failureShareDelta > VOLUME_SHARE_SPIKE_THRESHOLD &&
      failureShareCurrent >= MIN_VOLUME_SHARE_FOR_ANALYSIS
    ) {
      flagged = true;
      flagReason = 'VOLUME_SPIKE'; // More failures in this dimension
    }

    // Failure Rate Increase Detector - detect if failure rate (% of total transactions) increased
    if (
      failureRateDelta > 1 && // 1% increase in failure rate
      volumeShareCurrent >= MIN_VOLUME_SHARE_FOR_ANALYSIS
    ) {
      flagged = true;
      flagReason = 'SR_DEGRADATION'; // This dimension's failure rate increased
    }

    // Failure Explosion Detector (for failure reason dimension)
    if (dimension.name === 'Failure Reason' && currentFailureCount > 0) {
      if (
        previousFailureCount > 0 &&
        currentFailureCount > previousFailureCount * 1.5 && // 50% increase
        failureShareCurrent >= MIN_VOLUME_SHARE_FOR_ANALYSIS
      ) {
        flagged = true;
        flagReason = 'FAILURE_EXPLOSION';
      }
    }

    // Calculate counterfactual SR (what SR would be without this dimension's failures)
    let counterfactualSR: number | undefined;
    let impactOnOverallSR: number | undefined;

    if (flagged && currentFailureCount > 0) {
      // Calculate what overall SR would be if we removed this dimension's failed transactions
      // Total success count in overall period
      const overallSuccessCount = Math.round((overallCurrentSR / 100) * overallCurrentVolume);
      
      // If we remove this dimension's failures:
      // Adjusted total = overall volume - this dimension's failures
      // Adjusted success = overall success (stays the same)
      const adjustedTotal = overallCurrentVolume - currentFailureCount;
      const adjustedSuccess = overallSuccessCount;
      
      if (adjustedTotal > 0 && adjustedTotal >= adjustedSuccess) {
        counterfactualSR = calculateSR(adjustedSuccess, adjustedTotal);
        impactOnOverallSR = counterfactualSR - overallCurrentSR;
      }
    }

    // Calculate estimated SR for this dimension
    // Since we only have failures, we estimate SR based on failure rate
    // If this dimension has X% of failures, and overall SR is Y%, 
    // we estimate this dimension's SR impact
    const estimatedCurrentSR = overallCurrentVolume > 0
      ? calculateSR(overallCurrentVolume - currentFailureCount, overallCurrentVolume)
      : overallCurrentSR;
    const estimatedPreviousSR = overallPreviousVolume > 0
      ? calculateSR(overallPreviousVolume - previousFailureCount, overallPreviousVolume)
      : overallPreviousSR;

    // Find top failure reason (txmsg) within this dimension value
    // Only if this is not already the "Failure Reason" dimension
    let topFailureReason: string | undefined;
    let topFailureReasonCount: number | undefined;
    
    if (dimension.name !== 'Failure Reason' && currentTxs.length > 0) {
      const failureReasonCounts = new Map<string, number>();
      currentTxs.forEach((tx) => {
        const reason = tx.txmsg || 'Unknown';
        failureReasonCounts.set(reason, (failureReasonCounts.get(reason) || 0) + 1);
      });
      
      // Get the top failure reason
      const sortedReasons = Array.from(failureReasonCounts.entries())
        .sort((a, b) => b[1] - a[1]);
      
      if (sortedReasons.length > 0) {
        topFailureReason = sortedReasons[0][0];
        topFailureReasonCount = sortedReasons[0][1];
      }
    } else if (dimension.name === 'Failure Reason') {
      // For Failure Reason dimension, the dimensionValue IS the failure reason
      topFailureReason = value;
      topFailureReasonCount = currentFailureCount;
    }

    analyses.push({
      dimension: dimension.name,
      dimensionValue: value,
      currentVolume: currentFailureCount, // Failure count
      previousVolume: previousFailureCount, // Failure count
      volumeDelta: volumeDelta, // Change in failure rate (% of total transactions)
      volumeShareCurrent, // % of total transactions that are failures in this dimension
      volumeSharePrevious, // % of total transactions that were failures in this dimension
      currentSR: estimatedCurrentSR, // Estimated SR if we remove these failures
      previousSR: estimatedPreviousSR, // Estimated SR if we remove these failures
      srDelta,
      flagged,
      flagReason,
      counterfactualSR,
      impactOnOverallSR,
      topFailureReason,
      topFailureReasonCount,
    });
  });

  return analyses;
}

function determinePrimaryCause(
  current: Metrics,
  previous: Metrics,
  dimensionAnalyses: DimensionAnalysis[]
): PrimaryCause {
  const failedRateCurrent = current.failedPercent;
  const failedRatePrevious = previous.failedPercent;

  // Check if failure rate increased significantly
  const failureSpike = failedRateCurrent > failedRatePrevious + 1; // 1% increase

  // Check for volume mix issues
  const volumeMixIssues = dimensionAnalyses.filter(
    (d) => d.flagReason === 'VOLUME_SPIKE' && d.volumeDelta > VOLUME_SHARE_SPIKE_THRESHOLD
  );

  // Check for segment degradation
  const segmentDegradation = dimensionAnalyses.filter(
    (d) => d.flagReason === 'SR_DEGRADATION' && d.srDelta < -SR_DEGRADATION_THRESHOLD
  );

  if (failureSpike && volumeMixIssues.length > 0) return 'MIXED';
  if (failureSpike) return 'FAILURE_SPIKE';
  if (volumeMixIssues.length > 0) return 'VOLUME_MIX';
  if (segmentDegradation.length > 0) return 'SEGMENT_DEGRADATION';
  
  return 'MIXED';
}

function generateInsights(
  current: Metrics,
  previous: Metrics,
  srDelta: number,
  volumeDelta: number,
  dimensionAnalyses: DimensionAnalysis[],
  paymentMode: PaymentMode,
  allTransactions: Transaction[] // All transactions for customer analysis
): RCAInsight[] {
  const insights: RCAInsight[] = [];

  // Overall SR movement insight (only if significant)
  if (Math.abs(srDelta) >= SR_DROP_THRESHOLD && srDelta < 0) {
    const paymentModeText = paymentMode === 'ALL' ? 'Overall' : paymentMode;
    insights.push({
      rootCause: `${paymentModeText} SR Drop`,
      dimension: 'Overall',
      impactedVolumePercent: 100,
      srDrop: srDelta,
      statement: `${paymentModeText} SR dropped by ${Math.abs(srDelta).toFixed(2)}% (${current.sr.toFixed(2)}% vs ${previous.sr.toFixed(2)}%)`,
      confidence: 'HIGH',
      impact: Math.abs(srDelta),
    });
  }

  // FOCUS: PG-Level Analysis (Primary Insights)
  const pgAnalyses = dimensionAnalyses.filter((d) => d.dimension === 'PG' && d.flagged);
  
  // Group PG analyses and find affected payment modes
  pgAnalyses.sort((a, b) => Math.abs(b.impactOnOverallSR || 0) - Math.abs(a.impactOnOverallSR || 0));
  
  pgAnalyses.slice(0, 10).forEach((pgAnalysis) => {
    // Find which payment modes are affected by this PG
    const pgTransactions = allTransactions.filter((tx) => 
      (tx.pg || 'Unknown') === pgAnalysis.dimensionValue && tx.txstatus !== 'SUCCESS'
    );
    
    // Group failures by payment mode for this PG
    const paymentModeGroups = new Map<PaymentMode, Transaction[]>();
    pgTransactions.forEach((tx) => {
      let mode: PaymentMode = 'ALL';
      if (tx.paymentmode === 'UPI' || tx.paymentmode === 'UPI_CREDIT_CARD' || tx.paymentmode === 'UPI_PPI') {
        mode = 'UPI';
      } else if (tx.paymentmode === 'CREDIT_CARD') {
        mode = 'CREDIT_CARD';
      } else if (tx.paymentmode === 'DEBIT_CARD') {
        mode = 'DEBIT_CARD';
      } else if (tx.paymentmode === 'PREPAID_CARD') {
        mode = 'PREPAID_CARD';
      } else if (tx.paymentmode === 'NET_BANKING') {
        mode = 'NETBANKING';
      }
      
      if (!paymentModeGroups.has(mode)) {
        paymentModeGroups.set(mode, []);
      }
      paymentModeGroups.get(mode)!.push(tx);
    });

    // Calculate counterfactual SR per payment mode
    const paymentModeImpacts: Array<{
      mode: PaymentMode;
      failureCount: number;
      counterfactualSR: number;
      currentSR: number;
    }> = [];

    paymentModeGroups.forEach((failures, mode) => {
      if (mode === 'ALL' || failures.length === 0) return;
      
      const modeTransactions = allTransactions.filter((tx) => {
        if (mode === 'UPI') {
          return tx.paymentmode === 'UPI' || tx.paymentmode === 'UPI_CREDIT_CARD' || tx.paymentmode === 'UPI_PPI';
        }
        return tx.paymentmode === mode;
      });
      
      const modeTotal = modeTransactions.length;
      const modeSuccess = modeTransactions.filter(tx => tx.isSuccess).length;
      const modeCurrentSR = calculateSR(modeSuccess, modeTotal);
      
      // Remove this PG's failures from this payment mode
      const adjustedTotal = modeTotal - failures.length;
      const adjustedSuccess = modeSuccess;
      const counterfactualSR = adjustedTotal > 0 ? calculateSR(adjustedSuccess, adjustedTotal) : modeCurrentSR;
      
      paymentModeImpacts.push({
        mode,
        failureCount: failures.length,
        counterfactualSR,
        currentSR: modeCurrentSR,
      });
    });

    // Get top failure reasons for this PG
    const failureReasonCounts = new Map<string, number>();
    pgTransactions.forEach((tx) => {
      const reason = tx.txmsg || 'Unknown';
      failureReasonCounts.set(reason, (failureReasonCounts.get(reason) || 0) + 1);
    });
    
    const topFailureReasons = Array.from(failureReasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    // Build evidence
    const evidence: string[] = [];
    evidence.push(`PG: ${pgAnalysis.dimensionValue}`);
    evidence.push(`Failure count: ${pgAnalysis.currentVolume} (up from ${pgAnalysis.previousVolume})`);
    evidence.push(`Failure rate: ${pgAnalysis.volumeShareCurrent.toFixed(2)}% of total transactions`);
    topFailureReasons.forEach(([reason, count]) => {
      evidence.push(`"${reason}": ${count} failures`);
    });

    // Build statement
    const failureReasonsText = topFailureReasons.length > 0
      ? ` Top failures: ${topFailureReasons.map(([r, c]) => `"${r}" (${c})`).join(', ')}.`
      : '';

    const paymentModeImpactText = paymentModeImpacts.length > 0
      ? ` If these failures are resolved, SR would improve to: ${paymentModeImpacts.map(p => `${p.mode} ${p.counterfactualSR.toFixed(2)}%`).join(', ')}.`
      : '';

    insights.push({
      rootCause: `PG: ${pgAnalysis.dimensionValue}`,
      dimension: 'PG',
      dimensionValue: pgAnalysis.dimensionValue,
      impactedVolumePercent: pgAnalysis.volumeShareCurrent,
      srDrop: pgAnalysis.impactOnOverallSR || 0,
      statement: `PG "${pgAnalysis.dimensionValue}" failure rate increased from ${pgAnalysis.volumeSharePrevious.toFixed(2)}% to ${pgAnalysis.volumeShareCurrent.toFixed(2)}% of total transactions, with ${pgAnalysis.currentVolume} failures (up from ${pgAnalysis.previousVolume}).${failureReasonsText}${paymentModeImpactText}`,
      confidence: pgAnalysis.volumeShareCurrent > 2 ? 'HIGH' : 'MEDIUM',
      impact: pgAnalysis.impactOnOverallSR ? Math.abs(pgAnalysis.impactOnOverallSR) : Math.abs(pgAnalysis.volumeDelta),
      counterfactualSR: pgAnalysis.counterfactualSR,
      evidence,
    });
  });

  // Note: Problematic customers are handled separately in the UI, not in main insights

  // Sort insights by impact (descending)
  insights.sort((a, b) => b.impact - a.impact);

  return insights.slice(0, 10); // Top 10 insights (focused, less repetitive)
}

export function computePeriodComparison(
  currentPeriod: Transaction[],
  previousPeriod: Transaction[],
  paymentMode: PaymentMode = 'ALL'
): PeriodComparison {
  // Filter by payment mode
  const currentFiltered = filterByPaymentMode(currentPeriod, paymentMode);
  const previousFiltered = filterByPaymentMode(previousPeriod, paymentMode);

  // Calculate overall metrics (all transactions) for context
  const current = computeMetrics(currentFiltered);
  const previous = computeMetrics(previousFiltered);

  // Filter to ONLY failure transactions for RCA analysis (txstatus !== 'SUCCESS')
  const currentFailures = currentFiltered.filter((tx) => tx.txstatus !== 'SUCCESS');
  const previousFailures = previousFiltered.filter((tx) => tx.txstatus !== 'SUCCESS');

  const srDelta = current.sr - previous.sr;
  const volumeDelta = previous.totalCount > 0
    ? ((current.totalCount - previous.totalCount) / previous.totalCount) * 100
    : 0;

  const successCountDelta = current.successCount - previous.successCount;
  const failedCountDelta = current.failedCount - previous.failedCount;
  const userDroppedDelta = current.userDroppedCount - previous.userDroppedCount;

  const srMovement = classifySRMovement(srDelta);
  const failedRateCurrent = current.failedPercent;
  const failedRatePrevious = previous.failedPercent;

  // Layer 2A: Dimension-wise RCA - ONLY on failure transactions
  const dimensions = getDimensionsForPaymentMode(paymentMode);
  const dimensionAnalyses: DimensionAnalysis[] = [];

  dimensions.forEach((dimension) => {
    const analyses = analyzeDimension(
      dimension,
      currentFailures, // Only failure transactions
      previousFailures, // Only failure transactions
      current.sr,
      previous.sr,
      current.totalCount, // Total volume for context
      previous.totalCount // Total volume for context
    );
    dimensionAnalyses.push(...analyses);
  });

  // Determine primary cause
  const primaryCause = determinePrimaryCause(current, previous, dimensionAnalyses);

  // Generate insights (pass all transactions for customer analysis)
  const insights = generateInsights(
    current,
    previous,
    srDelta,
    volumeDelta,
    dimensionAnalyses,
    paymentMode,
    currentFiltered // All transactions (not just failures) for customer analysis
  );

  // Analyze volume mix changes (ALL transactions, not just failures)
  const volumeMixChanges = analyzeVolumeMixChanges(
    currentFiltered,
    previousFiltered,
    paymentMode
  );

  return {
    current,
    previous,
    srDelta,
    volumeDelta,
    insights,
    srMovement,
    primaryCause,
    dimensionAnalyses,
    successCountDelta,
    failedCountDelta,
    userDroppedDelta,
    failedRateCurrent,
    failedRatePrevious,
    volumeMixChanges,
  };
}
