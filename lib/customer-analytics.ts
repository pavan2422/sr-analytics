import { Transaction } from '@/types';
import { calculateSR } from '@/lib/utils';
import { getFailureLabel } from '@/lib/failure-utils';

export type CustomerType = 
  | 'RETRY_CUSTOMER'      // Same card/UPI attempting multiple times
  | 'USER_DROPPED'         // User dropped transactions
  | 'HIGH_VALUE'           // High transaction amount
  | 'LOW_VALUE'            // Low transaction amount
  | 'SINGLE_ATTEMPT';      // Only one attempt

export interface CustomerSegment {
  customerType: CustomerType;
  volume: number;
  successCount: number;
  failedCount: number;
  userDroppedCount: number;
  sr: number;
  failureRate: number;
  userDroppedRate: number;
  avgAmount: number;
  impactOnSR: number; // How much this segment impacts overall SR
}

export interface CustomerAnalytics {
  segments: CustomerSegment[];
  overallSR: number;
  retryCustomerSR: number;
  singleAttemptSR: number;
  highValueSR: number;
  lowValueSR: number;
}

/**
 * Classify a transaction into customer type
 * First transaction (earliest txtime) per customer = first attempt
 * Subsequent transactions = retry customers
 */
function classifyCustomerType(
  tx: Transaction,
  firstTransactionMap: Map<string, Date>, // customer identifier -> first transaction time
  amountThreshold: number
): CustomerType {
  // Check if user dropped
  if (tx.isUserDropped) {
    return 'USER_DROPPED';
  }

  // Check if this is a retry (not the first transaction for this customer)
  const identifier = tx.cardnumber || tx.cardmasked || 'unknown';
  const firstTransactionTime = firstTransactionMap.get(identifier);
  
  if (firstTransactionTime) {
    // If this transaction's time is after the first transaction time, it's a retry
    if (tx.txtime.getTime() > firstTransactionTime.getTime()) {
      return 'RETRY_CUSTOMER';
    }
    // If it's the first transaction, continue to value-based classification
  }

  // Check transaction value (for first attempts only)
  if (tx.txamount >= amountThreshold) {
    return 'HIGH_VALUE';
  } else if (tx.txamount > 0) {
    return 'LOW_VALUE';
  }

  return 'SINGLE_ATTEMPT';
}

/**
 * Calculate amount threshold (median or 75th percentile)
 */
function calculateAmountThreshold(transactions: Transaction[]): number {
  if (transactions.length === 0) return 0;
  
  const amounts = transactions
    .map(tx => tx.txamount)
    .filter(amt => amt > 0)
    .sort((a, b) => a - b);
  
  if (amounts.length === 0) return 0;
  
  // Use 75th percentile as threshold
  const percentile75Index = Math.floor(amounts.length * 0.75);
  return amounts[percentile75Index] || amounts[amounts.length - 1];
}

/**
 * Build first transaction map: find earliest transaction time per customer
 */
function buildFirstTransactionMap(transactions: Transaction[]): Map<string, Date> {
  const firstTransactionMap = new Map<string, Date>();
  
  transactions.forEach((tx) => {
    const identifier = tx.cardnumber || tx.cardmasked || 'unknown';
    const currentFirst = firstTransactionMap.get(identifier);
    
    if (!currentFirst || tx.txtime.getTime() < currentFirst.getTime()) {
      firstTransactionMap.set(identifier, tx.txtime);
    }
  });
  
  return firstTransactionMap;
}

/**
 * Build retry statistics: count retries per customer
 */
function buildRetryStats(transactions: Transaction[]): Map<string, {
  firstTransactionTime: Date;
  totalAttempts: number;
  retryCount: number;
  transactions: Transaction[];
}> {
  const customerMap = new Map<string, {
    firstTransactionTime: Date;
    totalAttempts: number;
    retryCount: number;
    transactions: Transaction[];
  }>();
  
  transactions.forEach((tx) => {
    const identifier = tx.cardnumber || tx.cardmasked || 'unknown';
    
    if (!customerMap.has(identifier)) {
      customerMap.set(identifier, {
        firstTransactionTime: tx.txtime,
        totalAttempts: 0,
        retryCount: 0,
        transactions: [],
      });
    }
    
    const customer = customerMap.get(identifier)!;
    customer.transactions.push(tx);
    customer.totalAttempts++;
    
    // Update first transaction time if this is earlier
    if (tx.txtime.getTime() < customer.firstTransactionTime.getTime()) {
      customer.firstTransactionTime = tx.txtime;
    }
  });
  
  // Calculate retry count (transactions after first transaction)
  customerMap.forEach((customer, identifier) => {
    customer.retryCount = customer.transactions.filter(tx => 
      tx.txtime.getTime() > customer.firstTransactionTime.getTime()
    ).length;
  });
  
  return customerMap;
}

