'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { FileUpload } from '@/components/FileUpload';
import { FileInfo } from '@/components/FileInfo';
import { Filters } from '@/components/Filters';
import dynamic from 'next/dynamic';

// Lazy load tab components for code splitting
const OverviewTab = dynamic(() => import('@/components/tabs/OverviewTab').then(mod => ({ default: mod.OverviewTab })), {
  loading: () => <div className="flex items-center justify-center p-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>,
});
const UPITab = dynamic(() => import('@/components/tabs/UPITab').then(mod => ({ default: mod.UPITab })), {
  loading: () => <div className="flex items-center justify-center p-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>,
});
const CardsTab = dynamic(() => import('@/components/tabs/CardsTab').then(mod => ({ default: mod.CardsTab })), {
  loading: () => <div className="flex items-center justify-center p-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>,
});
const NetbankingTab = dynamic(() => import('@/components/tabs/NetbankingTab').then(mod => ({ default: mod.NetbankingTab })), {
  loading: () => <div className="flex items-center justify-center p-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>,
});
const RCATab = dynamic(() => import('@/components/tabs/RCATab').then(mod => ({ default: mod.RCATab })), {
  loading: () => <div className="flex items-center justify-center p-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>,
});
const InsightsTab = dynamic(() => import('@/components/tabs/InsightsTab').then(mod => ({ default: mod.InsightsTab })), {
  loading: () => <div className="flex items-center justify-center p-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>,
});
const ReportsTab = dynamic(() => import('@/components/tabs/ReportsTab').then(mod => ({ default: mod.ReportsTab })), {
  loading: () => <div className="flex items-center justify-center p-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>,
});
import { cn } from '@/lib/utils';

type Tab = 'overview' | 'upi' | 'cards' | 'netbanking' | 'rca' | 'insights' | 'reports';

// Components are already lazy-loaded, no need for additional memoization

