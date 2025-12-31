// Utility functions for filtering and metrics computation
// Used as fallback when Web Workers are not available

import { Transaction, FilterState, Metrics, DailyTrend } from '@/types';
import { calculateSR } from './utils';
import { classifyUPIFlow } from './data-normalization';

export function filterTransactions(transactions: Transaction[], filters: FilterState): Transaction[] {
  const filtered: Transaction[] = [];
  const endDate = filters.dateRange.end ? new Date(filters.dateRange.end) : null;
  if (endDate) {
    endDate.setHours(23, 59, 59, 999);
  }
  
  // Pre-compute filter sets for O(1) lookup
  const paymentModeSet = filters.paymentModes.length > 0 
    ? new Set(filters.paymentModes) 
    : null;
  const merchantIdSet = filters.merchantIds.length > 0 
    ? new Set(filters.merchantIds) 
    : null;
  const pgSet = filters.pgs.length > 0 
    ? new Set(filters.pgs) 
    : null;
  const bankSet = filters.banks.length > 0 
    ? new Set(filters.banks) 
    : null;
  const cardTypeSet = filters.cardTypes.length > 0 
    ? new Set(filters.cardTypes) 
    : null;
  
  // Single pass filtering
  for (const tx of transactions) {
    // Remove records where PG = 'N/A'
    const pg = String(tx.pg || '').trim().toUpperCase();
    if (pg === 'N/A' || pg === 'NA' || pg === '') {
      continue;
    }
    
    // Date range filter
    if (filters.dateRange.start && tx.txtime < filters.dateRange.start) {
      continue;
    }
    if (endDate && tx.txtime > endDate) {
      continue;
    }
    
    // Payment mode filter
    if (paymentModeSet && !paymentModeSet.has(tx.paymentmode)) {
      continue;
    }
    
    // Merchant ID filter
    if (merchantIdSet) {
      const merchantId = String(tx.merchantid || '').trim();
      if (!merchantIdSet.has(merchantId)) {
        continue;
      }
    }
    
    // PG filter
    if (pgSet && !pgSet.has(tx.pg)) {
      continue;
    }
    
    // Bank filter (for UPI, this filters by INTENT/COLLECT classification)
    if (bankSet) {
      const flow = classifyUPIFlow(tx.bankname);
      if (!bankSet.has(flow) && !bankSet.has(tx.bankname)) {
        continue;
      }
    }
    
    // Card type filter
    if (cardTypeSet && !cardTypeSet.has(tx.cardtype)) {
      continue;
    }
    
    filtered.push(tx);
  }
  
  return filtered;
}

export function computeMetricsSync(transactions: Transaction[]): { globalMetrics: Metrics | null; dailyTrends: DailyTrend[] } {
  if (transactions.length === 0) {
    return {
      globalMetrics: null,
      dailyTrends: []
    };
  }
  
  // Optimize: Single pass computation instead of multiple filter/reduce calls
  let successCount = 0;
  let failedCount = 0;
  let userDroppedCount = 0;
  let successGmv = 0;
  const dailyMap = new Map<string, DailyTrend>();
  
  // Single pass through transactions
  for (const tx of transactions) {
    // Count statuses
    if (tx.isSuccess) {
      successCount++;
      successGmv += tx.txamount;
    } else if (tx.isFailed) {
      failedCount++;
    } else if (tx.isUserDropped) {
      userDroppedCount++;
    }
    
    // Aggregate daily trends
    const date = tx.transactionDate;
    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        volume: 0,
        sr: 0,
        successCount: 0,
        failedCount: 0,
        userDroppedCount: 0,
      });
    }
    
    const trend = dailyMap.get(date)!;
    trend.volume++;
    if (tx.isSuccess) trend.successCount++;
    if (tx.isFailed) trend.failedCount++;
    if (tx.isUserDropped) trend.userDroppedCount++;
  }
  
  const totalCount = transactions.length;
  
  const metrics: Metrics = {
    totalCount,
    successCount,
    failedCount,
    userDroppedCount,
    sr: calculateSR(successCount, totalCount),
    successGmv,
    failedPercent: calculateSR(failedCount, totalCount),
    userDroppedPercent: calculateSR(userDroppedCount, totalCount),
  };
  
  // Calculate SR for each day
  const dailyTrends = Array.from(dailyMap.values())
    .map((trend) => ({
      ...trend,
      sr: calculateSR(trend.successCount, trend.volume),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  
  return { globalMetrics: metrics, dailyTrends };
}






