'use client';

import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  ColumnDef,
  SortingState,
} from '@tanstack/react-table';
import { useState, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { GroupedMetrics, FailureRCA } from '@/types';

interface DataTableProps<T = GroupedMetrics> {
  data: T[];
  columns: ColumnDef<T>[];
  height?: number;
}

export function DataTable<T = GroupedMetrics>({ data, columns, height = 400 }: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const parentRef = useRef<HTMLDivElement>(null);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Virtualization: Only render visible rows for tables with >50 rows
  const shouldVirtualize = data.length > 50;
  
  const { rows } = table.getRowModel();

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 50, // Estimated row height
    overscan: 10, // Render 10 extra rows for smooth scrolling
  });

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center border border-border rounded-lg bg-card"
        style={{ height }}
      >
        <p className="text-muted-foreground">No data available</p>
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="border border-border rounded-lg bg-card overflow-auto"
      style={{ height }}
    >
      <table className="w-full">
        <thead className="sticky top-0 bg-card border-b border-border z-10">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} className="border-b border-border">
              {headerGroup.headers.map((header, index) => {
                // First column (usually text) = left align, others = right align
                // For Failure RCA tables, ensure consistent alignment
                const isFirstColumn = index === 0;
                const alignClass = isFirstColumn ? 'text-left' : 'text-right';
                return (
                  <th
                    key={header.id}
                    className={`py-3 px-4 ${alignClass} text-sm font-semibold text-muted-foreground whitespace-nowrap`}
                  >
                    {header.isPlaceholder ? null : (
                      <span
                        className={
                          header.column.getCanSort()
                            ? 'cursor-pointer select-none'
                            : ''
                        }
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                        {{
                          asc: ' ↑',
                          desc: ' ↓',
                        }[header.column.getIsSorted() as string] ?? null}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody
          style={{
            height: shouldVirtualize ? `${virtualizer.getTotalSize()}px` : 'auto',
            position: 'relative',
          }}
        >
          {shouldVirtualize ? (
            // Virtualized rendering for large tables
            virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              return (
                <tr
                  key={row.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="border-b border-border hover:bg-muted/50 transition-colors"
                >
                  {row.getVisibleCells().map((cell, cellIndex) => {
                    // First column (usually text) = left align, others = right align
                    // For Failure RCA tables, ensure consistent alignment
                    const isFirstColumn = cellIndex === 0;
                    const alignClass = isFirstColumn ? 'text-left' : 'text-right';
                    return (
                      <td
                        key={cell.id}
                        className={`py-3 px-4 text-sm ${alignClass} whitespace-nowrap`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          ) : (
            // Regular rendering for small tables
            rows.map((row) => {
              return (
                <tr
                  key={row.id}
                  className="border-b border-border hover:bg-muted/50 transition-colors"
                >
                  {row.getVisibleCells().map((cell, cellIndex) => {
                    // First column (usually text) = left align, others = right align
                    // For Failure RCA tables, ensure consistent alignment
                    const isFirstColumn = cellIndex === 0;
                    const alignClass = isFirstColumn ? 'text-left' : 'text-right';
                    return (
                      <td
                        key={cell.id}
                        className={`py-3 px-4 text-sm ${alignClass} whitespace-nowrap`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
