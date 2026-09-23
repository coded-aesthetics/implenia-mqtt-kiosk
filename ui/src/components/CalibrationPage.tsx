import { useEffect, useState, useCallback } from 'react';

/**
 * Per-sensor linear calibration: `wert = rohwert × Faktor + Versatz`.
 *
 * A reading does not always arrive in the unit the sensor is supposed to be
 * in — a channel scaled for a different machine, a different transducer, or a
 * depth sensor that sits on the feed rather than in the hole. That belongs
 * fixed on the machine, but a rig cannot always be taken out of service, so
 * the kiosk can correct it.
 *
 * The live raw and corrected values are polled and shown side by side, because
 * a factor is set by comparing the kiosk against the display on the rig, not
 * by arithmetic. „Nullen" does the most common correction in one tap: it
 * stores the offset that cancels whatever the sensor is reading at rest.
 */

interface Sensor {
  name: string;
  unit: string;
  source: string;
  scale: number;
  offset: number;
  topic: string | null;
  raw: number | null;
  /** How old the raw value is. The buffer keeps the last one for minutes. */
  rawAgeMs: number | null;
  calibrated: number | null;
}

/**
 * Above this, the value on screen is the last one that arrived rather than
 * what the sensor is doing — say so, and do not offer to zero against it. The
 * server refuses a stale tare anyway; this keeps the technician from tapping
 * into that refusal.
 */
const STALE_AFTER_MS = 10_000;

function isStale(s: Sensor): boolean {
  return s.raw !== null && s.rawAgeMs !== null && s.rawAgeMs > STALE_AFTER_MS;
}

