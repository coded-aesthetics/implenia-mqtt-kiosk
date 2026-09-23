import { useEffect, useState } from 'react';
import { formatNumber } from '../utils/format';

/**
 * Rohrverlängerung settings.
 *
 * Drilling is interrupted every 2 m or 3 m to add a Bohrrohr: the Klemmbacke
 * closes, the Drehantrieb unscrews itself and travels back up the mast. The
 * readings from that window are not drilling data, so they are recorded but
 * kept out of the upload.
 *
 * The live Klemmbacke value is polled and shown next to the thresholds, so a
 * technician can set them by watching the clamp open and close instead of
 * guessing.
 */

type DepthMode = 'absolut' | 'inkrementell';

interface Config {
  clampTopic: string | null;
  enabled: boolean;
  depthMode: DepthMode;
  pipeLength: number;
  closeThreshold: number;
  openThreshold: number;
  tolerance: number;
  defaultClampTopic: string;
}

/** Last payload seen per topic, from the shared observation buffer. */
interface ObservedTopic {
  topic: string;
  lastPayload: string;
  lastSeen: number;
}

const PIPE_PRESETS = [2, 3];

/** Mirrors the server's isClampTopic: full topic, or last segment. */
function matchesClampTopic(topic: string, clampTopic: string): boolean {
  const full = topic.toLowerCase();
  const wanted = clampTopic.toLowerCase();
  if (full === wanted) return true;
  const segment = full.split('/').pop() ?? '';
  return segment !== '' && segment === (wanted.split('/').pop() ?? '');
}

