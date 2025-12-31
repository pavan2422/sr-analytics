'use client';

import { useMemo, memo } from 'react';
import ReactECharts from 'echarts-for-react';

interface DonutChartData {
  name: string;
  value: number;
}

interface BarChartData {
  name: string;
  volume: number;
  sr?: number;
}

interface LineChartData {
  name: string;
  volume: number;
  sr: number;
}

interface ScatterData {
  name: string;
  volume: number;
  sr: number;
}

interface AmountDistributionData {
  name: string;
  volume: number;
  gmv: number;
  sr: number;
}

interface OverviewChartProps {
  type: 'donut' | 'paymentMode' | 'hourly' | 'pg' | 'failureReasons' | 'dayOfWeek' | 'amountDistribution' | 'srTrend' | 'banks' | 'scatter';
  data: DonutChartData[] | BarChartData[] | LineChartData[] | ScatterData[] | AmountDistributionData[];
  height?: number;
}

// Chart Safety Limits: Cap categories at 50, skip <0.1%
function applyChartSafetyLimits(barData: BarChartData[]): BarChartData[] {
  if (barData.length === 0) return barData;
  
  const totalVolume = barData.reduce((sum, d) => sum + (d.volume || 0), 0);
  const minVolumeThreshold = totalVolume * 0.001; // 0.1% threshold
  
  let filteredData = barData.filter(d => (d.volume || 0) >= minVolumeThreshold);
  
  // Sort by volume and cap at 50
  filteredData.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  if (filteredData.length > 50) {
    const top50 = filteredData.slice(0, 50);
    const others = filteredData.slice(50);
    const othersVolume = others.reduce((sum, d) => sum + (d.volume || 0), 0);
    const othersSR = othersVolume > 0 
      ? others.reduce((sum, d) => sum + ((d.sr || 0) * (d.volume || 0)), 0) / othersVolume
      : 0;
    filteredData = [...top50, { name: 'OTHER', volume: othersVolume, sr: othersSR }];
  }
  
  return filteredData;
}

