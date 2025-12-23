// Web Worker for filtering and metrics computation
// Runs in background thread to prevent UI blocking

self.onmessage = function(e) {
  const { type, payload } = e.data;

  if (type === 'FILTER_TRANSACTIONS') {
    const { transactions, filters } = payload;
    const filtered = filterTransactions(transactions, filters);
    self.postMessage({ type: 'FILTERED_RESULT', payload: filtered });
  } else if (type === 'COMPUTE_METRICS') {
    const { transactions } = payload;
    const metrics = computeMetrics(transactions);
    self.postMessage({ type: 'METRICS_RESULT', payload: metrics });
  }
};

function filterTransactions(transactions, filters) {
  const filtered = [];
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
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    
    // Remove records where PG = 'N/A'
    const pg = String(tx.pg || '').trim().toUpperCase();
    if (pg === 'N/A' || pg === 'NA' || pg === '') {
      continue;
    }
    
    // Date range filter
    const txTime = typeof tx.txtime === 'string' ? new Date(tx.txtime) : tx.txtime;
    if (filters.dateRange.start) {
      const startDate = typeof filters.dateRange.start === 'string' ? new Date(filters.dateRange.start) : filters.dateRange.start;
      if (txTime < startDate) {
        continue;
      }
    }
    if (endDate && txTime > endDate) {
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

function computeMetrics(transactions) {
  if (transactions.length === 0) {
    return {
      globalMetrics: null,
      dailyTrends: []
    };
  }
  
  let successCount = 0;
  let failedCount = 0;
  let userDroppedCount = 0;
  let successGmv = 0;
  const dailyMap = new Map();
  
  // Single pass through transactions
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    
    // Count statuses
    if (tx.isSuccess) {
      successCount++;
      successGmv += tx.txamount || 0;
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
    
    const trend = dailyMap.get(date);
    trend.volume++;
    if (tx.isSuccess) trend.successCount++;
    if (tx.isFailed) trend.failedCount++;
    if (tx.isUserDropped) trend.userDroppedCount++;
  }
  
  const totalCount = transactions.length;
  
  const globalMetrics = {
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
  
  return { globalMetrics, dailyTrends };
}

function calculateSR(success, total) {
  if (total === 0) return 0;
  return Math.round((success / total) * 100 * 100) / 100;
}

function classifyUPIFlow(bankname) {
  if (!bankname || typeof bankname !== 'string' || bankname.trim() === '') return 'COLLECT';
  if (bankname.toLowerCase() === 'link') return 'INTENT';
  return bankname;
}

