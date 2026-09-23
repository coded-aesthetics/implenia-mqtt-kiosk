import { useCallback, useEffect, useState } from 'react';
import { navigate } from '../hooks/useHashRouter';
import { formatNumber } from '../utils/format';

/**
 * Bind MQTT topics to sensors — the MQTT counterpart to ChannelPicker, and
 * deliberately the same two-step shape: pick a sensor, then pick its source.
 *
 * Built for the case where nothing auto-matches. The box's topic names are not
 * known in advance and may be opaque (`plc/ch07`), so the live value is the
 * primary way to identify a source: you watch which number moves when the
 * machine moves, exactly as with serial channels.
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
  name: 'passt automatisch',
  none: '',
};

/** A payload that is not a number is shown as-is — that text is often the
 *  only thing identifying an opaque topic. */
function formatValue(raw: string): string {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return raw || '–';
  return formatNumber(n);
}

function secondsAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 2) return 'gerade eben';
  if (s < 60) return `vor ${s} s`;
  return `vor ${Math.floor(s / 60)} Min.`;
}

export function TopicAssignment() {
  const [sensors, setSensors] = useState<SensorRow[]>([]);
  const [topics, setTopics] = useState<ObservedTopic[]>([]);
  const [selected, setSelected] = useState<SensorRow | null>(null);
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

  // Values must move while the machine moves — that is what makes an opaque
  // topic identifiable at all.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch('/api/config/mqtt/topics')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d) setTopics(d.topics ?? []); })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const boundTopics = new Map(
    sensors.filter((s) => s.topic).map((s) => [s.topic as string, s]),
  );

  async function assign(topic: string) {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/config/topic-overrides', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, sensorName: selected.name }),
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
      const res = await fetch(
        `/api/config/topic-overrides/${encodeURIComponent(topic)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        // Without this check a failed delete looked exactly like a successful
        // one: the row simply reappeared, and the only thing left to do was
        // tap it again.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          body.error ??
            'Die Zuordnung konnte nicht aufgehoben werden. Bitte erneut versuchen.',
        );
        setPendingUnassign(null);
        return;
      }
      setPendingUnassign(null);
      loadSensors();
    } catch {
      setError('Die Anwendung ist nicht erreichbar.');
    } finally {
      setBusy(false);
    }
  }

  const assignedCount = sensors.filter((s) => s.topic).length;

  // ── Step 2: pick the topic that feeds the chosen sensor ──
  if (selected) {
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <button onClick={() => setSelected(null)} style={styles.backButton}>← Zurück</button>
          <h2 style={styles.title}>
            Quelle für <span style={styles.highlight}>{selected.name}</span> wählen
            {selected.unit && <span style={styles.titleUnit}> ({selected.unit})</span>}
          </h2>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.help}>
          Das Topic antippen, dessen Wert sich passend zum Sensor verhält. Am
          einfachsten, während die Maschine läuft.
        </div>

        <div style={styles.list}>
          {topics.length === 0 && (
            <div style={styles.empty}>
              Noch keine Topics empfangen. Ist die MQTT-Box verbunden und die
              Maschine eingeschaltet?
            </div>
          )}
          {topics.map((t) => {
            const takenBy = boundTopics.get(t.topic);
            const takenByOther = takenBy && takenBy.name !== selected.name;
            return (
              <button
                key={t.topic}
                onClick={() => assign(t.topic)}
                disabled={busy}
                style={styles.rowButton}
              >
                <span style={styles.rowName}>{t.topic}</span>
                <span style={styles.rowRight}>
                  <span style={styles.rowValue}>{formatValue(t.lastPayload)}</span>
                  <span style={styles.rowAge}>{secondsAgo(t.lastSeen)}</span>
                  {takenByOther && (
                    <span style={styles.rowTaken}>belegt: {takenBy!.name}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Step 1: the sensors this Verfahren expects ──
  return (
    <div style={styles.page} onClick={() => setPendingUnassign(null)}>
      <div style={styles.header}>
        <h2 style={styles.title}>Sensorzuordnung</h2>
        <div style={styles.headerRight}>
          <span style={styles.counter}>{assignedCount} / {sensors.length}</span>
          <button
            onClick={(e) => { e.stopPropagation(); navigate('config'); }}
            style={styles.backButton}
          >
            Schließen
          </button>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.help}>
        Sensor antippen, um eine Quelle zuzuordnen. Zugeordneten Sensor antippen,
        um die Zuordnung aufzuheben. Nicht zugeordnete Sensoren werden{' '}
        <strong>nicht hochgeladen</strong>.
      </div>

      <div style={styles.list}>
        {sensors.map((s) => {
          const live = s.topic ? topics.find((t) => t.topic === s.topic) : undefined;
          // Only an explicit override can be undone here; a name match has
          // nothing stored to remove.
          const removable = s.boundBy === 'override';
          const isPending = pendingUnassign === s.name;
          return (
            <button
              key={s.name}
              onClick={(e) => {
                e.stopPropagation();
                if (isPending && s.topic) { unassign(s.topic); return; }
                if (removable) { setPendingUnassign(s.name); return; }
                setPendingUnassign(null);
                setSelected(s);
              }}
              disabled={busy}
              style={isPending ? styles.rowDanger : styles.rowButton}
            >
              <span style={styles.rowName}>
                {s.name}
                {s.unit && <span style={styles.rowUnit}> {s.unit}</span>}
              </span>
              {isPending ? (
                <span style={styles.rowPending}>Wirklich aufheben?</span>
              ) : (
                <span style={styles.rowRight}>
                  {s.topic ? (
                    <>
                      <span style={styles.rowValue}>
                        {live ? formatValue(live.lastPayload) : '–'}
                      </span>
                      <span style={styles.rowTopic}>{s.topic}</span>
                      <span style={styles.rowBadge}>{BOUND_LABEL[s.boundBy]}</span>
                    </>
                  ) : (
                    <span style={styles.rowUnassigned}>Nicht zugeordnet</span>
                  )}
                </span>
              )}
            </button>
          );
        })}
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
  padding: '0 var(--space-lg)',
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
  page: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-md)',
    padding: 'var(--space-lg)',
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-md)',
  },
  headerRight: { display: 'flex', alignItems: 'center', gap: 'var(--space-md)' },
  title: { margin: 0, fontSize: 'var(--font-lg)', fontWeight: 700, color: 'var(--text-primary)' },
  titleUnit: { fontSize: 'var(--font-md)', fontWeight: 400, color: 'var(--text-muted)' },
  highlight: { color: 'var(--color-accent)' },
  counter: { fontSize: 'var(--font-md)', fontWeight: 700, color: 'var(--text-primary)' },
  backButton: {
    minHeight: 'var(--tap-sm)',
    padding: '0 var(--space-lg)',
    fontFamily: 'inherit',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-3)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
  },
  help: {
    fontSize: 'var(--font-sm)',
    lineHeight: 1.4,
    color: 'var(--text-muted)',
    padding: 'var(--space-sm) var(--space-md)',
    backgroundColor: 'var(--surface-0)',
    borderRadius: 'var(--radius-md)',
    borderLeft: '3px solid var(--color-accent)',
  },
  // The list scrolls, not the page: the header and help text stay put.
  list: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
  },
  rowButton: rowBase,
  rowDanger: { ...rowBase, backgroundColor: 'var(--color-danger)', borderColor: 'var(--color-danger)', color: '#fff' },
  rowName: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowUnit: { fontWeight: 400, color: 'var(--text-muted)' },
  rowRight: { display: 'flex', alignItems: 'center', gap: 'var(--space-lg)', flexShrink: 0 },
  rowValue: { fontFamily: 'var(--font-mono)', fontSize: 'var(--font-md)', color: 'var(--text-primary)' },
  rowAge: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)' },
  rowTopic: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)', maxWidth: '14rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowBadge: { fontSize: 'var(--font-sm)', color: 'var(--color-success)' },
  rowTaken: { fontSize: 'var(--font-sm)', color: 'var(--color-warning)' },
  rowUnassigned: { fontSize: 'var(--font-base)', color: 'var(--color-warning)' },
  rowPending: { fontSize: 'var(--font-base)', fontWeight: 700, color: '#fff' },
  empty: { fontSize: 'var(--font-base)', lineHeight: 1.4, color: 'var(--text-muted)', padding: 'var(--space-md)' },
  error: {
    fontSize: 'var(--font-base)', lineHeight: 1.4, color: 'var(--text-primary)',
    padding: 'var(--space-md)', backgroundColor: 'var(--color-danger-muted)',
    borderRadius: 'var(--radius-sm)',
  },
};
