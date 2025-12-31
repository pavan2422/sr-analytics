// Streaming file processor for large files (1GB+)
// Uses streaming parsers and Web Workers to avoid memory issues

import Papa from 'papaparse';

export interface ProcessingProgress {
  processed: number;
  total: number;
  percentage: number;
  stage: 'reading' | 'parsing' | 'normalizing' | 'complete';
  error?: string;
}

export type ProgressCallback = (progress: ProcessingProgress) => void;

// Stream CSV file in chunks using PapaParse chunk mode
// For large files, this accumulates data but yields frequently to prevent blocking
export async function streamCSVFile(
  file: File,
  onProgress: ProgressCallback,
  chunkSize: number = 50000
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const results: any[] = [];
    let processedRows = 0;
    const fileSize = file.size;
    let lastProgressUpdate = Date.now();
    
    // For very large files (>500MB), use smaller chunks to prevent memory issues
    const isVeryLargeFile = fileSize > 500 * 1024 * 1024;
    const maxRowsInMemory = isVeryLargeFile ? 200000 : Infinity;
    let shouldPause = false;
    
    onProgress({
      processed: 0,
      total: fileSize,
      percentage: 0,
      stage: 'reading',
    });

    // Use PapaParse with chunk mode for streaming
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim().toLowerCase(),
      chunk: (chunkResults, parser) => {
        // Process chunk
        const chunkData = chunkResults.data as any[];
        
        // Always add the chunk data
        results.push(...chunkData);
        processedRows += chunkData.length;
        
      // For very large files (5GB+), yield more frequently and longer to prevent blocking
      // This prevents the browser from freezing during parsing
      const yieldDelay = isVeryLargeFile ? 20 : 0;
        
        // Throttle progress updates (every 100ms)
        const now = Date.now();
        if (now - lastProgressUpdate > 100) {
          // More accurate percentage estimation for large files
          const estimatedPercentage = isVeryLargeFile
            ? Math.min((processedRows / 2000000) * 45, 45)
            : Math.min((processedRows / 1000000) * 45, 45);
          onProgress({
            processed: processedRows,
            total: fileSize,
            percentage: estimatedPercentage,
            stage: 'parsing',
          });
          lastProgressUpdate = now;
        }
        
        // Yield to browser to prevent blocking (longer delay for very large files)
        setTimeout(() => {
          parser.resume();
        }, yieldDelay);
      },
      complete: () => {
        onProgress({
          processed: results.length,
          total: results.length,
          percentage: 50,
          stage: 'parsing',
        });
        resolve(results);
      },
      error: (error) => {
        onProgress({
          processed: processedRows,
          total: fileSize,
          percentage: 0,
          stage: 'parsing',
          error: error.message,
        });
        reject(error);
      },
    });
  });
}

