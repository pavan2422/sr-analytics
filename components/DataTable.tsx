'use client';

import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  ColumnDef,
  SortingState,
} from '@tanstack/react-table';
import { useState } from 'react';
import { GroupedMetrics, FailureRCA } from '@/types';

interface DataTableProps<T = GroupedMetrics> {
  data: T[];
  columns: ColumnDef<T>[];
  height?: number;
}

export function DataTable<T = GroupedMetrics>({ data, columns, height = 400 }: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
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
      className="border border-border rounded-lg bg-card overflow-auto"
      style={{ height }}
    >
      <table className="w-full">
        <thead className="sticky top-0 bg-card border-b border-border z-10">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} className="border-b border-border">
              {headerGroup.headers.map((header, index) => {
                // First column (usually text) = left align, others = right align
                const alignClass = index === 0 ? 'text-left' : 'text-right';
                return (
                  <th
                    key={header.id}
                    className={`py-3 px-4 ${alignClass} text-sm font-semibold text-muted-foreground`}
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
        <tbody>
          {table.getRowModel().rows.map((row) => {
            return (
              <tr
                key={row.id}
                className="border-b border-border hover:bg-muted/50 transition-colors"
              >
                {row.getVisibleCells().map((cell, cellIndex) => {
                  // First column (usually text) = left align, others = right align
                  const alignClass = cellIndex === 0 ? 'text-left' : 'text-right';
                  return (
                    <td
                      key={cell.id}
                      className={`py-3 px-4 text-sm ${alignClass}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
