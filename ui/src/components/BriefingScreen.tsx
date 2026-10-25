import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { BohrprofilLog, normalisiere } from '@coded-aesthetics/din4023/profile';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight';
import type { VorgabenData } from '../hooks/useImplenia';
import { findSoll } from '../utils/sensors';
import { formatNumber } from '../utils/format';
import { grad, VORGABE_HORIZONTAL, VORGABE_VERTIKAL } from '../utils/ausrichtung';
import {
  buildSchichten, collectVorgabeEntries, extractCoordinates, geplanteTiefe,
} from '../utils/vorgaben';

/**
 * What is planned at this element, before anyone starts drilling it.
 *
 * Injektionsbohren's Vorgaben are thin — two numbers, two angles, two
 * coordinate triples and up to ten geology layers — and until now they were on
 * the kiosk and on no screen: the element route goes straight to the drilling
 * screen, which draws Soll values only as tick marks on gauges. A worker could
 * not find out how deep the hole was meant to be.
 *
 * Everything fits one screen at 1024x768 with room to spare, so there is no
 * tab, no scroll and nothing behind a tap. `briefingBeimOeffnen` decides when
 * it is shown; this draws it.
 *
 * **It never blocks.** The recording bar is live underneath, so a worker who
 * does not need the briefing starts the recording from here and the drilling
 * screen takes over by itself. The forward button is a convenience, not a gate.
 */

interface Props {
  vorgaben: VorgabenData | null;
  /** Where the forward button goes, and what it is called. */
  weiter: { label: string; aktion: () => void };
}

/** A Soll value with its unit, or a dash. Two decimals, German, as everywhere. */
function soll(vorgaben: VorgabenData | null, name: string): string {
  const wert = findSoll(vorgaben, name);
  return wert === null ? '–' : formatNumber(wert);
}

/**
 * A coordinate for display.
 *
 * `extractCoordinates` hands back the machine-readable strings `vorgabeText`
 * produces — deliberately unformatted, because the geology parser reads them
 * back and `1.234,50` would parse as 1.234. Formatting happens here, at the
 * point of display, which is the rule that module's comment sets out.
 */
function koordinate(wert: string): string {
  return formatNumber(wert);
}