function OverviewChartComponent({ type, data, height = 400 }: OverviewChartProps) {
  const option = useMemo(() => {
    if (type === 'donut') {
      const donutData = data as DonutChartData[];
      return {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(26, 26, 26, 0.95)',
          borderColor: '#2a2a2a',
          textStyle: { color: '#ffffff' },
          formatter: '{b}: {c} ({d}%)',
        },
        legend: {
          orient: 'vertical',
          left: 'left',
          textStyle: { color: '#a1a1aa' },
        },
        series: [
          {
            name: 'Transaction Status',
            type: 'pie',
            radius: ['40%', '70%'],
            avoidLabelOverlap: false,
            itemStyle: {
              borderRadius: 10,
              borderColor: '#0a0a0a',
              borderWidth: 2,
            },
            label: {
              show: true,
              formatter: '{b}\n{d}%',
              color: '#ffffff',
            },
            emphasis: {
              label: {
                show: true,
                fontSize: 14,
                fontWeight: 'bold',
              },
            },
            data: donutData.map((d, idx) => ({
              ...d,
              itemStyle: {
                color: idx === 0 ? '#10b981' : idx === 1 ? '#ef4444' : '#f59e0b',
              },
            })),
          },
        ],
      };
    }

    if (type === 'paymentMode') {
      const barData = applyChartSafetyLimits(data as BarChartData[]);
      return {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
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
          data: barData.map((d) => d.name),
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa', rotate: 15 },
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
            data: barData.map((d) => d.volume),
            itemStyle: { color: '#3b82f6' },
          },
          {
            name: 'SR %',
            type: 'line',
            yAxisIndex: 1,
            data: barData.map((d) => d.sr || 0),
            smooth: true,
            itemStyle: { color: '#10b981' },
            symbol: 'circle',
            symbolSize: 8,
          },
        ],
      };
    }

    if (type === 'hourly') {
      const lineData = data as LineChartData[];
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
          data: lineData.map((d) => d.name),
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
            data: lineData.map((d) => d.volume),
            itemStyle: { color: '#3b82f6' },
          },
          {
            name: 'SR %',
            type: 'line',
            yAxisIndex: 1,
            data: lineData.map((d) => d.sr),
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

    if (type === 'pg') {
      const barData = applyChartSafetyLimits(data as BarChartData[]);
      return {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
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
          data: barData.map((d) => d.name),
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa', rotate: 15 },
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
            data: barData.map((d) => d.volume),
            itemStyle: { color: '#3b82f6' },
          },
          {
            name: 'SR %',
            type: 'line',
            yAxisIndex: 1,
            data: barData.map((d) => d.sr || 0),
            smooth: true,
            itemStyle: { color: '#10b981' },
            symbol: 'circle',
            symbolSize: 8,
          },
        ],
      };
    }

    if (type === 'failureReasons') {
      const barData = applyChartSafetyLimits(data as BarChartData[]);
      const showValueLabels = barData.length <= 20;
      return {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          backgroundColor: 'rgba(26, 26, 26, 0.95)',
          borderColor: '#2a2a2a',
          textStyle: { color: '#ffffff' },
          formatter: (params: any) => {
            const param = params[0];
            return `${param.name}<br/>Count: ${param.value}`;
          },
        },
        grid: {
          left: '28%',
          right: '4%',
          bottom: '10%',
          top: '3%',
          containLabel: true,
        },
        xAxis: {
          type: 'value',
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa' },
          splitLine: { lineStyle: { color: '#1a1a1a' } },
        },
        yAxis: {
          type: 'category',
          data: barData.map((d) => d.name),
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: {
            color: '#a1a1aa',
            width: 260,
            overflow: 'truncate',
          },
        },
        dataZoom: barData.length > 20 ? [
          {
            type: 'slider',
            yAxisIndex: 0,
            width: 10,
            right: 4,
            start: 0,
            end: Math.min(100, Math.max(30, (20 / barData.length) * 100)),
          },
          {
            type: 'inside',
            yAxisIndex: 0,
            start: 0,
            end: Math.min(100, Math.max(30, (20 / barData.length) * 100)),
          },
        ] : [],
        series: [
          {
            name: 'Failure Count',
            type: 'bar',
            data: barData.map((d) => d.volume),
            itemStyle: { color: '#ef4444' },
            label: {
              show: showValueLabels,
              position: 'right',
              color: '#ffffff',
              formatter: '{c}',
            },
          },
        ],
      };
    }

    if (type === 'dayOfWeek') {
      const barData = data as BarChartData[];
      const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      const sortedData = dayOrder.map(day => barData.find(d => d.name === day) || { name: day, volume: 0, sr: 0 });
      
      return {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
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
          data: sortedData.map((d) => d.name.substring(0, 3)),
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
            data: sortedData.map((d) => d.volume),
            itemStyle: { color: '#3b82f6' },
          },
          {
            name: 'SR %',
            type: 'line',
            yAxisIndex: 1,
            data: sortedData.map((d) => d.sr || 0),
            smooth: true,
            itemStyle: { color: '#10b981' },
            symbol: 'circle',
            symbolSize: 8,
          },
        ],
      };
    }

    if (type === 'amountDistribution') {
      const amountData = data as AmountDistributionData[];
      return {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
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
          data: amountData.map((d) => d.name),
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa', rotate: 15 },
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
            data: amountData.map((d) => d.volume),
            itemStyle: { color: '#3b82f6' },
          },
          {
            name: 'SR %',
            type: 'line',
            yAxisIndex: 1,
            data: amountData.map((d) => d.sr),
            smooth: true,
            itemStyle: { color: '#10b981' },
            symbol: 'circle',
            symbolSize: 8,
          },
        ],
      };
    }

    if (type === 'srTrend') {
      const lineData = data as LineChartData[];
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
          data: lineData.map((d) => d.name),
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa' },
        },
        yAxis: {
          type: 'value',
          name: 'SR %',
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
            data: lineData.map((d) => d.sr),
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
            markLine: {
              data: [
                { yAxis: 95, name: 'Target SR', lineStyle: { color: '#10b981', type: 'dashed' } },
                { yAxis: 90, name: 'Warning', lineStyle: { color: '#f59e0b', type: 'dashed' } },
              ],
            },
          },
        ],
      };
    }

    if (type === 'banks') {
      const barData = data as BarChartData[];
      return {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
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
          data: barData.map((d) => d.name.length > 15 ? d.name.substring(0, 15) + '...' : d.name),
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa', rotate: 15 },
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
            data: barData.map((d) => d.volume),
            itemStyle: { color: '#3b82f6' },
          },
          {
            name: 'SR %',
            type: 'line',
            yAxisIndex: 1,
            data: barData.map((d) => d.sr || 0),
            smooth: true,
            itemStyle: { color: '#10b981' },
            symbol: 'circle',
            symbolSize: 8,
          },
        ],
      };
    }

    if (type === 'scatter') {
      const scatterData = data as ScatterData[];
      return {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(26, 26, 26, 0.95)',
          borderColor: '#2a2a2a',
          textStyle: { color: '#ffffff' },
          formatter: (params: any) => {
            const data = params.data;
            return `${data[2] || 'Unknown'}<br/>Volume: ${data[0]}<br/>SR: ${data[1].toFixed(2)}%`;
          },
        },
        grid: {
          left: '3%',
          right: '4%',
          bottom: '3%',
          containLabel: true,
        },
        xAxis: {
          type: 'value',
          name: 'Volume',
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa' },
          splitLine: { lineStyle: { color: '#1a1a1a' } },
        },
        yAxis: {
          type: 'value',
          name: 'SR %',
          min: 0,
          max: 100,
          axisLine: { lineStyle: { color: '#2a2a2a' } },
          axisLabel: { color: '#a1a1aa', formatter: '{value}%' },
          splitLine: { lineStyle: { color: '#1a1a1a' } },
        },
        series: [
          {
            name: 'Volume vs SR',
            type: 'scatter',
            data: scatterData.map((d) => [d.volume, d.sr, d.name]),
            symbolSize: (data: any) => Math.sqrt(data[0]) / 10,
            itemStyle: {
              color: (params: any) => {
                const sr = params.data[1];
                if (sr >= 95) return '#10b981';
                if (sr >= 90) return '#f59e0b';
                return '#ef4444';
              },
              opacity: 0.7,
            },
          },
        ],
      };
    }

    return {};
  }, [type, data]);

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
export const OverviewChart = memo(OverviewChartComponent);