function formatValue(v: number | null, digits = 2): string {
  if (v === null) return '—';
  return v.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** German decimal comma in, JS number out. */
function parseNumber(input: string): number {
  return Number(input.replace(',', '.'));
}

export function CalibrationPage() {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { scale: string; offset: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback((withDrafts: boolean) => {
    fetch('/api/config/calibration')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { sensors?: Sensor[] } | null) => {
        if (!d?.sensors) return;
        setSensors(d.sensors);
        if (withDrafts) {
          const next: Record<string, { scale: string; offset: string }> = {};
          for (const s of d.sensors) {
            next[s.name] = { scale: String(s.scale), offset: String(s.offset) };
          }
          setDrafts(next);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => { load(true); }, [load]);

  // Keep the live values moving without touching what is being typed.
  useEffect(() => {
    const timer = setInterval(() => load(false), 3000);
    return () => clearInterval(timer);
  }, [load]);

  async function save(sensor: Sensor) {
    const draft = drafts[sensor.name];
    if (!draft) return;
    setSaving(sensor.name);
    setError(null);
    try {
      const res = await fetch('/api/config/calibration', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sensorName: sensor.name,
          scale: parseNumber(draft.scale),
          offset: parseNumber(draft.offset),
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Fehler ${res.status}`);
      setSavedName(sensor.name);
      setTimeout(() => setSavedName(null), 4000);
      load(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  /**
   * Store the offset that makes the current reading zero. The server reads the
   * live value itself — the one polled into this screen can be a few seconds
   * old — and answers with the offset it stored, which goes straight back into
   * the field so the technician sees what was applied.
   */
  async function tare(sensor: Sensor) {
    setSaving(sensor.name);
    setError(null);
    try {
      const res = await fetch(
        `/api/config/calibration/${encodeURIComponent(sensor.name)}/tare`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scale: parseNumber(drafts[sensor.name]?.scale ?? '1') }),
        },
      );
      const body = (await res.json()) as { offset?: number; scale?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Fehler ${res.status}`);
      setDrafts((d) => ({
        ...d,
        [sensor.name]: {
          scale: String(body.scale ?? sensor.scale),
          offset: String(body.offset ?? 0),
        },
      }));
      setSavedName(sensor.name);
      setTimeout(() => setSavedName(null), 4000);
      load(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  async function reset(sensor: Sensor) {
    setSaving(sensor.name);
    setError(null);
    try {
      const res = await fetch(`/api/config/calibration/${encodeURIComponent(sensor.name)}`, {
        method: 'DELETE',
      });
      // Without this the fields would read 1 / 0 whatever happened, and the
      // next poll would quietly paint the old values back — leaving the
      // technician unsure whether the calibration is gone.
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Die Kalibrierung konnte nicht entfernt werden (Fehler ${res.status}).`);
      }
      setDrafts((d) => ({ ...d, [sensor.name]: { scale: '1', offset: '0' } }));
      load(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  function edit(name: string, field: 'scale' | 'offset', value: string) {
    setDrafts((d) => ({ ...d, [name]: { ...d[name], [field]: value } }));
    setError(null);
  }

  if (loaded && sensors.length === 0) {
    return (
      <div style={styles.empty}>
        Für dieses Verfahren sind keine Messwert-Sensoren hinterlegt. Bitte zuerst
        die Einrichtung abschließen.
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.intro}>
        Messwert = Rohwert × Faktor + Versatz. Faktor 1 und Versatz 0 bedeuten:
        der Wert wird unverändert übernommen. „Nullen" setzt den Versatz so, dass
        der Sensor jetzt 0 anzeigt — dafür muss die Maschine in Ruhestellung sein.
        Die Umrechnung gehört eigentlich ans Gerät — hier ist sie für Geräte
        gedacht, an denen das gerade nicht geht.
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.list}>
        {sensors.map((s) => {
          const draft = drafts[s.name] ?? { scale: '1', offset: '0' };
          const changed =
            parseNumber(draft.scale) !== s.scale || parseNumber(draft.offset) !== s.offset;
          const active = s.scale !== 1 || s.offset !== 0;
          return (
            <div key={s.name} style={active ? styles.rowActive : styles.row}>
              <div style={styles.nameCell}>
                <div style={styles.name}>{s.name}</div>
                <div style={styles.meta}>
                  {s.unit || '—'}
                  {s.topic ? ` · ${s.topic}` : ' · kein Topic zugeordnet'}
                </div>
              </div>

              <div style={styles.valueCell}>
                <div style={styles.valueLabel}>{isStale(s) ? 'Rohwert (alt)' : 'Rohwert'}</div>
                <div style={isStale(s) ? styles.rawValueStale : styles.rawValue}>
                  {formatValue(s.raw)}
                </div>
              </div>
              <div style={styles.arrow}>→</div>
              <div style={styles.valueCell}>
                <div style={styles.valueLabel}>Messwert</div>
                <div style={styles.calValue}>{formatValue(s.calibrated)}</div>
              </div>

              <label style={styles.inputCell}>
                <span style={styles.valueLabel}>Faktor</span>
                <input
                  style={styles.input}
                  value={draft.scale}
                  inputMode="decimal"
                  onChange={(e) => edit(s.name, 'scale', e.target.value)}
                />
              </label>
              <div style={styles.offsetCell}>
                <label style={styles.inputCell}>
                  <span style={styles.valueLabel}>Versatz</span>
                  <input
                    style={styles.input}
                    value={draft.offset}
                    inputMode="decimal"
                    onChange={(e) => edit(s.name, 'offset', e.target.value)}
                  />
                </label>
                <button
                  style={s.raw === null || isStale(s) ? styles.tareButtonIdle : styles.tareButton}
                  onClick={() => tare(s)}
                  disabled={saving === s.name || s.raw === null || isStale(s)}
                  title="Versatz auf den aktuellen Rohwert setzen"
                >
                  Nullen
                </button>
              </div>

              <button
                style={changed ? styles.saveButton : styles.saveButtonIdle}
                onClick={() => save(s)}
                disabled={saving === s.name || !changed}
              >
                {savedName === s.name ? '✓' : 'Speichern'}
              </button>
              <button
                style={active ? styles.resetButton : styles.resetButtonIdle}
                onClick={() => reset(s)}
                disabled={saving === s.name || !active}
              >
                Zurücksetzen
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex', flexDirection: 'column', gap: 'var(--space-md)',
    padding: 'var(--space-lg)', minHeight: 0, flex: 1, boxSizing: 'border-box',
  },
  intro: {
    fontSize: 'var(--font-base)', lineHeight: 1.4, color: 'var(--text-secondary)',
  },
  list: {
    display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)',
    overflowY: 'auto', minHeight: 0,
  },
  // The row has to hold name, two live values, two fields and three buttons at
  // 1024 px, so the gaps are tight and only the name cell gives way.
  row: {
    display: 'flex', alignItems: 'flex-end', gap: 'var(--space-sm)',
    padding: 'var(--space-md)', borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
  },
  rowActive: {
    display: 'flex', alignItems: 'flex-end', gap: 'var(--space-sm)',
    padding: 'var(--space-md)', borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-3)',
    borderLeft: '4px solid var(--color-accent)',
  },
  nameCell: { flex: 1, minWidth: 0, alignSelf: 'center' },
  name: {
    fontSize: 'var(--font-base)', fontWeight: 700, color: 'var(--text-primary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  meta: {
    fontSize: 'var(--font-sm)', color: 'var(--text-muted)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  valueCell: { minWidth: '96px', textAlign: 'right', alignSelf: 'center' },
  valueLabel: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)' },
  rawValue: {
    fontSize: 'var(--font-md)', fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
  },
  rawValueStale: {
    fontSize: 'var(--font-md)', fontFamily: 'var(--font-mono)',
    color: 'var(--color-warning)',
  },
  calValue: {
    fontSize: 'var(--font-md)', fontFamily: 'var(--font-mono)', fontWeight: 700,
    color: 'var(--text-primary)',
  },
  arrow: { fontSize: 'var(--font-md)', color: 'var(--text-muted)', alignSelf: 'center' },
  inputCell: { display: 'flex', flexDirection: 'column', gap: '2px', width: '110px' },
  offsetCell: { display: 'flex', alignItems: 'flex-end', gap: 'var(--space-sm)' },
  input: {
    minHeight: 'var(--tap-min)', padding: '0 var(--space-sm)',
    fontSize: 'var(--font-md)', fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)', backgroundColor: 'var(--surface-0)',
    border: '2px solid var(--border)', borderRadius: 'var(--radius-md)',
    width: '100%', boxSizing: 'border-box',
  },
  tareButton: {
    minHeight: 'var(--tap-min)', minWidth: '92px', padding: '0 var(--space-sm)',
    fontSize: 'var(--font-base)', fontWeight: 700, fontFamily: 'inherit',
    whiteSpace: 'nowrap', color: 'var(--color-accent)',
    backgroundColor: 'var(--surface-0)', border: '2px solid var(--color-accent)',
    borderRadius: 'var(--radius-md)', cursor: 'pointer',
  },
  // No live value means there is nothing to cancel out.
  tareButtonIdle: {
    minHeight: 'var(--tap-min)', minWidth: '92px', padding: '0 var(--space-sm)',
    fontSize: 'var(--font-base)', fontWeight: 600, fontFamily: 'inherit',
    whiteSpace: 'nowrap', color: 'var(--text-muted)',
    backgroundColor: 'var(--surface-0)', border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
  },
  saveButton: {
    minHeight: 'var(--tap-min)', minWidth: '120px', padding: '0 var(--space-sm)',
    fontSize: 'var(--font-base)', fontWeight: 700, fontFamily: 'inherit',
    color: '#fff', backgroundColor: 'var(--color-accent)',
    border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  },
  saveButtonIdle: {
    minHeight: 'var(--tap-min)', minWidth: '120px', padding: '0 var(--space-sm)',
    fontSize: 'var(--font-base)', fontWeight: 600, fontFamily: 'inherit',
    color: 'var(--text-muted)', backgroundColor: 'var(--surface-0)',
    border: 'none', borderRadius: 'var(--radius-md)',
  },
  resetButton: {
    minHeight: 'var(--tap-min)', minWidth: '132px', padding: '0 var(--space-sm)',
    whiteSpace: 'nowrap',
    fontSize: 'var(--font-base)', fontWeight: 600, fontFamily: 'inherit',
    color: 'var(--color-danger)', backgroundColor: 'var(--surface-3)',
    border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  },
  resetButtonIdle: {
    minHeight: 'var(--tap-min)', minWidth: '132px', padding: '0 var(--space-sm)',
    whiteSpace: 'nowrap',
    fontSize: 'var(--font-base)', fontWeight: 600, fontFamily: 'inherit',
    color: 'var(--text-dim)', backgroundColor: 'var(--surface-2)',
    border: 'none', borderRadius: 'var(--radius-md)',
  },
  error: {
    padding: 'var(--space-md)', fontSize: 'var(--font-base)', lineHeight: 1.4,
    color: 'var(--text-primary)', backgroundColor: 'var(--color-danger-muted)',
    borderRadius: 'var(--radius-sm)',
  },
  empty: {
    padding: 'var(--space-xl)', fontSize: 'var(--font-base)', lineHeight: 1.5,
    color: 'var(--text-secondary)',
  },
};