/**
 * Analyze customer segments and their impact on SR
 */
export function analyzeCustomerSegments(
  transactions: Transaction[]
): CustomerAnalytics {
  if (transactions.length === 0) {
    return {
      segments: [],
      overallSR: 0,
      retryCustomerSR: 0,
      singleAttemptSR: 0,
      highValueSR: 0,
      lowValueSR: 0,
    };
  }

  // Calculate overall metrics
  const totalCount = transactions.length;
  const successCount = transactions.filter(tx => tx.isSuccess).length;
  const overallSR = calculateSR(successCount, totalCount);

  // Build first transaction map (earliest transaction per customer)
  const firstTransactionMap = buildFirstTransactionMap(transactions);
  
  // Calculate amount threshold
  const amountThreshold = calculateAmountThreshold(transactions);

  // Group transactions by customer type
  const segmentsMap = new Map<CustomerType, Transaction[]>();
  
  transactions.forEach((tx) => {
    const customerType = classifyCustomerType(tx, firstTransactionMap, amountThreshold);
    if (!segmentsMap.has(customerType)) {
      segmentsMap.set(customerType, []);
    }
    segmentsMap.get(customerType)!.push(tx);
  });

  // Calculate metrics for each segment
  const segments: CustomerSegment[] = [];
  
  segmentsMap.forEach((txs, customerType) => {
    const volume = txs.length;
    const successCount = txs.filter(tx => tx.isSuccess).length;
    const failedCount = txs.filter(tx => tx.isFailed).length;
    const userDroppedCount = txs.filter(tx => tx.isUserDropped).length;
    const sr = calculateSR(successCount, volume);
    const failureRate = calculateSR(failedCount, volume);
    const userDroppedRate = calculateSR(userDroppedCount, volume);
    const avgAmount = volume > 0 
      ? txs.reduce((sum, tx) => sum + tx.txamount, 0) / volume 
      : 0;

    // Calculate impact on overall SR
    // Impact = (segment SR - overall SR) * (segment volume / total volume)
    const volumeShare = (volume / totalCount) * 100;
    const impactOnSR = (sr - overallSR) * (volume / totalCount);

    segments.push({
      customerType,
      volume,
      successCount,
      failedCount,
      userDroppedCount,
      sr,
      failureRate,
      userDroppedRate,
      avgAmount,
      impactOnSR,
    });
  });

  // Sort by impact (most negative first)
  segments.sort((a, b) => a.impactOnSR - b.impactOnSR);

  // Get specific segment SRs
  const retrySegment = segments.find(s => s.customerType === 'RETRY_CUSTOMER');
  const singleAttemptSegment = segments.find(s => s.customerType === 'SINGLE_ATTEMPT');
  const highValueSegment = segments.find(s => s.customerType === 'HIGH_VALUE');
  const lowValueSegment = segments.find(s => s.customerType === 'LOW_VALUE');

  return {
    segments,
    overallSR,
    retryCustomerSR: retrySegment?.sr || 0,
    singleAttemptSR: singleAttemptSegment?.sr || 0,
    highValueSR: highValueSegment?.sr || 0,
    lowValueSR: lowValueSegment?.sr || 0,
  };
}

/**
 * Compare customer segments between two periods
 */
export function compareCustomerSegments(
  currentPeriod: Transaction[],
  previousPeriod: Transaction[]
): {
  current: CustomerAnalytics;
  previous: CustomerAnalytics;
  deltas: {
    customerType: CustomerType;
    volumeDelta: number;
    srDelta: number;
    impactDelta: number;
  }[];
} {
  const current = analyzeCustomerSegments(currentPeriod);
  const previous = analyzeCustomerSegments(previousPeriod);

  // Calculate deltas
  const deltas: {
    customerType: CustomerType;
    volumeDelta: number;
    srDelta: number;
    impactDelta: number;
  }[] = [];

  current.segments.forEach((currentSegment) => {
    const previousSegment = previous.segments.find(
      s => s.customerType === currentSegment.customerType
    );

    if (previousSegment) {
      const volumeDelta = currentSegment.volume - previousSegment.volume;
      const srDelta = currentSegment.sr - previousSegment.sr;
      const impactDelta = currentSegment.impactOnSR - previousSegment.impactOnSR;

      deltas.push({
        customerType: currentSegment.customerType,
        volumeDelta,
        srDelta,
        impactDelta,
      });
    } else {
      // New segment in current period
      deltas.push({
        customerType: currentSegment.customerType,
        volumeDelta: currentSegment.volume,
        srDelta: currentSegment.sr,
        impactDelta: currentSegment.impactOnSR,
      });
    }
  });

  // Sort by impact delta (most negative first)
  deltas.sort((a, b) => a.impactDelta - b.impactDelta);

  return {
    current,
    previous,
    deltas,
  };
}

/**
 * Get human-readable label for customer type
 */
