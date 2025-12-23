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
import { cn } from '@/lib/utils';

type Tab = 'overview' | 'upi' | 'cards' | 'netbanking' | 'rca';

// Components are already lazy-loaded, no need for additional memoization

export function Dashboard() {
  // Use selector to only subscribe to rawTransactions length
  // Also check if store is hydrated to prevent showing uploader on refresh
  const rawTransactions = useStore((state) => state.rawTransactions);
  const isLoading = useStore((state) => state.isLoading);
  const setFilters = useStore((state) => state.setFilters);
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [isHydrated, setIsHydrated] = useState(false);
  
  // Check if store is hydrated (data loaded from persistence)
  useEffect(() => {
    // Use a small delay to allow Zustand to hydrate
    const timer = setTimeout(() => {
      setIsHydrated(true);
    }, 50);
    return () => clearTimeout(timer);
  }, []);
  
  // Show dashboard if we have data OR if we're still loading (might be hydrating)
  const hasData = rawTransactions.length > 0 || (isLoading && !isHydrated);
  
  // Payment mode options based on active tab - memoized
  const getPaymentModeOptions = useMemo(() => {
    const options: Record<Tab, string[]> = {
      cards: ['CREDIT_CARD', 'DEBIT_CARD', 'PREPAID_CARD'],
      upi: ['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'],
      netbanking: ['NET_BANKING'],
      overview: [],
      rca: [],
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
    const tabPaymentModes = getPaymentModeOptions(tab);
    const { filters } = useStore.getState();
    
    // Clear invalid payment mode selections and tab-specific filters
    const validPaymentModes = tabPaymentModes.length > 0
      ? filters.paymentModes.filter((pm) => tabPaymentModes.includes(pm))
      : filters.paymentModes; // Overview/RCA keep all
    
    // Batch filter updates
    setFilters({ 
      paymentModes: validPaymentModes,
      pgs: [], 
      banks: [], 
      cardTypes: [],
      // Keep merchantIds when switching tabs
    });
  }, [setFilters, getPaymentModeOptions]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'upi', label: 'UPI' },
    { id: 'cards', label: 'Cards' },
    { id: 'netbanking', label: 'Netbanking' },
    { id: 'rca', label: 'RCA' },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-lg">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold">SR Analytics Dashboard</h1>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                SR ANALYTICS TOOL - PRODUCT OPS
              </p>
            </div>
            <div className="flex-shrink-0 w-full sm:w-auto">
              <FileInfo />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        {!hasData ? (
          <div className="max-w-3xl mx-auto">
            <FileUpload />
          </div>
        ) : (
          <>
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
              {activeTab === 'overview' && <OverviewTab />}
              {activeTab === 'upi' && <UPITab />}
              {activeTab === 'cards' && <CardsTab />}
              {activeTab === 'netbanking' && <NetbankingTab />}
              {activeTab === 'rca' && <RCATab />}
            </div>
          </>
        )}
      </main>
    </div>
  );
}


