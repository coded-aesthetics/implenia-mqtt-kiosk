import type { CSSProperties } from 'react';
import { formatNumber } from '../utils/format';

interface Props {
  value: number;
  unit: string;
  label: string;
  accentColor?: string;
  decimals?: number;
}

export function ValueHero({ value, unit, label, accentColor, decimals = 2 }: Props) {
  return (
    <div style={styles.container}>
      <div style={styles.label}>{label}</div>
      <div style={styles.row}>
        <span style={{ ...styles.value, ...(accentColor ? { color: accentColor } : {}) }}>
          {formatNumber(value, decimals)}
        </span>
        <span style={styles.unit}>{unit}</span>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
  },
  label: {
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: '0.2rem',
  },
  value: {
    fontSize: 'var(--font-hero)',
    fontWeight: 800,
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--text-primary)',
  },
  unit: {
    fontSize: 'var(--font-md)',
    color: 'var(--text-muted)',
    fontWeight: 600,
  },
};
