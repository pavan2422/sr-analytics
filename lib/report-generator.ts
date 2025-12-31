import { Transaction } from '@/types';
import { format, startOfWeek } from 'date-fns';
import { extractUPIHandle } from './data-normalization';

export type ReportType = 'daily' | 'weekly' | 'monthly';

export interface ReportRow {
  [key: string]: any; // Flexible structure for different sheet types
}

/**
 * Compute SR metrics for a group of transactions
 */
function computeSRMetrics(
  transactions: Transaction[],
  totalVolume: number,
  merchantTotals?: Map<string, number>
): {
  Volume: number;
  Success: number;
  'SR (%)': number;
  'SR without User Drops (%)': number;
  UserDrops: number;
  'Unsuccessful Count': number;
  'Total_Value': number;
  GMV: number;
  '% of Volume (Global)': number;
  '% of Volume (Per Merchant)'?: number;
} {
  const volume = transactions.length;
  const success = transactions.filter(tx => tx.isSuccess).length;
  const userDrops = transactions.filter(tx => tx.isUserDropped).length;
  const unsuccessful = volume - success;
  
  const totalValue = transactions.reduce((sum, tx) => sum + (tx.txamount || 0), 0);
  const gmv = transactions
    .filter(tx => tx.isSuccess)
    .reduce((sum, tx) => sum + (tx.txamount || 0), 0);
  
  const sr = volume > 0 ? Number((100 * success / volume).toFixed(2)) : 0;
  
  // SR without user drops
  const nonUserDropTxs = transactions.filter(tx => !tx.isUserDropped);
  const srWithoutDrops = nonUserDropTxs.length > 0
    ? Number((100 * nonUserDropTxs.filter(tx => tx.isSuccess).length / nonUserDropTxs.length).toFixed(2))
    : 0;
  
  const percentGlobal = totalVolume > 0 ? Number((100 * volume / totalVolume).toFixed(2)) : 0;
  
  const result: any = {
    Volume: volume,
    Success: success,
    'SR (%)': sr,
    'SR without User Drops (%)': srWithoutDrops,
    UserDrops: userDrops,
    'Unsuccessful Count': unsuccessful,
    'Total_Value': totalValue,
    GMV: gmv,
    '% of Volume (Global)': percentGlobal,
  };
  
  // Add per-merchant percentage if merchant totals provided
  if (merchantTotals && transactions.length > 0) {
    const merchantId = String(transactions[0].merchantid || '').trim();
    const merchantTotal = merchantTotals.get(merchantId) || 0;
    result['% of Volume (Per Merchant)'] = merchantTotal > 0
      ? Number((100 * volume / merchantTotal).toFixed(2))
      : 0;
  }
  
  return result;
}

/**
 * Generic function to compute SR breakdown by grouping columns
 */
function computeSRBreakdown(
  transactions: Transaction[],
  groupCols: string[]
): ReportRow[] {
  if (transactions.length === 0) return [];
  
  const totalVolume = transactions.length;
  const merchantTotals = new Map<string, number>();
  transactions.forEach(tx => {
    const merchantId = String(tx.merchantid || '').trim();
    merchantTotals.set(merchantId, (merchantTotals.get(merchantId) || 0) + 1);
  });
  
  // Group transactions
  const groups = new Map<string, Transaction[]>();
  
  transactions.forEach(tx => {
    const merchantId = String(tx.merchantid || '').trim();
    
    // Build group key from grouping columns
    const keyParts: string[] = [merchantId];
    for (const col of groupCols) {
      let value: string;
      if (col === 'Day') {
        value = format(tx.txtime, 'yyyy-MM-dd');
      } else if (col === 'Week') {
        // Calculate week start (Monday)
        const weekStart = startOfWeek(tx.txtime, { weekStartsOn: 1 }); // Monday
        value = format(weekStart, 'yyyy-MM-dd');
      } else if (col === 'Month') {
        value = format(tx.txtime, 'yyyy-MM');
      } else if (col === 'paymentmode') {
        value = tx.paymentmode || 'UNKNOWN';
      } else if (col === 'bankname') {
        value = tx.bankname || 'UNKNOWN';
      } else if (col === 'cardtype') {
        value = tx.cardtype || 'UNKNOWN';
      } else if (col === 'upi_psp') {
        value = tx.upi_psp || 'UNKNOWN';
      } else if (col === 'handle') {
        const handle = extractUPIHandle(tx.cardmasked);
        value = handle || 'UNKNOWN';
      } else {
        value = String((tx as any)[col] || 'UNKNOWN');
      }
      keyParts.push(value);
    }
    
    const key = keyParts.join('|');
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(tx);
  });
  
  const rows: ReportRow[] = [];
  
  groups.forEach((groupTxs, key) => {
    const parts = key.split('|');
    const merchantId = parts[0];
    
    const row: ReportRow = {
      MerchantID: merchantId,
    };
    
    // Add grouping column values (use column names as-is: Day, Month, paymentmode, etc.)
    groupCols.forEach((col, idx) => {
      const value = parts[idx + 1] || 'UNKNOWN';
      row[col] = value;
    });
    
    // Add metrics
    const metrics = computeSRMetrics(groupTxs, totalVolume, merchantTotals);
    Object.assign(row, metrics);
    
    rows.push(row);
  });
  
  // Sort by grouping columns (use original column names)
  rows.sort((a, b) => {
    for (const col of groupCols) {
      const aVal = String(a[col] || '');
      const bVal = String(b[col] || '');
      
      if (aVal !== bVal) {
        return aVal.localeCompare(bVal);
      }
    }
    
    // Then by merchant
    if (a.MerchantID !== b.MerchantID) {
      return a.MerchantID.localeCompare(b.MerchantID);
    }
    
    return 0;
  });
  
  return rows;
}

