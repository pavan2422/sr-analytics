import { Transaction, GroupedMetrics, DailyTrend, FailureRCA } from '@/types';
import { calculateSR, safeDivide } from '@/lib/utils';
import { extractUPIHandle, classifyUPIFlow, classifyCardScope, classifyBankTier } from '@/lib/data-normalization';
import { getFailureLabel } from '@/lib/failure-utils';

export function groupBy(
  transactions: Transaction[],
  groupKey: (tx: Transaction) => string
): GroupedMetrics[] {
  const groups = new Map<string, Transaction[]>();
  
  transactions.forEach((tx) => {
    const key = groupKey(tx) || 'Unknown';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(tx);
  });
  
  return Array.from(groups.entries())
    .map(([group, txs]) => {
      const totalCount = txs.length;
      const successCount = txs.filter((tx) => tx.isSuccess).length;
      const failedCount = txs.filter((tx) => tx.isFailed).length;
      const userDroppedCount = txs.filter((tx) => tx.isUserDropped).length;
      
      // Calculate daily trend for this group
      const dailyMap = new Map<string, DailyTrend>();
      txs.forEach((tx) => {
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
      });
      
      const dailyTrend = Array.from(dailyMap.values())
        .map((trend) => ({
          ...trend,
          sr: calculateSR(trend.successCount, trend.volume),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      
      return {
        group,
        volume: totalCount,
        sr: calculateSR(successCount, totalCount),
        successCount,
        failedCount,
        userDroppedCount,
        dailyTrend,
      };
    })
    .sort((a, b) => b.volume - a.volume);
}

export function computeUPIMetrics(transactions: Transaction[]) {
  // Include UPI and UPI variants
  const upiTxs = transactions.filter((tx) => 
    tx.paymentmode === 'UPI' || 
    tx.paymentmode === 'UPI_CREDIT_CARD' || 
    tx.paymentmode === 'UPI_PPI'
  );
  
  // PG Level
  const pgLevel = groupBy(upiTxs, (tx) => tx.pg || 'Unknown');
  
  // Intent vs Collect
  const flowLevel = groupBy(upiTxs, (tx) => classifyUPIFlow(tx.bankname));
  
  // Handle Level - extract from cardmasked field (UPI VPA)
  const handleLevel = groupBy(upiTxs, (tx) => {
    const handle = extractUPIHandle(tx.cardmasked);
    return handle || 'Unknown';
  }).filter((g) => g.group !== 'Unknown');
  
  // PSP Level
  const pspLevel = groupBy(upiTxs, (tx) => tx.upi_psp || 'Unknown');
  
  // Failure RCA - only analyze technical failures (excludes USER_DROPPED, INIT_FAILED)
  const failures = upiTxs.filter((tx) => tx.isFailed);
  const totalCount = upiTxs.length;
  const successCount = upiTxs.filter((tx) => tx.isSuccess).length;
  
  const failureGroups = new Map<string, Transaction[]>();
  failures.forEach((tx) => {
    const msg = getFailureLabel(tx) || 'Unknown';
    if (!failureGroups.has(msg)) {
      failureGroups.set(msg, []);
    }
    failureGroups.get(msg)!.push(tx);
  });
  
  const failureRCA: FailureRCA[] = Array.from(failureGroups.entries())
    .map(([txmsg, txs]) => {
      const failureCount = txs.length;
      const adjustedSR = calculateSR(
        successCount,
        totalCount - failureCount
      );
      const currentSR = calculateSR(successCount, totalCount);
      
      return {
        txmsg,
        failureCount,
        failurePercent: calculateSR(failureCount, totalCount),
        adjustedSR,
        impact: adjustedSR - currentSR,
      };
    })
    .sort((a, b) => b.failureCount - a.failureCount);
  
  return {
    pgLevel,
    flowLevel,
    handleLevel,
    pspLevel,
    failureRCA,
  };
}

export function computeCardMetrics(transactions: Transaction[]) {
  const cardTxs = transactions.filter((tx) =>
    ['CREDIT_CARD', 'DEBIT_CARD', 'PREPAID_CARD'].includes(tx.paymentmode)
  );
  
  // PG Level
  const pgLevel = groupBy(cardTxs, (tx) => tx.pg || 'Unknown');
  
  // Card Type
  const cardTypeLevel = groupBy(cardTxs, (tx) => tx.cardtype || 'Unknown');
  
  // Domestic vs IPG
  const scopeLevel = groupBy(cardTxs, (tx) => classifyCardScope(tx.cardcountry));
  
  // Authentication & Friction
  const authLevels = {
    processingCardType: groupBy(cardTxs, (tx) => tx.processingcardtype || 'Unknown'),
    nativeOtpEligible: groupBy(cardTxs, (tx) => tx.nativeotpurleligible || 'Unknown'),
    isFrictionless: groupBy(cardTxs, (tx) => tx.card_isfrictionless || 'Unknown'),
    nativeOtpAction: groupBy(cardTxs, (tx) => tx.card_nativeotpaction || 'Unknown'),
    cardPar: groupBy(cardTxs, (tx) => tx.card_par || 'Unknown'),
    cvvPresent: groupBy(cardTxs, (tx) => String(tx.iscvvpresent || 'Unknown').trim() || 'Unknown'),
  };
  
  // Failure RCA - only analyze technical failures (excludes USER_DROPPED, INIT_FAILED)
  const failures = cardTxs.filter((tx) => tx.isFailed);
  const totalCount = cardTxs.length;
  const successCount = cardTxs.filter((tx) => tx.isSuccess).length;
  
  const failureGroups = new Map<string, Transaction[]>();
  failures.forEach((tx) => {
    const msg = getFailureLabel(tx) || 'Unknown';
    if (!failureGroups.has(msg)) {
      failureGroups.set(msg, []);
    }
    failureGroups.get(msg)!.push(tx);
  });
  
  const failureRCA: FailureRCA[] = Array.from(failureGroups.entries())
    .map(([txmsg, txs]) => {
      const failureCount = txs.length;
      const adjustedSR = calculateSR(
        successCount,
        totalCount - failureCount
      );
      const currentSR = calculateSR(successCount, totalCount);
      
      return {
        txmsg,
        failureCount,
        failurePercent: calculateSR(failureCount, totalCount),
        adjustedSR,
        impact: adjustedSR - currentSR,
      };
    })
    .sort((a, b) => b.failureCount - a.failureCount);
  
  return {
    pgLevel,
    cardTypeLevel,
    scopeLevel,
    authLevels,
    failureRCA,
  };
}

export function computeNetbankingMetrics(transactions: Transaction[]) {
  const nbTxs = transactions.filter((tx) => tx.paymentmode === 'NET_BANKING');
  
  // PG Level
  const pgLevel = groupBy(nbTxs, (tx) => tx.pg || 'Unknown');
  
  // Bank Level
  const bankLevel = groupBy(nbTxs, (tx) => tx.bankname || 'Unknown');
  
  // Bank Tier Level
  const bankTierLevel = groupBy(nbTxs, (tx) => classifyBankTier(tx.bankname));
  
  // Failure RCA - only analyze technical failures (excludes USER_DROPPED, INIT_FAILED)
  const failures = nbTxs.filter((tx) => tx.isFailed);
  const totalCount = nbTxs.length;
  const successCount = nbTxs.filter((tx) => tx.isSuccess).length;
  
  const failureGroups = new Map<string, Transaction[]>();
  failures.forEach((tx) => {
    const msg = getFailureLabel(tx) || 'Unknown';
    if (!failureGroups.has(msg)) {
      failureGroups.set(msg, []);
    }
    failureGroups.get(msg)!.push(tx);
  });
  
  const failureRCA: FailureRCA[] = Array.from(failureGroups.entries())
    .map(([txmsg, txs]) => {
      const failureCount = txs.length;
      const adjustedSR = calculateSR(
        successCount,
        totalCount - failureCount
      );
      const currentSR = calculateSR(successCount, totalCount);
      
      return {
        txmsg,
        failureCount,
        failurePercent: calculateSR(failureCount, totalCount),
        adjustedSR,
        impact: adjustedSR - currentSR,
      };
    })
    .sort((a, b) => b.failureCount - a.failureCount);
  
  return {
    pgLevel,
    bankLevel,
    bankTierLevel,
    failureRCA,
  };
}


