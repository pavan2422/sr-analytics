import { Transaction, VolumeMixChange } from '@/types';
import { calculateSR } from '@/lib/utils';
import { classifyUPIFlow, classifyCardScope, extractUPIHandle } from '@/lib/data-normalization';

type PaymentMode = 'ALL' | 'UPI' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'PREPAID_CARD' | 'NETBANKING';

interface DimensionConfig {
  name: string;
  getValue: (tx: Transaction) => string;
}

function getVolumeMixDimensions(paymentMode: PaymentMode): DimensionConfig[] {
  switch (paymentMode) {
    case 'UPI':
      return [
        { name: 'Flow Type', getValue: (tx) => classifyUPIFlow(tx.bankname) },
        { name: 'Handle', getValue: (tx) => extractUPIHandle(tx.cardmasked) || 'Unknown' },
        { name: 'PSP', getValue: (tx) => tx.upi_psp || 'Unknown' },
      ];
    case 'CREDIT_CARD':
    case 'DEBIT_CARD':
    case 'PREPAID_CARD':
      return [
        { name: 'Card Type', getValue: (tx) => tx.cardtype || 'Unknown' },
        { name: 'Card Scope', getValue: (tx) => classifyCardScope(tx.cardcountry) },
        { name: 'Bank', getValue: (tx) => tx.bankname || 'Unknown' },
      ];
    case 'NETBANKING':
      return [
        { name: 'Bank', getValue: (tx) => tx.bankname || 'Unknown' },
      ];
    case 'ALL':
      return [
        { name: 'Payment Mode', getValue: (tx) => tx.paymentmode || 'Unknown' },
      ];
    default:
      return [];
  }
}

/**
 * Analyze volume mix changes: which dimension values increased/decreased in volume
 * This analyzes ALL transactions (not just failures) to see volume shifts
 */
export function analyzeVolumeMixChanges(
  currentPeriod: Transaction[],
  previousPeriod: Transaction[],
  paymentMode: PaymentMode
): VolumeMixChange[] {
  const dimensions = getVolumeMixDimensions(paymentMode);
  const changes: VolumeMixChange[] = [];

  const currentTotalVolume = currentPeriod.length;
  const previousTotalVolume = previousPeriod.length;
  const overallCurrentSR = currentTotalVolume > 0
    ? calculateSR(
        currentPeriod.filter(tx => tx.isSuccess).length,
        currentTotalVolume
      )
    : 0;
  const overallPreviousSR = previousTotalVolume > 0
    ? calculateSR(
        previousPeriod.filter(tx => tx.isSuccess).length,
        previousTotalVolume
      )
    : 0;

  dimensions.forEach((dimension) => {
    // Group current period transactions by dimension value
    const currentGroups = new Map<string, Transaction[]>();
    currentPeriod.forEach((tx) => {
      const value = dimension.getValue(tx);
      if (!currentGroups.has(value)) {
        currentGroups.set(value, []);
      }
      currentGroups.get(value)!.push(tx);
    });

    // Group previous period transactions by dimension value
    const previousGroups = new Map<string, Transaction[]>();
    previousPeriod.forEach((tx) => {
      const value = dimension.getValue(tx);
      if (!previousGroups.has(value)) {
        previousGroups.set(value, []);
      }
      previousGroups.get(value)!.push(tx);
    });

    // Analyze each dimension value
    const allValues = new Set([...currentGroups.keys(), ...previousGroups.keys()]);

    allValues.forEach((value) => {
      const currentTxs = currentGroups.get(value) || [];
      const previousTxs = previousGroups.get(value) || [];

      // Skip if both periods have no data
      if (currentTxs.length === 0 && previousTxs.length === 0) return;

      const currentVolume = currentTxs.length;
      const previousVolume = previousTxs.length;
      const volumeDelta = currentVolume - previousVolume;
      const volumeDeltaPercent = previousVolume > 0
        ? ((currentVolume - previousVolume) / previousVolume) * 100
        : currentVolume > 0 ? 100 : 0;

      // Calculate volume share (% of total transactions)
      const volumeShareCurrent = currentTotalVolume > 0
        ? (currentVolume / currentTotalVolume) * 100
        : 0;
      const volumeSharePrevious = previousTotalVolume > 0
        ? (previousVolume / previousTotalVolume) * 100
        : 0;
      const volumeShareDelta = volumeShareCurrent - volumeSharePrevious;

      // Calculate SR for this dimension value
      const currentSuccessCount = currentTxs.filter(tx => tx.isSuccess).length;
      const previousSuccessCount = previousTxs.filter(tx => tx.isSuccess).length;
      const currentSR = calculateSR(currentSuccessCount, currentVolume);
      const previousSR = calculateSR(previousSuccessCount, previousVolume);
      const srDelta = currentSR - previousSR;

      // Calculate impact on overall SR
      // Impact = (segment SR - overall SR) * (change in volume share)
      // If a low-SR segment's volume share increases, it negatively impacts overall SR
      const impactOnOverallSR = (currentSR - overallCurrentSR) * (volumeShareDelta / 100);

      changes.push({
        dimension: dimension.name,
        dimensionValue: value,
        currentVolume,
        previousVolume,
        volumeDelta,
        volumeDeltaPercent,
        volumeShareCurrent,
        volumeSharePrevious,
        volumeShareDelta,
        currentSR,
        previousSR,
        srDelta,
        impactOnOverallSR,
      });
    });
  });

  // Sort by impact (most negative first - volume shifts that hurt SR)
  changes.sort((a, b) => a.impactOnOverallSR - b.impactOnOverallSR);

  return changes;
}







