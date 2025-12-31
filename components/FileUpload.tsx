'use client';

import { useCallback, useState } from 'react';
import { useStore } from '@/store/useStore';
import { cn } from '@/lib/utils';

export function FileUpload() {
  const [isDragging, setIsDragging] = useState(false);
  const { loadDataFromFile, isLoading, error, progress } = useStore();

  const handleFile = useCallback(
    async (file: File) => {
      console.log('File selected:', file.name, file.size);
      const validExtensions = ['csv', 'xlsx', 'xls'];
      const extension = file.name.split('.').pop()?.toLowerCase();
      
      if (!extension || !validExtensions.includes(extension)) {
        alert('Please upload a CSV or XLSX file');
        return;
      }
      
      // Block XLSX for large files (>100MB) - must use CSV
      const fileSizeMB = file.size / 1024 / 1024;
      if ((extension === 'xlsx' || extension === 'xls') && fileSizeMB > 100) {
        alert('Large files (>100MB) must be uploaded as CSV format.\n\nXLSX files are loaded fully into memory and will cause crashes.\n\nPlease export your data as CSV and try again.');
        return;
      }
      
      try {
        await loadDataFromFile(file);
        console.log('File loaded successfully');
      } catch (err) {
        console.error('Error loading file:', err);
        alert('Failed to load file. Please check the console for details.');
      }
    },
    [loadDataFromFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      
      const file = e.dataTransfer.files[0];
      if (file) {
        handleFile(file);
      }
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFile(file);
      }
    },
    [handleFile]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12 border-2 border-dashed border-border rounded-lg bg-card">
        <div className="text-center w-full max-w-md">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground mb-4">
            {progress?.stage === 'reading' && 'Reading file...'}
            {progress?.stage === 'parsing' && 'Parsing file...'}
            {progress?.stage === 'normalizing' && 'Normalizing data...'}
            {!progress && 'Processing file...'}
          </p>
          {progress && (
            <div className="w-full">
              <div className="flex justify-between text-sm text-muted-foreground mb-2">
                <span>
                  {progress.stage === 'reading' && 'Reading'}
                  {progress.stage === 'parsing' && 'Parsing'}
                  {progress.stage === 'normalizing' && 'Normalizing'}
                </span>
                <span>{progress.percentage.toFixed(0)}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                <div
                  className="bg-primary h-full transition-all duration-300"
                  style={{ width: `${progress.percentage}%` }}
                />
              </div>
              {progress.processed > 0 && progress.total > 0 && (
                <p className="text-xs text-muted-foreground mt-2">
                  {progress.processed.toLocaleString()} / {progress.total.toLocaleString()} rows
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      className={cn(
        'relative border-2 border-dashed rounded-lg p-12 transition-colors',
        isDragging
          ? 'border-primary bg-primary/10'
          : 'border-border bg-card hover:border-primary/50'
      )}
    >
      <input
        type="file"
        id="file-upload"
        accept=".csv,.xlsx,.xls"
        onChange={handleFileInput}
        className="hidden"
      />
      <div className="flex flex-col items-center justify-center">
        <label
          htmlFor="file-upload"
          className="flex flex-col items-center justify-center cursor-pointer w-full"
        >
          <svg
            className="w-16 h-16 mb-4 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>
          <p className="text-lg font-medium mb-2">
            Drag & drop your transaction file here
          </p>
          <p className="text-sm text-muted-foreground mb-4">
            or click to browse (CSV, XLSX)
          </p>
        </label>
        <button
          type="button"
          onClick={() => document.getElementById('file-upload')?.click()}
          className="px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          Select File
        </button>
      </div>
      {error && (
        <div className="mt-4 p-3 bg-error/10 border border-error rounded text-error text-sm text-center">
          {error}
        </div>
      )}
    </div>
  );
}


