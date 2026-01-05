'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { ReportType, generateReport } from '@/lib/report-generator';
import { exportToExcel } from '@/lib/excel-export';
import { MultiSelect } from '@/components/MultiSelect';
import { Transaction } from '@/types';

export function ReportsTab() {
  const filteredTransactions = useStore((state) => state.filteredTransactions);
  const _useIndexedDB = useStore((state) => state._useIndexedDB);
  const _useBackend = useStore((state) => state._useBackend);
  const backendUploadId = useStore((state) => state.backendUploadId);
  const filters = useStore((state) => state.filters);
  const filteredTransactionCount = useStore((state) => state.filteredTransactionCount);
  const getSampleFilteredTransactions = useStore((state) => state.getSampleFilteredTransactions);
  const getIndexedDBFilterOptions = useStore((state) => state.getIndexedDBFilterOptions);
  
  const [reportType, setReportType] = useState<ReportType>('daily');
  const [selectedPaymentModes, setSelectedPaymentModes] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // For IndexedDB mode, we don't keep transactions in memory. Use a bounded sample for reports.
  const isLargeFile = _useIndexedDB && filteredTransactions.length === 0;
  const [sample, setSample] = useState<Transaction[]>([]);
  const [backendPaymentModes, setBackendPaymentModes] = useState<string[]>([]);

  // Load a bounded sample for report generation in IndexedDB mode
  useEffect(() => {
    if (!_useIndexedDB) {
      setSample([]);
      setBackendPaymentModes([]);
      return;
    }
    if (filteredTransactionCount === 0) {
      setSample([]);
      setBackendPaymentModes([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (_useBackend) {
          const opts = await getIndexedDBFilterOptions();
          if (!cancelled) setBackendPaymentModes(opts.paymentModes || []);
          setSample([]);
          return;
        }
        const txs = await getSampleFilteredTransactions(50000);
        if (!cancelled) setSample(txs);
      } catch {
        if (!cancelled) setSample([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [_useIndexedDB, _useBackend, filteredTransactionCount, getSampleFilteredTransactions, getIndexedDBFilterOptions]);

  // Get available payment modes from filtered transactions
  const availablePaymentModes = useMemo(() => {
    if (_useIndexedDB && _useBackend) return backendPaymentModes;
    const source = isLargeFile ? sample : filteredTransactions;
    const modes = new Set(source.map(tx => tx.paymentmode).filter(Boolean));
    return Array.from(modes).sort();
  }, [_useIndexedDB, _useBackend, backendPaymentModes, filteredTransactions, isLargeFile, sample]);

  // Filter transactions by selected payment modes
  const reportTransactions = useMemo(() => {
    const source = isLargeFile ? sample : filteredTransactions;
    if (selectedPaymentModes.length === 0) {
      return source;
    }
    return source.filter(tx => selectedPaymentModes.includes(tx.paymentmode));
  }, [filteredTransactions, selectedPaymentModes, isLargeFile, sample]);

  const canGenerate = useMemo(() => {
    // Large-file mode can still generate a report, but it's based on a bounded sample
    // (we do not keep the full filtered set in memory/IndexedDB in this tab).
    if (_useIndexedDB && _useBackend) return Boolean(backendUploadId) && filteredTransactionCount > 0;
    return reportTransactions.length > 0;
  }, [_useIndexedDB, _useBackend, backendUploadId, filteredTransactionCount, reportTransactions.length]);

  const handleGenerateReport = useCallback(async () => {
    if (!canGenerate) return;

    setIsGenerating(true);
    try {
      if (_useIndexedDB && _useBackend) {
        if (!backendUploadId) throw new Error('Missing backend upload id');
        const { retryApiCall } = await import('@/lib/retry-api');
        const res = await retryApiCall(async () => {
          const r = await fetch(`/api/uploads/${backendUploadId}/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              reportType,
              selectedPaymentModes,
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
            throw new Error(`Failed to generate backend report (${r.status}): ${msg}`);
          }
          return r;
        });

        const blob = await res.blob();
        const cd = res.headers.get('content-disposition') || '';
        const m = /filename=\"?([^\";]+)\"?/i.exec(cd);
        const filename = m?.[1] || `SR_Analysis_${reportType}.xlsx`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } else {
        // Generate report for selected type and payment modes (client-side)
        const sheets = generateReport(reportTransactions, reportType, selectedPaymentModes);
        exportToExcel(sheets);
      }
    } catch (error) {
      console.error('Error generating report:', error);
      alert('Failed to generate report. Please check the console for details.');
    } finally {
      setIsGenerating(false);
    }
  }, [_useIndexedDB, _useBackend, backendUploadId, filters, reportTransactions, reportType, selectedPaymentModes, canGenerate]);

  return (
    <div className="space-y-6">
      {/* Controls Section */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-6">SR Analysis Report</h2>
        
        {isLargeFile && !_useBackend && (
          <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              You uploaded a large file. Reports will be generated from a bounded sample (up to 50,000 transactions),
              so totals may differ slightly from the full dataset.
            </p>
          </div>
        )}

        {isLargeFile && _useBackend && (
          <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              Large file detected. Reports are generated from the full dataset on the server (no sampling). This may take a few minutes.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Report Type Selection */}
          <div>
            <label className="block text-sm font-medium mb-3">Report Type</label>
            <div className="flex flex-col space-y-2">
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="radio"
                  name="reportType"
                  value="daily"
                  checked={reportType === 'daily'}
                  onChange={(e) => setReportType(e.target.value as ReportType)}
                  className="w-4 h-4 text-primary focus:ring-primary"
                />
                <span>Daily Report</span>
              </label>
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="radio"
                  name="reportType"
                  value="weekly"
                  checked={reportType === 'weekly'}
                  onChange={(e) => setReportType(e.target.value as ReportType)}
                  className="w-4 h-4 text-primary focus:ring-primary"
                />
                <span>Weekly Report</span>
              </label>
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="radio"
                  name="reportType"
                  value="monthly"
                  checked={reportType === 'monthly'}
                  onChange={(e) => setReportType(e.target.value as ReportType)}
                  className="w-4 h-4 text-primary focus:ring-primary"
                />
                <span>Monthly Report</span>
              </label>
            </div>
          </div>

          {/* Payment Mode Selection */}
          <div>
            <MultiSelect
              label="Payment Mode"
              options={availablePaymentModes}
              value={selectedPaymentModes}
              onChange={setSelectedPaymentModes}
              placeholder="Select payment modes (leave empty for all)"
            />
          </div>
        </div>

        {/* Download Button */}
        <div>
          <button
            onClick={handleGenerateReport}
            disabled={!canGenerate || isGenerating}
            className={`
              w-full md:w-auto px-6 py-3 rounded-lg font-medium transition-colors
              ${canGenerate && !isGenerating
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
              }
            `}
          >
            {isGenerating ? (
              <span className="flex items-center justify-center space-x-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></div>
                <span>Generating Report...</span>
              </span>
            ) : (
              `Download ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Report`
            )}
          </button>
        </div>

        {/* Info */}
        <div className="mt-4 text-sm text-muted-foreground space-y-1">
          <p>• Report uses all currently applied dashboard filters (merchant, date range, etc.)</p>
          <p>• Selected payment modes: <span className="font-medium">
            {selectedPaymentModes.length === 0 ? 'All Payment Modes' : selectedPaymentModes.join(', ')}
          </span></p>
          <p>• {reportTransactions.length.toLocaleString()} transaction(s) will be included in the report</p>
          <p>• Report includes: SR breakdowns, PSP level (UPI), Handle level (UPI), Bank, Card Network, Failure Analysis, and more</p>
        </div>
      </div>

      {/* Preview Section */}
      {!(_useIndexedDB && _useBackend) && reportTransactions.length === 0 && (
        <div className="bg-card border border-border rounded-lg p-6 text-center">
          <p className="text-muted-foreground">No transactions available for the selected filters.</p>
        </div>
      )}
    </div>
  );
}
