import type { CSSProperties } from 'react';
import type { OperatingMode } from '../hooks/useWebSocket';

interface Props {
  mode: OperatingMode;
}

const COLORS: Record<OperatingMode, string> = {
  bohren: 'var(--color-accent)',
  verpressen: '#6a1b9a',
};

const LABELS: Record<OperatingMode, string> = {
  bohren: 'Bohren',
  verpressen: 'Verpressen',
};

export function PhaseBadge({ mode }: Props) {
  return (
    <span style={{ ...styles.badge, backgroundColor: COLORS[mode] }}>
      {LABELS[mode]}
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
    color: '#ffffff',
    lineHeight: 1.4,
  },
};
