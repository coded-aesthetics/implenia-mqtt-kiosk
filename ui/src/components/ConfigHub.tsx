import { useEffect, useState } from 'react';
import type { ConfigState } from '../hooks/useImplenia';
import { navigate } from '../hooks/useHashRouter';

interface Props {
  config: ConfigState;
  updateAvailable: string | null;
  /** Only to warn on the shutdown tile — nothing here is blocked by it. */
  recording: boolean;
}

interface TileStatus {
  color: string;
  summary: string;
}

type SectionKey = 'netzwerk' | 'verbindung' | 'datenquelle' | 'messwerte' | 'system';

/**
 * In the order a kiosk is set up on site. WLAN comes first because nothing
 * after it can be checked until the machine is on the Implenia box's network.
 */
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'netzwerk', label: 'WLAN' },
  { key: 'verbindung', label: 'Verbindung' },
  { key: 'datenquelle', label: 'Datenquelle' },
  { key: 'messwerte', label: 'Messwerte' },
  { key: 'system', label: 'System' },
];

export function ConfigHub({ config, updateAvailable, recording }: Props) {
  const [status, setStatus] = useState<Record<SectionKey, TileStatus>>({
    netzwerk: { color: 'var(--text-muted)', summary: '...' },
    verbindung: { color: 'var(--text-muted)', summary: '...' },
    datenquelle: { color: 'var(--text-muted)', summary: '...' },
    messwerte: { color: 'var(--text-muted)', summary: '...' },
    system: { color: 'var(--text-muted)', summary: '...' },
  });

  useEffect(() => {
    const controller = new AbortController();
    const s = controller.signal;

    const configP = fetch('/api/config', { signal: s }).then((r) => r.json()).catch(() => null);
    const validateP = fetch('/api/config/validate', { signal: s }).then((r) => r.json()).catch(() => null);
    const transportP = fetch('/api/config/transport', { signal: s }).then((r) => r.json()).catch(() => null);
    const rohrwechselP = fetch('/api/config/rohrwechsel', { signal: s }).then((r) => r.json()).catch(() => null);
    const calibrationP = fetch('/api/config/calibration', { signal: s }).then((r) => r.json()).catch(() => null);
    const netzwerkP = fetch('/api/config/netzwerk', { signal: s }).then((r) => r.json()).catch(() => null);

    Promise.all([configP, validateP, transportP, rohrwechselP, calibrationP, netzwerkP]).then(
      ([_cfg, validate, transport, rohrwechsel, calibration, netzwerk]) => {
        if (controller.signal.aborted) return;

        // WLAN. A machine that cannot set its own Wi-Fi is not a fault, so the
        // tile stays neutral and says so rather than going red — the wired
        // connection it has instead works perfectly well.
        // Whether the kiosk is on a WLAN comes first. Leading with the route
        // meant a machine on a network cable and no WLAN — the normal state of
        // one being prepared in the office — reported "Verkehr über enp1s0",
        // which answers a question nobody asked instead of the tile's own.
        let netzwerkTile: TileStatus;
        if (!netzwerk || netzwerk.capability?.available !== true) {
          netzwerkTile = { color: 'var(--text-muted)', summary: 'Nicht verfügbar' };
        } else if (!netzwerk.ssid) {
          netzwerkTile = { color: 'var(--color-warning)', summary: 'Nicht verbunden' };
        } else if (netzwerk.routedElsewhere) {
          netzwerkTile = {
            color: 'var(--color-warning)',
            summary: `${netzwerk.ssid} · Verkehr über ${netzwerk.defaultRouteDevice}`,
          };
        } else {
          netzwerkTile = { color: 'var(--color-success)', summary: netzwerk.ssid };
        }

        // Verbindung
        let verbindung: TileStatus;
        if (validate?.ok) {
          verbindung = {
            color: 'var(--color-success)',
            summary: validate.deviceName ? `Verbunden als „${validate.deviceName}"` : 'Verbunden',
          };
        } else if (config.hasApiKey) {
          verbindung = {
            color: 'var(--color-warning)',
            summary: validate?.error ?? 'Verbindungstest fehlgeschlagen',
          };
        } else {
          verbindung = { color: 'var(--color-danger)', summary: 'Nicht konfiguriert' };
        }

        // Datenquelle
        let datenquelle: TileStatus;
        if (transport?.configured) {
          datenquelle = {
            color: 'var(--color-success)',
            summary: transport.transport === 'serial' ? 'Serielle Verbindung (USB)' : 'MQTT-Box',
          };
        } else {
          datenquelle = { color: 'var(--color-warning)', summary: 'Nicht gewählt' };
        }

        // Messwerte
        const calibratedCount = calibration?.sensors?.filter(
          (s: { scale?: number; offset?: number }) => (s.scale != null && s.scale !== 1) || (s.offset != null && s.offset !== 0),
        ).length ?? 0;
        const rohrEnabled = rohrwechsel?.enabled === true;
        const parts: string[] = [];
        parts.push(`Rohrverlängerung: ${rohrEnabled ? 'Ein' : 'Aus'}`);
        if (calibratedCount > 0) parts.push(`${calibratedCount} Sensor${calibratedCount === 1 ? '' : 'en'} kalibriert`);
        const messwerte: TileStatus = {
          color: 'var(--color-accent)',
          summary: parts.join(', '),
        };

        // System
        const system: TileStatus = updateAvailable
          ? { color: 'var(--color-warning)', summary: `Update verfügbar: v${updateAvailable}` }
          : { color: 'var(--color-success)', summary: 'Aktuell' };

        setStatus({ netzwerk: netzwerkTile, verbindung, datenquelle, messwerte, system });
      },
    );

    return () => controller.abort();
  }, [config.hasApiKey, config.apiUrl, updateAvailable]);

  return (
    <div style={styles.container}>
      {SECTIONS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => navigate(`config/${key}`)}
          style={styles.tile}
        >
          <span style={{ ...styles.dot, backgroundColor: status[key].color }} />
          <span style={styles.tileLabel}>{label}</span>
          <span style={styles.tileSummary}>{status[key].summary}</span>
        </button>
      ))}
      <ShutdownTile recording={recording} />
    </div>
  );
}

