'use client';

import { cn } from '@/lib/utils';
import { formatNumber, formatCurrency } from '@/lib/utils';

interface KPICardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  variant?: 'default' | 'success' | 'error' | 'warning';
}

export function KPICard({
  title,
  value,
  subtitle,
  trend,
  variant = 'default',
}: KPICardProps) {
  const variantStyles = {
    default: 'border-border',
    success: 'border-success/50 bg-success/5',
    error: 'border-error/50 bg-error/5',
    warning: 'border-warning/50 bg-warning/5',
  };

  return (
    <div
      className={cn(
        'p-6 rounded-lg border bg-card',
        variantStyles[variant]
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
        {trend && (
          <span
            className={cn(
              'text-xs font-medium',
              trend.isPositive ? 'text-success' : 'text-error'
            )}
          >
            {trend.isPositive ? '+' : ''}
            {trend.value.toFixed(1)}%
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <p className="text-2xl font-bold">{value}</p>
        {subtitle && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
    </div>
  );
}








