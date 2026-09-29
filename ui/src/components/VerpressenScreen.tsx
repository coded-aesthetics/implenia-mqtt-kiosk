import { useMemo, useRef, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SensorReading, RecordingState } from '../hooks/useWebSocket';
import type { VorgabenData } from '../hooks/useImplenia';
import { SensorGauge } from './SensorGauge';
import { SensorChart, type ChartSeries, type ChartScale } from './SensorChart';
import { KlemmbackeIndicator } from './KlemmbackeIndicator';
import { formatNumber } from '../utils/format';

export interface GaugeSlot {
  sensor: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  vorgabeName?: string;
}

export interface ChartTrace {
  sensor: string;
  label: string;
  unit: string;
  color: string;
  scale?: string;
}

export interface VerpressenConfig {
  depthSensor: string;
  volumeSensor: string;
  gauges: GaugeSlot[];
  chartTraces: ChartTrace[];
  chartScales?: ChartScale[];
}

interface ClampConfig {
  clampTopic: string | null;
  openThreshold: number;
  closeThreshold: number;
}

interface Props {
  readings: Map<string, SensorReading>;
  vorgaben: VorgabenData | null;
  config: VerpressenConfig;
  recordingState: RecordingState;
}

const CHART_WINDOW_MINUTES = 5;
const MAX_BUFFER_POINTS = CHART_WINDOW_MINUTES * 60 * 2;

function findSoll(vorgaben: VorgabenData | null, sensorName: string): number | null {
  if (!vorgaben) return null;
  const fv = vorgaben.float_sensors?.[sensorName];
  if (typeof fv === 'number' && Number.isFinite(fv)) return fv;
  const iv = vorgaben.int_sensors?.[sensorName];
  if (typeof iv === 'number' && Number.isFinite(iv)) return iv;
  return null;
}

function resolveSensorValue(readings: Map<string, SensorReading>, sensor: string): number {
  for (const r of readings.values()) {
    if (r.topic === sensor) {
      const n = parseFloat(r.payload);
      return Number.isFinite(n) ? n : 0;
    }
    const slashIdx = r.topic.lastIndexOf('/');
    if (slashIdx >= 0 && r.topic.substring(slashIdx + 1) === sensor) {
      const n = parseFloat(r.payload);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

export function VerpressenScreen({ readings, vorgaben, config }: Props) {
  // Klemmbacke config from server
  const [clampConfig, setClampConfig] = useState<ClampConfig>({
    clampTopic: null,
    openThreshold: 50,
    closeThreshold: 100,
  });

  useEffect(() => {
    fetch('/api/config/rohrwechsel')
      .then((r) => r.json())
      .then((data) => {
        setClampConfig({
          clampTopic: data.clampTopic ?? null,
          openThreshold: data.openThreshold ?? 50,
          closeThreshold: data.closeThreshold ?? 100,
        });
      })
      .catch(() => {});
  }, []);

  // Build sensor values map
  const sensorValues = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of readings.values()) {
      const n = parseFloat(r.payload);
      const val = Number.isFinite(n) ? n : 0;
      map.set(r.topic, val);
      const slashIdx = r.topic.lastIndexOf('/');
      if (slashIdx >= 0) {
        map.set(r.topic.substring(slashIdx + 1), val);
      }
    }
    return map;
  }, [readings]);

  const depth = sensorValues.get(config.depthSensor) ?? 0;
  const volume = sensorValues.get(config.volumeSensor) ?? 0;

  // Klemmbacke state with hysteresis
  const clampValue = useMemo(() => {
    if (!clampConfig.clampTopic) return 0;
    return resolveSensorValue(readings, clampConfig.clampTopic);
  }, [readings, clampConfig.clampTopic]);

  const clampOpenRef = useRef(true);
  if (clampValue >= clampConfig.closeThreshold) {
    clampOpenRef.current = false;
  } else if (clampValue < clampConfig.openThreshold) {
    clampOpenRef.current = true;
  }
  const isClampOpen = clampOpenRef.current;

  // Chart data accumulation — samples sensorValues at ~1Hz, wall clock timestamps
  const chartBufferRef = useRef<Map<string, Array<{ ts: number; value: number }>>>(new Map());
  const lastSampleRef = useRef(0);

  // Runs during render so the buffer is populated before chartSeries reads it
  const now = Date.now();
  const sampled = now - lastSampleRef.current >= 1000;
  if (sampled) {
    lastSampleRef.current = now;
    const cutoff = now - CHART_WINDOW_MINUTES * 60 * 1000;
    const buf = chartBufferRef.current;

    for (const trace of config.chartTraces) {
      const val = sensorValues.get(trace.sensor);
      if (val === undefined) continue;

      let arr = buf.get(trace.sensor);
      if (!arr) {
        arr = [];
        buf.set(trace.sensor, arr);
      }
      arr.push({ ts: now, value: val });
      while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
      if (arr.length > MAX_BUFFER_POINTS) arr.splice(0, arr.length - MAX_BUFFER_POINTS);
    }
  }

  const chartSeries = useMemo<ChartSeries[]>(() => {
    const buf = chartBufferRef.current;
    return config.chartTraces.map((t) => ({
      label: t.label,
      unit: t.unit,
      color: t.color,
      scale: t.scale,
      data: [...(buf.get(t.sensor) ?? [])],
    }));
  // readings triggers re-computation; sampled ensures we only snapshot at 1Hz
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.chartTraces, readings]);

  return (
    <div style={styles.container}>
      {/* Row 1: Hero values — Tiefe | Gesamtvolumen | Klemmbacke */}
      <div style={styles.heroRow}>
        <div style={styles.heroCell}>
          <div style={styles.heroLabel}>Tiefe</div>
          <div style={styles.heroValueRow}>
            <span style={styles.heroValue}>{formatNumber(depth)}</span>
            <span style={styles.heroUnit}>m</span>
          </div>
        </div>
        <div style={styles.heroCell}>
          <div style={styles.heroLabel}>Gesamtvolumen</div>
          <div style={styles.heroValueRow}>
            <span style={styles.heroValue}>{formatNumber(volume)}</span>
            <span style={styles.heroUnit}>l</span>
          </div>
        </div>
        <div style={styles.heroCell}>
          {clampConfig.clampTopic ? (
            <KlemmbackeIndicator
              value={clampValue}
              unit="bar"
              openThreshold={clampConfig.openThreshold}
              closeThreshold={clampConfig.closeThreshold}
              isOpen={isClampOpen}
            />
          ) : (
            <div style={styles.heroLabel}>Klemmbacke nicht konfiguriert</div>
          )}
        </div>
      </div>

      {/* Row 2: Speed dials */}
      <div style={styles.gaugeRow}>
        {config.gauges.map((g) => (
          <div key={g.sensor} style={styles.gaugeCell}>
            <SensorGauge
              value={sensorValues.get(g.sensor) ?? 0}
              min={g.min}
              max={g.max}
              label={g.label}
              unit={g.unit}
              soll={findSoll(vorgaben, g.vorgabeName ?? g.sensor)}
              size={235}
            />
          </div>
        ))}
      </div>

      {/* Row 3: Chart */}
      <div style={styles.chartRow}>
        <SensorChart
          series={chartSeries}
          scales={config.chartScales}
          windowMinutes={CHART_WINDOW_MINUTES}
          height={200}
        />
      </div>
    </div>
  );
}

