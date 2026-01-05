'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { computePeriodComparison, computeUserDroppedAnalysis } from '@/lib/rca';
import { KPICard } from '@/components/KPICard';
import { formatNumber, formatCurrency } from '@/lib/utils';
import { RCAInsight, DimensionAnalysis, VolumeMixChange, Transaction } from '@/types';
import { subDays, format } from 'date-fns';
import { compareCustomerSegments, getCustomerTypeLabel, getCustomerTypeDescription, CustomerType } from '@/lib/customer-analytics';
import { detectProblematicCustomers } from '@/lib/customer-analytics';
import { classifyUPIFlow, classifyCardScope, extractUPIHandle } from '@/lib/data-normalization';
import { getFailureCategory, getFailureLabel } from '@/lib/failure-utils';

type PaymentMode = 'ALL' | 'UPI' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'PREPAID_CARD' | 'NETBANKING';

export function RCATab() {
  // Use selectors - but DON'T load all transactions into memory
  const _useIndexedDB = useStore((state) => state._useIndexedDB);
  const _useBackend = useStore((state) => state._useBackend);
  const backendUploadId = useStore((state) => state.backendUploadId);
  const filteredTransactionCount = useStore((state) => state.filteredTransactionCount);
  const filteredTransactions = useStore((state) => state.filteredTransactions);
  const getSampleFilteredTransactions = useStore((state) => state.getSampleFilteredTransactions);
  const getFilteredTimeBounds = useStore((state) => state.getFilteredTimeBounds);
  const filters = useStore((state) => state.filters);
  const [periodDays, setPeriodDays] = useState(7);
  const [selectedPaymentMode, setSelectedPaymentMode] = useState<PaymentMode>('ALL');
  const [comparison, setComparison] = useState<any>(null);
  const [isComputing, setIsComputing] = useState(false);

  // Compute comparison using either:
  // - in-memory filteredTransactions (small files)
  // - bounded IndexedDB samples for current/previous period (large files)
  useEffect(() => {
    if (filteredTransactionCount === 0) {
      setComparison(null);
      return;
    }

    setIsComputing(true);
    const computeAsync = async () => {
      try {
        if (_useIndexedDB && _useBackend) {
          if (!backendUploadId) {
            setComparison(null);
            setIsComputing(false);
            return;
          }
          const { retryApiCall } = await import('@/lib/retry-api');
          const res = await retryApiCall(async () => {
            const r = await fetch(`/api/uploads/${backendUploadId}/rca`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                periodDays,
                selectedPaymentMode,
                filters: {
                  startDate: filters.dateRange.start ? filters.dateRange.start.toISOString() : null,
                  endDate: filters.dateRange.end ? filters.dateRange.end.toISOString() : null,
                  paymentModes: filters.paymentModes || [],
                  merchantIds: filters.merchantIds || [],
                  pgs: filters.pgs || [],
                  banks: filters.banks || [],
                  cardTypes: filters.cardTypes || [],
                },
              }),
            });
            if (!r.ok) {
              const msg = await r.text().catch(() => '');
              throw new Error(`Failed to compute backend RCA (${r.status}): ${msg}`);
            }
            return r;
          }, 5, undefined, backendUploadId);
          const json = (await res.json()) as any;
          setComparison({
            comparison: json.comparison,
            userDroppedAnalysis: json.userDroppedAnalysis,
            customerAnalytics: json.customerAnalytics,
            problematicCustomers: json.problematicCustomers,
            currentPeriodTransactions: [],
            periods: json.periods,
          });
          setIsComputing(false);
          return;
        }

        let currentFiltered: Transaction[] = [];
        let previousFiltered: Transaction[] = [];

        if (_useIndexedDB) {
          // Efficiently find bounds using the txtime index, then sample per-period.
          const bounds = await getFilteredTimeBounds();
          const currentPeriodEnd = bounds.max || new Date();
          const currentPeriodStart = subDays(currentPeriodEnd, periodDays);
          const previousPeriodEnd = subDays(currentPeriodStart, 1);
          const previousPeriodStart = subDays(previousPeriodEnd, periodDays);

          // Sample current + previous from IndexedDB (bounded, memory-safe).
          currentFiltered = await getSampleFilteredTransactions(25000, {
            startDate: currentPeriodStart,
            endDate: currentPeriodEnd,
          });
          previousFiltered = await getSampleFilteredTransactions(25000, {
            startDate: previousPeriodStart,
            endDate: previousPeriodEnd,
          });
        } else {
          // Small dataset path: compute exact periods from the in-memory filtered set.
          const times = filteredTransactions.map((t) => t.txtime.getTime());
          const maxTime = times.length ? Math.max(...times) : Date.now();
          const currentPeriodEnd = new Date(maxTime);
          const currentPeriodStart = subDays(currentPeriodEnd, periodDays);
          const previousPeriodEnd = subDays(currentPeriodStart, 1);
          const previousPeriodStart = subDays(previousPeriodEnd, periodDays);

          currentFiltered = filteredTransactions.filter(
            (tx) => tx.txtime >= currentPeriodStart && tx.txtime <= currentPeriodEnd
          );
          previousFiltered = filteredTransactions.filter(
            (tx) => tx.txtime >= previousPeriodStart && tx.txtime <= previousPeriodEnd
          );
        }

        if (currentFiltered.length === 0) {
          setComparison(null);
          setIsComputing(false);
          return;
        }

        const result = {
          comparison: computePeriodComparison(currentFiltered, previousFiltered, selectedPaymentMode),
          userDroppedAnalysis: computeUserDroppedAnalysis(currentFiltered, previousFiltered, selectedPaymentMode),
          customerAnalytics: compareCustomerSegments(currentFiltered, previousFiltered),
          problematicCustomers: detectProblematicCustomers(currentFiltered),
          currentPeriodTransactions: currentFiltered,
        };

        setComparison(result);
      } catch (error) {
        console.error('Error computing RCA:', error);
        setComparison(null);
      } finally {
        setIsComputing(false);
      }
    };

    computeAsync();
  }, [
    _useIndexedDB,
    _useBackend,
    backendUploadId,
    filteredTransactionCount,
    periodDays,
    selectedPaymentMode,
    filteredTransactions,
    getSampleFilteredTransactions,
    getFilteredTimeBounds,
    filters,
  ]);

  if (isComputing) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Computing RCA analysis...</p>
        </div>
      </div>
    );
  }

  if (!comparison || !comparison.comparison) {
    return (
      <div className="flex items-center justify-center p-12">
        <p className="text-muted-foreground">No data available for comparison.</p>
      </div>
    );
  }

  const { comparison: rcaComparison, userDroppedAnalysis, customerAnalytics, problematicCustomers } = comparison;

  const getPrimaryCauseBadgeColor = (cause: string) => {
    switch (cause) {
      case 'VOLUME_MIX':
        return 'bg-blue-500/20 text-blue-300 border-blue-500/50';
      case 'FAILURE_SPIKE':
        return 'bg-red-500/20 text-red-300 border-red-500/50';
      case 'SEGMENT_DEGRADATION':
        return 'bg-orange-500/20 text-orange-300 border-orange-500/50';
      case 'MIXED':
        return 'bg-purple-500/20 text-purple-300 border-purple-500/50';
      default:
        return 'bg-gray-500/20 text-gray-300 border-gray-500/50';
    }
  };

  const getSRMovementColor = (movement: string) => {
    switch (movement) {
      case 'SR_DROP':
        return 'text-red-400';
      case 'SR_IMPROVEMENT':
        return 'text-green-400';
      default:
        return 'text-gray-400';
    }
  };

  return (
    <div className="space-y-6">
      {/* Global Controls */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Payment Mode Selector */}
          <div>
            <label className="block text-sm font-medium mb-2">
              Payment Mode (Primary Filter)
            </label>
            <select
              value={selectedPaymentMode}
              onChange={(e) => setSelectedPaymentMode(e.target.value as PaymentMode)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="ALL">ALL</option>
              <option value="UPI">UPI</option>
              <option value="CREDIT_CARD">CREDIT_CARD</option>
              <option value="DEBIT_CARD">DEBIT_CARD</option>
              <option value="PREPAID_CARD">PREPAID_CARD</option>
              <option value="NETBANKING">NETBANKING</option>
            </select>
          </div>

          {/* Time Comparison Selector */}
          <div>
        <label className="block text-sm font-medium mb-2">
          Comparison Period (Days)
        </label>
        <select
          value={periodDays}
          onChange={(e) => setPeriodDays(Number(e.target.value))}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {Array.from({ length: 30 }, (_, i) => i + 1).map((days) => (
                <option key={days} value={days}>
                  {days} {days === 1 ? 'Day' : 'Days'}
                </option>
              ))}
        </select>
          </div>
        </div>

        {/* Period Info */}
        <div className="text-sm text-muted-foreground">
          {comparison && comparison.comparison && (() => {
            // Use comparison data instead of iterating transactions
            const maxDate = new Date();
            const currentPeriodEnd = maxDate;
            const currentPeriodStart = subDays(currentPeriodEnd, periodDays);
            const previousPeriodEnd = subDays(currentPeriodStart, 1);
            const previousPeriodStart = subDays(previousPeriodEnd, periodDays);
            
            return (
              <>
                <p>
                  Current Period: {format(currentPeriodStart, 'MMM d, yyyy')} - {format(currentPeriodEnd, 'MMM d, yyyy')}
                </p>
                <p>
                  Previous Period: {format(previousPeriodStart, 'MMM d, yyyy')} - {format(previousPeriodEnd, 'MMM d, yyyy')}
                </p>
              </>
            );
          })()}
        </div>
      </div>

      {/* Top Summary Panel */}
      <div className="bg-card border border-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">RCA Summary</h2>
          <div className="text-sm text-muted-foreground">
            Analyzing: <span className="font-medium text-foreground">{selectedPaymentMode}</span>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <KPICard
          title="SR Delta"
            value={`${rcaComparison.srDelta >= 0 ? '+' : ''}${rcaComparison.srDelta.toFixed(2)}%`}
            variant={rcaComparison.srDelta >= 0 ? 'success' : 'error'}
        />
        <KPICard
          title="Volume Delta"
            value={`${rcaComparison.volumeDelta >= 0 ? '+' : ''}${rcaComparison.volumeDelta.toFixed(1)}%`}
            variant={rcaComparison.volumeDelta >= 0 ? 'success' : 'error'}
        />
        <KPICard
          title="Current SR"
            value={`${rcaComparison.current.sr.toFixed(2)}%`}
            variant={rcaComparison.current.sr >= 95 ? 'success' : rcaComparison.current.sr >= 90 ? 'warning' : 'error'}
        />
        <KPICard
          title="Previous SR"
            value={`${rcaComparison.previous.sr.toFixed(2)}%`}
            variant={rcaComparison.previous.sr >= 95 ? 'success' : rcaComparison.previous.sr >= 90 ? 'warning' : 'error'}
          />
        </div>

        {/* Primary Cause Badge */}
        <div className="flex items-center gap-4 mt-4">
          <div className="text-sm font-medium text-muted-foreground">Primary Cause:</div>
          <div className={`px-3 py-1 rounded-full border text-sm font-medium ${getPrimaryCauseBadgeColor(rcaComparison.primaryCause)}`}>
            {rcaComparison.primaryCause.replace('_', ' ')}
          </div>
          <div className={`text-sm font-medium ${getSRMovementColor(rcaComparison.srMovement)}`}>
            {rcaComparison.srMovement.replace('_', ' ')}
          </div>
        </div>
      </div>

      {/* Detailed Metrics Table */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Period Comparison Details</h3>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 text-sm font-semibold text-muted-foreground">Metric</th>
                <th className="text-right py-3 px-4 text-sm font-semibold text-muted-foreground">Current</th>
                <th className="text-right py-3 px-4 text-sm font-semibold text-muted-foreground">Previous</th>
                <th className="text-right py-3 px-4 text-sm font-semibold text-muted-foreground">Delta</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="py-3 px-4">Total Volume</td>
                <td className="text-right py-3 px-4">{formatNumber(rcaComparison.current.totalCount)}</td>
                <td className="text-right py-3 px-4">{formatNumber(rcaComparison.previous.totalCount)}</td>
                <td className="text-right py-3 px-4">
                  {formatNumber(rcaComparison.current.totalCount - rcaComparison.previous.totalCount)}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="py-3 px-4">Success Count</td>
                <td className="text-right py-3 px-4">{formatNumber(rcaComparison.current.successCount)}</td>
                <td className="text-right py-3 px-4">{formatNumber(rcaComparison.previous.successCount)}</td>
                <td className="text-right py-3 px-4">
                  <span className={rcaComparison.successCountDelta >= 0 ? 'text-success' : 'text-error'}>
                    {formatNumber(rcaComparison.successCountDelta)}
                  </span>
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="py-3 px-4">Failed Count</td>
                <td className="text-right py-3 px-4">{formatNumber(rcaComparison.current.failedCount)}</td>
                <td className="text-right py-3 px-4">{formatNumber(rcaComparison.previous.failedCount)}</td>
                <td className="text-right py-3 px-4">
                  <span className={rcaComparison.failedCountDelta > 0 ? 'text-error' : 'text-success'}>
                    {formatNumber(rcaComparison.failedCountDelta)}
                  </span>
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="py-3 px-4">User Dropped Count</td>
                <td className="text-right py-3 px-4">{formatNumber(rcaComparison.current.userDroppedCount)}</td>
                <td className="text-right py-3 px-4">{formatNumber(rcaComparison.previous.userDroppedCount)}</td>
                <td className="text-right py-3 px-4">
                  <span className={rcaComparison.userDroppedDelta > 0 ? 'text-warning' : 'text-success'}>
                    {formatNumber(rcaComparison.userDroppedDelta)}
                  </span>
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="py-3 px-4">Failed Rate</td>
                <td className="text-right py-3 px-4">{rcaComparison.failedRateCurrent.toFixed(2)}%</td>
                <td className="text-right py-3 px-4">{rcaComparison.failedRatePrevious.toFixed(2)}%</td>
                <td className="text-right py-3 px-4">
                  <span className={(rcaComparison.failedRateCurrent - rcaComparison.failedRatePrevious) > 0 ? 'text-error' : 'text-success'}>
                    {((rcaComparison.failedRateCurrent - rcaComparison.failedRatePrevious) >= 0 ? '+' : '')}
                    {(rcaComparison.failedRateCurrent - rcaComparison.failedRatePrevious).toFixed(2)}%
                  </span>
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="py-3 px-4">Success GMV</td>
                <td className="text-right py-3 px-4">{formatCurrency(rcaComparison.current.successGmv)}</td>
                <td className="text-right py-3 px-4">{formatCurrency(rcaComparison.previous.successGmv)}</td>
                <td className="text-right py-3 px-4">
                  {formatCurrency(rcaComparison.current.successGmv - rcaComparison.previous.successGmv)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* RCA Insight Feed */}
      <div className="bg-card border border-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Root Cause Analysis Insights</h3>
          <div className="text-sm text-muted-foreground">
            Payment Mode: <span className="font-medium text-foreground">{selectedPaymentMode}</span>
          </div>
        </div>
        {rcaComparison.insights.length === 0 ? (
          <p className="text-muted-foreground">No significant issues detected. SR is stable or improving.</p>
        ) : (
          <div className="space-y-4">
            {rcaComparison.insights.map((insight: RCAInsight, index: number) => (
              <InsightCard key={index} insight={insight} rank={index + 1} paymentMode={selectedPaymentMode} />
            ))}
          </div>
        )}
      </div>

      {/* Volume Mix Changes Section */}
      {rcaComparison.volumeMixChanges && rcaComparison.volumeMixChanges.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Volume Mix Changes Analysis</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Analysis of volume shifts across dimensions that led to SR changes. Shows which segment volumes increased/decreased.
          </p>
          <VolumeMixChangesPanel changes={rcaComparison.volumeMixChanges} paymentMode={selectedPaymentMode} />
        </div>
      )}

      {/* Retry Customers Table */}
      {problematicCustomers && problematicCustomers.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Problematic Retry Customers</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Customers with substantial retries (10+ retry attempts) and very low SR (&lt;1%) on retry transactions
          </p>
          <RetryCustomersTable customers={problematicCustomers} paymentMode={selectedPaymentMode} />
        </div>
      )}

      {/* Customer Analytics Panel */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Customer Analytics</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Analysis of customer segments and their impact on SR
        </p>
        <CustomerAnalyticsPanel analytics={customerAnalytics} paymentMode={selectedPaymentMode} />
      </div>

      {/* Dimension Deep-Dive Panel */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Dimension Deep-Dive</h3>
        <DimensionDeepDive 
          failedAnalyses={rcaComparison.dimensionAnalyses} 
          userDroppedAnalyses={userDroppedAnalysis.dimensionAnalyses}
          currentPeriodTransactions={(comparison.currentPeriodTransactions || []) as Transaction[]}
          selectedPaymentMode={selectedPaymentMode}
          backendContext={
            _useIndexedDB && _useBackend && backendUploadId && comparison?.periods?.current
              ? {
                  uploadId: backendUploadId,
                  periodStart: comparison.periods.current.start,
                  periodEnd: comparison.periods.current.end,
                  filters: {
                    startDate: filters.dateRange.start ? filters.dateRange.start.toISOString() : null,
                    endDate: filters.dateRange.end ? filters.dateRange.end.toISOString() : null,
                    paymentModes: filters.paymentModes || [],
                    merchantIds: filters.merchantIds || [],
                    pgs: filters.pgs || [],
                    banks: filters.banks || [],
                    cardTypes: filters.cardTypes || [],
                  },
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}

function InsightCard({ insight, rank, paymentMode }: { insight: RCAInsight; rank: number; paymentMode: PaymentMode }) {
  const [expanded, setExpanded] = useState(false);

  const getConfidenceColor = (confidence: string) => {
    switch (confidence) {
      case 'HIGH':
        return 'bg-blue-500/20 text-blue-300 border-blue-500/50';
      case 'MEDIUM':
        return 'bg-yellow-500/20 text-yellow-300 border-yellow-500/50';
      case 'LOW':
        return 'bg-gray-500/20 text-gray-300 border-gray-500/50';
      default:
        return 'bg-gray-500/20 text-gray-300 border-gray-500/50';
    }
  };

  // Determine if this is a failure-related insight (should be red)
  const isFailureRelated = 
    insight.rootCause.toLowerCase().includes('failure') ||
    insight.rootCause.toLowerCase().includes('rate increase') ||
    insight.rootCause.toLowerCase().includes('spike') ||
    insight.rootCause.toLowerCase().includes('explosion') ||
    insight.rootCause.toLowerCase().includes('drop');

  // For failure-related insights, always show in red (bad situation)
  // For SR improvements, show in green (good situation)
  const getImpactColor = () => {
    if (isFailureRelated) {
      return 'text-error'; // Failures are always bad, show in red
    }
    // For SR improvements or other positive insights
    return insight.srDrop >= 0 ? 'text-success' : 'text-error';
  };

  return (
    <div className="p-4 bg-muted rounded-lg border border-border hover:border-primary/50 transition-colors">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-start gap-3 flex-1">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-sm font-bold text-primary">
            #{rank}
          </div>
          <div className="flex-1">
          <div className="font-medium text-foreground">{insight.rootCause}</div>
            <div className="text-sm text-muted-foreground mt-1">
              {insight.dimension}
              {insight.dimensionValue && ` • ${insight.dimensionValue}`}
            </div>
          </div>
        </div>
        <div className="text-right ml-4">
          {isFailureRelated && insight.counterfactualSR ? (
            <>
              <div className={`text-lg font-bold ${getImpactColor()}`}>
                +{insight.impact.toFixed(2)}%
              </div>
              <div className="text-xs text-muted-foreground">
                SR impact if fixed
              </div>
            </>
          ) : (
            <>
              <div className={`text-lg font-bold ${getImpactColor()}`}>
            {insight.srDrop >= 0 ? '+' : ''}{insight.srDrop.toFixed(2)}%
          </div>
          <div className="text-xs text-muted-foreground">
            {insight.impactedVolumePercent.toFixed(1)}% volume
              </div>
            </>
          )}
          <div className={`text-xs mt-1 px-2 py-0.5 rounded border ${getConfidenceColor(insight.confidence)}`}>
            {insight.confidence}
          </div>
        </div>
      </div>
      
      <p className="text-sm text-foreground mt-2">{insight.statement}</p>

      {insight.counterfactualSR && (
        <div className="mt-2 text-sm text-muted-foreground">
          <span className="font-medium">Counterfactual:</span> If this issue didn&apos;t exist, <span className="font-medium text-foreground">{paymentMode}</span> SR would be{' '}
          <span className="text-primary font-medium">{insight.counterfactualSR.toFixed(2)}%</span>
        </div>
      )}

      {insight.evidence && insight.evidence.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-sm text-primary hover:underline"
          >
            {expanded ? 'Hide' : 'Show'} Evidence ({insight.evidence.length})
          </button>
          {expanded && (
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground list-disc list-inside">
              {insight.evidence.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function CustomerAnalyticsPanel({ 
  analytics, 
  paymentMode 
}: { 
  analytics: ReturnType<typeof compareCustomerSegments>; 
  paymentMode: PaymentMode;
}) {
  const paymentModeText = paymentMode === 'ALL' ? 'Overall' : paymentMode;
  
  // Filter deltas that show significant negative impact
  const significantDeltas = analytics.deltas.filter(
    delta => delta.impactDelta < -0.1 || delta.srDelta < -1
  );

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-muted rounded-lg p-4 border border-border">
          <div className="text-sm text-muted-foreground mb-1">Retry Customers SR</div>
          <div className={`text-2xl font-bold ${analytics.current.retryCustomerSR < analytics.current.overallSR ? 'text-error' : 'text-success'}`}>
            {analytics.current.retryCustomerSR.toFixed(2)}%
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            vs Overall {analytics.current.overallSR.toFixed(2)}%
          </div>
        </div>
        <div className="bg-muted rounded-lg p-4 border border-border">
          <div className="text-sm text-muted-foreground mb-1">Single Attempt SR</div>
          <div className={`text-2xl font-bold ${analytics.current.singleAttemptSR < analytics.current.overallSR ? 'text-error' : 'text-success'}`}>
            {analytics.current.singleAttemptSR.toFixed(2)}%
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            vs Overall {analytics.current.overallSR.toFixed(2)}%
          </div>
        </div>
        <div className="bg-muted rounded-lg p-4 border border-border">
          <div className="text-sm text-muted-foreground mb-1">High Value SR</div>
          <div className={`text-2xl font-bold ${analytics.current.highValueSR < analytics.current.overallSR ? 'text-error' : 'text-success'}`}>
            {analytics.current.highValueSR.toFixed(2)}%
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            vs Overall {analytics.current.overallSR.toFixed(2)}%
          </div>
        </div>
        <div className="bg-muted rounded-lg p-4 border border-border">
          <div className="text-sm text-muted-foreground mb-1">Low Value SR</div>
          <div className={`text-2xl font-bold ${analytics.current.lowValueSR < analytics.current.overallSR ? 'text-error' : 'text-success'}`}>
            {analytics.current.lowValueSR.toFixed(2)}%
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            vs Overall {analytics.current.overallSR.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Customer Segments Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 px-3 font-semibold text-muted-foreground">Customer Type</th>
              <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Volume</th>
              <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Volume Δ</th>
              <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Current SR</th>
              <th className="text-right py-2 px-3 font-semibold text-muted-foreground">SR Δ</th>
              <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Impact on SR</th>
              <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Failure Rate</th>
            </tr>
          </thead>
          <tbody>
            {analytics.current.segments.map((segment, idx) => {
              const delta = analytics.deltas.find(d => d.customerType === segment.customerType);
              const previousSegment = analytics.previous.segments.find(
                s => s.customerType === segment.customerType
              );
              
              return (
                <tr
                  key={idx}
                  className={`border-b border-border ${
                    segment.impactOnSR < -0.5 ? 'bg-red-500/5' : ''
                  }`}
                >
                  <td className="py-2 px-3">
                    <div className="font-medium">{getCustomerTypeLabel(segment.customerType)}</div>
                    <div className="text-xs text-muted-foreground">
                      {getCustomerTypeDescription(segment.customerType)}
                    </div>
                  </td>
                  <td className="text-right py-2 px-3">
                    {formatNumber(segment.volume)}
                  </td>
                  <td className="text-right py-2 px-3">
                    {delta && (
                      <span className={delta.volumeDelta > 0 ? 'text-success' : 'text-error'}>
                        {delta.volumeDelta >= 0 ? '+' : ''}{formatNumber(delta.volumeDelta)}
                      </span>
                    )}
                  </td>
                  <td className="text-right py-2 px-3">
                    <span className={segment.sr < analytics.current.overallSR ? 'text-error' : 'text-success'}>
                      {segment.sr.toFixed(2)}%
                    </span>
                  </td>
                  <td className="text-right py-2 px-3">
                    {delta && (
                      <span className={delta.srDelta < 0 ? 'text-error' : 'text-success'}>
                        {delta.srDelta >= 0 ? '+' : ''}{delta.srDelta.toFixed(2)}%
                      </span>
                    )}
                  </td>
                  <td className="text-right py-2 px-3">
                    <span className={segment.impactOnSR < 0 ? 'text-error' : 'text-success'}>
                      {segment.impactOnSR >= 0 ? '+' : ''}{segment.impactOnSR.toFixed(3)}%
                    </span>
                  </td>
                  <td className="text-right py-2 px-3">
                    {segment.failureRate.toFixed(2)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Key Insights */}
      {significantDeltas.length > 0 && (
        <div className="mt-6 p-4 bg-muted rounded-lg border border-border">
          <h4 className="font-semibold mb-3 text-foreground">Key Customer Insights</h4>
          <ul className="space-y-2 text-sm">
            {significantDeltas.slice(0, 3).map((delta, idx) => {
              const segment = analytics.current.segments.find(s => s.customerType === delta.customerType);
              if (!segment) return null;
              
              return (
                <li key={idx} className="text-foreground">
                  <span className="font-medium">{getCustomerTypeLabel(delta.customerType)}</span>
                  {' '}volume {delta.volumeDelta > 0 ? 'increased' : 'decreased'} by {Math.abs(delta.volumeDelta)}, 
                  SR {delta.srDelta < 0 ? 'dropped' : 'improved'} by {Math.abs(delta.srDelta).toFixed(2)}%, 
                  impacting {paymentModeText} SR by{' '}
                  <span className={delta.impactDelta < 0 ? 'text-error font-medium' : 'text-success font-medium'}>
                    {delta.impactDelta >= 0 ? '+' : ''}{delta.impactDelta.toFixed(3)}%
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function VolumeMixChangesPanel({ 
  changes, 
  paymentMode 
}: { 
  changes: VolumeMixChange[]; 
  paymentMode: PaymentMode;
}) {
  // Group changes by dimension
  const changesByDimension = new Map<string, VolumeMixChange[]>();
  
  changes.forEach((change) => {
    if (!changesByDimension.has(change.dimension)) {
      changesByDimension.set(change.dimension, []);
    }
    changesByDimension.get(change.dimension)!.push(change);
  });

  // Filter to show only significant changes (volume share delta > 1% or impact > 0.1%)
  const significantChanges = changes.filter(
    (c) => Math.abs(c.volumeShareDelta) > 1 || Math.abs(c.impactOnOverallSR) > 0.1
  );

  if (significantChanges.length === 0) {
    return (
      <p className="text-muted-foreground">No significant volume mix changes detected.</p>
    );
  }

  return (
    <div className="space-y-6">
      {Array.from(changesByDimension.entries()).map(([dimension, dimensionChanges]) => {
        const significantDimensionChanges = dimensionChanges.filter(
          (c) => Math.abs(c.volumeShareDelta) > 1 || Math.abs(c.impactOnOverallSR) > 0.1
        );

        if (significantDimensionChanges.length === 0) return null;

        return (
          <div key={dimension} className="space-y-2">
            <h4 className="text-md font-semibold text-foreground">{dimension}</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-3 font-semibold text-muted-foreground">{dimension} Value</th>
                    <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Current Volume</th>
                    <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Volume Δ</th>
                    <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Volume Share</th>
                    <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Share Δ</th>
                    <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Current SR</th>
                    <th className="text-right py-2 px-3 font-semibold text-muted-foreground">SR Δ</th>
                    <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Impact on SR</th>
                  </tr>
                </thead>
                <tbody>
                  {significantDimensionChanges
                    .sort((a, b) => Math.abs(b.impactOnOverallSR) - Math.abs(a.impactOnOverallSR))
                    .map((change, idx) => (
                      <tr
                        key={idx}
                        className={`border-b border-border ${
                          change.impactOnOverallSR < -0.1 ? 'bg-red-500/5' : ''
                        }`}
                      >
                        <td className="py-2 px-3 font-medium">
                          {change.dimensionValue}
                          {change.dimensionValue === 'Unknown' && (
                            <span className="text-xs text-muted-foreground ml-1">(missing data)</span>
                          )}
                        </td>
                        <td className="text-right py-2 px-3">
                          {formatNumber(change.currentVolume)}
                        </td>
                        <td className="text-right py-2 px-3">
                          <span className={change.volumeDelta > 0 ? 'text-success' : change.volumeDelta < 0 ? 'text-error' : ''}>
                            {change.volumeDelta >= 0 ? '+' : ''}{formatNumber(change.volumeDelta)}
                            {' '}
                            <span className="text-xs text-muted-foreground">
                              ({change.volumeDeltaPercent >= 0 ? '+' : ''}{change.volumeDeltaPercent.toFixed(1)}%)
                            </span>
                          </span>
                        </td>
                        <td className="text-right py-2 px-3">
                          {change.volumeShareCurrent.toFixed(2)}%
                        </td>
                        <td className="text-right py-2 px-3">
                          <span className={change.volumeShareDelta > 0 ? 'text-error' : change.volumeShareDelta < 0 ? 'text-success' : ''}>
                            {change.volumeShareDelta >= 0 ? '+' : ''}{change.volumeShareDelta.toFixed(2)}%
                          </span>
                        </td>
                        <td className="text-right py-2 px-3">
                          <span className={change.currentSR >= 90 ? 'text-success' : change.currentSR >= 80 ? 'text-warning' : 'text-error'}>
                            {change.currentSR.toFixed(2)}%
                          </span>
                        </td>
                        <td className="text-right py-2 px-3">
                          <span className={change.srDelta < 0 ? 'text-error' : 'text-success'}>
                            {change.srDelta >= 0 ? '+' : ''}{change.srDelta.toFixed(2)}%
                          </span>
                        </td>
                        <td className="text-right py-2 px-3">
                          <span className={change.impactOnOverallSR < 0 ? 'text-error font-medium' : 'text-success'}>
                            {change.impactOnOverallSR >= 0 ? '+' : ''}{change.impactOnOverallSR.toFixed(3)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RetryCustomersTable({ 
  customers, 
  paymentMode 
}: { 
  customers: ReturnType<typeof detectProblematicCustomers>; 
  paymentMode: PaymentMode;
}) {
  if (customers.length === 0) {
    return (
      <p className="text-muted-foreground">No problematic retry customers found.</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-3 font-semibold text-muted-foreground">Customer Identifier</th>
            <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Total Attempts</th>
            <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Retry Count</th>
            <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Retry SR</th>
            <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Success (Retries)</th>
            <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Failed (Retries)</th>
            <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Volume Share</th>
            <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Impact on SR</th>
            <th className="text-left py-2 px-3 font-semibold text-muted-foreground">Top Failure Reason</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((customer, idx) => {
            const retryCount = customer.attemptCount - 1; // Total - 1 (first attempt)
            const customerIdentifier = customer.identifier.length > 30 
              ? `${customer.identifier.substring(0, 30)}...` 
              : customer.identifier;
            
            return (
              <tr
                key={idx}
                className="border-b border-border hover:bg-muted/50"
              >
                <td className="py-2 px-3 font-mono text-xs">{customerIdentifier}</td>
                <td className="text-right py-2 px-3">{formatNumber(customer.attemptCount)}</td>
                <td className="text-right py-2 px-3">
                  <span className="font-medium text-warning">{formatNumber(retryCount)}</span>
                </td>
                <td className="text-right py-2 px-3">
                  <span className={`font-bold ${customer.sr < 1 ? 'text-error' : 'text-warning'}`}>
                    {customer.sr.toFixed(2)}%
                  </span>
                </td>
                <td className="text-right py-2 px-3 text-success">
                  {formatNumber(customer.successCount)}
                </td>
                <td className="text-right py-2 px-3 text-error">
                  {formatNumber(customer.failedCount)}
                </td>
                <td className="text-right py-2 px-3">
                  {customer.volumeShare.toFixed(2)}%
                </td>
                <td className="text-right py-2 px-3">
                  <span className={customer.impactOnSR < 0 ? 'text-error font-medium' : 'text-success'}>
                    {customer.impactOnSR >= 0 ? '+' : ''}{customer.impactOnSR.toFixed(3)}%
                  </span>
                </td>
                <td className="py-2 px-3 text-xs text-muted-foreground max-w-xs truncate">
                  {customer.topFailureReason ? (
                    <span title={customer.topFailureReason}>
                      {customer.topFailureReason.length > 40 
                        ? `${customer.topFailureReason.substring(0, 40)}...` 
                        : customer.topFailureReason}
                      {customer.topFailureReasonCount && ` (${customer.topFailureReasonCount})`}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DimensionDeepDive({ 
  failedAnalyses, 
  userDroppedAnalyses,
  currentPeriodTransactions,
  selectedPaymentMode,
  backendContext,
}: { 
  failedAnalyses: DimensionAnalysis[];
  userDroppedAnalyses: DimensionAnalysis[];
  currentPeriodTransactions: Transaction[];
  selectedPaymentMode: PaymentMode;
  backendContext?: {
    uploadId: string;
    periodStart: string;
    periodEnd: string;
    filters: {
      startDate: string | null;
      endDate: string | null;
      paymentModes: string[];
      merchantIds: string[];
      pgs: string[];
      banks: string[];
      cardTypes: string[];
    };
  };
}) {
  const [analysisType, setAnalysisType] = useState<'FAILED' | 'USER_DROPPED'>('FAILED');
  const [selectedDimension, setSelectedDimension] = useState<string>('');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [breakdownCache, setBreakdownCache] = useState<Record<string, { paymentModes: any[]; pgs: any[] }>>({});
  const [breakdownLoading, setBreakdownLoading] = useState<Record<string, boolean>>({});

  // Switch between FAILED and USER_DROPPED analyses
  const analyses = analysisType === 'FAILED' ? failedAnalyses : userDroppedAnalyses;

  const periodTxs: Transaction[] = currentPeriodTransactions || [];

  // Get unique dimensions
  const dimensions = Array.from(new Set(analyses.map((a) => a.dimension)));

  // Filter flagged analyses
  const flaggedAnalyses = analyses.filter((a) => a.flagged);

  // Get analyses for selected dimension
  const dimensionAnalyses = selectedDimension
    ? analyses.filter((a) => a.dimension === selectedDimension)
    : flaggedAnalyses;

  const showDimensionColumn = !selectedDimension; // Only needed when we're mixing multiple dimensions

  // Helper function to get dimension value from transaction
  const getDimensionValue = (tx: Transaction, dimName: string): string => {
    // Error taxonomy dimensions
    if (dimName === 'CF Error Description') return tx.cf_errordescription || 'Unknown';
    if (dimName === 'CF Error Code') return tx.cf_errorcode || 'Unknown';
    if (dimName === 'CF Error Source') return tx.cf_errorsource || 'Unknown';
    if (dimName === 'CF Error Reason') return tx.cf_errorreason || 'Unknown';
    if (dimName === 'PG Error Code') return tx.pg_errorcode || 'Unknown';
    if (dimName === 'PG Error Message') return tx.pg_errormessage || 'Unknown';
    if (dimName === 'Failure Category') return getFailureCategory(tx);
    if (dimName === 'Failure Reason') return getFailureLabel(tx) || 'Unknown';
    
    // Core dimensions
    if (dimName === 'PG') return tx.pg || 'Unknown';
    if (dimName === 'Payment Mode') return tx.paymentmode || 'Unknown';
    
    // UPI dimensions
    if (dimName === 'Flow Type') return classifyUPIFlow(tx.bankname);
    if (dimName === 'Handle') return extractUPIHandle(tx.cardmasked) || 'Unknown';
    if (dimName === 'PSP') return tx.upi_psp || 'Unknown';
    
    // Card dimensions
    if (dimName === 'Card Type') return tx.cardtype || 'Unknown';
    if (dimName === 'Card Scope') return classifyCardScope(tx.cardcountry);
    if (dimName === 'Processing Card Type') return tx.processingcardtype || 'Unknown';
    if (dimName === 'Native OTP Eligible') return tx.nativeotpurleligible || 'Unknown';
    if (dimName === 'Frictionless') return tx.card_isfrictionless || 'Unknown';
    
    // Bank dimension
    if (dimName === 'Bank') return tx.bankname || 'Unknown';
    
    return 'Unknown';
  };

  // Compute breakdown for a specific analysis
  const computeBreakdown = (analysis: DimensionAnalysis) => {
    const cacheKey = `${analysisType}::${analysis.dimension}::${analysis.dimensionValue}`;
    if (backendContext) {
      return breakdownCache[cacheKey] || { paymentModes: [], pgs: [] };
    }
    // Filter to current period transactions matching this dimension value and status
    const relevantTxs = periodTxs.filter((tx) => {
      const statusMatch = analysisType === 'FAILED' ? tx.isFailed : tx.isUserDropped;
      if (!statusMatch) return false;
      
      const dimValue = getDimensionValue(tx, analysis.dimension);
      return dimValue === analysis.dimensionValue;
    });
    
    if (relevantTxs.length === 0) {
      return { paymentModes: [], pgs: [] };
    }
    
    // Group by payment mode
    const paymentModeMap = new Map<string, number>();
    relevantTxs.forEach((tx) => {
      const mode = tx.paymentmode || 'Unknown';
      paymentModeMap.set(mode, (paymentModeMap.get(mode) || 0) + 1);
    });
    
    // Group by PG
    const pgMap = new Map<string, number>();
    relevantTxs.forEach((tx) => {
      const pg = tx.pg || 'Unknown';
      pgMap.set(pg, (pgMap.get(pg) || 0) + 1);
    });
    
    const paymentModes = Array.from(paymentModeMap.entries())
      .map(([name, count]) => ({
        name,
        count,
        percent: (count / relevantTxs.length) * 100
      }))
      .sort((a, b) => b.count - a.count);
    
    const pgs = Array.from(pgMap.entries())
      .map(([name, count]) => ({
        name,
        count,
        percent: (count / relevantTxs.length) * 100
      }))
      .sort((a, b) => b.count - a.count);
    
    return { paymentModes, pgs };
  };

  const displayRows = useMemo(() => {
    return dimensionAnalyses
      .filter((a) => a.currentVolume > 0)
      .sort((a, b) => b.currentVolume - a.currentVolume);
  }, [dimensionAnalyses]);

  // Backend mode: fetch breakdown on-demand for the expanded row (full data, no sampling).
  useEffect(() => {
    if (!backendContext) return;
    if (expandedRow === null) return;
    const analysis = displayRows[expandedRow];
    if (!analysis) return;

    const cacheKey = `${analysisType}::${analysis.dimension}::${analysis.dimensionValue}`;
    if (breakdownCache[cacheKey]) return;
    if (breakdownLoading[cacheKey]) return;

    setBreakdownLoading((s) => ({ ...s, [cacheKey]: true }));
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/uploads/${backendContext.uploadId}/rca-breakdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          analysisType,
          dimension: analysis.dimension,
          dimensionValue: analysis.dimensionValue,
          period: { start: backendContext.periodStart, end: backendContext.periodEnd },
          filters: backendContext.filters,
        }),
      });
      if (!res.ok) throw new Error(`Failed to load breakdown (${res.status})`);
      const json = (await res.json()) as { paymentModes: any[]; pgs: any[] };
      if (cancelled) return;
      setBreakdownCache((s) => ({ ...s, [cacheKey]: { paymentModes: json.paymentModes || [], pgs: json.pgs || [] } }));
    })()
      .catch(() => {
        if (cancelled) return;
        setBreakdownCache((s) => ({ ...s, [cacheKey]: { paymentModes: [], pgs: [] } }));
      })
      .finally(() => {
        if (cancelled) return;
        setBreakdownLoading((s) => ({ ...s, [cacheKey]: false }));
      });

    return () => {
      cancelled = true;
    };
  }, [backendContext, analysisType, expandedRow, displayRows, breakdownCache, breakdownLoading]);

  if (dimensions.length === 0) {
    return <p className="text-muted-foreground">No dimension data available.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Analysis Type Selector */}
      <div>
        <label className="block text-sm font-medium mb-2">Analysis Type</label>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => {
              setAnalysisType('FAILED');
              setSelectedDimension(''); // Reset dimension selection
            }}
            className={`px-4 py-2 rounded-lg border transition-colors ${
              analysisType === 'FAILED'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-foreground border-border hover:border-primary/50'
            }`}
          >
            Technical Failures (FAILED)
          </button>
          <button
            onClick={() => {
              setAnalysisType('USER_DROPPED');
              setSelectedDimension(''); // Reset dimension selection
            }}
            className={`px-4 py-2 rounded-lg border transition-colors ${
              analysisType === 'USER_DROPPED'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-foreground border-border hover:border-primary/50'
            }`}
          >
            User Dropped (USER_DROPPED)
          </button>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {analysisType === 'FAILED' 
            ? 'Analyzing technical payment failures with error taxonomy (CF Error Code, PG Error, Failure Category, etc.)'
            : 'Analyzing user abandonment patterns by PG, Payment Mode, Card Type, Flow, etc. (no error taxonomy)'}
        </div>
      </div>

      {/* Dimension Selector */}
      <div>
        <label className="block text-sm font-medium mb-2">Select Dimension</label>
        <select
          value={selectedDimension}
          onChange={(e) => setSelectedDimension(e.target.value)}
          className="w-full md:w-auto px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="">All Flagged Issues</option>
          {dimensions.map((dim) => (
            <option key={dim} value={dim}>
              {dim}
            </option>
          ))}
        </select>
        <div className="mt-2 text-xs text-muted-foreground">
          Showing:{' '}
          <span className="font-medium text-foreground">
            {selectedDimension || 'All Flagged Issues'}
          </span>{' '}
          ({formatNumber(dimensionAnalyses.length)} rows)
        </div>
      </div>

      {/* Dimension Analysis Table */}
      {dimensionAnalyses.length === 0 ? (
        <p className="text-muted-foreground">No issues found for this dimension.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {showDimensionColumn && (
                  <th className="text-left py-2 px-3 font-semibold text-muted-foreground">Dimension</th>
                )}
                <th className="text-left py-2 px-3 font-semibold text-muted-foreground">
                  {selectedDimension ? `${selectedDimension} Value` : 'Dimension Value'}
                </th>
                <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Count</th>
                <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Volume Share</th>
                <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Volume Δ</th>
                <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Previous SR</th>
                <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Current SR</th>
                <th className="text-right py-2 px-3 font-semibold text-muted-foreground">SR Δ</th>
                <th className="text-center py-2 px-3 font-semibold text-muted-foreground">Flag</th>
                <th className="text-right py-2 px-3 font-semibold text-muted-foreground">Counterfactual SR</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((analysis, idx) => {
                  const rowKey = `${analysis.dimension}-${analysis.dimensionValue}`;
                  const isExpanded = expandedRow === idx;
                  
                  // Compute breakdown - no hooks inside map!
                  const breakdown = isExpanded ? computeBreakdown(analysis) : { paymentModes: [], pgs: [] };
                  const cacheKey = `${analysisType}::${analysis.dimension}::${analysis.dimensionValue}`;
                  const isLoading = Boolean(backendContext && breakdownLoading[cacheKey]);
                  
                  return (
                    <React.Fragment key={rowKey}>
                      <tr
                        className={`border-b border-border cursor-pointer hover:bg-muted/30 transition-colors ${
                          analysis.flagged ? 'bg-red-500/5' : ''
                        }`}
                        onClick={() => setExpandedRow(isExpanded ? null : idx)}
                      >
                        {showDimensionColumn && (
                          <td className="py-2 px-3 text-xs text-muted-foreground">{analysis.dimension}</td>
                        )}
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            <svg
                              className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                            <span className="font-medium">{analysis.dimensionValue}</span>
                          </div>
                        </td>
                        <td className="text-right py-2 px-3">
                          {formatNumber(analysis.currentVolume)}
                        </td>
                        <td className="text-right py-2 px-3">
                          {analysis.volumeShareCurrent.toFixed(1)}%
                        </td>
                        <td className="text-right py-2 px-3">
                          <span
                            className={
                              analysis.volumeDelta > 0
                                ? 'text-success'
                                : analysis.volumeDelta < 0
                                ? 'text-error'
                                : ''
                            }
                          >
                            {analysis.volumeDelta >= 0 ? '+' : ''}
                            {analysis.volumeDelta.toFixed(1)}%
                          </span>
                        </td>
                        <td className="text-right py-2 px-3">
                          <span
                            className={
                              analysis.previousSR >= 90
                                ? 'text-success'
                                : analysis.previousSR >= 80
                                ? 'text-warning'
                                : 'text-error'
                            }
                          >
                            {analysis.previousSR.toFixed(2)}%
                          </span>
                        </td>
                        <td className="text-right py-2 px-3">
                          <span
                            className={
                              analysis.currentSR >= 90
                                ? 'text-success'
                                : analysis.currentSR >= 80
                                ? 'text-warning'
                                : 'text-error'
                            }
                          >
                            {analysis.currentSR.toFixed(2)}%
                          </span>
                        </td>
                        <td className="text-right py-2 px-3">
                          <span
                            className={
                              analysis.srDelta < 0
                                ? 'text-error'
                                : analysis.srDelta > 0
                                ? 'text-success'
                                : ''
                            }
                          >
                            {analysis.srDelta >= 0 ? '+' : ''}
                            {analysis.srDelta.toFixed(2)}%
                          </span>
                        </td>
                        <td className="text-center py-2 px-3">
                          {analysis.flagged && analysis.flagReason && (
                            <span className="px-2 py-1 rounded text-xs bg-red-500/20 text-red-300 border border-red-500/50">
                              {analysis.flagReason.replace('_', ' ')}
                            </span>
                          )}
                        </td>
                        <td className="text-right py-2 px-3">
                          {analysis.counterfactualSR ? (
                            <span className="text-primary font-medium">
                              {analysis.counterfactualSR.toFixed(2)}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                      
                      {/* Expanded Breakdown Row */}
                      {isExpanded && (
                        <tr className="border-b border-border bg-muted/20">
                          <td colSpan={showDimensionColumn ? 10 : 9} className="py-4 px-6">
                            {isLoading && (
                              <div className="text-xs text-muted-foreground mb-3">Loading full-data breakdown…</div>
                            )}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                              {/* Payment Mode Breakdown */}
                              <div>
                                <h4 className="text-sm font-semibold mb-3 text-foreground">Payment Mode Breakdown</h4>
                                {breakdown.paymentModes.length === 0 ? (
                                  <p className="text-xs text-muted-foreground">No data</p>
                                ) : (
                                  <div className="space-y-2">
                                    {breakdown.paymentModes.map((pm) => (
                                      <div key={pm.name} className="flex items-center justify-between text-sm">
                                        <span className="text-foreground">{pm.name}</span>
                                        <div className="flex items-center gap-3">
                                          <span className="text-muted-foreground">{formatNumber(pm.count)}</span>
                                          <span className="text-primary font-medium w-12 text-right">
                                            {pm.percent.toFixed(1)}%
                                          </span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                              
                              {/* PG Breakdown */}
                              <div>
                                <h4 className="text-sm font-semibold mb-3 text-foreground">PG Breakdown</h4>
                                {breakdown.pgs.length === 0 ? (
                                  <p className="text-xs text-muted-foreground">No data</p>
                                ) : (
                                  <div className="space-y-2">
                                    {breakdown.pgs.map((pg) => (
                                      <div key={pg.name} className="flex items-center justify-between text-sm">
                                        <span className="text-foreground">{pg.name}</span>
                                        <div className="flex items-center gap-3">
                                          <span className="text-muted-foreground">{formatNumber(pg.count)}</span>
                                          <span className="text-primary font-medium w-12 text-right">
                                            {pg.percent.toFixed(1)}%
                                          </span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