export function getCustomerTypeLabel(customerType: CustomerType): string {
  switch (customerType) {
    case 'RETRY_CUSTOMER':
      return 'Retry Customers';
    case 'USER_DROPPED':
      return 'User Dropped';
    case 'HIGH_VALUE':
      return 'High Value Transactions';
    case 'LOW_VALUE':
      return 'Low Value Transactions';
    case 'SINGLE_ATTEMPT':
      return 'Single Attempt';
    default:
      return customerType;
  }
}

/**
 * Get description for customer type
 */
export function getCustomerTypeDescription(customerType: CustomerType): string {
  switch (customerType) {
    case 'RETRY_CUSTOMER':
      return 'Customers who attempted the same transaction multiple times (retries)';
    case 'USER_DROPPED':
      return 'Transactions where users dropped/abandoned the payment flow';
    case 'HIGH_VALUE':
      return 'High-value transactions (above 75th percentile amount)';
    case 'LOW_VALUE':
      return 'Low-value transactions (below 75th percentile amount)';
    case 'SINGLE_ATTEMPT':
      return 'Customers with only one transaction attempt';
    default:
      return '';
  }
}

export interface ProblematicCustomer {
  identifier: string; // cardnumber or UPI handle
  attemptCount: number;
  successCount: number;
  failedCount: number;
  sr: number;
  volumeShare: number; // % of total transactions
  impactOnSR: number; // How much this customer impacts overall SR
  topFailureReason?: string;
  topFailureReasonCount?: number;
}

/**
 * Detect problematic customers: substantial retries + very low SR
 * Only counts retry transactions (not first attempts)
 * First transaction = minimum txtime per customer
 */
export function detectProblematicCustomers(
  transactions: Transaction[],
  minRetryCount: number = 10, // Minimum retry attempts (not total attempts)
  maxSR: number = 1.0 // SR threshold (1%)
): ProblematicCustomer[] {
  if (transactions.length === 0) return [];

  // Build retry statistics (identifies first transaction vs retries)
  const retryStats = buildRetryStats(transactions);

  const totalCount = transactions.length;
  const overallSuccessCount = transactions.filter(tx => tx.isSuccess).length;
  const overallSR = calculateSR(overallSuccessCount, totalCount);

  const problematicCustomers: ProblematicCustomer[] = [];

  retryStats.forEach((customerData, identifier) => {
    // Only consider customers with substantial retries (not total attempts)
    if (customerData.retryCount < minRetryCount) return;

    // Calculate SR for retry transactions only (not first attempt)
    const retryTransactions = customerData.transactions.filter(tx => 
      tx.txtime.getTime() > customerData.firstTransactionTime.getTime()
    );
    
    if (retryTransactions.length === 0) return;

    const retrySuccessCount = retryTransactions.filter(tx => tx.isSuccess).length;
    const retryFailedCount = retryTransactions.filter(tx => tx.isFailed).length;
    const retrySR = calculateSR(retrySuccessCount, retryTransactions.length);
    const volumeShare = (customerData.totalAttempts / totalCount) * 100;

    // Check if retry SR is below threshold
    if (retrySR > maxSR) return;

    // Calculate impact on overall SR (removing all this customer's failures)
    const allFailedCount = customerData.transactions.filter(tx => tx.isFailed).length;
    const adjustedTotal = totalCount - allFailedCount;
    const adjustedSuccess = overallSuccessCount; // Success count stays same
    const counterfactualSR = adjustedTotal > 0 
      ? calculateSR(adjustedSuccess, adjustedTotal)
      : overallSR;
    const impactOnSR = counterfactualSR - overallSR;

    // Find top failure reason for retry transactions
    const failureReasonCounts = new Map<string, number>();
    retryTransactions.filter(tx => tx.isFailed).forEach((tx) => {
      const reason = getFailureLabel(tx) || 'Unknown';
      failureReasonCounts.set(reason, (failureReasonCounts.get(reason) || 0) + 1);
    });

    const sortedReasons = Array.from(failureReasonCounts.entries())
      .sort((a, b) => b[1] - a[1]);
    
    const topFailureReason = sortedReasons.length > 0 ? sortedReasons[0][0] : undefined;
    const topFailureReasonCount = sortedReasons.length > 0 ? sortedReasons[0][1] : undefined;

    problematicCustomers.push({
      identifier,
      attemptCount: customerData.totalAttempts, // Total attempts (for context)
      successCount: retrySuccessCount, // Success in retries only
      failedCount: retryFailedCount, // Failed in retries only
      sr: retrySR, // SR of retry transactions only
      volumeShare,
      impactOnSR,
      topFailureReason,
      topFailureReasonCount,
    });
  });

  // Sort by impact (most negative first)
  problematicCustomers.sort((a, b) => a.impactOnSR - b.impactOnSR);

  return problematicCustomers;
}

