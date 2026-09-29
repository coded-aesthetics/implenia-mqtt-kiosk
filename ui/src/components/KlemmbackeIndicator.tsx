import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { formatNumber } from '../utils/format';
import { clampFrac } from '../utils/sensor-viz';

interface Props {
  value: number;
  unit: string;
  openThreshold: number;
  closeThreshold: number;
  isOpen: boolean;
}

export function KlemmbackeIndicator({ value, unit, openThreshold, closeThreshold, isOpen }: Props) {
  const gaugeMax = useMemo(
    () => Math.ceil(closeThreshold * 1.5 / 100) * 100 || 100,
    [closeThreshold],
  );

  const stateLabel = isOpen ? 'Offen' : 'Zu';
  const color = isOpen
    ? 'var(--color-success)'
    : value >= closeThreshold * 1.5
      ? 'var(--color-danger)'
      : 'var(--color-warning)';

  const fillPct = clampFrac(value, 0, gaugeMax) * 100;
  const openPct = clampFrac(openThreshold, 0, gaugeMax) * 100;
  const closePct = clampFrac(closeThreshold, 0, gaugeMax) * 100;

  return (
    <div style={styles.container}>
      <div style={styles.top}>
        <span style={{ ...styles.stateText, color }}>Klemmbacke</span>
        <span style={{ ...styles.stateText, ...styles.stateLabel, color }}>{stateLabel}</span>
        <span style={styles.spacer} />
        <span style={styles.valueGroup}>
          <span style={{ ...styles.value, color }}>{formatNumber(value, 0)}</span>
          <span style={styles.unit}>{unit}</span>
        </span>
      </div>
      <div style={styles.gaugeWrap}>
        <div style={styles.track}>
          <div style={{ ...styles.fill, width: `${Math.max(0.5, fillPct)}%`, background: color }} />
          <div style={{ ...styles.threshold, ...styles.openThreshold, left: `${openPct}%` }} />
          <div style={{ ...styles.threshold, ...styles.closeThreshold, left: `${closePct}%` }} />
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {},
  top: {
    display: 'flex',
    alignItems: 'center',
    padding: '0.5rem 0',
    gap: '0.5rem',
  },
  stateText: {
    fontSize: '1.6rem',
    fontWeight: 900,
    lineHeight: 1,
  },
  stateLabel: {
    display: 'inline-block',
    minWidth: '5.5rem',
  },
  spacer: {
    flex: 1,
  },
  valueGroup: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.2rem',
    flexShrink: 0,
  },
  value: {
    fontSize: '1.3rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1,
  },
  unit: {
    fontSize: '0.75rem',
    color: 'var(--text-dim)',
    fontWeight: 500,
  },
  gaugeWrap: {
    paddingBottom: '0.25rem',
  },
  track: {
    position: 'relative',
    height: 8,
    background: 'var(--surface-3)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    overflow: 'visible',
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '100%',
    borderRadius: '4px 0 0 4px',
    opacity: 0.65,
    minWidth: 3,
  },
  threshold: {
    position: 'absolute',
    top: -3,
    width: 2,
    height: 14,
    borderRadius: 1,
    transform: 'translateX(-1px)',
    zIndex: 2,
  },
  openThreshold: {
    background: 'var(--color-success)',
  },
  closeThreshold: {
    background: 'var(--color-warning)',
  },
};
