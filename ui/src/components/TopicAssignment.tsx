import { useCallback, useEffect, useState } from 'react';

/**
 * Bind MQTT topics to sensors.
 *
 * The box's topic names are not known in advance and may not resemble the
 * sensor names at all, so this is built for the case where *nothing*
 * auto-matches: the manual path is the primary one and any automatic match is
 * shown as a starting point to confirm.
 *
 * Live values are the point. With opaque topic names the only way to tell
 * which is which is to watch the numbers move while the machine moves — the
 * same way the serial channel picker works.
 */

interface SensorRow {
  name: string;
  unit: string;
  priority: string;
  topic: string | null;
  boundBy: 'override' | 'shipped' | 'name' | 'none';
}

interface ObservedTopic {
  topic: string;
  lastPayload: string;
  lastSeen: number;
  count: number;
}

const BOUND_LABEL: Record<SensorRow['boundBy'], string> = {
  override: 'zugeordnet',
  shipped: 'voreingestellt',
  // Already works: the topic's name matches the sensor, nothing to do.
  name: 'passt automatisch',
  none: '',
};

function formatValue(raw: string): string {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return raw || '–';
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function TopicAssignment() {
  const [sensors, setSensors] = useState<SensorRow[]>([]);
  const [topics, setTopics] = useState<ObservedTopic[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pendingUnassign, setPendingUnassign] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSensors = useCallback(() => {
    fetch('/api/config/topic-overrides')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setSensors(d.sensors ?? []); })
      .catch(() => {});
  }, []);

  useEffect(() => { loadSensors(); }, [loadSensors]);

  // Poll observed topics so values move while the machine moves.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch('/api/config/mqtt/topics')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d) setTopics(d.topics ?? []); })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const boundTopics = new Map(
    sensors.filter((s) => s.topic).map((s) => [s.topic as string, s.name]),
  );

  async function assign(topic: string) {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/config/topic-overrides', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, sensorName: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Zuordnung fehlgeschlagen.');
        return;
      }
      setSelected(null);
      loadSensors();
    } catch {
      setError('Die Anwendung ist nicht erreichbar.');
    } finally {
      setBusy(false);
    }
  }

  async function unassign(topic: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/config/topic-overrides/${encodeURIComponent(topic)}`, { method: 'DELETE' });
      setPendingUnassign(null);
      loadSensors();
    } catch {
      setError('Die Anwendung ist nicht erreichbar.');
    } finally {
      setBusy(false);
    }
  }

  const unmatched = topics.filter((t) => !boundTopics.has(t.topic));
  const assignedCount = sensors.filter((s) => s.topic).length;

  return (
    <div style={styles.container} onClick={() => setPendingUnassign(null)}>
      <div style={styles.summary}>
        {assignedCount} von {sensors.length} Sensoren zugeordnet · {topics.length} Topics empfangen
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {selected ? (
        <div style={styles.instruction}>
          Topic für <strong>{selected}</strong> antippen.{' '}
          <button onClick={(e) => { e.stopPropagation(); setSelected(null); }} style={styles.linkButton}>
            Abbrechen
          </button>
        </div>
      ) : (
        <div style={styles.instruction}>
          Sensor antippen, dann das passende Topic. Am einfachsten während die
          Maschine läuft — dann sind die Werte an ihrer Bewegung zu erkennen.
        </div>
      )}

      <div style={styles.columns}>
        {/* Sensors the Verfahren expects */}
        <div style={styles.column}>
          <div style={styles.columnTitle}>Sensoren</div>
          {sensors.map((s) => {
            const live = s.topic ? topics.find((t) => t.topic === s.topic) : undefined;
            const isSelected = selected === s.name;
            return (
              <button
                key={s.name}
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingUnassign(null);
                  setSelected(isSelected ? null : s.name);
                }}
                style={isSelected ? styles.rowSelected : s.topic ? styles.rowBound : styles.row}
              >
                <span style={styles.rowName}>
                  {s.name}
                  {s.unit && <span style={styles.rowUnit}> [{s.unit}]</span>}
                </span>
                {s.topic ? (
                  <span style={styles.rowMeta}>
                    <span style={styles.rowValue}>
                      {live ? formatValue(live.lastPayload) : '–'}
                    </span>
                    <span style={styles.rowTopic}>{s.topic}</span>
                    <span style={styles.rowBadge}>{BOUND_LABEL[s.boundBy]}</span>
                  </span>
                ) : (
                  <span style={styles.rowUnassigned}>nicht zugeordnet</span>
                )}
              </button>
            );
          })}
        </div>

        {/* What the broker is actually sending */}
        <div style={styles.column}>
          <div style={styles.columnTitle}>Empfangene Topics</div>

          {topics.length === 0 && (
            <div style={styles.empty}>
              Noch keine Topics empfangen. Ist die MQTT-Box verbunden und die
              Maschine eingeschaltet?
            </div>
          )}

          {topics.map((t) => {
            const boundTo = boundTopics.get(t.topic);
            const isPending = pendingUnassign === t.topic;
            return (
              <button
                key={t.topic}
                onClick={(e) => {
                  e.stopPropagation();
                  if (selected) { assign(t.topic); return; }
                  if (!boundTo) return;
                  if (isPending) unassign(t.topic);
                  else setPendingUnassign(t.topic);
                }}
                style={
                  isPending ? styles.rowDangerConfirm
                  : selected ? styles.rowAssignable
                  : boundTo ? styles.rowBound
                  : styles.row
                }
              >
                <span style={styles.rowName}>{t.topic}</span>
                <span style={styles.rowMeta}>
                  <span style={styles.rowValue}>{formatValue(t.lastPayload)}</span>
                  {isPending ? (
                    <span style={styles.rowBadge}>Zuordnung wirklich aufheben?</span>
                  ) : boundTo ? (
                    <span style={styles.rowBadge}>→ {boundTo}</span>
                  ) : (
                    <span style={styles.rowUnassigned}>ohne Sensor</span>
                  )}
                </span>
              </button>
            );
          })}

          {unmatched.length > 0 && (
            <div style={styles.warning}>
              {unmatched.length} Topic(s) ohne Sensor. Diese Werte werden
              angezeigt, aber <strong>nicht hochgeladen</strong>.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const rowBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-md)',
  width: '100%',
  minHeight: 'var(--tap-min)',
  padding: '0 var(--space-md)',
  marginBottom: 'var(--space-sm)',
  fontFamily: 'inherit',
  fontSize: 'var(--font-base)',
  textAlign: 'left',
  color: 'var(--text-primary)',
  backgroundColor: 'var(--surface-2)',
  border: '2px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
};

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' },
  summary: { fontSize: 'var(--font-base)', fontWeight: 600, color: 'var(--text-primary)' },
  instruction: {
    fontSize: 'var(--font-sm)', lineHeight: 1.4, color: 'var(--text-muted)',
    padding: 'var(--space-sm) var(--space-md)',
    backgroundColor: 'var(--surface-0)', borderRadius: 'var(--radius-md)',
    borderLeft: '3px solid var(--color-accent)',
  },
  columns: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)' },
  column: { minWidth: 0 },
  columnTitle: {
    fontSize: 'var(--font-base)', fontWeight: 700, color: 'var(--text-primary)',
    marginBottom: 'var(--space-sm)',
  },
  row: rowBase,
  rowBound: { ...rowBase, borderColor: 'var(--color-success)' },
  rowSelected: { ...rowBase, backgroundColor: 'var(--surface-4)', borderColor: 'var(--color-accent)' },
  rowAssignable: { ...rowBase, borderColor: 'var(--color-accent)', borderStyle: 'dashed' },
  rowDangerConfirm: { ...rowBase, backgroundColor: 'var(--color-danger)', borderColor: 'var(--color-danger)', color: '#fff' },
  rowName: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowUnit: { fontWeight: 400, color: 'var(--text-muted)' },
  rowMeta: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexShrink: 0 },
  rowValue: { fontFamily: 'var(--font-mono)', fontSize: 'var(--font-base)', color: 'var(--text-primary)' },
  rowTopic: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)', maxWidth: '10rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowBadge: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)' },
  rowUnassigned: { fontSize: 'var(--font-sm)', color: 'var(--color-warning)' },
  rowValueDim: { fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' },
  empty: { fontSize: 'var(--font-base)', lineHeight: 1.4, color: 'var(--text-muted)', padding: 'var(--space-md)' },
  warning: {
    fontSize: 'var(--font-sm)', lineHeight: 1.4, color: 'var(--text-primary)',
    padding: 'var(--space-md)', marginTop: 'var(--space-sm)',
    backgroundColor: 'var(--surface-0)', borderRadius: 'var(--radius-md)',
    borderLeft: '3px solid var(--color-warning)',
  },
  error: {
    fontSize: 'var(--font-base)', lineHeight: 1.4, color: 'var(--text-primary)',
    padding: 'var(--space-md)', backgroundColor: 'var(--color-danger-muted)',
    borderRadius: 'var(--radius-sm)',
  },
  linkButton: {
    fontFamily: 'inherit', fontSize: 'var(--font-sm)', color: 'var(--color-accent)',
    background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline',
  },
};
