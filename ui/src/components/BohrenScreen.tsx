import { useMemo } from 'react';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight';
import type { CSSProperties } from 'react';
import type { SensorReading, RecordingState } from '../hooks/useWebSocket';
import type { VorgabenData } from '../hooks/useImplenia';
import { SensorGauge } from './SensorGauge';
import { SensorBar } from './SensorBar';
import { KlemmbackeIndicator } from './KlemmbackeIndicator';
import { formatNumber } from '../utils/format';
import { findSoll, sensorValue, type Kanal } from '../utils/sensors';
import { useSensorValues } from '../hooks/useSensorValues';
import { useClampState } from '../hooks/useClampState';
import { useBoxFit } from '../hooks/useFitScale';
import { buildSchichten, collectVorgabeEntries } from '../utils/vorgaben';
import { BohrprofilLog } from '@coded-aesthetics/din4023/profile';
import { GeologieSpalte } from './GeologieSpalte';
import { bisZurBohrung } from '../utils/geologie';
import type { GeologieErfassung } from '../hooks/useGeologieErfassung';

export interface GaugeSlot extends Kanal {
  label: string;
  unit: string;
  min: number;
  max: number;
  vorgabeName?: string;
}

export interface BarSlot extends Kanal {
  label: string;
  unit: string;
  min: number;
  max: number;
  vorgabeName?: string;
}

export interface BohrenConfig {
  depth: Kanal;
  volume: Kanal;
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
  /**
   * Open the depth correction, or undefined when there is nothing to correct
   * (no recording running).
   *
   * The depth itself is the tap target: it is what the worker is looking at
   * when they notice the measuring wheel has slipped, and the hint under it is
   * the only thing that says the number can be moved. A button of its own
   * would cost 64px of a column that has none to spare.
   */
  onKorrigieren?: () => void;
}