/**
 * Add MoM changes to monthly data
 */
function addMoMChanges(rows: ReportRow[], groupCols: string[]): ReportRow[] {
  if (rows.length <= 1 || !groupCols.includes('Month')) return rows;
  
  const keyCols = groupCols.filter(col => col !== 'Month');
  
  // Group rows by key columns for MoM calculation
  const rowsByKey = new Map<string, ReportRow[]>();
  rows.forEach(row => {
    const key = keyCols.map(col => {
      if (col === 'MerchantID') return row.MerchantID;
      return String(row[col] || '');
    }).join('|');
    
    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, []);
    }
    rowsByKey.get(key)!.push(row);
  });
  
  // Calculate MoM for each group
  rowsByKey.forEach(groupRows => {
    groupRows.sort((a, b) => (a['Month'] || '').localeCompare(b['Month'] || ''));
    
    for (let i = 1; i < groupRows.length; i++) {
      const current = groupRows[i];
      const previous = groupRows[i - 1];
      
      // Volume changes
      current['Volume Δ'] = current.Volume - previous.Volume;
      current['Volume % Change'] = previous.Volume > 0
        ? Number((100 * (current.Volume - previous.Volume) / previous.Volume).toFixed(2))
        : 0;
      
      // SR changes
      current['SR (%) Δ'] = Number((current['SR (%)'] - previous['SR (%)']).toFixed(2));
      current['SR (%) % Change'] = previous['SR (%)'] > 0
        ? Number((100 * (current['SR (%)'] - previous['SR (%)']) / previous['SR (%)']).toFixed(2))
        : 0;
    }
  });
  
  return rows;
}

/**
 * Generate failure analysis sheets
 */