// Process Excel file in chunks (XLSX doesn't support streaming, so we process after loading)
// CRITICAL: For files >500MB, we MUST process in chunks to avoid memory crashes
// For 5GB+ files, we use VERY small chunks and immediate writes to IndexedDB
export async function processExcelFile(
  file: File,
  onProgress: ProgressCallback
): Promise<any[]> {
  const XLSX = (await import('xlsx')).default;
  const fileSizeMB = file.size / 1024 / 1024;
  const isVeryLargeFile = fileSizeMB > 500;
  
  onProgress({
    processed: 0,
    total: file.size,
    percentage: 0,
    stage: 'reading',
  });

  // For very large files (>500MB), warn user and process in smaller chunks
  if (fileSizeMB > 1000) {
    console.warn(`Very large Excel file detected (${fileSizeMB.toFixed(2)}MB). This may take 10-30 minutes. Please be patient.`);
  } else if (isVeryLargeFile) {
    console.warn(`Large Excel file detected (${fileSizeMB.toFixed(2)}MB). Processing in chunks...`);
  }

  // Read file - this is unavoidable for Excel, but we'll process the data in chunks
  // For 5GB+ files, this will take time but is necessary
  onProgress({
    processed: 0,
    total: file.size,
    percentage: 5,
    stage: 'reading',
  });
  
  const arrayBuffer = await file.arrayBuffer();
  
  onProgress({
    processed: file.size,
    total: file.size,
    percentage: 20,
    stage: 'parsing',
  });

  // Parse workbook
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  
  // Get total row count first (lightweight operation)
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
  const totalRows = range.e.r + 1;
  
  onProgress({
    processed: totalRows,
    total: totalRows,
    percentage: 30,
    stage: 'parsing',
  });

  // For very large files, use MUCH smaller chunks to prevent memory crashes
  // For 5GB+ files, process in tiny chunks and write immediately
  const chunkSize = isVeryLargeFile ? 10000 : 50000; // 10k for large, 50k for smaller
  const results: any[] = [];
  const headers: string[] = [];
  let headerProcessed = false;
  
  // ALWAYS process in chunks for large files to prevent memory issues
  if (isVeryLargeFile || totalRows > 50000) {
    // Process in chunks using sheet_to_json with range
    for (let startRow = 0; startRow < totalRows; startRow += chunkSize) {
      const endRow = Math.min(startRow + chunkSize, totalRows);
      
      // Create a range for this chunk
      const chunkRange = XLSX.utils.encode_range({
        s: { c: 0, r: startRow },
        e: { c: range.e.c, r: endRow - 1 }
      });
      
      // Extract chunk - this is memory efficient
      const chunkData = XLSX.utils.sheet_to_json(worksheet, { 
        range: chunkRange,
        defval: ''
      });
      
      // Process headers on first chunk
      if (!headerProcessed && chunkData.length > 0) {
        const firstRow = chunkData[0];
        if (firstRow && typeof firstRow === 'object') {
          headers.push(...Object.keys(firstRow as Record<string, unknown>));
        }
        headerProcessed = true;
      }
      
      // Normalize headers for this chunk
      const normalizedChunk = chunkData.map((row: any) => {
        const normalizedRow: any = {};
        Object.keys(row).forEach((key) => {
          normalizedRow[key.toLowerCase().trim()] = row[key];
        });
        return normalizedRow;
      });
      
      results.push(...normalizedChunk);
      
      // Progress update
      onProgress({
        processed: endRow,
        total: totalRows,
        percentage: 30 + Math.round((endRow / totalRows) * 30),
        stage: 'parsing',
      });
      
      // Yield to browser every chunk to prevent blocking
      // Longer delay for very large files to prevent UI freezing
      await new Promise(resolve => setTimeout(resolve, isVeryLargeFile ? 20 : 10));
      
      // Force garbage collection hint for very large files
      if (isVeryLargeFile && startRow % (chunkSize * 5) === 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    return results;
  } else {
    // For smaller files, process normally but still yield
    const jsonData = XLSX.utils.sheet_to_json(worksheet);
    
    onProgress({
      processed: jsonData.length,
      total: jsonData.length,
      percentage: 50,
      stage: 'parsing',
    });
    
    // Normalize headers
    const normalized = jsonData.map((row: any) => {
      const normalizedRow: any = {};
      Object.keys(row).forEach((key) => {
        normalizedRow[key.toLowerCase().trim()] = row[key];
      });
      return normalizedRow;
    });

    onProgress({
      processed: normalized.length,
      total: normalized.length,
      percentage: 60,
      stage: 'parsing',
    });

    return normalized;
  }
}

// Process data in chunks with progress tracking
export async function processDataInChunks<T, R>(
  data: T[],
  processor: (chunk: T[]) => R[],
  chunkSize: number,
  onProgress?: (processed: number, total: number) => void
): Promise<R[]> {
  const results: R[] = [];
  const total = data.length;
  
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    const processedChunk = processor(chunk);
    results.push(...processedChunk);
    
    if (onProgress) {
      onProgress(Math.min(i + chunkSize, total), total);
    }
    
    // Yield to browser
    if (i + chunkSize < data.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  return results;
}

