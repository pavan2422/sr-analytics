'use client';

import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { FileUpload } from '@/components/FileUpload';
import { FileInfo } from '@/components/FileInfo';
import { Filters } from '@/components/Filters';
import { OverviewTab } from '@/components/tabs/OverviewTab';
import { UPITab } from '@/components/tabs/UPITab';
import { CardsTab } from '@/components/tabs/CardsTab';
import { NetbankingTab } from '@/components/tabs/NetbankingTab';
import { RCATab } from '@/components/tabs/RCATab';
import { cn } from '@/lib/utils';

type Tab = 'overview' | 'upi' | 'cards' | 'netbanking' | 'rca';

export function Dashboard() {
  const { rawTransactions, setFilters } = useStore();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  
  // Payment mode options based on active tab
  const getPaymentModeOptions = (tab: Tab): string[] => {
    if (tab === 'cards') {
      return ['CREDIT_CARD', 'DEBIT_CARD', 'PREPAID_CARD'];
    } else if (tab === 'upi') {
      return ['UPI', 'UPI_CREDIT_CARD', 'UPI_PPI'];
    } else if (tab === 'netbanking') {
      return ['NET_BANKING'];
    }
    return []; // Overview and RCA show all
  };

  // Clear tab-specific filters when switching tabs
  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    const tabPaymentModes = getPaymentModeOptions(tab);
    const { filters } = useStore.getState();
    
    // Clear invalid payment mode selections and tab-specific filters
    const validPaymentModes = tabPaymentModes.length > 0
      ? filters.paymentModes.filter((pm) => tabPaymentModes.includes(pm))
      : filters.paymentModes; // Overview/RCA keep all
    
    setFilters({ 
      paymentModes: validPaymentModes,
      pgs: [], 
      banks: [], 
      cardTypes: [],
      // Keep merchantIds when switching tabs
    });
  };

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
        {rawTransactions.length === 0 ? (
          <div className="max-w-3xl mx-auto">
            <FileUpload />
          </div>
        ) : (
          <>
            {/* Global Filters */}
            <Filters activeTab={activeTab} paymentModeOptions={getPaymentModeOptions(activeTab)} />

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


