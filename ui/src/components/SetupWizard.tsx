import { useEffect, useState } from 'react';
import { navigate } from '../hooks/useHashRouter';
import type { ConfigState } from '../hooks/useImplenia';
import { MqttSettings } from './MqttSettings';
import { VerbindungConfig } from './VerbindungConfig';
import { usePolledJson } from '../hooks/usePolledJson';

/**
 * First-start setup, shown instead of the whole app until this machine has a
 * Verfahren. Service-personnel UI, not worker UI: it is deliberately a
 * multi-step flow, which the worker-facing rules in CLAUDE.md rule out. The
 * glove-sized tap targets, contrast and German still apply.
 *
 * Each step commits its own setting as it completes, so an interrupted setup
 * resumes where it left off instead of starting over.
 */

interface Verfahren {
  key: string;
  label: string;
}

interface Props {
  /** Current step, from the URL (`#/setup/<step>`). */
  step: string;
  /** Leave the wizard: the app re-reads the Verfahren and routes home. */
  onFinish: () => void;
  config: ConfigState;
}

type Transport = 'mqtt' | 'serial';
type Step = 'verfahren' | 'transport' | 'mqtt' | 'serial' | 'verbindung' | 'done';

const STEP_TITLES: Record<Step, string> = {
  verfahren: 'Verfahren wählen',
  transport: 'Datenquelle wählen',
  mqtt: 'MQTT-Box verbinden',
  serial: 'Geräte anschließen',
  verbindung: 'API-Zugang einrichten',
  done: 'Einrichtung abgeschlossen',
};

/** The step sequence depends on the transport, so the counter stays honest. */
function stepOrder(transport: Transport | null): Step[] {
  if (transport === null) return ['verfahren', 'transport', 'done'];
  return ['verfahren', 'transport', transport, 'verbindung', 'done'];
}

interface SerialDevice {
  deviceId: number;
  label: string;
  type: string;
  connected: boolean;
}

function isStep(value: string): value is Step {
  return value in STEP_TITLES;
}

