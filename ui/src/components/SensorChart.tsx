import { useRef, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { formatNumber } from '../utils/format';

export interface ChartSeries {
  label: string;
  unit: string;
  color: string;
  scale?: string;
  data: Array<{ ts: number; value: number }>;
}

export interface ChartScale {
  key: string;
  min: number;
  max: number;
  side?: 1 | 3;
}

interface Props {
  series: ChartSeries[];
  scales?: ChartScale[];
  windowMinutes?: number;
  height?: number;
}

function emptyData(seriesCount: number): uPlot.AlignedData {
  const cols: uPlot.AlignedData = [new Float64Array(0)];
  for (let i = 0; i < seriesCount; i++) cols.push(new Float64Array(0));
  return cols;
}

function buildData(series: ChartSeries[]): uPlot.AlignedData {
  if (series.length === 0) return [new Float64Array(0)];

  const tsSet = new Set<number>();
  for (const s of series) {
    for (const d of s.data) tsSet.add(Math.floor(d.ts / 1000));
  }
  const timestamps = Array.from(tsSet).sort((a, b) => a - b);
  if (timestamps.length === 0) return emptyData(series.length);

  const tsIndex = new Map<number, number>();
  timestamps.forEach((t, i) => tsIndex.set(t, i));

  const aligned: uPlot.AlignedData = [new Float64Array(timestamps)];
  for (const s of series) {
    const arr = new Float64Array(timestamps.length).fill(NaN);
    for (const d of s.data) {
      const idx = tsIndex.get(Math.floor(d.ts / 1000));
      if (idx !== undefined) arr[idx] = d.value;
    }
    aligned.push(arr);
  }
  return aligned;
}

const AXIS_STYLE = {
  stroke: 'rgba(255,255,255,0.45)',
  grid: { stroke: 'rgba(255,255,255,0.06)', width: 1 },
  ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
  font: '11px Inter, system-ui, sans-serif',
} as const;

export function SensorChart({ series, scales: scalesProp, windowMinutes = 5, height = 200 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const dataRef = useRef<uPlot.AlignedData>(emptyData(series.length));
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seriesRef = useRef(series);
  seriesRef.current = series;

  const seriesKey = series.map((s) => `${s.label}\0${s.color}\0${s.scale ?? 'y'}`).join('\n');
  const scalesKey = scalesProp?.map((s) => `${s.key}:${s.min}:${s.max}:${s.side ?? 0}`).join('\n') ?? '';

  const seriesOpts = useMemo<uPlot.Series[]>(() => [
    {},
    ...series.map((s) => ({
      label: s.label,
      stroke: s.color,
      width: 2,
      scale: s.scale ?? 'y',
      points: { show: false },
    })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [seriesKey]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const width = el.clientWidth;

    const yScales: Record<string, uPlot.Scale> = {};
    const yAxes: uPlot.Axis[] = [];

    if (scalesProp && scalesProp.length > 0) {
      const numSplits = 4;

      for (const sc of scalesProp) {
        yScales[sc.key] = {
          range: [sc.min, sc.max],
        };
        const isFirst = yAxes.length === 0;
        const step = (sc.max - sc.min) / numSplits;
        const splits = Array.from({ length: numSplits + 1 }, (_, i) => sc.min + i * step);
        yAxes.push({
          scale: sc.key,
          side: sc.side ?? (isFirst ? 3 : 1),
          ...AXIS_STYLE,
          ...(!isFirst && { grid: { show: false }, ticks: { show: false } }),
          splits: () => splits,
          values: (_u, vals) => vals.map((v) => formatNumber(v, 0)),
        });
      }
    } else {
      yScales.y = { auto: true };
      yAxes.push({
        scale: 'y',
        ...AXIS_STYLE,
        values: (_u, vals) => vals.map((v) => formatNumber(v, 0)),
      });
    }

    const opts: uPlot.Options = {
      width,
      height,
      cursor: { show: false },
      legend: { show: true },
      scales: {
        x: {
          time: true,
          auto: true,
          range: (_u, _dataMin, dataMax) => {
            const winSec = windowMinutes * 60;
            const max = dataMax || Math.floor(Date.now() / 1000);
            return [max - winSec, max];
          },
        },
        ...yScales,
      },
      axes: [
        {
          ...AXIS_STYLE,
          values: (_u, vals) => vals.map((v) => {
            const d = new Date(v * 1000);
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          }),
        },
        ...yAxes,
      ],
      series: seriesOpts,
    };

    const initial = buildData(seriesRef.current);
    dataRef.current = initial;

    const chart = new uPlot(opts, initial, el);
    chartRef.current = chart;


    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w > 0 && w !== chart.width) chart.setSize({ width: w, height });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.destroy();
      chartRef.current = null;
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
    };
  }, [height, windowMinutes, seriesOpts, scalesKey]);

  useEffect(() => {
    if (throttleRef.current) return;
    throttleRef.current = setTimeout(() => {
      throttleRef.current = null;
      const data = buildData(seriesRef.current);
      dataRef.current = data;
      chartRef.current?.setData(data);
    }, 1000);
  }, [series]);

  return (
    <>
      <style>{DARK_OVERRIDES}</style>
      <div ref={containerRef} style={styles.container} />
    </>
  );
}

const DARK_OVERRIDES = `
.uplot .u-legend .u-label { color: var(--text-secondary, #ccc); }
.uplot .u-legend .u-value { display: none; }
.uplot .u-legend .u-series:first-child { display: none; }
.uplot .u-inline.u-live th::after { content: none; }
`;

const styles: Record<string, CSSProperties> = {
  container: {
    width: '100%',
    minWidth: 0,
  },
};