function generateFailureAnalyses(
  transactions: Transaction[],
  timeCol: string
): Map<string, ReportRow[]> {
  const sheets = new Map<string, ReportRow[]>();
  
  const failureTransactions = transactions.filter(tx => !tx.isSuccess);
  
  if (failureTransactions.length === 0) return sheets;
  
  // Check if multi-month data
  const months = new Set(transactions.map(tx => format(tx.txtime, 'yyyy-MM')));
  const isMultiMonth = months.size > 1;
  
  // Failures by Reason (merchantid, paymentmode, txmsg)
  const reasonGroups = new Map<string, Transaction[]>();
  failureTransactions.forEach(tx => {
    const merchantId = String(tx.merchantid || '').trim();
    const paymentMode = tx.paymentmode || 'UNKNOWN';
    const txmsg = tx.txmsg || 'UNKNOWN';
    const key = `${merchantId}|${paymentMode}|${txmsg}`;
    
    if (!reasonGroups.has(key)) {
      reasonGroups.set(key, []);
    }
    reasonGroups.get(key)!.push(tx);
  });
  
  const failuresByReason: ReportRow[] = [];
  reasonGroups.forEach((txs, key) => {
    const [merchantId, paymentMode, txmsg] = key.split('|');
    failuresByReason.push({
      MerchantID: merchantId,
      paymentmode: paymentMode,
      txmsg: txmsg,
      Volume: txs.length,
    });
  });
  failuresByReason.sort((a, b) => b.Volume - a.Volume);
  sheets.set('Failures by Reason', failuresByReason);
  
  // Failures by Time Period (merchantid, timeCol)
  const timeGroups = new Map<string, Transaction[]>();
  failureTransactions.forEach(tx => {
    const merchantId = String(tx.merchantid || '').trim();
    let timeValue: string;
    if (timeCol === 'Day') {
      timeValue = format(tx.txtime, 'yyyy-MM-dd');
    } else if (timeCol === 'Week') {
      const weekStart = startOfWeek(tx.txtime, { weekStartsOn: 1 });
      timeValue = format(weekStart, 'yyyy-MM-dd');
    } else {
      timeValue = format(tx.txtime, 'yyyy-MM');
    }
    const key = `${merchantId}|${timeValue}`;
    
    if (!timeGroups.has(key)) {
      timeGroups.set(key, []);
    }
    timeGroups.get(key)!.push(tx);
  });
  
  const failuresByTime: ReportRow[] = [];
  timeGroups.forEach((txs, key) => {
    const [merchantId, timeValue] = key.split('|');
    failuresByTime.push({
      MerchantID: merchantId,
      [timeCol]: timeValue,
      Volume: txs.length,
    });
  });
  failuresByTime.sort((a, b) => String(a[timeCol] || '').localeCompare(String(b[timeCol] || '')));
  sheets.set(`Failures ${timeCol === 'Day' ? 'Daily' : timeCol === 'Week' ? 'Weekly' : 'Monthly'}`, failuresByTime);
  
  // Failures by Payment Mode and Time (if multi-month for monthly)
  if (isMultiMonth && timeCol === 'Month') {
    const paymodeTimeGroups = new Map<string, Transaction[]>();
    failureTransactions.forEach(tx => {
      const merchantId = String(tx.merchantid || '').trim();
      const paymentMode = tx.paymentmode || 'UNKNOWN';
      const month = format(tx.txtime, 'yyyy-MM');
      const key = `${merchantId}|${paymentMode}|${month}`;
      
      if (!paymodeTimeGroups.has(key)) {
        paymodeTimeGroups.set(key, []);
      }
      paymodeTimeGroups.get(key)!.push(tx);
    });
    
    const paymodeTimeRows: ReportRow[] = [];
    paymodeTimeGroups.forEach((txs, key) => {
      const parts = key.split('|');
      paymodeTimeRows.push({
        MerchantID: parts[0],
        paymentmode: parts[1],
        Month: parts[2],
        Volume: txs.length,
      });
    });
    
    // Sort and add MoM changes
    paymodeTimeRows.sort((a, b) => {
      if (a.Month !== b.Month) return (a.Month || '').localeCompare(b.Month || '');
      if (a.MerchantID !== b.MerchantID) return a.MerchantID.localeCompare(b.MerchantID);
      return 0;
    });
    
    // Add MoM changes
    const rowsByKey = new Map<string, ReportRow[]>();
    paymodeTimeRows.forEach(row => {
      const key = `${row.MerchantID}|${row.paymentmode}`;
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, []);
      }
      rowsByKey.get(key)!.push(row);
    });
    
    rowsByKey.forEach(groupRows => {
      groupRows.sort((a, b) => (a.Month || '').localeCompare(b.Month || ''));
      for (let i = 1; i < groupRows.length; i++) {
        const current = groupRows[i];
        const previous = groupRows[i - 1];
        current['Volume Δ'] = current.Volume - previous.Volume;
        current['Volume % Change'] = previous.Volume > 0
          ? Number((100 * (current.Volume - previous.Volume) / previous.Volume).toFixed(2))
          : 0;
      }
    });
    
    sheets.set('Failures by Paymode Monthly', paymodeTimeRows);
  }
  
  return sheets;
}

/**
 * Generate reports based on report type
 */
