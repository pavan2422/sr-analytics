'use client';

import { useMemo, memo } from 'react';
import ReactECharts from 'echarts-for-react';
import { DailyTrend } from '@/types';

interface ChartProps {
  data: DailyTrend[];
  type?: 'volume' | 'sr' | 'dual';
  height?: number;
}

// Sample data for large datasets to improve performance
// For 5GB files, we need very aggressive sampling
function sampleData<T extends { date: string }>(data: T[], maxPoints: number = 1000): T[] {
  if (data.length <= maxPoints) return data;
  
  // For very large datasets (>10k points), use more aggressive sampling
  const actualMaxPoints = data.length > 10000 ? 500 : maxPoints;
  
  // Use evenly distributed sampling
  const step = Math.ceil(data.length / actualMaxPoints);
  const sampled: T[] = [];
  
  for (let i = 0; i < data.length; i += step) {
    sampled.push(data[i]);
  }
  
  // Always include the first and last point
  if (sampled.length === 0 || sampled[0] !== data[0]) {
    sampled.unshift(data[0]);
  }
  if (sampled.length === 0 || sampled[sampled.length - 1] !== data[data.length - 1]) {
    sampled.push(data[data.length - 1]);
  }
  
  return sampled;
}

function ChartComponent({ data, type = 'dual', height = 400 }: ChartProps) {
  // Sample data if it's too large to prevent rendering issues
  const sampledData = useMemo(() => sampleData(data, 1000), [data]);
  
  const option = useMemo(() => {
    if (type === 'volume') {
      return {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          backgroundColor: 'rgba(26, 26, 26, 0.95)',
          borderColor: '#2a2a2a',
          textStyle: { color: '#ffffff' },
        },
        grid: {
          left: '3%',
          right: '4%',
          bottom: '3%',
          containLabel: true,
        },
        xAxis: {
          type: 'category',
          data: sampledData.map((d) => d.date),
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa' },
        },
        yAxis: {
          type: 'value',
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa' },
          splitLine: { lineStyle: { color: '#1a1a1a' } },
        },
        series: [
          {
            name: 'Volume',
            type: 'bar',
            data: sampledData.map((d) => d.volume),
            itemStyle: { color: '#3b82f6' },
          },
        ],
      };
    }

    if (type === 'sr') {
      return {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(26, 26, 26, 0.95)',
          borderColor: '#2a2a2a',
          textStyle: { color: '#ffffff' },
        },
        grid: {
          left: '3%',
          right: '4%',
          bottom: '3%',
          containLabel: true,
        },
        xAxis: {
          type: 'category',
          data: sampledData.map((d) => d.date),
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa' },
        },
        yAxis: {
          type: 'value',
          min: 0,
          max: 100,
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa', formatter: '{value}%' },
          splitLine: { lineStyle: { color: '#1a1a1a' } },
        },
        series: [
          {
            name: 'SR %',
            type: 'line',
            data: sampledData.map((d) => d.sr),
            smooth: true,
            itemStyle: { color: '#10b981' },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(16, 185, 129, 0.3)' },
                  { offset: 1, color: 'rgba(16, 185, 129, 0.05)' },
                ],
              },
            },
          },
        ],
      };
    }

    // Dual axis
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: 'rgba(26, 26, 26, 0.95)',
        borderColor: '#2a2a2a',
        textStyle: { color: '#ffffff' },
      },
      legend: {
        data: ['Volume', 'SR %'],
        textStyle: { color: '#a1a1aa' },
        top: 10,
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: sampledData.map((d) => d.date),
        axisLine: { lineStyle: { color: '#2a2a2a' } },
        axisLabel: { color: '#a1a1aa' },
      },
      yAxis: [
        {
          type: 'value',
          name: 'Volume',
          position: 'left',
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa' },
          splitLine: { lineStyle: { color: '#1a1a1a' } },
        },
        {
          type: 'value',
          name: 'SR %',
          position: 'right',
          min: 0,
          max: 100,
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa', formatter: '{value}%' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Volume',
          type: 'bar',
          yAxisIndex: 0,
          data: sampledData.map((d) => d.volume),
          itemStyle: { color: '#3b82f6' },
        },
        {
          name: 'SR %',
          type: 'line',
          yAxisIndex: 1,
          data: sampledData.map((d) => d.sr),
          smooth: true,
          itemStyle: { color: '#10b981' },
        },
      ],
    };
  }, [sampledData, type]);

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
    <div>
      {data.length > 1000 && (
        <div className="text-xs text-muted-foreground mb-2 px-2">
          Showing sampled data ({sampledData.length} of {data.length} points for performance)
        </div>
      )}
      <ReactECharts
        option={option}
        style={{ height: `${height}px`, width: '100%' }}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  );
}

// Memoize to prevent unnecessary re-renders
export const Chart = memo(ChartComponent);



