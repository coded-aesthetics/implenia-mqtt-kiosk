import { useMemo, useRef, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SensorReading, RecordingState } from '../hooks/useWebSocket';
import type { VorgabenData } from '../hooks/useImplenia';
import { SensorGauge } from './SensorGauge';
import { SensorBar } from './SensorBar';
import { formatNumber } from '../utils/format';
import { findSoll } from '../utils/sensors';
import { useSensorValues } from '../hooks/useSensorValues';
import { buildSchichten, collectVorgabeEntries } from '../utils/vorgaben';
import { BohrprofilLog } from '@coded-aesthetics/din4023/profile';

export interface GaugeSlot {
  sensor: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  vorgabeName?: string;
}

export interface BarSlot {
  sensor: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  vorgabeName?: string;
}

export interface BohrenConfig {
  depthSensor: string;
  gauges: GaugeSlot[];
  bars: BarSlot[];
}

interface Props {
  readings: Map<string, SensorReading>;
  vorgaben: VorgabenData | null;
  config: BohrenConfig;
  recordingState: RecordingState;
}

export function BohrenScreen({ readings, vorgaben, config, recordingState }: Props) {
  const geoRef = useRef<HTMLDivElement>(null);
  const [geoHeight, setGeoHeight] = useState(0);
  const [ackedWarning, setAckedWarning] = useState<number | null>(null);

  const rohrwechsel = recordingState.rohrwechsel;
  const operatingMode = recordingState.operatingMode;

  useEffect(() => {
    if (!geoRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      setGeoHeight(Math.floor(entry.contentRect.height));
    });
    ro.observe(geoRef.current);
    return () => ro.disconnect();
  }, []);

  const allEntries = useMemo(() => collectVorgabeEntries(vorgaben), [vorgaben]);
  const geologyProfile = useMemo(() => buildSchichten(allEntries), [allEntries]);

  const sensorValues = useSensorValues(readings);

  const depth = sensorValues.get(config.depthSensor) ?? 0;

  return (
    <div style={styles.container}>
      <div style={styles.layout}>
        {/* Left column: depth hero + geology */}
        <div style={styles.leftColumn}>
          <div style={styles.depthHero}>
            <div style={styles.depthRow}>
              <span style={styles.depthValue}>{formatNumber(depth)}</span>
              <span style={styles.depthUnit}>m</span>
            </div>
          </div>
          {geologyProfile && (
            <div ref={geoRef} style={styles.geoContainer}>
              <BohrprofilLog
                schichten={geologyProfile.schichten}
                endTiefe={geologyProfile.endTiefe}
                breite={150}
                hoehe={geoHeight > 0 ? geoHeight : 300}
                modus="vollbild"
                tiefenIndikator={depth}
                styleOverrides={geoStyles}
              />
            </div>
          )}
          {!geologyProfile && <div style={styles.geoPlaceholder} />}
        </div>

        {/* Right area: gauges + bars */}
        <div style={styles.rightArea}>
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
                  size={250}
                />
              </div>
            ))}
          </div>

          {/* Klemmbacke indicator — between gauges and bars */}
          {recordingState.active && operatingMode === 'bohren' && rohrwechsel && (
            <div style={rohrwechsel.phase === 'rohrwechsel' ? styles.klemmStrip : styles.klemmStripOpen}>
              <span
                style={rohrwechsel.phase === 'rohrwechsel' ? styles.klemmDot : styles.klemmDotOpen}
              />
              {rohrwechsel.phase === 'rohrwechsel' ? (
                <span>Rohrwechsel — Rohr {rohrwechsel.pipeCount + 1} einbauen</span>
              ) : (
                <span>Klemmbacke offen — Rohr {rohrwechsel.pipeCount}</span>
              )}
              {rohrwechsel.warning && rohrwechsel.warningSince !== ackedWarning && (
                <span
                  style={styles.klemmWarning}
                  onClick={() => setAckedWarning(rohrwechsel.warningSince ?? null)}
                >
                  {rohrwechsel.warning}
                </span>
              )}
            </div>
          )}

          <div style={styles.barStack}>
            {config.bars.map((b) => (
              <SensorBar
                key={b.sensor}
                value={sensorValues.get(b.sensor) ?? 0}
                min={b.min}
                max={b.max}
                label={b.label}
                unit={b.unit}
                soll={findSoll(vorgaben, b.vorgabeName ?? b.sensor)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export const INJEKTIONSBOHREN_BOHREN: BohrenConfig = {
  depthSensor: 'Tiefe',
  gauges: [
    { sensor: 'Druck_innen', label: 'I.Drehm. / Hammer', unit: 'Nm', min: 0, max: 300, vorgabeName: 'IDrehmoment' },
    { sensor: 'Druck_aussen', label: 'A.Drehm. / Vorschub', unit: 'Nm', min: 0, max: 300, vorgabeName: 'ADrehmoment' },
    { sensor: 'Drehzahl', label: 'Drehzahl', unit: '1/min', min: 0, max: 100 },
  ],
  bars: [
    { sensor: 'Ziehgeschwindigkeit', label: 'Vorschub', unit: 'cm/min', min: 0, max: 60, vorgabeName: 'Vorschubgeschw.' },
    { sensor: 'Druck_Medium', label: 'Druck Medium', unit: 'bar', min: 0, max: 70, vorgabeName: 'Suspensionsdruck' },
    { sensor: 'Verpresspumpe/Durchfluss', label: 'Durchfluss V', unit: 'l/min', min: 0, max: 300, vorgabeName: 'DurchflussV' },
    { sensor: 'Spuelpumpe/Durchfluss', label: 'Durchfluss B', unit: 'l/min', min: 0, max: 300, vorgabeName: 'DurchflussB' },
  ],
};

const geoStyles = {
  depthTick: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 600,
  } as CSSProperties,
  depthLine: {
    borderTopColor: '#ffffff',
  } as CSSProperties,
  label: {
    fontSize: 14,
    fontWeight: 700,
  } as CSSProperties,
  depthIndicatorLine: {
    borderTopColor: '#ff4444',
    borderTopWidth: 2,
  } as CSSProperties,
  depthIndicatorLabel: {
    color: '#ff4444',
    fontSize: 14,
    fontWeight: 700,
  } as CSSProperties,
};

const styles: Record<string, CSSProperties> = {
  container: {
    padding: '0.25rem 1rem 0',
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  layout: {
    display: 'flex',
    gap: '1rem',
    flex: 1,
    minHeight: 0,
  },
  leftColumn: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: 170,
    minHeight: 0,
  },
  depthHero: {
    textAlign: 'center',
    padding: '0.25rem 0',
    flexShrink: 0,
  },
  depthRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: '0.2rem',
  },
  depthValue: {
    fontSize: '3rem',
    fontWeight: 800,
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    color: '#ffffff',
  },
  depthUnit: {
    fontSize: '1.4rem',
    color: '#8899aa',
    fontWeight: 600,
  },
  geoContainer: {
    flex: 1,
    minHeight: 0,
    overflow: 'visible',
    marginTop: '0.25rem',
    paddingTop: '0.75rem',
  },
  geoPlaceholder: {
    flex: 1,
  },
  rightArea: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  gaugeRow: {
    display: 'flex',
    justifyContent: 'center',
    gap: '1rem',
    flexShrink: 0,
    paddingBottom: '0.25rem',
  },
  gaugeCell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  klemmStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.3rem 1rem',
    borderRadius: '4px',
    backgroundColor: 'rgba(230, 81, 0, 0.15)',
    color: '#ffb74d',
    fontSize: '1rem',
    fontWeight: 600,
    flexShrink: 0,
  },
  klemmStripOpen: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.3rem 1rem',
    borderRadius: '4px',
    color: 'var(--text-muted)',
    fontSize: '1rem',
    fontWeight: 600,
    flexShrink: 0,
  },
  klemmDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: '#ffb74d',
    flexShrink: 0,
  },
  klemmDotOpen: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: 'var(--color-success)',
    flexShrink: 0,
  },
  klemmWarning: {
    marginLeft: 'auto',
    color: '#e65100',
    fontSize: '1rem',
    cursor: 'pointer',
  },
  barStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    flex: 1,
    justifyContent: 'center',
    padding: '0 1rem',
  },
};
