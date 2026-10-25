import { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { BohrprofilLog, normalisiere } from '@coded-aesthetics/din4023/profile';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight';
import type { VorgabenData } from '../hooks/useImplenia';
import { wertGroesse } from '../utils/briefing';
import { findSoll } from '../utils/sensors';
import { formatNumber } from '../utils/format';
import { grad, VORGABE_HORIZONTAL, VORGABE_VERTIKAL } from '../utils/ausrichtung';
import {
  buildSchichten, collectVorgabeEntries, extractCoordinates, geplanteTiefe,
} from '../utils/vorgaben';
import type { CoordinateGroup } from '../utils/vorgaben';

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

/*
 * The full size of each of the two value rows. Not in `styles`, because
 * `wertGroesse` steps them down for a number too long for its cell — see
 * there for the measurement that makes that necessary.
 */
const HERO_REM = 5.5;
const WINKEL_REM = 5;

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

      {/* Right: the Soll values, three rows of two cells — see `Zelle` */}
      <div style={styles.werte}>
        <div style={{ ...styles.reihe, flex: 1.25 }}>
          <Hero label="Bohrlänge" wert={tiefe === null ? '–' : formatNumber(tiefe)} einheit="m" />
          <Hero label="Sollvolumen" wert={soll(vorgaben, 'Sollvolumen')} einheit="l" />
        </div>

        <div style={{ ...styles.reihe, flex: 1.25 }}>
          <Winkel label="Horizontalneigung" wert={findSoll(vorgaben, VORGABE_HORIZONTAL)} />
          <Winkel label="Vertikalneigung" wert={findSoll(vorgaben, VORGABE_VERTIKAL)} />
        </div>

        <div style={{ ...styles.reihe, flex: 1 }}>
          {koordinaten.length > 0 ? (
            koordinaten.map((k) => <Punkt key={k.label} punkt={k} />)
          ) : (
            <div style={styles.leer}>Der Schichtauftrag nennt keine Punkte.</div>
          )}
        </div>

        <button style={styles.weiter} onClick={weiter.aktion}>
          {weiter.label}
          <span style={styles.pfeil}>›</span>
        </button>
      </div>
    </div>
  );
}

/**
 * One planned value, under the name of the thing it plans.
 *
 * All six cells have the same shape — label above, value below, both centred —
 * because they are one grid read in one glance, not three sections: the labels
 * line up across a row and the eye drops straight to the numbers. The angles
 * used to carry theirs underneath, which put two of the four large numbers on
 * a different line from the other two.
 *
 * The label is the only thing saying what the number is, so it is
 * `--font-base` and never `--font-sm`, which this screen reserves for the
 * geology column's meta line.
 */
function Zelle({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={styles.zelle}>
      <div style={styles.zellenLabel}>{label}</div>
      {children}
    </div>
  );
}

function Hero({ label, wert, einheit }: { label: string; wert: string; einheit: string }) {
  return (
    <Zelle label={label}>
      <div style={styles.heroZeile}>
        <span style={{ ...styles.heroWert, fontSize: wertGroesse(wert, HERO_REM) }}>{wert}</span>
        <span style={styles.heroEinheit}>{einheit}</span>
      </div>
    </Zelle>
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
  const text = wert === null ? '–' : grad(wert);
  return (
    <Zelle label={label}>
      <span style={{ ...styles.winkelWert, fontSize: wertGroesse(text, WINKEL_REM) }}>
        {text}
      </span>
    </Zelle>
  );
}

/**
 * Where the hole starts and where it is meant to come out.
 *
 * The three axes are stacked rather than set on one line, which is what the
 * numbers are: an LV95 easting formats as `2.681.432,18`, so a triple runs
 * ~390px and two of them side by side do not fit the column — on the first
 * version the two points overlapped and the leading axis letter was cut off.
 * Stacked, they fit at any magnitude, and the X of one point sits on the X of
 * the other, which is the comparison worth making here.
 */
function Punkt({ punkt }: { punkt: CoordinateGroup }) {
  return (
    <Zelle label={punkt.label}>
      <div style={styles.koordinaten}>
        <span style={styles.achse}>X</span><span>{koordinate(punkt.x)}</span>
        <span style={styles.achse}>Y</span><span>{koordinate(punkt.y)}</span>
        <span style={styles.achse}>Z</span><span>{koordinate(punkt.z)}</span>
      </div>
    </Zelle>
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
   * 194px, of which the chart's depth gutter takes a fixed 48 and the hatched
   * column fills the remaining 146 — within a couple of pixels of the drilling
   * screen's 144.
   *
   * `breite` is passed for form's sake and decides nothing: the chart lays its
   * two parts out with flex, so the column takes whatever this width leaves.
   * It was 258 while the Soll values were set in cards at 3.5rem; at 5.5rem
   * they are what the screen is for, and the profile — which has no depth
   * indicator and no live value to carry here — gives up the 64px.
   */
  geoSpalte: {
    flexShrink: 0,
    width: 194,
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
  // The rows share what is left rather than stacking at their content height:
  // a column of values over 200px of empty screen reads as unfinished, and the
  // space is better spent on bigger numbers. `flex` is set per row at the call
  // site, so the two rows of large numbers take more of it than the points.
  reihe: {
    minHeight: 0,
    display: 'flex',
    gap: '0.75rem',
  },
  zelle: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.1rem',
  },
  zellenLabel: {
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
  winkelWert: {
    fontWeight: 800,
    lineHeight: 1.05,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--text-primary)',
  },
  koordinaten: {
    display: 'grid',
    gridTemplateColumns: 'auto auto',
    columnGap: '0.6rem',
    rowGap: '0.1rem',
    // Monospace and right-aligned so the digits line up between the two
    // points: the difference between them is the length and the inclination of
    // the hole, which is the one check worth making on this screen.
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-md)',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right',
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap',
  },
  achse: { color: 'var(--text-muted)', fontWeight: 400, textAlign: 'left' },
  leer: {
    flex: 1,
    alignSelf: 'center',
    textAlign: 'center',
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
  },
  /*
   * The forward step, deliberately the quieter of the two buttons at the foot
   * of this screen.
   *
   * **Not green**, although `Weiter zum Austausch` on the geology sign-off is:
   * that one only ever appears while a recording runs, so the bar beneath it
   * shows stop and pause. This is the pre-recording screen, so the bar beneath
   * *this* is showing „Aufzeichnung beginnen" in green — and green on this
   * kiosk means the recording lifecycle, nothing else. Two green buttons 12px
   * apart meaning „start recording" and „next screen" is the one way to get
   * that mapping wrong.
   *
   * **Not filled**, so the screen has exactly one solid button and it is the
   * one that starts recording. This button is a convenience and not a gate — a
   * worker can start the recording from here and the drilling screen takes
   * over under their finger — so it must not out-shout the action that matters.
   * Still high contrast and still a 64px full-width tap target: quieter than
   * the green one, not a fine control.
   *
   * Otherwise it is the forward-step button the rest of the app uses:
   * `--font-md`, 800, sentence case, `--tap-min`. The uppercase and the 72px
   * it used to carry matched nothing — not this family, not the recording
   * bar's own (52px, 1.1rem).
   */
  weiter: {
    flexShrink: 0,
    minHeight: 'var(--tap-min)',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    border: '2px solid var(--color-accent)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--color-accent)',
    fontFamily: 'inherit',
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    cursor: 'pointer',
  },
  pfeil: { fontSize: '1.6rem', fontWeight: 800, lineHeight: 1, opacity: 0.7 },
};