type ShutdownPhase = 'idle' | 'pending' | 'sending';

/**
 * The sixth tile, and the only one that is not a way into a sub-screen.
 *
 * It exists because the alternative is the socket: the industry PC's own power
 * button sits behind the monitor, so a shift ends with somebody pulling the
 * plug — the unclean shutdown `~/.xsession` has to paper over on the next
 * start. Tap-to-confirm like every destructive control here, and it carries no
 * status dot: the five tiles beside it report a state, this one does something.
 *
 * It says how the machine comes back on, because on the first revision in the
 * field nothing brings it back by itself after a power cut (docs/kiosk-
 * provisioning.md). A worker who switches it off and cannot find the knob is
 * the dead end this screen must not create.
 *
 * Every line below is measured against the tile, which is **304x261** at
 * 1024x768 in a font wider than the kiosk's own: the longest state (the
 * warning under the idle text) needs 233px of it, and a failure message of
 * 190 characters needed 286 and grew the grid's second row off the bottom of
 * the screen. `server/src/power.ts` keeps its two messages short for that
 * reason, and the warning gives way to a failure rather than stacking under
 * it — a failure is the thing to act on, and both do not fit.
 */
function ShutdownTile({ recording }: { recording: boolean }) {
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [phase, setPhase] = useState<ShutdownPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/system/power', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { capability?: { available?: boolean; reason?: string } }) => {
        if (data.capability?.available === false) {
          setUnavailable(data.capability.reason ?? 'Dieses Gerät kann sich nicht selbst ausschalten.');
        }
      })
      // Optimistic on a failed read, deliberately: this call only spares the
      // operator a button that cannot work, and refusing to offer one because
      // a single GET did not come back would be the worse failure. A tap then
      // either switches the machine off or says in German why it did not.
      .catch(() => {});
    return () => controller.abort();
  }, []);

  async function doShutdown() {
    setError(null);
    setPhase('sending');
    try {
      const res = await fetch('/api/system/shutdown', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Das Ausschalten ist fehlgeschlagen. Bitte den Einschaltknopf am Gerät verwenden.');
        setPhase('idle');
      }
      // On success nothing more happens here: the screen goes dark within a
      // few seconds, and there is no state after that to render.
    } catch {
      // A rejected request is as much the success case as the failure one —
      // systemd starts stopping units while the reply is still in flight, so
      // the server can die before it is flushed. Staying in `sending` is the
      // honest answer; a machine that is not going down after all leaves the
      // screen up, and the operator can leave it and come back.
    }
  }

  if (unavailable) {
    return (
      <div style={{ ...styles.tile, ...styles.tileInert }}>
        <span style={styles.tileLabel}>Ausschalten</span>
        <span style={styles.tileSummary}>{unavailable}</span>
      </div>
    );
  }

  if (phase === 'sending') {
    return (
      <div style={{ ...styles.tile, ...styles.tileInert }}>
        <span style={styles.tileLabel}>Wird ausgeschaltet</span>
        <span style={styles.tileSummary}>Der Bildschirm wird jetzt dunkel.</span>
      </div>
    );
  }

  const pending = phase === 'pending';
  return (
    <button
      onClick={() => {
        if (pending) doShutdown();
        else {
          setError(null);
          setPhase('pending');
        }
      }}
      // Tapping anything else cancels, same as the other tap-to-confirm
      // controls — the confirmation must not survive a worker walking away.
      // Only out of `pending`: a stray blur must not turn „Wird ausgeschaltet"
      // back into an offer.
      onBlur={() => setPhase((p) => (p === 'pending' ? 'idle' : p))}
      style={{ ...styles.tile, ...(pending ? styles.tileDangerConfirm : styles.tileDanger) }}
    >
      <span style={{ ...styles.tileLabel, color: pending ? '#fff' : 'var(--color-danger)' }}>
        {pending ? 'Wirklich ausschalten?' : 'Ausschalten'}
      </span>
      {pending ? (
        <span style={{ ...styles.tileSummary, color: '#fff' }}>
          Zum Bestätigen noch einmal tippen.
        </span>
      ) : error ? (
        <span style={{ ...styles.tileSummary, color: 'var(--color-danger)' }}>{error}</span>
      ) : (
        <span style={styles.tileSummary}>Gerät herunterfahren. Einschalten nur am Gerät.</span>
      )}
      {!pending && !error && recording && (
        <span style={{ ...styles.tileSummary, color: 'var(--color-warning-text)' }}>
          Aufzeichnung läuft. Sie wird nach dem Einschalten fortgesetzt.
        </span>
      )}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gridTemplateRows: 'repeat(2, 1fr)',
    gap: 'var(--space-lg)',
    padding: 'var(--space-xl)',
    height: '100%',
    boxSizing: 'border-box',
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-md)',
    backgroundColor: 'var(--surface-2)',
    borderRadius: 'var(--radius-lg)',
    border: '3px solid var(--border)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: 'var(--space-lg)',
  },
  /* The shutdown tile's states, spread over `tile` so the sixth tile keeps the
     grid's shape. Danger styling as everywhere else: surface-3 under
     danger-red text, inverting to white on red once the tap has to be
     confirmed. */
  tileDanger: {
    backgroundColor: 'var(--surface-3)',
    border: '3px solid var(--color-danger)',
  },
  tileDangerConfirm: {
    backgroundColor: 'var(--color-danger)',
    border: '3px solid var(--color-danger)',
  },
  /* No tap target: the machine is on its way down, or it cannot do this. */
  tileInert: {
    cursor: 'default',
  },
  dot: {
    width: '1.5rem',
    height: '1.5rem',
    borderRadius: '50%',
    flexShrink: 0,
  },
  tileLabel: {
    fontSize: 'var(--font-lg)',
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  tileSummary: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
    textAlign: 'center',
    lineHeight: 1.3,
  },
};