export function SetupWizard({ step: rawStep, onFinish, config }: Props) {
  const hasApiKey = config.hasApiKey;
  const step: Step = isStep(rawStep) ? rawStep : 'verfahren';
  const goto = (next: Step) => navigate(`setup/${next}`);

  const [verfahren, setVerfahren] = useState<Verfahren[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The Verfahren already stored on this machine, if any. Write-once on the
  // server, so the wizard must not offer to write it a second time.
  const [lockedVerfahren, setLockedVerfahren] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Transport ──
  const [transport, setTransport] = useState<Transport | null>(null);
  const [transportSaving, setTransportSaving] = useState(false);
  const [mqttSaved, setMqttSaved] = useState(false);
  const [brokerUrl, setBrokerUrl] = useState('');
  const [serialDevices, setSerialDevices] = useState<SerialDevice[] | null>(null);

  useEffect(() => {
    fetch('/api/verfahren')
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setVerfahren(await r.json());
        setListError(null);
      })
      .catch(() =>
        setListError(
          'Die Verfahrensliste konnte nicht geladen werden. Bitte die Seite neu laden.',
        ),
      );
  }, []);

  // Devices are listed on the serial step so the technician can see whether the
  // USB connection is actually up before leaving the wizard.
  usePolledJson<{ devices?: SerialDevice[] }>(
    step === 'serial' ? '/status' : null,
    3000,
    (d) => setSerialDevices(d.devices ?? []),
    // An unreachable server means the list on screen is no longer evidence of
    // anything, and a stale device is worse here than an empty list: the whole
    // point of this step is seeing whether the USB connection is actually up.
    { onError: () => setSerialDevices([]) },
  );

  // Everything the wizard needs to render a step is read back from the server,
  // not carried in component state. A reload — or landing on #/setup/done
  // directly — then shows the real situation instead of an empty summary.
  useEffect(() => {
    fetch('/api/verfahren/active')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.verfahren) {
          setSelected(d.verfahren);
          setLockedVerfahren(d.verfahren);
        }
      })
      .catch(() => {});

    fetch('/api/config/transport')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.configured) setTransport(d.transport); })
      .catch(() => {});

    fetch('/api/config/mqtt')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.source === 'runtime' && d.brokerUrl) {
          setMqttSaved(true);
          setBrokerUrl(d.brokerUrl);
        }
      })
      .catch(() => {});
  }, []);

  async function chooseTransport(choice: Transport) {
    if (transportSaving) return;
    setTransportSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/config/transport', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transport: choice }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(body.error ?? 'Die Datenquelle konnte nicht gespeichert werden.');
        return;
      }
      setTransport(choice);
      goto(choice);
    } catch {
      setSaveError('Die Anwendung ist nicht erreichbar. Bitte erneut versuchen.');
    } finally {
      setTransportSaving(false);
    }
  }

  async function confirmVerfahren() {
    if (!selected || saving) return;
    // Already stored: the server would answer 409 and the step has no way
    // back, so move on instead of writing the same value again.
    if (lockedVerfahren) {
      if (selected !== lockedVerfahren) {
        setSaveError(
          'Das Verfahren ist bereits festgelegt und kann nicht geändert werden. ' +
            'Um ein anderes Verfahren zu wählen, muss die Software in den ' +
            'Einstellungen zurückgesetzt werden.',
        );
        return;
      }
      goto('transport');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/verfahren/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verfahren: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(
          body.error ??
            'Das Verfahren konnte nicht gespeichert werden. Bitte erneut versuchen.',
        );
        return;
      }
      goto('transport');
    } catch {
      setSaveError(
        'Die Anwendung ist nicht erreichbar. Bitte die Verbindung prüfen und erneut versuchen.',
      );
    } finally {
      setSaving(false);
    }
  }

  const selectedLabel = verfahren.find((v) => v.key === selected)?.label ?? '';
  const transportDone =
    transport === 'mqtt' ? mqttSaved
    : transport === 'serial' ? (serialDevices?.length ?? 0) > 0
    : false;

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerRow}>
          <div>
            <div style={styles.headerTitle}>Einrichtung</div>
            <div style={styles.headerStep}>
              Schritt {Math.max(stepOrder(transport).indexOf(step), 0) + 1} von{' '}
              {stepOrder(transport).length} · {STEP_TITLES[step]}
            </div>
          </div>
          {/* This machine is already set up, so the wizard is optional —
              without a way out, landing on #/setup (browser-back, a bookmark)
              would trap whoever is standing at the screen. */}
          {lockedVerfahren && (
            <button
              onClick={() => { onFinish(); navigate(''); }}
              style={styles.exitButton}
            >
              Einrichtung verlassen
            </button>
          )}
        </div>
      </header>

      <main style={styles.main}>
        {step === 'verfahren' && (
          <>
            <h1 style={styles.question}>
              Welches Verfahren wird mit dieser Maschine ausgeführt?
            </h1>

            {listError && <div style={styles.error}>{listError}</div>}

            <div style={styles.grid}>
              {verfahren.map((v) => {
                const isSelected = v.key === selected;
                const locked = lockedVerfahren !== null && v.key !== lockedVerfahren;
                return (
                  <button
                    key={v.key}
                    onClick={() => { setSelected(v.key); setSaveError(null); }}
                    disabled={locked}
                    style={
                      isSelected ? styles.tileSelected
                      : locked ? styles.tileLocked
                      : styles.tile
                    }
                  >
                    {v.label}
                  </button>
                );
              })}
            </div>

            <div style={styles.warning}>
              {lockedVerfahren
                ? 'Das Verfahren ist für diese Maschine bereits festgelegt. Um ein anderes Verfahren zu wählen, muss die Software in den Einstellungen zurückgesetzt werden — dabei gehen alle aufgezeichneten Daten verloren.'
                : 'Das Verfahren kann später nicht geändert werden. Um ein anderes Verfahren zu wählen, muss die Software zurückgesetzt werden — dabei gehen alle aufgezeichneten Daten verloren.'}
            </div>

            {saveError && <div style={styles.error}>{saveError}</div>}

            <button
              onClick={confirmVerfahren}
              disabled={!selected || saving}
              style={selected && !saving ? styles.confirmButton : styles.confirmButtonDisabled}
            >
              {saving
                ? 'Wird gespeichert...'
                : lockedVerfahren
                  ? 'Weiter'
                  : selected
                    ? `${selectedLabel} festlegen`
                    : 'Bitte ein Verfahren wählen'}
            </button>
          </>
        )}

        {step === 'transport' && (
          <>
            <h1 style={styles.question}>Wie ist die Maschine angeschlossen?</h1>

            <div style={styles.grid}>
              <button
                onClick={() => chooseTransport('mqtt')}
                disabled={transportSaving}
                style={styles.tile}
              >
                MQTT-Box
                <div style={styles.tileHint}>Daten über das Netzwerk</div>
              </button>
              <button
                onClick={() => chooseTransport('serial')}
                disabled={transportSaving}
                style={styles.tile}
              >
                Serielle Verbindung
                <div style={styles.tileHint}>Daten über USB</div>
              </button>
            </div>

            <div style={styles.hint}>
              Diese Auswahl gilt dauerhaft. Sie lässt sich nur ändern, indem die
              Software in den Einstellungen zurückgesetzt wird.
            </div>

            {saveError && <div style={styles.error}>{saveError}</div>}
          </>
        )}

        {step === 'mqtt' && (
          <>
            <h1 style={styles.question}>MQTT-Box verbinden</h1>
            <MqttSettings onSaved={(url) => { setMqttSaved(true); setBrokerUrl(url); }} />
            <div style={styles.doneActions}>
              <button onClick={() => goto('transport')} style={styles.secondaryButton}>
                Zurück
              </button>
              <button onClick={() => goto('done')} style={styles.secondaryButton}>
                {mqttSaved ? 'Weiter' : 'Überspringen'}
              </button>
            </div>
          </>
        )}

        {step === 'serial' && (
          <>
            <h1 style={styles.question}>Geräte anschließen</h1>

            {serialDevices === null && <div style={styles.hint}>Geräte werden geprüft...</div>}

            {serialDevices?.length === 0 && (
              <div style={styles.warning}>
                Es ist noch kein Gerät eingerichtet. Geräte und die Zuordnung der
                Kanäle zu den Sensoren werden in den Einstellungen angelegt —
                dafür muss die Maschine angeschlossen und eingeschaltet sein.
              </div>
            )}

            {serialDevices && serialDevices.length > 0 && (
              <div style={styles.deviceList}>
                {serialDevices.map((d) => (
                  <div key={d.deviceId} style={styles.deviceRow}>
                    <span
                      style={{
                        ...styles.deviceDot,
                        backgroundColor: d.connected
                          ? 'var(--color-success)'
                          : 'var(--color-danger)',
                      }}
                    />
                    <span style={styles.deviceLabel}>{d.label}</span>
                    <span style={styles.deviceState}>
                      {d.connected ? 'Verbunden' : 'Nicht verbunden'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div style={styles.hint}>
              Die Kanalzuordnung — welcher Messwert zu welchem Sensor gehört —
              erfolgt in den Einstellungen. Am einfachsten ist das, während die
              Maschine läuft: dann sind die Werte an ihrer Bewegung zu erkennen.
            </div>

            <div style={styles.doneActions}>
              <button onClick={() => goto('transport')} style={styles.secondaryButton}>
                Zurück
              </button>
              <button onClick={() => { onFinish(); navigate('config'); }} style={styles.confirmButton}>
                Einstellungen öffnen
              </button>
              <button onClick={() => goto('done')} style={styles.secondaryButton}>
                Weiter
              </button>
            </div>
          </>
        )}

        {step === 'verbindung' && (
          <>
            <h1 style={styles.question}>API-Zugang einrichten</h1>
            <VerbindungConfig config={config} />
            <div style={styles.doneActions}>
              <button onClick={() => goto(transport!)} style={styles.secondaryButton}>
                Zurück
              </button>
              <button onClick={() => goto('done')} style={styles.secondaryButton}>
                {hasApiKey ? 'Weiter' : 'Überspringen'}
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <h1 style={styles.question}>Verfahren festgelegt</h1>
            <div style={styles.doneBox}>
              <div style={styles.doneRow}>
                <span style={styles.doneCheck}>✓</span>
                <span>Verfahren: <strong>{selectedLabel}</strong></span>
              </div>
              <div style={styles.doneRow}>
                <span style={transportDone ? styles.doneCheck : styles.doneOpen}>
                  {transportDone ? '✓' : '!'}
                </span>
                <span>
                  {transport === 'mqtt' && (mqttSaved
                    ? <>Datenquelle: <strong>{brokerUrl}</strong></>
                    : 'MQTT-Box noch nicht eingerichtet — ohne sie kommen keine Messwerte an')}
                  {transport === 'serial' && (transportDone
                    ? <>Datenquelle: <strong>Serielle Verbindung</strong> ({serialDevices?.length} Gerät(e))</>
                    : 'Noch kein serielles Gerät eingerichtet — ohne Gerät kommen keine Messwerte an')}
                  {transport === null && 'Datenquelle noch nicht gewählt'}
                </span>
              </div>
              <div style={styles.doneRow}>
                <span style={hasApiKey ? styles.doneCheck : styles.doneOpen}>
                  {hasApiKey ? '✓' : '!'}
                </span>
                <span>
                  {hasApiKey
                    ? 'API-Zugang eingerichtet'
                    : 'API-Zugang fehlt noch — ohne ihn können keine Daten hochgeladen werden'}
                </span>
              </div>
            </div>

            <div style={styles.hint}>
              Alle weiteren Einstellungen — API-Zugang, Datenquelle und
              Sensorzuordnung — lassen sich jederzeit in den Einstellungen
              ändern.
            </div>

            <div style={styles.doneActions}>
              <button
                onClick={() => { onFinish(); navigate('config'); }}
                style={styles.confirmButton}
              >
                Einstellungen öffnen
              </button>
              <button
                onClick={() => { onFinish(); navigate(''); }}
                style={styles.secondaryButton}
              >
                Zur Anwendung
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'var(--surface-1)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-body)',
    overflow: 'hidden',
  },
  header: {
    padding: 'var(--space-md) var(--space-xl)',
    backgroundColor: 'var(--surface-0)',
    borderBottom: '2px solid var(--border)',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-md)',
  },
  exitButton: {
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-lg)',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-3)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
  },
  headerTitle: {
    fontSize: 'var(--font-lg)',
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  headerStep: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
    marginTop: 'var(--space-xs)',
  },
  main: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 'var(--space-lg)',
    padding: 'var(--space-xl)',
    maxWidth: '900px',
    width: '100%',
    margin: '0 auto',
  },
  question: {
    fontSize: 'var(--font-lg)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
    textAlign: 'center',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 'var(--space-md)',
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-xs)',
    minHeight: 'var(--tap-min)',
    padding: 'var(--space-lg)',
    fontSize: 'var(--font-md)',
    fontWeight: 600,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-2)',
    border: '3px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    cursor: 'pointer',
  },
  tileLocked: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-xs)',
    minHeight: 'var(--tap-min)',
    padding: 'var(--space-lg)',
    fontSize: 'var(--font-md)',
    fontWeight: 600,
    fontFamily: 'inherit',
    color: 'var(--text-muted)',
    backgroundColor: 'var(--surface-2)',
    border: '3px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    cursor: 'default',
  },
  tileSelected: {
    minHeight: 'var(--tap-min)',
    padding: 'var(--space-lg)',
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-4)',
    border: '3px solid var(--color-accent)',
    borderRadius: 'var(--radius-lg)',
    cursor: 'pointer',
  },
  warning: {
    padding: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    lineHeight: 1.4,
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-3)',
    borderLeft: '6px solid var(--color-warning)',
    borderRadius: 'var(--radius-sm)',
  },
  error: {
    padding: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    lineHeight: 1.4,
    color: 'var(--text-primary)',
    backgroundColor: 'var(--color-danger-muted)',
    borderRadius: 'var(--radius-sm)',
  },
  confirmButton: {
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-xl)',
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--color-accent)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
  },
  confirmButtonDisabled: {
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-xl)',
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    fontFamily: 'inherit',
    color: 'var(--text-muted)',
    backgroundColor: 'var(--surface-3)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'default',
  },
  secondaryButton: {
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-xl)',
    fontSize: 'var(--font-md)',
    fontWeight: 600,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-3)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
  },
  doneBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-md)',
    padding: 'var(--space-lg)',
    backgroundColor: 'var(--surface-2)',
    borderRadius: 'var(--radius-lg)',
  },
  doneRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    color: 'var(--text-primary)',
  },
  doneCheck: {
    flexShrink: 0,
    width: '2.5rem',
    height: '2.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    backgroundColor: 'var(--color-success)',
    color: '#fff',
    fontWeight: 700,
  },
  doneOpen: {
    flexShrink: 0,
    width: '2.5rem',
    height: '2.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    backgroundColor: 'var(--color-warning)',
    color: '#fff',
    fontWeight: 700,
  },
  hint: {
    fontSize: 'var(--font-base)',
    lineHeight: 1.4,
    color: 'var(--text-muted)',
  },
  doneActions: {
    display: 'flex',
    gap: 'var(--space-md)',
  },
  tileHint: {
    fontSize: 'var(--font-sm)',
    fontWeight: 400,
    color: 'var(--text-muted)',
  },
  deviceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
  },
  deviceRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
    minHeight: 'var(--tap-sm)',
    padding: '0 var(--space-md)',
    backgroundColor: 'var(--surface-2)',
    borderRadius: 'var(--radius-md)',
  },
  deviceDot: {
    flexShrink: 0,
    width: '1rem',
    height: '1rem',
    borderRadius: '50%',
  },
  deviceLabel: {
    flex: 1,
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  deviceState: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
  },
};
