import { useEffect, useState } from 'react';
import { configStyles as styles } from './configStyles';

/**
 * How much of a recording leaves the kiosk, and by which route.
 *
 * Its own screen rather than another card on Messwerte: three settings with
 * five choices each do not fit beside the calibration and Rohrverlängerung
 * cards, and CLAUDE.md asks for a sub-screen rather than a page that scrolls.
 *
 * **Two cards in one row, grouped by destination** — what goes to the platform,
 * what goes on the stick — because that is the distinction a technician is
 * actually making, and because three cards do not fit. Between the header and
 * the recording bar there are about 600 px at 1024x768, and a two-column grid
 * puts a third card on a second row that lands behind the recording bar. That
 * failure is silent: the config area hides its overflow, so content that does
 * not fit produces no scrollbar and is simply unreachable. Every explanation is
 * therefore two lines, and the choices read `1 s` rather than `1 Sekunde` so
 * five of them fit a column without clipping.
 *
 * Every setting applies on the way *out*. The kiosk's own database keeps every
 * reading at full resolution whatever is chosen here, so a choice made wrong
 * costs resolution on the platform and is undone by exporting or re-uploading
 * the same session.
 */

interface Granularity {
  ms: number;
  label: string;
  short: string;
}

interface Mode {
  key: string;
  label: string;
}

interface Settings {
  exportBucketMs: number;
  uploadBucketMs: number;
  uploadMode: string;
  holdMs: number;
  rowsPerChunk: number;
  granularities: Granularity[];
  uploadModes: Mode[];
}

/** Which card a refusal belongs to, so it is shown where the tap happened. */
type Field = 'mode' | 'upload' | 'export';

export function DatenuebertragungConfig() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Field | null>(null);
  const [failed, setFailed] = useState<{ field: Field; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/config/datenuebertragung', { signal: controller.signal })
      .then((r) => r.json())
      .then((d: Settings) => setSettings(d))
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadError(
            'Die Einstellungen konnten nicht geladen werden. Bitte die Seite neu ' +
            'laden — Aufzeichnung und Upload laufen davon unberührt weiter.',
          );
        }
      });
    return () => controller.abort();
  }, []);

  async function save(field: Field, patch: Partial<Settings>) {
    if (saving || !settings) return;
    setSaving(true);
    setFailed(null);
    setSaved(null);
    // The values to go back to if the server refuses, so the screen never shows
    // a setting the kiosk is not actually using.
    const before = settings;
    setSettings({ ...settings, ...patch });
    try {
      const res = await fetch('/api/config/datenuebertragung', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exportBucketMs: patch.exportBucketMs ?? settings.exportBucketMs,
          uploadBucketMs: patch.uploadBucketMs ?? settings.uploadBucketMs,
          uploadMode: patch.uploadMode ?? settings.uploadMode,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Fehler ${res.status}`);
      setSettings(await (await fetch('/api/config/datenuebertragung')).json() as Settings);
      setSaved(field);
      setTimeout(() => setSaved(null), 2500);
    } catch (err) {
      setSettings(before);
      setFailed({ field, message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div style={styles.container}>
        <div style={styles.cardWrapper}>
          <div style={styles.card}>
            <div style={loadError ? danger : hint}>
              {loadError ?? 'Einstellungen werden geladen...'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const seconds = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

  const grid = (field: Field, selected: number, key: 'uploadBucketMs' | 'exportBucketMs') =>
    settings.granularities.map((g) => (
      <button
        key={g.ms}
        style={g.ms === selected ? styles.presetButtonActive : styles.presetButton}
        onClick={() => save(field, { [key]: g.ms })}
        disabled={saving}
        aria-label={g.label}
      >
        {g.short}
      </button>
    ));

  return (
    <div style={styles.container}>
      {/* Everything about the upload, in the order it happens: route, then how
          much of the recording goes along it. */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>Upload zur Plattform</span>
            {(saved === 'mode' || saved === 'upload') && <span style={savedBadge}>Gespeichert</span>}
          </div>

          <div style={failed?.field === 'mode' ? danger : hint}>
            {failed?.field === 'mode'
              ? failed.message
              : `Gesammelt: alle Werte eines Zeitpunkts in einer Zeile, in Paketen von ` +
                `${settings.rowsPerChunk} Zeilen. Deutlich weniger Daten.`}
          </div>
          <div style={styles.presetRow}>
            {settings.uploadModes.map((m) => (
              <button
                key={m.key}
                style={m.key === settings.uploadMode ? styles.presetButtonActive : styles.presetButton}
                onClick={() => save('mode', { uploadMode: m.key })}
                disabled={saving}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div style={subLabel}>Auflösung</div>
          <div style={failed?.field === 'upload' ? danger : hint}>
            {failed?.field === 'upload'
              ? failed.message
              : `Je Zeitabschnitt der letzte gemessene Wert, nie ein Mittelwert. ` +
                `Ein Wert gilt bis zu ${seconds(settings.holdMs)} weiter.`}
          </div>
          <div style={styles.presetRow}>
            {grid('upload', settings.uploadBucketMs, 'uploadBucketMs')}
          </div>
        </div>
      </div>

      {/* The offline counterpart, which has its own granularity: a worker
          carrying a stick to the office is not paying for mobile data. */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>USB-Export</span>
            {saved === 'export' && <span style={savedBadge}>Gespeichert</span>}
          </div>
          <div style={failed?.field === 'export' ? danger : hint}>
            {failed?.field === 'export'
              ? failed.message
              : 'Für die Excel-Datei auf dem USB-Stick. „Voll" sind je Schicht ' +
                'Hunderttausende Zeilen, der Export dauert dann Minuten.'}
          </div>
          <div style={styles.presetRow}>
            {grid('export', settings.exportBucketMs, 'exportBucketMs')}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Explanatory text at `--font-base`, not `--font-sm`.
 *
 * CLAUDE.md reserves `--font-sm` for decoration: this is what a technician
 * decides by, so it has to be readable at arm's length in daylight.
 */
const hint: React.CSSProperties = {
  ...styles.envHint,
  fontSize: 'var(--font-base)',
};

const danger: React.CSSProperties = {
  ...hint,
  borderLeft: '3px solid var(--color-danger)',
  color: 'var(--text-primary)',
};

/** The second setting inside the upload card. */
const subLabel: React.CSSProperties = {
  fontSize: 'var(--font-base)',
  color: 'var(--text-secondary)',
  fontWeight: 600,
  marginBottom: 'var(--space-sm)',
};

const savedBadge: React.CSSProperties = {
  ...styles.statusBadge,
  fontSize: 'var(--font-base)',
  backgroundColor: 'var(--color-success)',
  color: '#fff',
};