export function BohrenScreen({
  readings, vorgaben, config, recordingState, markierteGrenze, geologie, onKorrigieren,
}: Props) {
  const [geoRef, geoHeight] = useMeasuredHeight();

  const rohrwechsel = recordingState.rohrwechsel;
  const operatingMode = recordingState.operatingMode;

  const allEntries = useMemo(() => collectVorgabeEntries(vorgaben), [vorgaben]);
  const geologyProfile = useMemo(() => buildSchichten(allEntries), [allEntries]);

  const sensorValues = useSensorValues(readings);
  const { clampConfig, clampValue, isClampOpen } = useClampState(sensorValues);

  const depth = sensorValue(sensorValues, config.depth.sensor, config.depth.topic) ?? 0;
  const volume = sensorValue(sensorValues, config.volume.sensor, config.volume.topic) ?? 0;
  /*
   * The total runs to five figures on a real shift — 41 912,50 l on the only
   * rig that has been captured — and its cell is whatever the Klemmbacke and
   * the pipe counter leave over. At 3rem in the kiosk's font that number is
   * wider than the gap, so it used to paint over both its neighbours and off
   * its own left edge. Shrinking it is the only option that keeps every digit.
   */
  const volumeText = formatNumber(volume);
  const { inner: volumeTextRef, outer: volumeCellRef, scale: volumeScale } = useBoxFit(volumeText);

  const showRohr = recordingState.active && operatingMode === 'bohren' && rohrwechsel;

  /**
   * What the column draws.
   *
   * While recording, the live profile: the layers the operator actually
   * recorded, drawn solid, with the Schichtauftrag dashed below — so an
   * obstruction is visible from the moment it is entered and grows with the
   * hole, instead of the only feedback being a message that fades after six
   * seconds. Before a recording starts there is nothing observed, so the plan
   * is the whole story.
   *
   * Either way its bottom is pulled down to the drill: the probe drilling the
   * Vorgabe comes from often stops short of the hole, and below `endTiefe` the
   * chart draws neither the depth indicator nor a layer. See bisZurBohrung.
   */
  const gezeigtesProfil = bisZurBohrung(geologie?.profil ?? geologyProfile, depth);

  return (
    <div style={styles.container}>
      <div style={styles.layout}>
        {/* Left column: depth hero + geology */}
        <div style={styles.leftColumn}>
          <button
            style={onKorrigieren ? { ...styles.depthHero, cursor: 'pointer' } : styles.depthHero}
            disabled={!onKorrigieren}
            onClick={() => onKorrigieren?.()}
          >
            <div style={styles.depthRow}>
              <span style={styles.depthValue}>{formatNumber(depth)}</span>
              <span style={styles.depthUnit}>m</span>
            </div>
            {onKorrigieren && <span style={styles.depthHint}>Tippen zum Korrigieren</span>}
          </button>
          {geologie?.auswahl ? (
            <GeologieSpalte
              art={geologie.auswahl}
              nrs={geologie.kandidaten}
              aktiveNr={geologie.aktiveArt}
              vorgabeNr={geologie.vorgabeArt}
              onWaehlen={geologie.erfasse}
              // "Andere" only where it leads somewhere: for soils, always (the
              // ground can differ from the plan), and for a Vorgabe with more
              // types than the column shows. The six obstruction kinds are all
              // of them, so there is nothing more to offer.
              onAndere={geologie.auswahl === 'schicht' ? geologie.oeffneAndere : undefined}
            />
          ) : gezeigtesProfil ? (
            <div ref={geoRef} data-testid="geologie-profil" style={styles.geoContainer}>
              <BohrprofilLog
                schichten={gezeigtesProfil.schichten}
                endTiefe={gezeigtesProfil.endTiefe}
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
            <div style={styles.volumeCell} ref={volumeCellRef as React.RefObject<HTMLDivElement>}>
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
                    value={sensorValue(sensorValues, g.sensor, g.topic) ?? 0}
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
                value={sensorValue(sensorValues, config.centerGauge.sensor, config.centerGauge.topic) ?? 0}
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
                    value={sensorValue(sensorValues, g.sensor, g.topic) ?? 0}
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
                value={sensorValue(sensorValues, b.sensor, b.topic) ?? 0}
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

/*
 * The three bar ranges come from Bohrung G08, Marktbreit, the one full shift
 * captured off a real Injektionsbohren rig. They were set by eye before that
 * capture existed and every one of them was too small — so the bar sat pinned
 * at its right end through the whole of the phase it is there to report, which
 * is the one thing a bar may not do: it then shows no change at all while the
 * value moves, and a worker watching it has no way to know that.
 *
 * `assets/reference/README.md` is the in-repo record of the capture, including
 * the full-session range of every topic. The raw 15 MB dump
 * (`assets/bohrung_g8_marktbreit_mqtt.txt`) is gitignored and kept beside the
 * repo — ask for a copy. The two slices in `server/test-fixtures/` are in the
 * repo, and the distributions below can be recomputed from them.
 *
 *                          was      full session    while actually running
 *   Ziehgeschwindigkeit    0..60   -121.7 / 144.0   median  56, max  143
 *   Druck_Medium           0..70    -76.8 / 119.9   median  63, max   81
 *   Spuelpumpe/Durchfluss  0..300     0.0 / 1046.5  median 698, max  872
 *
 * The last column is what settles it, and it is the column the first pass at
 * this did not have: the pump's *median* while pumping is 698 l/min against an
 * old scale that ended at 300, and the feed's median while advancing is 56
 * against one that ended at 60. These are sustained working values, not
 * spikes on an otherwise quiet channel, so the old bars were off their own
 * scale for most of a shift rather than occasionally.
 *
 * The maxima are rounded up past the full-session extreme for headroom — one
 * rig is one rig, and a scale that is slightly generous costs resolution while
 * one that is too short costs the reading. `Druck_Medium` keeps the Verpressen
 * screen's scale for the same sensor (0..150), so the operator reads one
 * number in one place on both screens; that leaves its working band in the
 * lower half of the bar, which is the price of agreeing with the gauge next
 * door and of the clean 0/50/100/150 ticks `autoLabelStep` gives it.
 *
 * Negative values (retraction, suction) still clamp to the left end — the
 * drilling screen is about what goes down the hole. The reading beside the bar
 * carries the sign.
 */
export const INJEKTIONSBOHREN_BOHREN: BohrenConfig = {
  depth: { sensor: 'Bohrtiefe', topic: 'Tiefe' },
  volume: { sensor: 'Q_Bohren', topic: 'Spuelpumpe/Volumen' },
  leftGauges: [
    { sensor: 'Druck Hammer', topic: 'Druck_Hammer', label: 'Druck Hammer', unit: 'bar', min: 0, max: 300, vorgabeName: 'Druck Hammer' },
    { sensor: 'Vorschubdruck', topic: 'Druck_Vorschub', label: 'Vorschubdruck', unit: 'bar', min: 0, max: 300, vorgabeName: 'Vorschubdruck' },
  ],
  centerGauge: { sensor: 'Drehzahl', label: 'Drehzahl', unit: '1/min', min: 0, max: 100 },
  rightGauges: [
    { sensor: 'IDrehmoment', topic: 'Druck_innen', label: 'Drehm. Innen', unit: 'Nm', min: 0, max: 300, vorgabeName: 'IDrehmoment' },
    { sensor: 'ADrehmoment', topic: 'Druck_aussen', label: 'Drehm. Aussen', unit: 'Nm', min: 0, max: 300, vorgabeName: 'ADrehmoment' },
  ],
  bars: [
    { sensor: 'Vorschubgeschw.', topic: 'Ziehgeschwindigkeit', label: 'Vorschub', unit: 'cm/min', min: 0, max: 150, vorgabeName: 'Vorschubgeschw.' },
    { sensor: 'Suspensionsdruck', topic: 'Druck_Medium', label: 'Druck Medium', unit: 'bar', min: 0, max: 150, vorgabeName: 'Suspensionsdruck' },
    { sensor: 'DurchflussB', topic: 'Spuelpumpe/Durchfluss', label: 'Durchfluss B', unit: 'l/min', min: 0, max: 1200, vorgabeName: 'DurchflussB' },
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
    // Wide enough for `Tippen zum Korrigieren` on one line under the depth.
    // The profile itself is 150px; the slack it costs comes out of the gauge
    // row, which has ~80px of it, rather than out of the profile's height.
    //
    // 192 was measured against the font a development machine resolved before
    // `--font-body` was applied to anything; in the kiosk's own font the hint
    // is 212px and wrapped to two lines on the machine and nowhere else. The
    // string is the measurement — if it changes, re-measure.
    width: 224,
    minHeight: 0,
  },
  depthHero: {
    textAlign: 'center',
    padding: '0.25rem 0',
    flexShrink: 0,
    // A button, so the whole hero is the tap target — and styled as no button
    // at all. A card drawn around the depth read as crammed next to the
    // profile, and the affordance it was carrying is in the label underneath.
    border: 'none',
    background: 'none',
    color: 'inherit',
    font: 'inherit',
    width: '100%',
    display: 'block',
  },
  depthHint: {
    display: 'block',
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    lineHeight: 1.2,
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
  // `1 1 auto`, not `1`: with a zero basis this cell took only what the
  // Klemmbacke left over, so a wide total shrank itself to fit while 80px of
  // give sat unused next door. Sized from its content, the two give way in
  // proportion and the reading stays as large as it can be.
  volumeCell: {
    flex: '1 1 auto',
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
    gap: '0.75rem',
    flexShrink: 1,
    // Neither the indicator nor the pipe counter can shrink, so a cell that
    // shrinks anyway does not make them smaller — it pushes the counter out
    // through the right edge of the screen, where `rightArea`'s overflow
    // quietly cuts it off. The floor has to be what the two of them measure.
    minWidth: 'fit-content',
  },
  // Was a hard 360. The total volume beside it has no width of its own — it
  // takes what is left — so a fixed Klemmbacke meant a wide reading had
  // nowhere to go but over the top of this one. It gives up 80px before the
  // number has to shrink, and never goes below a bar worth looking at.
  klemmGauge: {
    flex: '0 1 360px',
    // `fit-content`, not a number: the floor is whatever "Klemmbacke Auf" plus
    // the pressure actually measures in the font of the day. A hand-picked
    // 280 was narrower than that text, so the row shrank past it and the unit
    // disappeared behind the pipe counter — the same class of mistake as the
    // column width this is next to, and this one cannot be made again.
    minWidth: 'fit-content',
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