export function BriefingScreen({ vorgaben, weiter }: Props) {
  const [profilRef, profilHoehe] = useMeasuredHeight();

  const entries = useMemo(() => collectVorgabeEntries(vorgaben), [vorgaben]);
  const profil = useMemo(() => buildSchichten(entries), [entries]);
  const koordinaten = useMemo(() => extractCoordinates(entries), [entries]);

  const tiefe = geplanteTiefe(vorgaben);

  /*
   * The depth the survey stops at, where the drawn profile goes deeper.
   *
   * A profile is gapless, so the deepest planned layer is carried down to the
   * bottom — which means the stretch below `vermessenBis` is ground nobody
   * surveyed, drawn as if it were planned. The briefing is the one screen with
   * room to say so, and `markierteGrenze` is the marker the chart already has
   * for a boundary worth noticing.
   *
   * Null when the survey reaches the bottom, which is the ordinary case and
   * needs no marker, and when it states no depth at all.
   */
  const grenze = profil !== null && profil.vermessenBis > 0
    && profil.vermessenBis < profil.endTiefe ? profil.vermessenBis : null;

  /*
   * The layers the chart will actually draw.
   *
   * Never `profil.schichten.length`, which is what the Schichtauftrag listed
   * and not what appears: `normalisiere` — which the chart runs on its input
   * anyway — collapses layers sharing a depth, merges adjacent ones of the
   * same ground type, and drops anything at or below `endTiefe`. A pillar
   * whose bore was keyed shallower than its geology read „4 Schichten" over a
   * column showing one. Counting the same list the chart draws is what keeps
   * the two from ever disagreeing again.
   */
  const gezeichnet = useMemo(
    () => (profil ? normalisiere(profil.schichten, profil.endTiefe) : []),
    [profil],
  );

  const profilUntertitel = profil === null
    ? 'Keine Vorgabe'
    : `${gezeichnet.length} ${gezeichnet.length === 1 ? 'Schicht' : 'Schichten'}`
      + ` bis ${formatNumber(profil.endTiefe)} m`;

  return (
    <div style={styles.container}>
      {/* Left: the planned profile, bottoming out at the planned depth */}
      <div style={styles.geoSpalte}>
        <div style={styles.geoKopf}>
          <div style={styles.geoTitel}>Geologie Soll</div>
          <div style={styles.geoUntertitel}>{profilUntertitel}</div>
        </div>
        {profil ? (
          <div ref={profilRef} data-testid="briefing-profil" style={styles.profil}>
            <BohrprofilLog
              schichten={profil.schichten}
              endTiefe={profil.endTiefe}
              breite={150}
              hoehe={profilHoehe > 0 ? profilHoehe : 400}
              modus="vollbild"
              markierteGrenze={grenze}
              styleOverrides={geoStyles}
            />
          </div>
        ) : (
          <div style={styles.profilLeer}>
            Der Schichtauftrag nennt für dieses Element keine Geologie.
          </div>
        )}
        {grenze !== null && (
          <div style={styles.geoFuss}>
            Unterhalb {formatNumber(grenze)} m ist die Geologie nicht erkundet.
          </div>
        )}
      </div>

      {/* Right: the Soll values */}
      <div style={styles.werte}>
        <div style={styles.heroReihe}>
          <Hero label="Bohrlänge" wert={tiefe === null ? '–' : formatNumber(tiefe)} einheit="m" />
          <Hero label="Sollvolumen" wert={soll(vorgaben, 'Sollvolumen')} einheit="l" />
        </div>

        <section style={styles.karte}>
          <div style={styles.kartenTitel}>Ausrichtung</div>
          <div style={styles.paar}>
            <Winkel label="Horizontalneigung" wert={findSoll(vorgaben, VORGABE_HORIZONTAL)} />
            <Winkel label="Vertikalneigung" wert={findSoll(vorgaben, VORGABE_VERTIKAL)} />
          </div>
        </section>

        <section style={styles.karte}>
          <div style={styles.kartenTitel}>Ansatz- und Fusspunkt</div>
          {koordinaten.length > 0 ? (
            <div style={styles.koordinaten}>
              {koordinaten.map((k) => (
                <div key={k.label} style={styles.koordinatenZeile}>
                  <span style={styles.koordinatenName}>{k.label}</span>
                  <span style={styles.koordinatenWerte}>
                    <span><span style={styles.achse}>X</span>&nbsp;{koordinate(k.x)}</span>
                    <span><span style={styles.achse}>Y</span>&nbsp;{koordinate(k.y)}</span>
                    <span><span style={styles.achse}>Z</span>&nbsp;{koordinate(k.z)}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={styles.leer}>Der Schichtauftrag nennt keine Punkte.</div>
          )}
        </section>

        <button style={styles.weiter} onClick={weiter.aktion}>
          {weiter.label}
          <span style={styles.pfeil}>›</span>
        </button>
      </div>
    </div>
  );
}

function Hero({ label, wert, einheit }: { label: string; wert: string; einheit: string }) {
  return (
    <div style={styles.hero}>
      <div style={styles.heroLabel}>{label}</div>
      <div style={styles.heroZeile}>
        <span style={styles.heroWert}>{wert}</span>
        <span style={styles.heroEinheit}>{einheit}</span>
      </div>
    </div>
  );
}

/**
 * One planned angle.
 *
 * Formatted by `grad()` from ausrichtung.ts, which is what the alignment screen
 * one tap later puts on its Soll chip — the same number must not be spelled two
 * ways on consecutive screens.
 */
function Winkel({ label, wert }: { label: string; wert: number | null }) {
  return (
    <div style={styles.paarZelle}>
      <span style={styles.paarWert}>{wert === null ? '–' : grad(wert)}</span>
      <span style={styles.paarLabel}>{label}</span>
    </div>
  );
}

/** Same overrides the drilling screen gives the chart, so the column matches. */
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
  grenzeMarkiert: {
    borderTopColor: 'var(--color-warning)',
  } as CSSProperties,
};

const styles: Record<string, CSSProperties> = {
  container: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    gap: 'var(--space-md)',
    padding: '0.5rem 1rem 0.75rem',
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  /*
   * 258px, of which the chart's depth gutter takes a fixed 48 and the hatched
   * column fills the remaining 210.
   *
   * `breite` is passed for form's sake and decides nothing: the chart lays its
   * two parts out with flex, so the column takes whatever this width leaves.
   * Wider than the drilling screen's 144px because this screen has the room
   * and the profile is the densest thing on it — and because nothing here
   * competes for the space, there being no depth indicator and no live value
   * above it.
   */
  geoSpalte: {
    flexShrink: 0,
    width: 258,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  geoKopf: { flexShrink: 0, paddingLeft: 2 },
  geoTitel: {
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  geoUntertitel: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
  },
  /*
   * The chart is given a measured pixel height, so the padding that keeps the
   * topmost and bottommost depth labels off the edges has to sit on a box the
   * measurement does not include — hence the wrapper's padding and `flex: 1`
   * on it rather than on the chart.
   */
  profil: {
    flex: 1,
    minHeight: 0,
    overflow: 'visible',
    padding: '0.75rem 0 0.5rem',
  },
  profilLeer: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    lineHeight: 1.4,
  },
  geoFuss: {
    flexShrink: 0,
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    color: 'var(--color-warning-text)',
    lineHeight: 1.2,
  },
  werte: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  // The cards share what is left rather than stacking at their content height:
  // a column of small cards over 200px of empty screen reads as unfinished,
  // and the space is better spent on bigger numbers.
  heroReihe: {
    flex: 1.25,
    minHeight: 0,
    display: 'flex',
    gap: '0.75rem',
  },
  hero: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.1rem',
    padding: '0.5rem 1rem 0.75rem',
    backgroundColor: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
  },
  heroLabel: {
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  },
  heroZeile: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.35rem',
  },
  heroWert: {
    fontSize: '3.5rem',
    fontWeight: 800,
    lineHeight: 1.05,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--text-primary)',
  },
  heroEinheit: {
    fontSize: '1.5rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
  },
  karte: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: '0.5rem',
    padding: '0.5rem 1rem 0.75rem',
    backgroundColor: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
  },
  kartenTitel: {
    flexShrink: 0,
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  paar: { display: 'flex', gap: '0.75rem' },
  paarZelle: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  paarWert: {
    fontSize: '2rem',
    fontWeight: 800,
    lineHeight: 1.1,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--text-primary)',
  },
  paarLabel: {
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
  },
  koordinaten: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  koordinatenZeile: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.75rem',
  },
  koordinatenName: {
    width: 112,
    flexShrink: 0,
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    color: 'var(--text-muted)',
  },
  koordinatenWerte: {
    flex: 1,
    display: 'flex',
    gap: '1rem',
    // Monospace so the digits line up between the two rows: the difference
    // between them is the length and the inclination of the hole, which is the
    // one check worth making on this screen.
    fontFamily: 'var(--font-mono)',
    fontSize: '1.2rem',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap',
  },
  achse: { color: 'var(--text-muted)', fontWeight: 400 },
  leer: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
  },
  weiter: {
    flexShrink: 0,
    minHeight: 72,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-accent)',
    color: '#fff',
    fontFamily: 'inherit',
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    cursor: 'pointer',
  },
  pfeil: { fontSize: '1.6rem', fontWeight: 800, lineHeight: 1, opacity: 0.8 },
};
