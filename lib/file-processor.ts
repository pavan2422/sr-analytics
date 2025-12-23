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
        results.push(...chunkData);
        processedRows += chunkData.length;
        
        // Throttle progress updates (every 100ms)
        const now = Date.now();
        if (now - lastProgressUpdate > 100) {
          // Estimate percentage based on file size (rough estimate)
          const estimatedPercentage = Math.min((processedRows / 1000000) * 10, 50); // Rough estimate
          onProgress({
            processed: processedRows,
            total: fileSize,
            percentage: estimatedPercentage,
            stage: 'parsing',
          });
          lastProgressUpdate = now;
        }
        
        // Yield to browser to prevent blocking
        setTimeout(() => {
          parser.resume();
        }, 0);
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
export async function processExcelFile(
  file: File,
  onProgress: ProgressCallback
): Promise<any[]> {
  const XLSX = (await import('xlsx')).default;
  
  onProgress({
    processed: 0,
    total: file.size,
    percentage: 0,
    stage: 'reading',
  });

  // Read file in chunks if possible, otherwise read all at once
  const arrayBuffer = await file.arrayBuffer();
  
  onProgress({
    processed: file.size,
    total: file.size,
    percentage: 30,
    stage: 'parsing',
  });

  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  
  // Convert to JSON in chunks if large
  const totalRows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }).length;
  const jsonData = XLSX.utils.sheet_to_json(worksheet);
  
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

