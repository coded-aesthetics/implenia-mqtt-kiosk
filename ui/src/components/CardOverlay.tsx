import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

/**
 * The full-card result banner the config screen uses instead of a dialog.
 *
 * CLAUDE.md rules out modals: a worker must never be stuck behind one. So a
 * save result covers its own card, says what happened, and clears on a tap
 * anywhere on it.
 */

export interface OverlayState {
  /**
   * `warning` is a save that worked and still needs reading — it carries no ✕,
   * because nothing failed, and unlike `success` it does not clear itself.
   * A consequence the operator has to decide about cannot be on a 2.5 second
   * timer.
   */
  type: 'success' | 'error' | 'warning';
  title: string;
  detail?: string;
}

export function CardOverlay({ overlay, onDismiss }: { overlay: OverlayState; onDismiss: () => void }) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (overlay.type === 'success') {
      const id = setTimeout(() => dismissRef.current(), 2500);
      return () => clearTimeout(id);
    }
  }, [overlay.type]);

  const isError = overlay.type === 'error';
  const isWarning = overlay.type === 'warning';

  const background = isError ? 'var(--color-danger-overlay)'
    : isWarning ? 'var(--color-warning-overlay)'
    : 'var(--color-success-overlay)';

  return (
    <div
      style={{ ...overlayStyles.backdrop, backgroundColor: background }}
      onClick={(e) => { e.stopPropagation(); onDismiss(); }}
    >
      <div style={isWarning ? { ...overlayStyles.icon, ...overlayStyles.iconSmall } : overlayStyles.icon}>
        {isError ? '✕' : isWarning ? '⚠' : '✓'}
      </div>
      <div style={overlayStyles.title}>{overlay.title}</div>
      {overlay.detail && <div style={overlayStyles.detail}>{overlay.detail}</div>}
      {(isError || isWarning) && (
        <div style={overlayStyles.dismissHint}>Antippen zum Schließen</div>
      )}
    </div>
  );
}

const overlayStyles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'absolute',
    inset: 0,
    borderRadius: 'var(--radius-lg)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-sm)',
    padding: 'var(--space-lg)',
    zIndex: 1,
  },
  icon: {
    fontSize: '4rem',
    fontWeight: 700,
    color: '#fff',
    lineHeight: 1,
  },
  /**
   * The warning glyph is title-sized, not 4rem, and that is a measurement
   * rather than a taste.
   *
   * These overlays cover their own card, so the card's content height is the
   * whole budget — 227px on the API-key card at 1024x768. A `success` or
   * `error` is a few words and can spend 64px of that on a glyph; a `warning`
   * is a consequence the operator has to act on, and at 4rem the first version
   * of this clipped 44px off the bottom of a 241-character message that the
   * arithmetic said fit. Title-sized, the detail budget is **160 characters**
   * with a 58-character title (measured on the rendered page: it still fits at
   * 160, overflows at 165). Keep new messages under 150 — German compounds wrap
   * worse than their character count suggests, which is why this is measured
   * and not counted.
   */
  iconSmall: {
    fontSize: 'var(--font-md)',
  },
  title: {
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    color: '#fff',
    textAlign: 'center',
  },
  detail: {
    fontSize: 'var(--font-base)',
    color: 'rgba(255, 255, 255, 0.9)',
    textAlign: 'center',
    lineHeight: 1.4,
    maxWidth: '90%',
  },
  dismissHint: {
    fontSize: 'var(--font-sm)',
    color: 'rgba(255, 255, 255, 0.6)',
    marginTop: 'var(--space-sm)',
  },
};