export function Dashboard() {
  const METABASE_DATA_URL =
    'https://metabase.cashfree.com/question/23479-raw-data-for-analytics-tool?MerchantID=&start_date=&end_date=';

  // Use selector to only subscribe to rawTransactions
  const rawTransactions = useStore((state) => state.rawTransactions);
  const transactionCount = useStore((state) => state.transactionCount);
  const _useIndexedDB = useStore((state) => state._useIndexedDB);
  const isLoading = useStore((state) => state.isLoading);
  const error = useStore((state) => state.error);
  const hasHydrated = useStore((state) => state.hasHydrated);
  const analysisStage = useStore((state) => state.analysisStage);
  const fileNames = useStore((state) => state.fileNames);
  const fileSizes = useStore((state) => state.fileSizes);
  const restoreFromIndexedDB = useStore((state) => state.restoreFromIndexedDB);
  const clearData = useStore((state) => state.clearData);
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set(['overview']));
  const [restoreStatus, setRestoreStatus] = useState<'idle' | 'restoring' | 'missing' | 'error'>('idle');
  const [showAnalysisOverlay, setShowAnalysisOverlay] = useState(false);
  
  // Avoid flashing uploader during rehydrate: show uploader only after hydration completes.
  // Check both in-memory data and IndexedDB data
  const hasData = _useIndexedDB ? transactionCount > 0 : rawTransactions.length > 0;
  const showUploader = hasHydrated && !isLoading && !hasData && (!fileNames || fileNames.length === 0);
  const showAnalyzingOverlay = hasData && !isLoading && analysisStage !== null && showAnalysisOverlay;
  const showRestoreHint = hasHydrated && !isLoading && !hasData && (fileNames?.length ?? 0) > 0;

  // If we have metadata (fileNames) but no data, try restoring from IndexedDB once.
  useEffect(() => {
    if (!showRestoreHint) {
      setRestoreStatus('idle');
      return;
    }
    if (restoreStatus !== 'idle') return;

    setRestoreStatus('restoring');
    restoreFromIndexedDB()
      .then((res) => {
        if (res.status === 'restored') {
          setRestoreStatus('idle');
        } else {
          setRestoreStatus(res.status);
        }
      })
      .catch(() => setRestoreStatus('error'));
  }, [showRestoreHint, restoreStatus, restoreFromIndexedDB]);
  
  // Payment mode options based on active tab - memoized
  const getPaymentModeOptions = useMemo(() => {
    const options: Record<Tab, string[]> = {
      cards: ['CREDIT_CARD', 'DEBIT_CARD', 'PREPAID_CARD'],
      upi: ['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'],
      netbanking: ['NET_BANKING'],
      overview: [],
      rca: [],
      insights: [],
      reports: [],
    };
    return (tab: Tab) => options[tab] || [];
  }, []);

  // Memoize payment mode options for current tab
  const paymentModeOptions = useMemo(
    () => getPaymentModeOptions(activeTab),
    [activeTab, getPaymentModeOptions]
  );

  // Clear tab-specific filters when switching tabs - memoized with useCallback
  const handleTabChange = useCallback((tab: Tab) => {
    setActiveTab(tab);
    setMountedTabs((prev) => {
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
    // IMPORTANT: Do NOT auto-mutate filters on tab change.
    // Tab switches should be instant and should not trigger expensive recomputation for large datasets.
  }, []);

  // Avoid flashing the analyzing overlay for fast computations.
  useEffect(() => {
    if (analysisStage === null) {
      setShowAnalysisOverlay(false);
      return;
    }
    const t = setTimeout(() => setShowAnalysisOverlay(true), 300);
    return () => clearTimeout(t);
  }, [analysisStage]);

  // Prefetch other tab bundles after initial render to make first tab switch instant.
  useEffect(() => {
    const prefetch = () => {
      void import('@/components/tabs/UPITab');
      void import('@/components/tabs/CardsTab');
      void import('@/components/tabs/NetbankingTab');
      void import('@/components/tabs/RCATab');
      void import('@/components/tabs/InsightsTab');
      void import('@/components/tabs/ReportsTab');
    };
    // Best-effort: don't block paint
    if (typeof (window as any).requestIdleCallback === 'function') {
      (window as any).requestIdleCallback(prefetch, { timeout: 2000 });
    } else {
      const t = setTimeout(prefetch, 250);
      return () => clearTimeout(t);
    }
  }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'upi', label: 'UPI' },
    { id: 'cards', label: 'Cards' },
    { id: 'netbanking', label: 'Netbanking' },
    { id: 'rca', label: 'RCA' },
    { id: 'insights', label: 'Insights' },
    { id: 'reports', label: 'Reports' },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-lg">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-start sm:items-center gap-3 sm:gap-4">
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold">SR Analytics Dashboard</h1>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                SR ANALYTICS TOOL - PRODUCT OPS
              </p>
            </div>
            <div className="sm:justify-self-center w-full sm:w-auto">
              <div className="flex flex-col items-center text-center gap-0.5 sm:gap-0">
                <a
                  href={METABASE_DATA_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/30 px-3 py-1 text-[11px] sm:text-xs font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <svg
                    className="w-3.5 h-3.5 text-primary flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M14 3h7v7m0-7L10 14m-4 7h12a2 2 0 002-2V9"
                    />
                  </svg>
                  <span className="truncate">Click here for the data from metabase</span>
                </a>
                <span className="hidden md:inline text-xs text-muted-foreground leading-snug">
                  download the data from metabase and upload it here
                </span>
                <span className="md:hidden text-[10px] sm:text-[11px] text-muted-foreground leading-snug">
                  download the data from metabase and upload it here
                </span>
              </div>
            </div>
            <div className="sm:justify-self-end flex-shrink-0 w-full sm:w-auto">
              <FileInfo />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* While a file is uploading/parsing/normalizing, always show the FileUpload progress UI */}
        {isLoading ? (
          <div className="max-w-3xl mx-auto">
            <FileUpload />
          </div>
        ) : showUploader ? (
          <div className="max-w-3xl mx-auto">
            <FileUpload />
          </div>
        ) : showRestoreHint ? (
          <div className="max-w-3xl mx-auto">
            <div className="bg-card border border-border rounded-lg p-6">
              <div className="flex items-center gap-3 mb-2">
                {restoreStatus === 'restoring' ? (
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                ) : (
                  <div className="rounded-full h-6 w-6 border border-border bg-muted/30" />
                )}
                <h2 className="text-lg font-semibold">
                  {restoreStatus === 'restoring' ? 'Restoring dataset…' : 'Checking dataset…'}
                </h2>
              </div>
              <p className="text-sm text-muted-foreground">
                We found your last uploaded file name (<span className="font-medium text-foreground">{fileNames[0]}</span>).
                {restoreStatus === 'restoring' ? ' Restoring from browser storage…' : ' Checking if data is available…'}
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                If the dashboard doesn&apos;t load in a few seconds, click <span className="font-medium">Replace</span> (top right) and re-upload the file.
              </p>
              {(error || restoreStatus === 'missing' || restoreStatus === 'error') && (
                <div className="mt-4 p-3 bg-error/10 border border-error rounded text-error text-sm">
                  {error || 'We could not find your dataset in browser storage. Please click Replace and re-upload.'}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    setRestoreStatus('restoring');
                    const res = await restoreFromIndexedDB();
                    setRestoreStatus(res.status === 'restored' ? 'idle' : res.status);
                  }}
                  className="px-3 py-1.5 text-sm bg-primary/10 text-primary hover:bg-primary/20 rounded-md transition-colors"
                >
                  Retry restore
                </button>
                <button
                  type="button"
                  onClick={() => void clearData()}
                  className="px-3 py-1.5 text-sm bg-muted text-foreground hover:bg-muted/70 rounded-md transition-colors"
                >
                  Clear & re-upload
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="relative">
              {showAnalyzingOverlay && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg">
                  <div className="flex flex-col items-center text-center p-6">
                    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary mb-4" />
                    <div className="text-base font-semibold">Analysing the SR, getting all the insights…</div>
                    <div className="text-sm text-muted-foreground mt-2">
                      {analysisStage === 'FILTERING' ? 'Filtering transactions…' : 'Computing metrics…'}
                    </div>
                  </div>
                </div>
              )}

            {/* Global Filters */}
            <Filters activeTab={activeTab} paymentModeOptions={paymentModeOptions} />

            {/* Tabs */}
            <div className="mt-6 border-b border-border">
              <nav className="flex space-x-8">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    className={cn(
                      'py-4 px-1 border-b-2 font-medium text-sm transition-colors',
                      activeTab === tab.id
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>
            </div>

            {/* Tab Content */}
            <div className="mt-6">
              <div className={activeTab === 'overview' ? 'block' : 'hidden'}>
                <OverviewTab />
              </div>
              {mountedTabs.has('upi') && (
                <div className={activeTab === 'upi' ? 'block' : 'hidden'}>
                  <UPITab />
                </div>
              )}
              {mountedTabs.has('cards') && (
                <div className={activeTab === 'cards' ? 'block' : 'hidden'}>
                  <CardsTab />
                </div>
              )}
              {mountedTabs.has('netbanking') && (
                <div className={activeTab === 'netbanking' ? 'block' : 'hidden'}>
                  <NetbankingTab />
                </div>
              )}
              {mountedTabs.has('rca') && (
                <div className={activeTab === 'rca' ? 'block' : 'hidden'}>
                  <RCATab />
                </div>
              )}
              {mountedTabs.has('insights') && (
                <div className={activeTab === 'insights' ? 'block' : 'hidden'}>
                  <InsightsTab />
                </div>
              )}
              {mountedTabs.has('reports') && (
                <div className={activeTab === 'reports' ? 'block' : 'hidden'}>
                  <ReportsTab />
                </div>
              )}
            </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}


