'use client';

import { useMemo, memo } from 'react';
import ReactECharts from 'echarts-for-react';
import { DailyTrend } from '@/types';

interface ChartProps {
  data: DailyTrend[];
  type?: 'volume' | 'sr' | 'dual';
  height?: number;
}

function ChartComponent({ data, type = 'dual', height = 400 }: ChartProps) {
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
          data: data.map((d) => d.date),
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
            data: data.map((d) => d.volume),
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
          data: data.map((d) => d.date),
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
            data: data.map((d) => d.sr),
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
        data: data.map((d) => d.date),
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
          data: data.map((d) => d.volume),
          itemStyle: { color: '#3b82f6' },
        },
        {
          name: 'SR %',
          type: 'line',
          yAxisIndex: 1,
          data: data.map((d) => d.sr),
          smooth: true,
          itemStyle: { color: '#10b981' },
        },
      ],
    };
  }, [data, type]);

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
    <ReactECharts
      option={option}
      style={{ height: `${height}px`, width: '100%' }}
      opts={{ renderer: 'canvas' }}
    />
  );
}

// Memoize to prevent unnecessary re-renders
export const Chart = memo(ChartComponent);



