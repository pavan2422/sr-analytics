'use client';

import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  ColumnDef,
  SortingState,
} from '@tanstack/react-table';
import { useMemo, useRef, useState } from 'react';
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

  // Use a deterministic layout so header/body alignment never diverges.
  // First column is wide (labels/messages), remaining are numeric.
  const columnCount = table.getHeaderGroups()[0]?.headers?.length ?? 1;
  const gridTemplateColumns = useMemo(() => {
    if (columnCount <= 1) return 'minmax(240px, 1fr)';
    return [
      'minmax(240px, 2fr)',
      ...Array.from({ length: columnCount - 1 }, () => 'minmax(120px, 1fr)'),
    ].join(' ');
  }, [columnCount]);

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
      {/* Header */}
      <div className="sticky top-0 z-10 bg-card border-b border-border">
        {table.getHeaderGroups().map((headerGroup) => (
          <div
            key={headerGroup.id}
            className="grid items-center"
            style={{ gridTemplateColumns }}
          >
            {headerGroup.headers.map((header, index) => {
              const isFirstColumn = index === 0;
              const alignClass = isFirstColumn ? 'text-left' : 'text-right';
              const wrapClass = isFirstColumn ? 'whitespace-normal break-words' : 'whitespace-nowrap';

              return (
                <div
                  key={header.id}
                  className={`py-3 px-4 ${alignClass} text-sm font-semibold text-muted-foreground ${wrapClass}`}
                >
                  {header.isPlaceholder ? null : (
                    <span
                      className={header.column.getCanSort() ? 'cursor-pointer select-none' : ''}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {{
                        asc: ' ↑',
                        desc: ' ↓',
                      }[header.column.getIsSorted() as string] ?? null}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Body */}
      <div
        className="relative"
        style={{ height: shouldVirtualize ? `${virtualizer.getTotalSize()}px` : 'auto' }}
      >
        {(shouldVirtualize ? virtualizer.getVirtualItems() : rows.map((_, i) => ({ index: i, start: i * 50 } as any))).map(
          (virtualRow: any) => {
            const row = rows[virtualRow.index];
            if (!row) return null;

            return (
              <div
                key={row.id}
                ref={shouldVirtualize ? virtualizer.measureElement : undefined}
                data-index={virtualRow.index}
                className="grid items-center border-b border-border hover:bg-muted/50 transition-colors"
                style={{
                  gridTemplateColumns,
                  ...(shouldVirtualize
                    ? {
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                      }
                    : {}),
                }}
              >
                {row.getVisibleCells().map((cell, cellIndex) => {
                  const isFirstColumn = cellIndex === 0;
                  const alignClass = isFirstColumn ? 'text-left' : 'text-right';
                  const wrapClass = isFirstColumn ? 'whitespace-normal break-words' : 'whitespace-nowrap';

                  return (
                    <div
                      key={cell.id}
                      className={`py-3 px-4 text-sm ${alignClass} ${wrapClass}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  );
                })}
              </div>
            );
          }
        )}
      </div>
    </div>
  );
}
