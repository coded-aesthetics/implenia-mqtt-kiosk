import { useEffect, useState } from 'react';
import { usePolledJson } from '../hooks/usePolledJson';

/**
 * Broker address and subscription filter. Used by the setup wizard and by the
 * config page, so the two can never drift apart.
 *
 * Saving reconnects the data source in place — no restart — and the observed
 * topic count is polled afterwards, because a successful connection with zero
 * topics is its own kind of problem and worth showing.
 */

interface Props {
  /** Called after a successful save, with the normalized broker URL. */
  onSaved?: (brokerUrl: string) => void;
}

export function MqttSettings({ onSaved }: Props) {
  const [brokerUrl, setBrokerUrl] = useState('');
  const [topics, setTopics] = useState('');
  const [source, setSource] = useState<'runtime' | 'env' | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [topicCount, setTopicCount] = useState<number | null>(null);

  // Prefill from what is configured, falling back to the Implenia MQTT box's
  // default address so the common case is confirm-and-continue.
  useEffect(() => {
    fetch('/api/config/mqtt')
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as {
          brokerUrl: string | null; topics: string | null;
          defaultBrokerUrl: string; defaultTopics: string;
          source: 'runtime' | 'env' | null;
        };
        setBrokerUrl(d.brokerUrl ?? d.defaultBrokerUrl);
        setTopics(d.topics ?? d.defaultTopics);
        setSource(d.source);
      })
      .catch(() => {
        setBrokerUrl('mqtt://192.168.2.1:1883');
        setTopics('#');
      });
  }, []);

  usePolledJson<{ count: number }>(
    saved ? '/api/config/mqtt/topics' : null,
    3000,
    (d) => setTopicCount(d.count),
  );

  function edited<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setTestResult(null); setSaved(false); };
  }

  async function testBroker() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/config/mqtt/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brokerUrl }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; brokerUrl?: string };
      setTestResult(
        body.ok
          ? { ok: true, message: `Verbunden mit ${body.brokerUrl}` }
          : { ok: false, message: body.error ?? 'Verbindung fehlgeschlagen.' },
      );
    } catch {
      setTestResult({ ok: false, message: 'Die Anwendung ist nicht erreichbar.' });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/config/mqtt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brokerUrl, topics }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(body.error ?? 'Die Einstellungen konnten nicht gespeichert werden.');
        return;
      }
      const body = (await res.json()) as { brokerUrl: string };
      setBrokerUrl(body.brokerUrl);
      setSource('runtime');
      setSaved(true);
      onSaved?.(body.brokerUrl);
    } catch {
      setSaveError('Die Anwendung ist nicht erreichbar. Bitte erneut versuchen.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.container}>
      <label style={styles.fieldLabel}>
        Adresse der MQTT-Box
        <input
          value={brokerUrl}
          onChange={(e) => edited(setBrokerUrl)(e.target.value)}
          style={styles.input}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div style={styles.fieldHint}>
        Voreingestellt ist die Standard-Adresse der Implenia MQTT-Box. Nur ändern,
        wenn die Box anders eingerichtet wurde.
        {source === 'env' && ' Der Wert stammt aus der .env-Datei; ein hier gespeicherter Wert hat Vorrang.'}
      </div>

      <label style={styles.fieldLabel}>
        Topic-Filter
        <input
          value={topics}
          onChange={(e) => edited(setTopics)(e.target.value)}
          style={styles.input}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div style={styles.fieldHint}>
        „#" empfängt alle Topics. Das ist bei der Einrichtung gewollt — so werden
        auch unbekannte Sensornamen sichtbar.
      </div>

      {testResult && (
        <div style={testResult.ok ? styles.success : styles.error}>{testResult.message}</div>
      )}
      {saveError && <div style={styles.error}>{saveError}</div>}
      {saved && (
        <div style={styles.success}>
          Gespeichert.{' '}
          {topicCount === null
            ? 'Empfangene Topics werden geprüft...'
            : topicCount > 0
              ? `${topicCount} Topics empfangen.`
              : 'Noch keine Topics empfangen — läuft die Maschine bereits?'}
        </div>
      )}

      <div style={styles.actions}>
        <button onClick={testBroker} disabled={testing} style={styles.secondaryButton}>
          {testing ? 'Wird geprüft...' : 'Verbindung testen'}
        </button>
        <button onClick={save} disabled={saving} style={styles.primaryButton}>
          {saving ? 'Wird gespeichert...' : 'Speichern'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' },
  fieldLabel: {
    display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)',
    fontSize: 'var(--font-base)', fontWeight: 600, color: 'var(--text-primary)',
  },
  input: {
    minHeight: 'var(--tap-min)', padding: '0 var(--space-md)',
    fontSize: 'var(--font-md)', fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)', backgroundColor: 'var(--surface-0)',
    border: '2px solid var(--border)', borderRadius: 'var(--radius-md)',
  },
  fieldHint: {
    fontSize: 'var(--font-sm)', lineHeight: 1.4, color: 'var(--text-muted)',
    marginTop: 'calc(-1 * var(--space-sm))',
  },
  success: {
    padding: 'var(--space-md)', fontSize: 'var(--font-base)', lineHeight: 1.4,
    color: 'var(--text-primary)', backgroundColor: 'var(--color-success-muted)',
    borderRadius: 'var(--radius-sm)',
  },
  error: {
    padding: 'var(--space-md)', fontSize: 'var(--font-base)', lineHeight: 1.4,
    color: 'var(--text-primary)', backgroundColor: 'var(--color-danger-muted)',
    borderRadius: 'var(--radius-sm)',
  },
  actions: { display: 'flex', gap: 'var(--space-md)' },
  primaryButton: {
    minHeight: 'var(--tap-min)', padding: '0 var(--space-xl)',
    fontSize: 'var(--font-md)', fontWeight: 700, fontFamily: 'inherit',
    color: 'var(--text-primary)', backgroundColor: 'var(--color-accent)',
    border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  },
  secondaryButton: {
    minHeight: 'var(--tap-min)', padding: '0 var(--space-xl)',
    fontSize: 'var(--font-md)', fontWeight: 600, fontFamily: 'inherit',
    color: 'var(--text-primary)', backgroundColor: 'var(--surface-3)',
    border: '2px solid var(--border)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  },
};
