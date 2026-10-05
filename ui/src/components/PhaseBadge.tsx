import type { CSSProperties } from 'react';
import type { OperatingMode } from '../hooks/useWebSocket';
import { MODE_LABELS } from '../utils/operating-mode';

interface Props {
  mode: OperatingMode;
}

const COLORS: Record<OperatingMode, string> = {
  bohren: 'var(--color-accent)',
  austausch: 'var(--color-phase-alt)',
  einbauen: 'var(--color-phase-alt)',
  auffuellen: 'var(--color-phase-alt)',
};

export function PhaseBadge({ mode }: Props) {
  return (
    <span style={{ ...styles.badge, backgroundColor: COLORS[mode] }}>
      {MODE_LABELS[mode]}
    </span>
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
};