export function RohrwechselSettings() {
  const [enabled, setEnabled] = useState(false);
  const [clampTopic, setClampTopic] = useState('');
  const [depthMode, setDepthMode] = useState<DepthMode>('absolut');
  const [pipeLength, setPipeLength] = useState('2');
  const [closeThreshold, setCloseThreshold] = useState('100');
  const [openThreshold, setOpenThreshold] = useState('50');
  const [tolerance, setTolerance] = useState('0.3');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/config/rohrwechsel')
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as Config;
        setEnabled(d.enabled);
        setClampTopic(d.clampTopic ?? d.defaultClampTopic);
        setDepthMode(d.depthMode ?? 'absolut');
        setPipeLength(String(d.pipeLength));
        setCloseThreshold(String(d.closeThreshold));
        setOpenThreshold(String(d.openThreshold));
        setTolerance(String(d.tolerance));
      })
      .catch(() => {
        // Leave the defaults in place — an unreachable config endpoint must
        // not leave the technician with an empty form.
      });
  }, []);

  // Watch the clamp so the thresholds can be set against real values.
  useEffect(() => {
    if (!clampTopic.trim()) return;
    let cancelled = false;
    const poll = () => {
      fetch('/api/config/mqtt/topics')
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { topics?: ObservedTopic[] } | null) => {
          if (cancelled || !d?.topics) return;
          const hit = d.topics.find((t) => matchesClampTopic(t.topic, clampTopic));
          const value = hit ? Number(hit.lastPayload) : NaN;
          setLive(Number.isFinite(value) ? value : null);
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [clampTopic]);

  function edited<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setSaved(false); setError(null); };
  }

  async function save(nextEnabled: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/config/rohrwechsel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clampTopic: nextEnabled ? clampTopic : null,
          depthMode,
          pipeLength: Number(pipeLength.replace(',', '.')),
          closeThreshold: Number(closeThreshold.replace(',', '.')),
          openThreshold: Number(openThreshold.replace(',', '.')),
          tolerance: Number(tolerance.replace(',', '.')),
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Fehler ${res.status}`);
      setEnabled(nextEnabled);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const closeNum = Number(closeThreshold.replace(',', '.'));
  const openNum = Number(openThreshold.replace(',', '.'));
  const clampState =
    live === null ? null : live >= closeNum ? 'zu' : live < openNum ? 'offen' : 'dazwischen';

  return (
    <div style={styles.container}>
      <div style={styles.presetRow}>
        <button
          style={enabled ? styles.presetButton : styles.presetButtonActive}
          onClick={() => save(false)}
          disabled={saving}
        >
          Aus
        </button>
        <button
          style={enabled ? styles.presetButtonActive : styles.presetButton}
          onClick={() => save(true)}
          disabled={saving}
        >
          Ein
        </button>
      </div>

      <div style={styles.fieldHint}>
        {enabled
          ? 'Solange die Klemmbacke geschlossen ist, werden die Messwerte zwar aufgezeichnet, aber nicht hochgeladen — sie stammen vom Rohreinbau, nicht vom Bohren.'
          : 'Ausgeschaltet. Alle Messwerte werden hochgeladen — richtig für Geräte ohne Klemmbacken-Signal.'}
      </div>

      {enabled && (
        <>
          <label style={styles.fieldLabel}>
            Topic der Klemmbacke
            <input
              style={styles.input}
              value={clampTopic}
              onChange={(e) => edited(setClampTopic)(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <div style={styles.fieldHint}>
            Das Topic, auf dem der Druck der Klemmbacke gesendet wird.
          </div>

          <div style={live === null ? styles.liveMissing : styles.live}>
            {live === null ? (
              <>Kein Wert empfangen. Bitte Topic prüfen — die Maschine muss dabei laufen.</>
            ) : (
              <>
                Aktuell: <strong>{formatNumber(live)}</strong>
                {clampState === 'zu' && ' — Klemmbacke zu (Rohrwechsel)'}
                {clampState === 'offen' && ' — Klemmbacke offen (Bohren)'}
                {clampState === 'dazwischen' && ' — zwischen den Schwellen, unverändert'}
              </>
            )}
          </div>

          <label style={styles.fieldLabel}>
            Bohrtiefe vom Gerät
            <div style={styles.presetRow}>
              <button
                style={depthMode === 'absolut' ? styles.presetButtonActive : styles.presetButton}
                onClick={() => edited(setDepthMode)('absolut')}
              >
                Absolut
              </button>
              <button
                style={depthMode === 'inkrementell' ? styles.presetButtonActive : styles.presetButton}
                onClick={() => edited(setDepthMode)('inkrementell')}
              >
                Schlittenweg
              </button>
            </div>
          </label>
          <div style={styles.fieldHint}>
            {depthMode === 'absolut'
              ? 'Das Gerät meldet die Tiefe des Bohrlochs. Sie bleibt stehen, solange die Klemmbacke zu ist. Üblich, wenn die Tiefe vom Hersteller über CAN geliefert wird.'
              : 'Das Gerät meldet den Schlittenweg am Mast. Er läuft beim Rohrwechsel zurück, deshalb rechnet das Kiosk die Tiefe selbst hoch. Üblich bei nachgerüsteten Geräten.'}
          </div>
          <div style={styles.fieldHint}>
            Im Zweifel: läuft die angezeigte Tiefe zurück, während der Drehantrieb
            den Mast hochfährt, dann ist es der Schlittenweg.
          </div>

          {depthMode === 'inkrementell' && (
            <div style={styles.fieldHint}>
              Der Messgeber sitzt am Vorschub, nicht im Loch — ein Meter Messwert ist
              deshalb selten ein Meter Bohrloch. Wenn nach einem Rohrwechsel eine
              falsche Strecke gemeldet wird, steht der passende Faktor in der Meldung;
              eingetragen wird er unter Einstellungen → Kalibrierung beim Sensor der
              Bohrtiefe.
            </div>
          )}

          <label style={styles.fieldLabel}>
            Rohrlänge
            <div style={styles.presetRow}>
              {PIPE_PRESETS.map((m) => (
                <button
                  key={m}
                  style={
                    Number(pipeLength.replace(',', '.')) === m
                      ? styles.presetButtonActive
                      : styles.presetButton
                  }
                  onClick={() => edited(setPipeLength)(String(m))}
                >
                  {m} m
                </button>
              ))}
            </div>
            <input
              style={styles.input}
              value={pipeLength}
              inputMode="decimal"
              onChange={(e) => edited(setPipeLength)(e.target.value)}
            />
          </label>
          <div style={styles.fieldHint}>
            Die Länge eines Bohrrohrs in Metern. Dient der Kontrolle: zwischen zwei
            Rohrwechseln sollte etwa diese Strecke gebohrt worden sein.
          </div>

          <label style={styles.fieldLabel}>
            Klemmbacke zu ab
            <input
              style={styles.input}
              value={closeThreshold}
              inputMode="decimal"
              onChange={(e) => edited(setCloseThreshold)(e.target.value)}
            />
          </label>

          <label style={styles.fieldLabel}>
            Klemmbacke offen unter
            <input
              style={styles.input}
              value={openThreshold}
              inputMode="decimal"
              onChange={(e) => edited(setOpenThreshold)(e.target.value)}
            />
          </label>
          <div style={styles.fieldHint}>
            Zwei getrennte Schwellen, damit die Erkennung bei Messrauschen nicht
            hin- und herspringt. Die Einheit ist die des Geräts — manche Boxen senden
            bar, andere vierstellige Rohwerte. Deshalb: den Wert oben ablesen, während
            die Klemmbacke einmal schließt und wieder öffnet, und die Schwellen
            dazwischen legen.
          </div>
          <div style={styles.fieldHint}>
            Solange die Klemmbacke noch nie unter der Schwelle für „offen" war, wird
            nichts ausgeblendet — lieber alles aufzeichnen als eine ganze Schicht.
          </div>

          <label style={styles.fieldLabel}>
            Toleranz (m)
            <input
              style={styles.input}
              value={tolerance}
              inputMode="decimal"
              onChange={(e) => edited(setTolerance)(e.target.value)}
            />
          </label>
          <div style={styles.fieldHint}>
            Ab welcher Abweichung von der Rohrlänge die zwischen zwei Rohrwechseln
            gebohrte Strecke als unplausibel gemeldet wird.
          </div>

          <button style={styles.primaryButton} onClick={() => save(true)} disabled={saving}>
            {saving ? 'Wird gespeichert…' : 'Speichern'}
          </button>
        </>
      )}

      {error && <div style={styles.error}>{error}</div>}
      {saved && !error && <div style={styles.success}>Gespeichert.</div>}
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
  presetRow: { display: 'flex', gap: '2px', borderRadius: 'var(--radius-md)', overflow: 'hidden' },
  presetButton: {
    flex: 1, minHeight: 'var(--tap-min)', padding: 'var(--space-md)',
    fontSize: 'var(--font-base)', fontWeight: 600, fontFamily: 'inherit',
    backgroundColor: 'var(--surface-0)', color: 'var(--text-muted)',
    border: 'none', cursor: 'pointer',
  },
  presetButtonActive: {
    flex: 1, minHeight: 'var(--tap-min)', padding: 'var(--space-md)',
    fontSize: 'var(--font-base)', fontWeight: 700, fontFamily: 'inherit',
    backgroundColor: 'var(--color-accent)', color: 'var(--text-primary)',
    border: 'none', cursor: 'pointer',
  },
  live: {
    padding: 'var(--space-md)', fontSize: 'var(--font-base)', lineHeight: 1.4,
    color: 'var(--text-primary)', backgroundColor: 'var(--surface-0)',
    borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)',
  },
  liveMissing: {
    padding: 'var(--space-md)', fontSize: 'var(--font-base)', lineHeight: 1.4,
    color: 'var(--text-primary)', backgroundColor: 'var(--color-warning)',
    borderRadius: 'var(--radius-sm)',
  },
  primaryButton: {
    minHeight: 'var(--tap-min)', padding: '0 var(--space-xl)',
    fontSize: 'var(--font-md)', fontWeight: 700, fontFamily: 'inherit',
    color: 'var(--text-primary)', backgroundColor: 'var(--color-accent)',
    border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer',
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
};
