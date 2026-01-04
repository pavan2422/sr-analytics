'use client';

import { useCallback, useRef } from 'react';
import { useStore } from '@/store/useStore';

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

export function FileInfo() {
  const { fileNames, fileSizes, clearData, loadDataFromFile, addDataFromFile } = useStore();
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  const handleReplace = useCallback(() => {
    replaceInputRef.current?.click();
  }, []);

  const handleAdd = useCallback(() => {
    addInputRef.current?.click();
  }, []);

  const handleReplaceFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        const validExtensions = ['csv', 'xlsx', 'xls'];
        const extension = file.name.split('.').pop()?.toLowerCase();
        
        if (!extension || !validExtensions.includes(extension)) {
          alert('Please upload a CSV or XLSX file');
          return;
        }

        // Block XLSX for large files (>100MB) - must use CSV
        const fileSizeMB = file.size / 1024 / 1024;
        if ((extension === 'xlsx' || extension === 'xls') && fileSizeMB > 100) {
          alert(
            'Large files (>100MB) must be uploaded as CSV format.\n\n' +
              'XLSX files are loaded fully into memory and will cause crashes.\n\n' +
              'Please export your data as CSV and try again.'
          );
          return;
        }
        
        try {
          await loadDataFromFile(file);
        } catch (err) {
          console.error('Error loading file:', err);
          alert('Failed to load file. Please check the console for details.');
        }
      }
      // Reset input so the same file can be selected again
      if (replaceInputRef.current) {
        replaceInputRef.current.value = '';
      }
    },
    [loadDataFromFile]
  );

  const handleAddFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        const validExtensions = ['csv', 'xlsx', 'xls'];
        const extension = file.name.split('.').pop()?.toLowerCase();
        
        if (!extension || !validExtensions.includes(extension)) {
          alert('Please upload a CSV or XLSX file');
          return;
        }

        // Block XLSX for large files (>100MB) - must use CSV
        const fileSizeMB = file.size / 1024 / 1024;
        if ((extension === 'xlsx' || extension === 'xls') && fileSizeMB > 100) {
          alert(
            'Large files (>100MB) must be uploaded as CSV format.\n\n' +
              'XLSX files are loaded fully into memory and will cause crashes.\n\n' +
              'Please export your data as CSV and try again.'
          );
          return;
        }
        
        try {
          await addDataFromFile(file);
        } catch (err) {
          console.error('Error adding file:', err);
          alert('Failed to add file. Please check the console for details.');
        }
      }
      // Reset input so the same file can be selected again
      if (addInputRef.current) {
        addInputRef.current.value = '';
      }
    },
    [addDataFromFile]
  );

  const handleDelete = useCallback(() => {
    if (confirm('Are you sure you want to delete all files and data?')) {
      clearData();
    }
  }, [clearData]);

  if (!fileNames || fileNames.length === 0) return null;

  const totalSize = (fileSizes || []).reduce((sum, size) => sum + (size || 0), 0);

  return (
    <div className="bg-card border border-border rounded-lg px-3 sm:px-4 py-2 max-w-full">
      <div className="flex items-start gap-2 sm:gap-3">
        <svg
          className="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground flex-shrink-0 mt-0.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="flex flex-col gap-1">
            {fileNames.length === 1 ? (
              <>
                <span className="text-xs sm:text-sm font-medium text-foreground truncate" title={fileNames[0]}>
                  {fileNames[0]}
                </span>
                <span className="text-[10px] sm:text-xs text-muted-foreground">
                  {formatFileSize(fileSizes[0])}
                </span>
              </>
            ) : (
              <>
                <span className="text-xs sm:text-sm font-medium text-foreground">
                  {fileNames.length} files loaded
                </span>
                <span className="text-[10px] sm:text-xs text-muted-foreground">
                  Total: {formatFileSize(totalSize)}
                </span>
                <div className="mt-1 space-y-0.5 max-h-20 overflow-y-auto">
                  {fileNames.map((name, index) => (
                    <div key={index} className="text-[10px] sm:text-xs text-muted-foreground truncate" title={name}>
                      • {name} ({formatFileSize(fileSizes[index])})
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        
        <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
          <input
            ref={replaceInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleReplaceFile}
            className="hidden"
          />
          <input
            ref={addInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleAddFile}
            className="hidden"
          />
          <button
            onClick={handleAdd}
            className="px-2 sm:px-3 py-1 sm:py-1.5 text-xs sm:text-sm bg-success/10 text-success hover:bg-success/20 rounded-md transition-colors whitespace-nowrap"
            title="Add another file"
          >
            Add
          </button>
          <button
            onClick={handleReplace}
            className="px-2 sm:px-3 py-1 sm:py-1.5 text-xs sm:text-sm bg-primary/10 text-primary hover:bg-primary/20 rounded-md transition-colors whitespace-nowrap"
            title="Replace all files"
          >
            Replace
          </button>
          <button
            onClick={handleDelete}
            className="px-2 sm:px-3 py-1 sm:py-1.5 text-xs sm:text-sm bg-error/10 text-error hover:bg-error/20 rounded-md transition-colors whitespace-nowrap"
            title="Delete all files"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

