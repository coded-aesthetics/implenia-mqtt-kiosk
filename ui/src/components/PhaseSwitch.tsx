import type { CSSProperties } from 'react';
import type { OperatingMode } from '../hooks/useWebSocket';
import { MODE_LABELS, isVerpressenMode } from '../utils/operating-mode';

/**
 * What the rig is doing — as one control rather than a badge and a switch in
 * different places.
 *
 * It used to be a read-only badge in the header while the control for it (`B`
 * and `V`) sat in the recording bar 600 px away, so the operator read the state
 * at the top of the screen and reached for it at the bottom. The active segment
 * *is* the badge now, keeping the colours it had.
 *
 * It is navigation and a recording setting at once: `App` picks `BohrenScreen`
 * or `VerpressenScreen` from this, and ingestion uses it to decide whether a
 * closed Klemmbacke means a pipe change (clip those readings out of the upload)
 * or a pipe string being held (keep them). The second reading is why it is
 * worded rather than lettered — `V` said nothing about which of three modes was
 * running, and nothing about what it does to the data.
 *
 * Reversible, so no tap-to-confirm: confirming a phase switch every time would
 * cost more than the occasional mis-tap, which is one tap to undo.
 */

interface Props {
  mode: OperatingMode;
  /** Omit for a read-only badge. */
  onChange?: (mode: OperatingMode) => void;
}

/** The mode the Verpressen segment switches *to*. The other two are not
 * reachable from here — see the note in RecordingBar's history. */
const VERPRESSEN_DEFAULT: OperatingMode = 'austausch';

export function PhaseSwitch({ mode, onChange }: Props) {
  const imVerpressen = isVerpressenMode(mode);

  // While drilling the segment offers the family name; once inside it, the
  // actual mode. `Verpressen` is the umbrella (see isVerpressenMode), so
  // leaving it on an `Einbauen` session would name the wrong thing.
  const verpressenLabel = imVerpressen ? MODE_LABELS[mode] : 'Verpressen';

  if (!onChange) {
    return (
      <span
        style={{
          ...styles.badge,
          backgroundColor: imVerpressen ? 'var(--color-phase-alt)' : 'var(--color-accent)',
        }}
      >
        {MODE_LABELS[mode]}
      </span>
    );
  }

  return (
    <div style={styles.group} role="group" aria-label="Phase">
      <button
        style={{
          ...styles.segment,
          ...styles.segmentLinks,
          ...(imVerpressen ? styles.inaktiv : styles.aktivBohren),
        }}
        onClick={() => { if (imVerpressen) onChange('bohren'); }}
        aria-pressed={!imVerpressen}
      >
        {MODE_LABELS.bohren}
      </button>
      <button
        style={{
          ...styles.segment,
          ...styles.segmentRechts,
          ...(imVerpressen ? styles.aktivVerpressen : styles.inaktiv),
        }}
        onClick={() => { if (!imVerpressen) onChange(VERPRESSEN_DEFAULT); }}
        aria-pressed={imVerpressen}
      >
        {verpressenLabel}
      </button>
    </div>
  );
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
    minHeight: 'var(--tap-min)',
    minWidth: 120,
    padding: '0 var(--space-md)',
    border: 'none',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  segmentLinks: { borderRight: '1px solid var(--border)' },
  segmentRechts: {},
  aktivBohren: { backgroundColor: 'var(--color-accent)', color: '#fff' },
  aktivVerpressen: { backgroundColor: 'var(--color-phase-alt)', color: '#fff' },
  inaktiv: { backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)' },
};
