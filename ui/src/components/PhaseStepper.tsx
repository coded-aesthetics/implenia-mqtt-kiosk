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
 *
 * ── Ausrichten ────────────────────────────────────────────────────────────
 *
 * The alignment screen takes the slot *before* Bohren, for an element whose
 * Vertikalneigung is not 0. It is **not a phase**: `operating_mode` stays
 * whatever it was, nothing is recorded differently, and both its slots only
 * navigate. Making it a mode would have put a screen into the column that
 * decides Klemmbacke clipping and phase-segmented KPIs, for a step that
 * happens before there is anything to record.
 *
 * It is also the only slot that works **without a recording**: aligning
 * happens before the session starts, so `mode` is null and the stepper is then
 * just the one way in — [ ‹ Ausrichten ]. Which keeps the way back to it in
 * the same place at every point in the element's life, which is the whole
 * reason it lives here rather than in a button on one screen.
 */

export interface AusrichtenSlot {
  /** True while the alignment screen is the one on screen. */
  aktiv: boolean;
  oeffnen: () => void;
  /** Leave it again — back to the element's own screen. */
  schliessen: () => void;
}

interface Props {
  /** Null when nothing is being recorded: there is no phase then. */
  mode: OperatingMode | null;
  /** Omit for a read-only badge. */
  onChange?: (mode: OperatingMode) => void;
  /** The alignment screen as the step before Bohren. Omit where it does not apply. */
  ausrichten?: AusrichtenSlot;
}

/**
 * Fixed width, whatever the slot count.
 *
 * Without it the control grows from two slots to three and back as phases
 * advance, shifting the element name sideways each time. Wide enough for three
 * worded segments; measured against a 624px header centre.
 */
const BREITE = 420;

const AUSRICHTEN_LABEL = 'Ausrichten';

interface Segment {
  label: string;
  art: 'vergangen' | 'aktuell' | 'kommend';
  onClick?: () => void;
  /** Background of the current segment. */
  farbe?: string;
  ariaLabel?: string;
  /**
   * Which way the arrow points, where it is not the one the style implies.
   *
   * Only the standalone Ausrichten slot needs it: it is a step *back* from the
   * drilling screen, so its arrow points left — but it is the one way into the
   * screen and reads as subdued to the point of looking disabled in the
   * `vergangen` style.
   */
  pfeil?: 'links' | 'rechts';
}

export function PhaseStepper({ mode, onChange, ausrichten }: Props) {
  if (!onChange) {
    if (!mode) return null;
    return <span style={{ ...styles.badge, backgroundColor: farbe(mode) }}>{MODE_LABELS[mode]}</span>;
  }

  const segmente = baueSegmente(mode, onChange, ausrichten);
  if (segmente.length === 0) return null;

  return (
    <div
      style={{ ...styles.group, ...(segmente.length > 1 ? { width: BREITE } : {}) }}
      role="group"
      aria-label="Phase"
    >
      {segmente.map((s, i) => (
        <button
          key={s.label}
          style={{
            ...styles.segment,
            ...styles[s.art],
            ...(s.farbe ? { backgroundColor: s.farbe } : {}),
            ...(i > 0 ? styles.trenner : {}),
          }}
          // The current phase is already current; tapping it is a no-op rather
          // than a disabled control, so a mis-tap does nothing instead of
          // looking broken.
          onClick={s.onClick ?? (() => {})}
          aria-current={s.art === 'aktuell' ? 'step' : undefined}
          aria-label={s.ariaLabel}
        >
          {(s.pfeil ?? (s.art === 'vergangen' ? 'links' : undefined)) === 'links'
            && <span style={styles.pfeil}>‹</span>}
          {s.label}
          {(s.pfeil ?? (s.art === 'kommend' ? 'rechts' : undefined)) === 'rechts'
            && <span style={styles.pfeil}>›</span>}
        </button>
      ))}
    </div>
  );
}

function baueSegmente(
  mode: OperatingMode | null,
  onChange: (mode: OperatingMode) => void,
  ausrichten?: AusrichtenSlot,
): Segment[] {
  // On the alignment screen itself: where you are, and the one way on. No
  // Austausch slot — you cannot step past drilling from here, and offering it
  // would mean stepping a phase from a screen that has not drilled anything.
  if (ausrichten?.aktiv) {
    return [
      { label: AUSRICHTEN_LABEL, art: 'aktuell', farbe: 'var(--color-accent)' },
      {
        label: mode ? MODE_LABELS[mode] : MODE_LABELS.bohren,
        art: 'kommend',
        onClick: ausrichten.schliessen,
        ariaLabel: `Zurück zu ${mode ? MODE_LABELS[mode] : MODE_LABELS.bohren}`,
      },
    ];
  }

  // No recording: the phases do not exist yet, so the only thing to show is
  // the way into the alignment screen — and nothing at all without it.
  if (!mode) {
    if (!ausrichten) return [];
    return [{
      label: AUSRICHTEN_LABEL,
      art: 'kommend',
      pfeil: 'links',
      onClick: ausrichten.oeffnen,
      ariaLabel: 'Maschine ausrichten',
    }];
  }

  const segmente: Segment[] = [];
  const vorher = previousPhase(mode);

  if (ausrichten && mode === 'bohren') {
    segmente.push({
      label: AUSRICHTEN_LABEL,
      art: 'vergangen',
      onClick: ausrichten.oeffnen,
      ariaLabel: 'Zurück zum Ausrichten',
    });
  } else if (vorher) {
    segmente.push({
      label: MODE_LABELS[vorher],
      art: 'vergangen',
      onClick: () => onChange(vorher),
      ariaLabel: `Zurück zu ${MODE_LABELS[vorher]}`,
    });
  }

  segmente.push({ label: MODE_LABELS[mode], art: 'aktuell', farbe: farbe(mode) });

  const nachher = nextPhase(mode);
  if (nachher) {
    segmente.push({
      label: MODE_LABELS[nachher],
      art: 'kommend',
      onClick: () => onChange(nachher),
      ariaLabel: `Weiter zu ${MODE_LABELS[nachher]}`,
    });
  }

  return segmente;
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
    fontWeight: 600,
  },
  aktuell: {
    color: '#fff',
    cursor: 'default',
  },
  kommend: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
  },
  trenner: {
    borderLeft: '1px solid var(--border)',
  },
  pfeil: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    lineHeight: 1,
    opacity: 0.7,
  },
};
