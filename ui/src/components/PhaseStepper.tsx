import type { CSSProperties } from 'react';
import type { OperatingMode } from '../hooks/useWebSocket';
import { MODE_LABELS, nextPhase, previousPhase } from '../utils/operating-mode';

/**
 * Where the pillar is in its sequence of phases, and the one step forward.
 *
 * The phases always happen in the same order — Bohren, Austausch, Einbauen,
 * Auffüllen — with Austausch and Einbauen occasionally omitted. Nothing ever
 * runs out of order. A set of equal buttons said none of that; this shows the
 * position in the sequence and makes advancing one tap.
 *
 * Three slots at most:
 *
 *   Bohren      [ Bohren ][ Austausch › ]
 *   Austausch   [ ‹ Bohren ][ Austausch ][ Einbauen › ]
 *   Auffüllen   [ ‹ Einbauen ][ Auffüllen ]
 *
 * The past phase stays **tappable**, subdued rather than removed: an operator
 * who stepped forward too early needs a way back, and a phase's name says where
 * that goes in a way a `‹` on its own does not. Four slots would have shown the
 * whole sequence at once, but the header centre is 624px and four worded
 * segments plus the element name come to ~617 of it — fine for `P-01`, broken
 * for a longer name.
 *
 * **Skipping a phase is stepping through it**, and that is deliberate: all
 * three post-drilling phases are indistinguishable to Rohrverlängerung
 * clipping, and `operating_mode` is a single overwritten column rather than a
 * time series, so a moment spent in Austausch on the way to Einbauen leaves no
 * trace. `operating-mode.test.ts` on both sides pins that. If one of those
 * phases ever needs different clipping, this needs a way to skip without
 * entering.
 *
 * It is navigation and a recording setting at once: `App` picks the drilling or
 * the post-drilling screen from this, and ingestion uses it to decide whether a
 * closed Klemmbacke means a pipe change (clip those readings out of the upload)
 * or a pipe string being held. Reversible, so no tap-to-confirm — confirming
 * every phase change would cost more than the occasional mis-tap, which is one
 * tap to undo.
 */

interface Props {
  mode: OperatingMode;
  /** Omit for a read-only badge. */
  onChange?: (mode: OperatingMode) => void;
}

/**
 * Fixed width, whatever the slot count.
 *
 * Without it the control grows from two slots to three and back as phases
 * advance, shifting the element name sideways each time. Wide enough for three
 * worded segments; measured against a 624px header centre.
 */
const BREITE = 420;

export function PhaseStepper({ mode, onChange }: Props) {
  const vorher = previousPhase(mode);
  const nachher = nextPhase(mode);

  if (!onChange) {
    return <span style={{ ...styles.badge, backgroundColor: farbe(mode) }}>{MODE_LABELS[mode]}</span>;
  }

  return (
    <div style={{ ...styles.group, width: BREITE }} role="group" aria-label="Phase">
      {vorher && (
        <button
          style={{ ...styles.segment, ...styles.vergangen }}
          onClick={() => onChange(vorher)}
          aria-label={`Zurück zu ${MODE_LABELS[vorher]}`}
        >
          <span style={styles.pfeil}>‹</span>
          {MODE_LABELS[vorher]}
        </button>
      )}

      <button
        style={{ ...styles.segment, ...styles.aktuell, backgroundColor: farbe(mode) }}
        // The current phase is already current; tapping it is a no-op rather
        // than a disabled control, so a mis-tap does nothing instead of
        // looking broken.
        onClick={() => {}}
        aria-current="step"
      >
        {MODE_LABELS[mode]}
      </button>

      {nachher && (
        <button
          style={{ ...styles.segment, ...styles.kommend }}
          onClick={() => onChange(nachher)}
          aria-label={`Weiter zu ${MODE_LABELS[nachher]}`}
        >
          {MODE_LABELS[nachher]}
          <span style={styles.pfeil}>›</span>
        </button>
      )}
    </div>
  );
}

/** Drilling reads as the primary phase; everything after it shares one colour. */
function farbe(mode: OperatingMode): string {
  return mode === 'bohren' ? 'var(--color-accent)' : 'var(--color-phase-alt)';
}

const styles: Record<string, CSSProperties> = {
  badge: {
    display: 'inline-block',
    borderRadius: 'var(--radius-sm)',
    padding: '0.15rem 0.75rem',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: '#fff',
    lineHeight: 1.4,
  },
  group: {
    display: 'flex',
    flexShrink: 0,
    borderRadius: 'var(--radius-md)',
    border: '2px solid var(--border)',
    overflow: 'hidden',
    backgroundColor: 'var(--surface-2)',
  },
  segment: {
    // flex: 1 so the slots share the fixed width rather than the control
    // resizing — see BREITE.
    flex: 1,
    minWidth: 0,
    minHeight: 'var(--tap-min)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.25rem',
    padding: '0 var(--space-sm)',
    border: 'none',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    textTransform: 'uppercase',
    letterSpacing: '0.02em',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  /** Done. Subdued, but still a way back. */
  vergangen: {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-muted)',
    borderRight: '1px solid var(--border)',
    fontWeight: 600,
  },
  aktuell: {
    color: '#fff',
    cursor: 'default',
  },
  kommend: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
    borderLeft: '1px solid var(--border)',
  },
  pfeil: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    lineHeight: 1,
    opacity: 0.7,
  },
};
