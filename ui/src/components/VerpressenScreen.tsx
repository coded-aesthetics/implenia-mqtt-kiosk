import { useMemo, useRef, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { VorgabenData } from '../hooks/useImplenia';
import { SensorGauge } from './SensorGauge';
import { SensorChart, type ChartSeries, type ChartScale } from './SensorChart';
import { KlemmbackeIndicator } from './KlemmbackeIndicator';
import { formatNumber } from '../utils/format';
import { findSoll, sensorValue } from '../utils/sensors';
import { useSensorValues } from '../hooks/useSensorValues';
import { useClampState } from '../hooks/useClampState';
import { useBoxFit } from '../hooks/useFitScale';

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

interface Props {
  readings: Map<string, import('../hooks/useWebSocket').SensorReading>;
  vorgaben: VorgabenData | null;
  config: VerpressenConfig;
  /**
   * Open the depth correction, or undefined when nothing is being recorded.
   * The depth is the tap target — see BohrenScreen, which has the same hero.
   */
  onKorrigieren?: () => void;
}

const CHART_WINDOW_MINUTES = 5;
const MAX_BUFFER_POINTS = CHART_WINDOW_MINUTES * 60 * 2;

export function VerpressenScreen({ readings, vorgaben, config, onKorrigieren }: Props) {
  const sensorValues = useSensorValues(readings);
  const { clampConfig, clampValue, isClampOpen } = useClampState(sensorValues);

  const depth = sensorValue(sensorValues, config.depthSensor) ?? 0;
  const volume = sensorValue(sensorValues, config.volumeSensor) ?? 0;
  // Same reason as the drilling screen: five figures of litres is wider than a
  // third of the row, and a total that paints over its neighbours is worse
  // than one drawn a little smaller.
  const volumeText = formatNumber(volume);
  const { inner: volumeTextRef, outer: volumeCellRef, scale: volumeScale } = useBoxFit(volumeText);
  // Chart data accumulation — samples sensorValues at ~1Hz via useEffect
  const chartBufferRef = useRef<Map<string, Array<{ ts: number; value: number }>>>(new Map());
  const lastSampleRef = useRef(0);
  const [sampleTick, setSampleTick] = useState(0);

  useEffect(() => {
    const now = Date.now();
    if (now - lastSampleRef.current < 1000) return;
    lastSampleRef.current = now;

    const cutoff = now - CHART_WINDOW_MINUTES * 60 * 1000;
    const buf = chartBufferRef.current;

    for (const trace of config.chartTraces) {
      const val = sensorValue(sensorValues, trace.sensor);
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
    setSampleTick((t) => t + 1);
  }, [sensorValues, config.chartTraces]);

  const chartSeries = useMemo<ChartSeries[]>(() => {
    const buf = chartBufferRef.current;
    return config.chartTraces.map((t) => ({
      label: t.label,
      unit: t.unit,
      color: t.color,
      scale: t.scale,
      data: [...(buf.get(t.sensor) ?? [])],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.chartTraces, sampleTick]);

  return (
    <div style={styles.container}>
      {/* Row 1: Hero values — Tiefe | Gesamtvolumen | Klemmbacke */}
      <div style={styles.heroRow}>
        <button
          style={onKorrigieren ? { ...styles.heroCellKnopf, cursor: 'pointer' } : styles.heroCellKnopf}
          disabled={!onKorrigieren}
          onClick={() => onKorrigieren?.()}
        >
          <div style={styles.heroLabel}>Tiefe</div>
          <div style={styles.heroValueRow}>
            <span style={styles.heroValue}>{formatNumber(depth)}</span>
            <span style={styles.heroUnit}>m</span>
          </div>
          {onKorrigieren && <span style={styles.heroHint}>Tippen zum Korrigieren</span>}
        </button>
        <div style={styles.heroCell} ref={volumeCellRef as React.RefObject<HTMLDivElement>}>
          <div style={styles.heroLabel}>Gesamtvolumen</div>
          <div
            ref={volumeTextRef as React.RefObject<HTMLDivElement>}
            style={{
              ...styles.heroValueRow,
              transform: volumeScale < 1 ? `scale(${volumeScale})` : undefined,
            }}
          >
            <span style={styles.heroValue}>{volumeText}</span>
            <span style={styles.heroUnit}>l</span>
          </div>
        </div>
        <div style={styles.klemmRohrCell}>
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
              value={sensorValue(sensorValues, g.sensor) ?? 0}
              min={g.min}
              max={g.max}
              label={g.label}
              unit={g.unit}
              soll={findSoll(vorgaben, g.vorgabeName ?? g.sensor)}
              size={235}
              hideLabel
            />
            <span style={styles.gaugeLabelText}>{g.label}</span>
          </div>
        ))}
      </div>

      {/*
        Row 3: Chart.

        The three phase buttons that used to sit beside it are gone. The header's
        PhaseStepper owns phase changes now — keeping both would put the control
        in one place and the indicator in another, which is the split that was
        just removed for Bohren/Austausch. The chart gets the width back.
      */}
      <div style={styles.chartRow}>
        <div style={styles.chartFill}>
          <SensorChart
            series={chartSeries}
            scales={config.chartScales}
            windowMinutes={CHART_WINDOW_MINUTES}
            height={200}
          />
        </div>
      </div>
    </div>
  );
}

export const INJEKTIONSBOHREN_VERPRESSEN: VerpressenConfig = {
  depthSensor: 'Tiefe',
  volumeSensor: 'Q_verpressen',
  gauges: [
    // Same capture as the drilling screen's bars — see the note there.
    // Druck_Medium reached 119.93 bar; Verpresspumpe/Durchfluss only 167.44
    // l/min, which is why this one is a fifth of the Spülpumpe's scale.
    { sensor: 'Druck_Medium', label: 'Druck Medium', unit: 'bar', min: 0, max: 150, vorgabeName: 'Suspensionsdruck' },
    { sensor: 'Verpresspumpe/Durchfluss', label: 'Durchfluss V', unit: 'l/min', min: 0, max: 200, vorgabeName: 'DurchflussV' },
    { sensor: 'Druck_innen', label: 'Drehm. Innen', unit: 'Nm', min: 0, max: 300, vorgabeName: 'IDrehmoment' },
    { sensor: 'Druck_aussen', label: 'Drehm. Aussen', unit: 'Nm', min: 0, max: 300, vorgabeName: 'ADrehmoment' },
  ],
  chartTraces: [
    { sensor: 'Druck_Medium', label: 'Druck Medium', unit: 'bar', color: '#42a5f5', scale: 'bar' },
    { sensor: 'Verpresspumpe/Durchfluss', label: 'Durchfluss V', unit: 'l/min', color: '#66bb6a', scale: 'high' },
    { sensor: 'Druck_innen', label: 'Drehm. Innen', unit: 'Nm', color: '#ffa726', scale: 'high' },
    { sensor: 'Druck_aussen', label: 'Drehm. Aussen', unit: 'Nm', color: '#ef5350', scale: 'high' },
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
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '0.25rem 0',
  },
  // The depth cell is a button, so the whole hero is the tap target — and it
  // looks exactly like the cells beside it. What says it can be tapped is the
  // label under the value, not a box drawn around it.
  heroCellKnopf: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '0.25rem 0',
    border: 'none',
    background: 'none',
    color: 'inherit',
    font: 'inherit',
  },
  heroHint: {
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    lineHeight: 1.2,
  },
  klemmRohrCell: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    padding: '0.25rem 0',
  },
  heroLabel: {
    fontSize: 'var(--font-base)',
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
  gaugeLabelText: {
    fontSize: '1rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    marginTop: '-2.5rem',
  },
  chartRow: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'stretch',
  },
  chartFill: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'stretch',
  },
};
