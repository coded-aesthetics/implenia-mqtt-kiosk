import { useMemo } from 'react';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight';
import type { CSSProperties } from 'react';
import type { SensorReading, RecordingState } from '../hooks/useWebSocket';
import type { VorgabenData } from '../hooks/useImplenia';
import { SensorGauge } from './SensorGauge';
import { SensorBar } from './SensorBar';
import { KlemmbackeIndicator } from './KlemmbackeIndicator';
import { formatNumber } from '../utils/format';
import { findSoll } from '../utils/sensors';
import { useSensorValues } from '../hooks/useSensorValues';
import { useClampState } from '../hooks/useClampState';
import { buildSchichten, collectVorgabeEntries } from '../utils/vorgaben';
import { BohrprofilLog } from '@coded-aesthetics/din4023/profile';
import { GeologieSpalte } from './GeologieSpalte';
import type { GeologieErfassung } from '../hooks/useGeologieErfassung';

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
  volumeSensor: string;
  leftGauges: GaugeSlot[];
  centerGauge: GaugeSlot;
  rightGauges: GaugeSlot[];
  bars: BarSlot[];
}

interface Props {
  readings: Map<string, SensorReading>;
  vorgaben: VorgabenData | null;
  config: BohrenConfig;
  recordingState: RecordingState;
  /**
   * A planned boundary worth watching for, marked in the profile.
   *
   * Passed in rather than derived here: the recording bar's geology buttons are
   * driven by the same suggestion, and two copies of the rule would let the
   * button offer one boundary while the chart highlighted another.
   */
  markierteGrenze?: number | null;
  /**
   * Live geology entry. While its quick picker is open this column shows the
   * choices instead of the profile — see GeologieSpalte for why that is better
   * than a screen of its own.
   */
  geologie?: GeologieErfassung;
}

