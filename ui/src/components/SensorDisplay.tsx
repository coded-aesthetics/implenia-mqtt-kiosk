import { useEffect, useRef } from 'react';
import type { SensorReading } from '../hooks/useWebSocket';

interface Props {
  readings: Map<string, SensorReading>;
}

function formatTopic(topic: string): string {
  const parts = topic.split('/');
  return parts[parts.length - 1] || topic;
}

function isNoValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' || s === 'NaN' || s === '-Infinity' || s === 'Infinity';
  }
  if (typeof v === 'number') return !Number.isFinite(v);
  return false;
}

function parsePayload(payload: string): { value: string; unit: string } {
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed === 'object' && parsed !== null) {
      const hasValue = 'value' in parsed || 'v' in parsed;
      const raw = parsed.value ?? parsed.v;
      const unit = parsed.unit ?? parsed.u ?? '';
      if (!hasValue || isNoValue(raw)) return { value: '–', unit: String(unit) };
      return { value: String(raw), unit: String(unit) };
    }
    if (isNoValue(parsed)) return { value: '–', unit: '' };
    return { value: String(parsed), unit: '' };
  } catch {
    return { value: payload || '–', unit: '' };
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function SensorTile({ reading }: { reading: SensorReading }) {
  const tileRef = useRef<HTMLDivElement>(null);
  const prevTs = useRef(reading.receivedAt);

  useEffect(() => {
    if (reading.receivedAt !== prevTs.current) {
      prevTs.current = reading.receivedAt;
      const el = tileRef.current;
      if (el) {
        el.style.backgroundColor = '#2a2a4a';
        requestAnimationFrame(() => {
          el.style.transition = 'background-color 0.6s ease';
          el.style.backgroundColor = '#16213e';
        });
      }
    }
  }, [reading.receivedAt]);

  const { value, unit } = parsePayload(reading.payload);

  return (
    <div ref={tileRef} style={styles.tile}>
      <div style={styles.label}>{formatTopic(reading.topic)}</div>
      <div style={styles.value}>
        {value}
        {unit && <span style={styles.unit}>{unit}</span>}
      </div>
      <div style={styles.timestamp}>{formatTimestamp(reading.receivedAt)}</div>
    </div>
  );
}

export function SensorDisplay({ readings }: Props) {
  const entries = Array.from(readings.values());

  if (entries.length === 0) {
    return (
      <div style={styles.empty}>
        Warte auf Sensordaten...
      </div>
    );
  }

  return (
    <div style={styles.grid}>
      {entries.map((r) => (
        <SensorTile key={r.topic} reading={r} />
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '1rem',
  },
  tile: {
    backgroundColor: '#16213e',
    borderRadius: '12px',
    padding: '1.5rem',
    minHeight: '140px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    // Minimum 64x64 tap target (WCAG 2.5.5)
    minWidth: '64px',
    cursor: 'default',
    userSelect: 'none',
  },
  label: {
    fontSize: '0.9rem',
    color: '#8899aa',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '0.5rem',
  },
  value: {
    fontSize: '2.5rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1.2,
  },
  unit: {
    fontSize: '1.2rem',
    fontWeight: 400,
    color: '#8899aa',
    marginLeft: '0.3rem',
  },
  timestamp: {
    fontSize: '0.75rem',
    color: '#556677',
    marginTop: '0.5rem',
  },
  empty: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '50vh',
    fontSize: '1.2rem',
    color: '#556677',
  },
};
