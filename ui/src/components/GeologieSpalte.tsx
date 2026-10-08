import type { CSSProperties } from 'react';
import { findByNr, imageDataURI } from '@coded-aesthetics/din4023';
import { farbeVon, kurzLabel, nameVon } from '../utils/geologie';
import type { PickerArt } from '../hooks/useGeologieErfassung';

/**
 * The quick ground-type picker, in the space the profile column occupies.
 *
 * The operator is nearly always confirming a layer the Schichtauftrag already
 * predicted, so this offers the three to five soils that can plausibly occur in
 * *this* hole rather than the 58 DIN types — which would be 58 ways to mis-tap.
 * Anything unplanned is one more tap away behind "Andere".
 *
 * It takes the column rather than opening a screen. The depth hero directly
 * above keeps saying where the drill is, the gauges and the recording bar stay
 * put, and the whole interaction is over in a tap — so there is nothing the
 * chart was telling the operator that they lose for the second it is gone.
 * Ordered shallowest-first, which is the order the profile it replaced was
 * drawn in, and the ground the plan expects right here is marked — so the layer
 * most likely being confirmed, the next one down, sits right beside it.
 *
 * Tiles share the column height evenly with a 64px floor: an evenly divided
 * list is tappable where the real profile is not, because a thin planned layer
 * renders 32px tall and no gloved finger can hit it.
 */

interface Props {
  art: PickerArt;
  /** Ground types to offer, in column order. */
  nrs: readonly number[];
  /**
   * The ground the drill is in — what was last recorded, or the plan's answer
   * until something is. Highlighted and labelled "Aktuell".
   */
  aktiveNr?: number | null;
  /** The ground the Vorgabe plans at this depth. Labelled "Vorgabe". */
  vorgabeNr?: number | null;
  /** Offered when the Vorgabe names more soils than fit, and for rare ground. */
  onAndere?: () => void;
  onWaehlen: (nr: number, name: string) => void;
}

export function GeologieSpalte({ art, nrs, aktiveNr, vorgabeNr, onAndere, onWaehlen }: Props) {
  return (
    <div style={styles.spalte}>
      <div style={art === 'hindernis' ? styles.kopfHindernis : styles.kopf}>
        {art === 'hindernis' ? 'Hindernis' : 'Bodenart'}
      </div>

      {nrs.map((nr) => (
        <button
          key={nr}
          style={{
            ...styles.kachel,
            ...(nr === aktiveNr ? styles.kachelAktuell : {}),
          }}
          onClick={() => onWaehlen(nr, nameVon(nr))}
        >
          <Symbol nr={nr} />
          <span style={styles.text}>
            <span style={styles.kurz}>{kurzLabel(nr)}</span>
            <span style={styles.name}>{nameVon(nr)}</span>
            {/*
              Both markers, each said in a word, because the highlight alone
              cannot distinguish them — and when they sit on different tiles
              that difference is the whole point: the operator recorded ground
              the Schichtauftrag did not plan here.
              Stacked rather than joined on one line. "Aktuell · Vorgabe" is 17
              characters and the column is 170px wide, so it clipped to
              "Aktuell · Vorgal" — in the *ordinary* case, where the ground
              matches the plan. One word per line always fits, and the layout
              does not depend on how wide the column happens to be.
            */}
            {(nr === aktiveNr || nr === vorgabeNr) && (
              <span style={styles.marker}>
                {nr === aktiveNr && <span style={styles.markerAktiv}>Aktuell</span>}
                {nr === vorgabeNr && <span style={styles.markerVorgabe}>Vorgabe</span>}
              </span>
            )}
          </span>
        </button>
      ))}

      {nrs.length === 0 && (
        <div style={styles.leer}>
          Für dieses Element sind keine Bodenarten vorgegeben.
        </div>
      )}

      {onAndere && (
        <button style={styles.andere} onClick={onAndere}>Andere…</button>
      )}
    </div>
  );
}

/** The DIN hatch, so a tile matches what the profile draws in its place. */
function Symbol({ nr }: { nr: number }) {
  const entry = findByNr(nr);
  const img = entry ? imageDataURI(entry) : undefined;
  return (
    <span
      style={{
        ...styles.symbol,
        backgroundColor: farbeVon(nr),
        ...(img ? { backgroundImage: `url(${img})`, backgroundSize: 'cover' } : {}),
      }}
    />
  );
}

const styles: Record<string, CSSProperties> = {
  spalte: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    marginTop: '0.25rem',
    paddingBottom: '0.5rem',
    boxSizing: 'border-box',
  },
  kopf: {
    flexShrink: 0,
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--color-accent-strong)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    textAlign: 'center',
  },
  kopfHindernis: {
    flexShrink: 0,
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--color-warning-text)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    textAlign: 'center',
  },
  kachel: {
    // Even shares of the column, never below a glove-sized target.
    flex: 1,
    minHeight: 'var(--tap-min)',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    padding: '0 0.4rem',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    fontFamily: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    overflow: 'hidden',
  },
  /** The ground the drill is in. */
  kachelAktuell: {
    border: '2px solid var(--color-accent)',
    backgroundColor: 'var(--surface-3)',
  },
  marker: {
    display: 'flex',
    flexDirection: 'column',
    // The kiosk minimum (1rem). This is information the operator reads, not
    // decoration — it is what says whether they are on the plan or off it.
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    lineHeight: 1.15,
    whiteSpace: 'nowrap' as const,
  },
  markerAktiv: {
    color: 'var(--color-accent-strong)',
  },
  markerVorgabe: {
    color: 'var(--text-muted)',
  },

  symbol: {
    width: 30,
    height: 30,
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
  },
  text: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  kurz: {
    fontSize: 'var(--font-base)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.1,
  },
  /**
   * Two lines, then an ellipsis.
   *
   * It was `nowrap` with an ellipsis, which in a 170px column turns
   * `Verwitterungslehm, Hanglehm` into `Verwitterungsle…`; the sign-off
   * screen hosts this same column at 370px, where the whole name fits on one
   * line and there was no reason to cut it.
   *
   * But the tile cannot grow for its content — `flex: 1` with
   * `overflow: hidden` — so plain wrapping only moved the problem: at 170px
   * with five tiles sharing ~515px, a three-line name plus `kurz` and two
   * marker lines overflows ~81px and gets sliced through the middle of a
   * glyph, which is worse than an ellipsis because nothing says it was cut.
   * The clamp wraps where there is room and degrades to an ellipsis where
   * there is not.
   */
  name: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical' as CSSProperties['WebkitBoxOrient'],
    WebkitLineClamp: 2,
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    lineHeight: 1.15,
    overflow: 'hidden',
    overflowWrap: 'anywhere',
  },
  andere: {
    flexShrink: 0,
    minHeight: 'var(--tap-min)',
    border: '2px dashed var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  leer: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    textAlign: 'center',
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    lineHeight: 1.3,
  },
};
