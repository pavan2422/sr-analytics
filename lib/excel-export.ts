import * as XLSX from 'xlsx';
import { format } from 'date-fns';

/**
 * Export comprehensive report data to Excel file with multiple sheets
 */
export function exportToExcel(sheets: Map<string, any[]>): void {
  const workbook = XLSX.utils.book_new();
  
  // Create all sheets
  sheets.forEach((data, sheetName) => {
    if (data.length > 0) {
      const ws = XLSX.utils.json_to_sheet(data);
      
      // Auto-size columns
      const colWidths: { wch: number }[] = [];
      const firstRow = data[0];
      if (firstRow) {
        Object.keys(firstRow).forEach((key) => {
          const maxLength = Math.max(
            key.length,
            ...data.map(row => String((row as any)[key] || '').length)
          );
          colWidths.push({ wch: Math.min(maxLength + 2, 50) });
        });
      }
      ws['!cols'] = colWidths;
      
      XLSX.utils.book_append_sheet(workbook, ws, sheetName);
    } else {
      // Create empty sheet with message
      const emptyData = [{ Info: 'No data available' }];
      const emptyWS = XLSX.utils.json_to_sheet(emptyData);
      XLSX.utils.book_append_sheet(workbook, emptyWS, sheetName);
    }
  });
  
  // Generate filename
  const today = format(new Date(), 'yyyyMMdd');
  const filename = `SR_Analysis_${today}.xlsx`;
  
  // Write file
  XLSX.writeFile(workbook, filename);
}
