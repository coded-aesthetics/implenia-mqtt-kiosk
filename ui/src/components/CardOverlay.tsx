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
  type: 'success' | 'error';
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

  return (
    <div
      style={{
        ...overlayStyles.backdrop,
        backgroundColor: isError ? 'rgba(183, 28, 28, 0.95)' : 'rgba(27, 94, 32, 0.95)',
      }}
      onClick={(e) => { e.stopPropagation(); onDismiss(); }}
    >
      <div style={overlayStyles.icon}>{isError ? '✕' : '✓'}</div>
      <div style={overlayStyles.title}>{overlay.title}</div>
      {overlay.detail && <div style={overlayStyles.detail}>{overlay.detail}</div>}
      {isError && <div style={overlayStyles.dismissHint}>Antippen zum Schließen</div>}
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