export const INJEKTIONSBOHREN_VERPRESSEN: VerpressenConfig = {
  depthSensor: 'Tiefe',
  volumeSensor: 'Q_verpressen',
  gauges: [
    { sensor: 'Druck_Medium', label: 'Druck Medium', unit: 'bar', min: 0, max: 70, vorgabeName: 'Suspensionsdruck' },
    { sensor: 'Verpresspumpe/Durchfluss', label: 'Durchfluss V', unit: 'l/min', min: 0, max: 300, vorgabeName: 'DurchflussV' },
    { sensor: 'Druck_innen', label: 'I.Drehmoment', unit: 'Nm', min: 0, max: 300, vorgabeName: 'IDrehmoment' },
    { sensor: 'Druck_aussen', label: 'A.Drehmoment', unit: 'Nm', min: 0, max: 300, vorgabeName: 'ADrehmoment' },
  ],
  chartTraces: [
    { sensor: 'Druck_Medium', label: 'Druck Medium', unit: 'bar', color: '#42a5f5', scale: 'bar' },
    { sensor: 'Verpresspumpe/Durchfluss', label: 'Durchfluss V', unit: 'l/min', color: '#66bb6a', scale: 'high' },
    { sensor: 'Druck_innen', label: 'I.Drehmoment', unit: 'Nm', color: '#ffa726', scale: 'high' },
    { sensor: 'Druck_aussen', label: 'A.Drehmoment', unit: 'Nm', color: '#ef5350', scale: 'high' },
  ],
  chartScales: [
    { key: 'bar', min: 0, max: 80, side: 1 },
    { key: 'high', min: 0, max: 300, side: 3 },
  ],
};

const styles: Record<string, CSSProperties> = {
  container: {
    padding: '0.5rem 1rem 0',
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    overflow: 'hidden',
    gap: '0.25rem',
  },
  heroRow: {
    display: 'flex',
    gap: '1rem',
    flexShrink: 0,
  },
  heroCell: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '0.25rem 0',
  },
  heroLabel: {
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  heroValueRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: '0.25rem',
  },
  heroValue: {
    fontSize: '3rem',
    fontWeight: 800,
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--text-primary)',
  },
  heroUnit: {
    fontSize: '1.4rem',
    color: 'var(--text-muted)',
    fontWeight: 600,
  },
  gaugeRow: {
    display: 'flex',
    justifyContent: 'center',
    gap: '0.5rem',
    flexShrink: 0,
  },
  gaugeCell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  chartRow: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    alignItems: 'stretch',
  },
};
