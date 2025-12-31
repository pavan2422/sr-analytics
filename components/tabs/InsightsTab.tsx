'use client';

import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { generateFailureInsights } from '@/lib/insights';
import { FailureInsight, TrendDirection, Transaction } from '@/types';
import { formatNumber } from '@/lib/utils';
import { KPICard } from '@/components/KPICard';
import { cn } from '@/lib/utils';
import { useVirtualizer } from '@tanstack/react-virtual';

export function InsightsTab() {
  const filteredTransactions = useStore((state) => state.filteredTransactions);
  const useIndexedDB = useStore((state) => state._useIndexedDB);
  const filteredTransactionCount = useStore((state) => state.filteredTransactionCount);
  const streamFilteredTransactions = useStore((state) => state.streamFilteredTransactions);
  const [sortColumn, setSortColumn] = useState<keyof FailureInsight>('impactScore');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [filterPaymentMode, setFilterPaymentMode] = useState<string>('ALL');
  const [insights, setInsights] = useState<FailureInsight[]>([]);
  const [isGeneratingInsights, setIsGeneratingInsights] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  // Generate insights asynchronously with debouncing
  useEffect(() => {
    const hasData = useIndexedDB ? filteredTransactionCount > 0 : filteredTransactions.length > 0;
    
    if (!hasData) {
      setInsights([]);
      return;
    }

    setIsGeneratingInsights(true);
    const timeoutId = setTimeout(async () => {
      try {
        if (useIndexedDB) {
          // For large datasets (5GB+), stream and process in batches - DON'T accumulate all
          console.log(`Streaming ${filteredTransactionCount} transactions from IndexedDB for insights...`);
          
          // Process insights in TINY batches - NEVER accumulate more than 2k at a time
          let tempInsights: FailureInsight[] = [];
          const batchSize = 2000; // Very small batches - 2k max to prevent crashes
          let currentBatch: Transaction[] = [];

          await streamFilteredTransactions(async (chunk) => {
            // Process chunk immediately - don't accumulate
            for (const tx of chunk) {
              currentBatch.push(tx);
              
              // Process immediately when batch is full
              if (currentBatch.length >= batchSize) {
                const batchToProcess = currentBatch.splice(0, batchSize);
                const batchInsights = await generateFailureInsights(batchToProcess, 2500);
                
                // Merge insights but limit total size aggressively
                tempInsights = [...tempInsights, ...batchInsights];
                
                // Limit total insights aggressively to prevent memory issues
                if (tempInsights.length > 200) {
                  tempInsights.sort((a, b) => b.impactScore - a.impactScore);
                  tempInsights = tempInsights.slice(0, 200);
                }
                
                // Yield frequently to keep UI responsive
                await new Promise(resolve => setTimeout(resolve, 30));
              }
            }
          }, 2500); // Very small chunks from IndexedDB

          // Process remaining batch
          if (currentBatch.length > 0) {
            const batchInsights = await generateFailureInsights(currentBatch, 2500);
            tempInsights = [...tempInsights, ...batchInsights];
          }

          // Always limit insights to top 200 to prevent memory issues
          if (tempInsights.length > 200) {
            tempInsights.sort((a, b) => b.impactScore - a.impactScore);
            tempInsights = tempInsights.slice(0, 200);
          }
          
          setInsights(tempInsights);
          setCurrentPage(1);
          setIsGeneratingInsights(false);
          return; // Exit early - we've already set insights
        } else {
          // Small dataset - use in-memory transactions
          const transactions = filteredTransactions;
          if (transactions.length > 0) {
            console.log(`Generating insights from ${transactions.length} transactions...`);
            const generatedInsights = await generateFailureInsights(transactions, 25000);
            setInsights(generatedInsights);
            setCurrentPage(1);
          } else {
            setInsights([]);
          }
        }
      } catch (error) {
        console.error('Error generating insights:', error);
        setInsights([]);
      } finally {
        setIsGeneratingInsights(false);
      }
    }, 500); // Longer debounce for large files (5GB+)

    return () => clearTimeout(timeoutId);
  }, [filteredTransactions, useIndexedDB, filteredTransactionCount, streamFilteredTransactions]);

  // Get unique payment modes for filter
  const paymentModes = useMemo(() => {
    const modes = new Set(insights.map((i) => i.paymentMode));
    return ['ALL', ...Array.from(modes).sort()];
  }, [insights]);

  // Filter insights by payment mode
  const filteredInsights = useMemo(() => {
    let filtered = insights;

    if (filterPaymentMode !== 'ALL') {
      filtered = filtered.filter((i) => i.paymentMode === filterPaymentMode);
    }

    return filtered;
  }, [insights, filterPaymentMode]);

  // Sort insights
  const sortedInsights = useMemo(() => {
    const sorted = [...filteredInsights];

    sorted.sort((a, b) => {
      const aVal = a[sortColumn];
      const bVal = b[sortColumn];

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }

      return 0;
    });

    return sorted;
  }, [filteredInsights, sortColumn, sortDirection]);

  // Pagination
  const totalPages = Math.ceil(sortedInsights.length / itemsPerPage);
  const paginatedInsights = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return sortedInsights.slice(startIndex, startIndex + itemsPerPage);
  }, [sortedInsights, currentPage]);

  // Compute summary stats
  const summaryStats = useMemo(() => {
    if (insights.length === 0) {
      return {
        totalInsights: 0,
        criticalInsights: 0,
        increasingTrends: 0,
        highImpact: 0,
      };
    }

    return {
      totalInsights: insights.length,
      criticalInsights: insights.filter((i) => i.isAnomaly).length,
      increasingTrends: insights.filter((i) => i.trendDirection === 'INCREASING').length,
      highImpact: insights.filter((i) => i.failureShare > 10).length,
    };
  }, [insights]);

  const handleSort = (column: keyof FailureInsight) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  const getTrendIcon = (trend: TrendDirection) => {
    switch (trend) {
      case 'INCREASING':
        return (
          <svg className="w-4 h-4 text-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        );
      case 'DECREASING':
        return (
          <svg className="w-4 h-4 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
          </svg>
        );
      case 'STABLE':
        return (
          <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14" />
          </svg>
        );
    }
  };

  const getTrendColor = (trend: TrendDirection) => {
    switch (trend) {
      case 'INCREASING':
        return 'text-error';
      case 'DECREASING':
        return 'text-success';
      case 'STABLE':
        return 'text-muted-foreground';
    }
  };

  const hasData = useIndexedDB ? filteredTransactionCount > 0 : filteredTransactions.length > 0;
  
  if (!hasData) {
    return (
      <div className="flex items-center justify-center p-12">
        <p className="text-muted-foreground">No data available. Please upload a file to see insights.</p>
      </div>
    );
  }

  if (isGeneratingInsights) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">
            Generating insights from {(useIndexedDB ? filteredTransactionCount : filteredTransactions.length).toLocaleString()} transactions...
          </p>
          {useIndexedDB && (
            <p className="text-xs text-muted-foreground mt-2">Streaming from IndexedDB (this may take a few minutes for large files)</p>
          )}
        </div>
      </div>
    );
  }

  if (insights.length === 0) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-center">
          <div className="text-6xl mb-4">🎉</div>
          <p className="text-lg font-semibold">No Significant Issues Detected!</p>
          <p className="text-muted-foreground mt-2">
            Your failure patterns are stable and no anomalies were found.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-card border border-border rounded-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold">Automated Failure Insights</h2>
            <p className="text-sm text-muted-foreground mt-1">
              AI-powered analysis of failed transactions with actionable recommendations
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse"></div>
            <span className="text-sm text-muted-foreground">Auto-Generated</span>
          </div>
        </div>

        {/* Summary KPIs */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KPICard
            title="Total Insights"
            value={summaryStats.totalInsights.toString()}
            variant="default"
          />
          <KPICard
            title="Critical Anomalies"
            value={summaryStats.criticalInsights.toString()}
            variant={summaryStats.criticalInsights > 0 ? 'error' : 'success'}
          />
          <KPICard
            title="Increasing Trends"
            value={summaryStats.increasingTrends.toString()}
            variant={summaryStats.increasingTrends > 5 ? 'warning' : 'default'}
          />
          <KPICard
            title="High Impact Issues"
            value={summaryStats.highImpact.toString()}
            variant={summaryStats.highImpact > 0 ? 'error' : 'success'}
          />
        </div>
      </div>

      {/* Filter Controls */}
      <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[250px]">
            <label className="block text-sm font-medium mb-2">Filter by Payment Mode</label>
            <PaymentModeDropdown
              value={filterPaymentMode}
              options={paymentModes}
              onChange={setFilterPaymentMode}
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>
              Showing {paginatedInsights.length > 0 ? (currentPage - 1) * itemsPerPage + 1 : 0}-
              {Math.min(currentPage * itemsPerPage, sortedInsights.length)} of {sortedInsights.length} insights
              {sortedInsights.length !== insights.length && ` (${insights.length} total)`}
            </span>
          </div>
        </div>
      </div>

      {/* Insights Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th
                  className="text-left py-3 px-4 font-semibold text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                  onClick={() => handleSort('paymentMode')}
                >
                  <div className="flex items-center gap-1">
                    Payment Mode
                    {sortColumn === 'paymentMode' && (
                      <span className="text-primary">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  className="text-left py-3 px-4 font-semibold text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                  onClick={() => handleSort('cfErrorDescription')}
                >
                  <div className="flex items-center gap-1">
                    CF Error Description
                    {sortColumn === 'cfErrorDescription' && (
                      <span className="text-primary">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  className="text-right py-3 px-4 font-semibold text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                  onClick={() => handleSort('failureShare')}
                >
                  <div className="flex items-center justify-end gap-1">
                    Failure Share (%)
                    {sortColumn === 'failureShare' && (
                      <span className="text-primary">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  className="text-left py-3 px-4 font-semibold text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                  onClick={() => handleSort('primarySpikePeriod')}
                >
                  <div className="flex items-center gap-1">
                    Primary Spike Period
                    {sortColumn === 'primarySpikePeriod' && (
                      <span className="text-primary">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  className="text-center py-3 px-4 font-semibold text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                  onClick={() => handleSort('trendDirection')}
                >
                  <div className="flex items-center justify-center gap-1">
                    Trend
                    {sortColumn === 'trendDirection' && (
                      <span className="text-primary">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  className="text-right py-3 px-4 font-semibold text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                  onClick={() => handleSort('volumeDelta')}
                >
                  <div className="flex items-center justify-end gap-1">
                    Volume Δ
                    {sortColumn === 'volumeDelta' && (
                      <span className="text-primary">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th className="text-left py-3 px-4 font-semibold text-muted-foreground">
                  Insight Summary
                </th>
                <th className="text-left py-3 px-4 font-semibold text-muted-foreground">
                  Actionable Recommendation
                </th>
              </tr>
            </thead>
            <tbody>
              {paginatedInsights.map((insight, idx) => (
                <tr
                  key={idx}
                  className={`border-b border-border hover:bg-muted/20 transition-colors ${
                    insight.isAnomaly ? 'bg-red-500/5' : ''
                  }`}
                >
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{insight.paymentMode}</span>
                      {insight.isAnomaly && (
                        <span className="px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-300 border border-red-500/50">
                          ANOMALY
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="max-w-xs">
                      <span className="text-foreground">{insight.cfErrorDescription}</span>
                      {insight.spikeType && (
                        <div className="text-xs text-muted-foreground mt-1">
                          {insight.spikeType.replace('_', ' ')}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="text-right py-3 px-4">
                    <span
                      className={`font-medium ${
                        insight.failureShare > 10
                          ? 'text-error'
                          : insight.failureShare > 5
                          ? 'text-warning'
                          : 'text-foreground'
                      }`}
                    >
                      {insight.failureShare.toFixed(1)}%
                    </span>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatNumber(insight.currentVolume)} failures
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className="text-foreground">{insight.primarySpikePeriod}</span>
                  </td>
                  <td className="text-center py-3 px-4">
                    <div className="flex items-center justify-center gap-2">
                      {getTrendIcon(insight.trendDirection)}
                      <span className={`text-sm font-medium ${getTrendColor(insight.trendDirection)}`}>
                        {insight.trendDirection}
                      </span>
                    </div>
                  </td>
                  <td className="text-right py-3 px-4">
                    <div className="flex flex-col items-end gap-1">
                      <span
                        className={`font-medium ${
                          insight.volumeDelta > 50
                            ? 'text-error'
                            : insight.volumeDelta > 20
                            ? 'text-warning'
                            : insight.volumeDelta < -20
                            ? 'text-success'
                            : 'text-muted-foreground'
                        }`}
                      >
                        {insight.volumeDelta >= 0 ? '+' : ''}
                        {formatNumber(insight.volumeDelta)}
                      </span>
                      <div className="text-sm font-semibold text-foreground">
                        Total: {formatNumber(insight.currentVolume)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatNumber(insight.previousVolume)} → {formatNumber(insight.currentVolume)}
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="max-w-md text-sm text-foreground">{insight.insightSummary}</div>
                  </td>
                  <td className="py-3 px-4">
                    <div
                      className={`max-w-md text-sm p-3 rounded-lg border ${
                        insight.actionableRecommendation.startsWith('URGENT') ||
                        insight.actionableRecommendation.startsWith('Critical')
                          ? 'bg-red-500/10 border-red-500/50 text-red-200'
                          : insight.failureShare > 10
                          ? 'bg-orange-500/10 border-orange-500/50 text-orange-200'
                          : 'bg-blue-500/10 border-blue-500/50 text-blue-200'
                      }`}
                    >
                      {insight.actionableRecommendation}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        
        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between p-4 border-t border-border">
            <div className="text-sm text-muted-foreground">
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                className={cn(
                  'px-3 py-1.5 rounded-lg border border-border text-sm font-medium transition-colors',
                  currentPage === 1
                    ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                    : 'hover:bg-muted text-foreground cursor-pointer'
                )}
              >
                Previous
              </button>
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setCurrentPage(pageNum)}
                      className={cn(
                        'px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors',
                        currentPage === pageNum
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'border-border text-foreground hover:bg-muted'
                      )}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
                className={cn(
                  'px-3 py-1.5 rounded-lg border border-border text-sm font-medium transition-colors',
                  currentPage === totalPages
                    ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                    : 'hover:bg-muted text-foreground cursor-pointer'
                )}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className="bg-muted/30 border border-border rounded-lg p-4">
        <div className="text-sm text-muted-foreground">
          <p className="mb-2">
            <span className="font-medium text-foreground">How Insights Work:</span> This analysis automatically
            detects spikes, trends, and anomalies in failed transactions by comparing recent periods and identifying
            patterns across payment modes and error types.
          </p>
          <p>
            <span className="font-medium text-foreground">Actions:</span> Each recommendation is tailored based on
            the error type, spike pattern, and impact. Priority is given to sudden spikes, high-impact failures,
            and persistent issues.
          </p>
        </div>
      </div>
    </div>
  );
}

function PaymentModeDropdown({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedOption = options.find((opt) => opt === value) || value;

  return (
    <div className="relative" ref={dropdownRef}>
      <div
        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary min-h-[42px] flex items-center justify-between"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="flex-1 text-left">{selectedOption}</span>
        <svg
          className={cn(
            'w-4 h-4 transition-transform flex-shrink-0 ml-2',
            isOpen && 'transform rotate-180'
          )}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </div>
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-auto min-w-full">
          {options.map((option) => (
            <div
              key={option}
              className={cn(
                'px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors flex items-center justify-between',
                value === option && 'bg-primary/10'
              )}
              onClick={() => {
                onChange(option);
                setIsOpen(false);
              }}
            >
              <span className="flex-1 break-words">{option}</span>
              {value === option && (
                <svg
                  className="w-4 h-4 text-primary flex-shrink-0 ml-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