export function generateReport(
  transactions: Transaction[],
  reportType: ReportType,
  paymentModes?: string[]
): Map<string, ReportRow[]> {
  const sheets = new Map<string, ReportRow[]>();
  
  if (transactions.length === 0) return sheets;
  
  // Filter by payment modes if specified
  let filteredTxs = transactions;
  if (paymentModes && paymentModes.length > 0) {
    filteredTxs = transactions.filter(tx => paymentModes.includes(tx.paymentmode));
  }
  
  if (filteredTxs.length === 0) return sheets;
  
  // Check if multi-month data (for monthly reports)
  const months = new Set(filteredTxs.map(tx => format(tx.txtime, 'yyyy-MM')));
  const isMultiMonth = months.size > 1;
  
  // Base grouping column based on report type
  let timeCol: string;
  if (reportType === 'daily') {
    timeCol = 'Day';
  } else if (reportType === 'weekly') {
    timeCol = 'Week';
  } else {
    timeCol = 'Month';
  }
  
  // SR by Date/Week/Month
  const timeRows = computeSRBreakdown(filteredTxs, [timeCol]);
  if (reportType === 'monthly' && isMultiMonth) {
    sheets.set(`SR ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`, addMoMChanges(timeRows, [timeCol]));
  } else {
    sheets.set(`SR ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`, timeRows);
  }
  
  // SR by Paymode
  if (transactions.some(tx => tx.paymentmode)) {
    const paymodeRows = computeSRBreakdown(filteredTxs, ['paymentmode']);
    sheets.set('SR by Paymode', paymodeRows);
    
    // Paymode + time breakdown
    const paymodeTimeRows = computeSRBreakdown(filteredTxs, [timeCol, 'paymentmode']);
    if (reportType === 'monthly' && isMultiMonth) {
      sheets.set(`SR by Paymode ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`, addMoMChanges(paymodeTimeRows, [timeCol, 'paymentmode']));
    } else {
      sheets.set(`SR by Paymode ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`, paymodeTimeRows);
    }
  }
  
  // SR by Bank
  if (transactions.some(tx => tx.bankname)) {
    const bankRows = computeSRBreakdown(filteredTxs, ['bankname']);
    sheets.set('SR by Bank', bankRows);
    
    // Paymode + Bank
    if (transactions.some(tx => tx.paymentmode)) {
      const paymodeBankRows = computeSRBreakdown(filteredTxs, ['paymentmode', 'bankname']);
      sheets.set('Paymode+Bank', paymodeBankRows);
    }
  }
  
  // Card Network (filtered to CREDIT_CARD, DEBIT_CARD)
  const cardTransactions = filteredTxs.filter(tx => 
    ['CREDIT_CARD', 'DEBIT_CARD'].includes(tx.paymentmode)
  );
  if (cardTransactions.length > 0 && transactions.some(tx => tx.cardtype)) {
    sheets.set('Card Network', computeSRBreakdown(cardTransactions, ['paymentmode', 'cardtype']));
    
    if (reportType === 'daily') {
      sheets.set('SR by Card Type Daily', computeSRBreakdown(cardTransactions, ['Day', 'paymentmode', 'cardtype']));
    }
  }
  
  // UPI-specific: PSP Level
  const upiTransactions = filteredTxs.filter(tx => 
    ['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'].includes(tx.paymentmode) && tx.upi_psp
  );
  if (upiTransactions.length > 0) {
    const pspRows = computeSRBreakdown(upiTransactions, ['upi_psp']);
    sheets.set('SR by PSP', pspRows);
    
    // PSP + time breakdown
    const pspTimeRows = computeSRBreakdown(upiTransactions, [timeCol, 'upi_psp']);
    if (reportType === 'monthly' && isMultiMonth) {
      sheets.set(`SR by PSP ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`, addMoMChanges(pspTimeRows, [timeCol, 'upi_psp']));
    } else {
      sheets.set(`SR by PSP ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`, pspTimeRows);
    }
  }
  
  // UPI-specific: Handle Level
  const upiWithHandles = filteredTxs.filter(tx => {
    if (!['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'].includes(tx.paymentmode)) return false;
    const handle = extractUPIHandle(tx.cardmasked);
    return handle !== null;
  });
  if (upiWithHandles.length > 0) {
    const handleRows = computeSRBreakdown(upiWithHandles, ['handle']);
    // Sort by volume descending and take top handles
    handleRows.sort((a, b) => b.Volume - a.Volume);
    sheets.set('SR by Handle', handleRows);
    
    // Handle + time breakdown
    const handleTimeRows = computeSRBreakdown(upiWithHandles, [timeCol, 'handle']);
    handleTimeRows.sort((a, b) => {
      const timeCompare = String(a[timeCol] || '').localeCompare(String(b[timeCol] || ''));
      if (timeCompare !== 0) return timeCompare;
      return b.Volume - a.Volume;
    });
    sheets.set(`SR by Handle ${reportType.charAt(0).toUpperCase() + reportType.slice(1)}`, handleTimeRows);
  }
  
  // Add failure analysis sheets
  const failureSheets = generateFailureAnalyses(filteredTxs, timeCol);
  failureSheets.forEach((data, name) => {
    sheets.set(name, data);
  });
  
  return sheets;
}