export function BohrenScreen({ readings, vorgaben, config, recordingState, markierteGrenze, geologie }: Props) {
  const [geoRef, geoHeight] = useMeasuredHeight();

  const rohrwechsel = recordingState.rohrwechsel;
  const operatingMode = recordingState.operatingMode;

  const allEntries = useMemo(() => collectVorgabeEntries(vorgaben), [vorgaben]);
  const geologyProfile = useMemo(() => buildSchichten(allEntries), [allEntries]);

  const sensorValues = useSensorValues(readings);
  const { clampConfig, clampValue, isClampOpen } = useClampState(sensorValues);

  const depth = sensorValues.get(config.depthSensor) ?? 0;
  const volume = sensorValues.get(config.volumeSensor) ?? 0;

  const showRohr = recordingState.active && operatingMode === 'bohren' && rohrwechsel;

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
          {geologie?.auswahl ? (
            <GeologieSpalte
              art={geologie.auswahl}
              nrs={geologie.kandidaten}
              aktuelleNr={geologie.aktuelleArt}
              onWaehlen={geologie.erfasse}
              // "Andere" only where it leads somewhere: for soils, always (the
              // ground can differ from the plan), and for a Vorgabe with more
              // types than the column shows. The six obstruction kinds are all
              // of them, so there is nothing more to offer.
              onAndere={geologie.auswahl === 'schicht' ? geologie.oeffneAndere : undefined}
            />
          ) : geologyProfile ? (
            <div ref={geoRef} data-testid="geologie-profil" style={styles.geoContainer}>
              <BohrprofilLog
                schichten={geologyProfile.schichten}
                endTiefe={geologyProfile.endTiefe}
                breite={150}
                hoehe={geoHeight > 0 ? geoHeight : 300}
                modus="vollbild"
                tiefenIndikator={depth}
                markierteGrenze={markierteGrenze ?? null}
                styleOverrides={geoStyles}
              />
            </div>
          ) : (
            <div style={styles.geoPlaceholder} />
          )}
        </div>

        {/* Right area: status row + gauges + bars */}
        <div style={styles.rightArea}>
          {/* Status row: Gesamtvolumen | Klemmbacke + Rohr */}
          <div style={styles.statusRow}>
            <div style={styles.volumeCell}>
              <div style={styles.heroLabel}>Gesamtvolumen</div>
              <div style={styles.heroValueRow}>
                <span style={styles.heroValue}>{formatNumber(volume)}</span>
                <span style={styles.heroUnit}>l</span>
              </div>
            </div>
            <div style={styles.klemmRohrCell}>
              {clampConfig.clampTopic && (
                <div style={styles.klemmGauge}>
                  <KlemmbackeIndicator
                    value={clampValue}
                    unit="bar"
                    openThreshold={clampConfig.openThreshold}
                    closeThreshold={clampConfig.closeThreshold}
                    isOpen={isClampOpen}
                  />
                </div>
              )}
              {showRohr && (
                <div style={rohrwechsel.phase === 'rohrwechsel' ? styles.rohrStatusActive : styles.rohrStatus}>
                  <span style={styles.rohrNumber}>Rohr {rohrwechsel.phase === 'rohrwechsel' ? rohrwechsel.pipeCount + 1 : rohrwechsel.pipeCount}</span>
                  {rohrwechsel.phase === 'rohrwechsel' && (
                    <span style={styles.rohrPhase}>Nachlegen</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div style={styles.gaugeLayout}>
            {/* Left stack: half dials */}
            <div style={styles.gaugeStack}>
              {config.leftGauges.map((g) => (
                <div key={g.sensor} style={styles.gaugeLabelWrap}>
                  <SensorGauge
                    value={sensorValues.get(g.sensor) ?? 0}
                    min={g.min}
                    max={g.max}
                    label={g.label}
                    unit={g.unit}
                    soll={findSoll(vorgaben, g.vorgabeName ?? g.sensor)}
                    size={228}
                    half
                  />
                  <span style={styles.gaugeLabelText}>{g.label}</span>
                </div>
              ))}
            </div>

            {/* Center: full dial */}
            <div style={styles.gaugeCenterWrap}>
              <SensorGauge
                value={sensorValues.get(config.centerGauge.sensor) ?? 0}
                min={config.centerGauge.min}
                max={config.centerGauge.max}
                label={config.centerGauge.label}
                unit={config.centerGauge.unit}
                soll={findSoll(vorgaben, config.centerGauge.vorgabeName ?? config.centerGauge.sensor)}
                size={250}
                hideLabel
              />
              <span style={styles.centerGaugeLabelText}>{config.centerGauge.label}</span>
            </div>

            {/* Right stack: half dials */}
            <div style={styles.gaugeStack}>
              {config.rightGauges.map((g) => (
                <div key={g.sensor} style={styles.gaugeLabelWrap}>
                  <SensorGauge
                    value={sensorValues.get(g.sensor) ?? 0}
                    min={g.min}
                    max={g.max}
                    label={g.label}
                    unit={g.unit}
                    soll={findSoll(vorgaben, g.vorgabeName ?? g.sensor)}
                    size={228}
                    half
                  />
                  <span style={styles.gaugeLabelText}>{g.label}</span>
                </div>
              ))}
            </div>
          </div>

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
  volumeSensor: 'Q_Bohren',
  leftGauges: [
    { sensor: 'Druck_Hammer', label: 'Druck Hammer', unit: 'bar', min: 0, max: 300, vorgabeName: 'Druck Hammer' },
    { sensor: 'Druck_Vorschub', label: 'Vorschubdruck', unit: 'bar', min: 0, max: 300, vorgabeName: 'Vorschubdruck' },
  ],
  centerGauge: { sensor: 'Drehzahl', label: 'Drehzahl', unit: '1/min', min: 0, max: 100 },
  rightGauges: [
    { sensor: 'Druck_innen', label: 'Drehm. Innen', unit: 'Nm', min: 0, max: 300, vorgabeName: 'IDrehmoment' },
    { sensor: 'Druck_aussen', label: 'Drehm. Aussen', unit: 'Nm', min: 0, max: 300, vorgabeName: 'ADrehmoment' },
  ],
  bars: [
    { sensor: 'Ziehgeschwindigkeit', label: 'Vorschub', unit: 'cm/min', min: 0, max: 60, vorgabeName: 'Vorschubgeschw.' },
    { sensor: 'Druck_Medium', label: 'Druck Medium', unit: 'bar', min: 0, max: 70, vorgabeName: 'Suspensionsdruck' },
    { sensor: 'Spuelpumpe/Durchfluss', label: 'Durchfluss B', unit: 'l/min', min: 0, max: 300, vorgabeName: 'DurchflussB' },
  ],
};

const geoStyles = {
  depthTick: {
    color: 'var(--text-primary)',
    fontSize: 14,
    fontWeight: 600,
  } as CSSProperties,
  depthLine: {
    borderTopColor: 'var(--text-primary)',
  } as CSSProperties,
  label: {
    fontSize: 14,
    fontWeight: 700,
  } as CSSProperties,
  depthIndicatorLine: {
    borderTopColor: 'var(--color-danger)',
    borderTopWidth: 2,
  } as CSSProperties,
  depthIndicatorLabel: {
    color: 'var(--color-danger)',
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
    color: 'var(--text-primary)',
  },
  depthUnit: {
    fontSize: '1.4rem',
    color: 'var(--text-muted)',
    fontWeight: 600,
  },
  geoContainer: {
    flex: 1,
    minHeight: 0,
    overflow: 'visible',
    marginTop: '0.25rem',
    paddingTop: '0.75rem',
    paddingBottom: '1rem',
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
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexShrink: 0,
    padding: '0 1rem',
  },
  volumeCell: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minWidth: 0,
  },
  heroLabel: {
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
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
  klemmRohrCell: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexShrink: 0,
  },
  klemmGauge: {
    width: 360,
    flexShrink: 0,
  },
  gaugeLayout: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    flexShrink: 0,
  },
  gaugeStack: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.25rem',
  },
  gaugeCenterWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  gaugeLabelWrap: {
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
    marginTop: '-0.5rem',
  },
  centerGaugeLabelText: {
    fontSize: '1rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    marginTop: '-2.5rem',
  },
  rohrStatus: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flexShrink: 0,
    minWidth: '6rem',
    color: 'var(--text-muted)',
  },
  rohrStatusActive: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flexShrink: 0,
    minWidth: '6rem',
    padding: '0.4rem 0.75rem',
    borderRadius: '8px',
    backgroundColor: 'var(--color-warning-tint)',
    color: 'var(--color-warning-text)',
  },
  rohrNumber: {
    fontSize: '1.4rem',
    fontWeight: 800,
    lineHeight: 1.2,
  },
  rohrPhase: {
    fontSize: '1rem',
    fontWeight: 600,
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
