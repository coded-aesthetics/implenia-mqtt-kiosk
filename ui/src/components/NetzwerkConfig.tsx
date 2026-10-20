import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { configStyles as styles } from './configStyles';

/**
 * The WLAN screen.
 *
 * A kiosk is primed in the office and carried to a site, where it has to join
 * the Implenia MQTT box's access point — which is both the data source and the
 * internet uplink. This is the first thing service personnel touch on site, so
 * it is a top-level tile rather than buried under Verbindung.
 *
 * Three decisions worth keeping:
 *
 * **No field for the network name.** Only networks the machine can actually see
 * are offered. Typing an SSID with gloves on is how a kiosk ends up on a
 * network that does not exist, and the list answers "does it exist" for free.
 *
 * **The message slot is reserved.** It holds the explanation of what Verbinden
 * does when there is nothing to report, and the result when there is, so a
 * three-line error cannot reflow the card out from under the finger that is
 * about to tap it. No auto-dismiss: on a site a stale message costs nothing and
 * one the technician never saw costs a call.
 *
 * **Connecting does not block the screen.** It takes up to half a minute, and
 * the server survives it either way — the browser talks to the server over
 * localhost, so the switch cannot cut the connection this screen is using.
 */

interface WifiNetwork {
  ssid: string;
  signal: number;
  secured: boolean;
  active: boolean;
}

interface NetworkStatus {
  hostname: string;
  capability: { available: true; iface: string } | { available: false; reason: string };
  ssid: string | null;
  signal: number | null;
  defaultRouteDevice: string | null;
  routedElsewhere: boolean;
}

type Message =
  | { kind: 'hint' }
  | { kind: 'busy'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'success'; text: string };

const HINT =
  'Nach dem Verbinden prüft der Kiosk, ob die Implenia-Box erreichbar ist. ' +
  'Schlägt das fehl, wird das bisherige WLAN wiederhergestellt.';

/** Words, not bars: a signal icon small enough to fit is too small to read. */
function strength(signal: number): string {
  if (signal >= 70) return 'stark';
  if (signal >= 45) return 'mittel';
  return 'schwach';
}

interface Props {
  /**
   * Called with the SSID after a successful switch, and with `null` when the
   * screen first learns the machine is on nothing. Only the setup wizard uses
   * it, to word its continue button; the screen itself needs no parent.
   */
  onConnected?: (ssid: string | null) => void;
}

export function NetzwerkConfig({ onConnected }: Props = {}) {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [scanning, setScanning] = useState(true);
  const [selected, setSelected] = useState<WifiNetwork | null>(null);
  const [psk, setPsk] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState<Message>({ kind: 'hint' });

  const loadStatus = useCallback(async () => {
    try {
      const next = await (await fetch('/api/config/netzwerk')).json() as NetworkStatus;
      setStatus(next);
      onConnected?.(next.ssid);
    } catch {
      // The screen degrades to the list alone rather than showing an error for
      // something the technician cannot act on.
    }
  }, [onConnected]);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const data = await (await fetch('/api/config/netzwerk/scan')).json() as { networks: WifiNetwork[] };
      setNetworks(data.networks ?? []);
    } catch {
      setNetworks([]);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    scan();
  }, [loadStatus, scan]);

  function choose(network: WifiNetwork): void {
    if (connecting) return;
    setSelected(network);
    setPsk('');
    setMessage({ kind: 'hint' });
  }

  async function connect(): Promise<void> {
    if (!selected || connecting) return;
    setConnecting(true);
    setMessage({ kind: 'busy', text: `Verbinde mit „${selected.ssid}" — das kann bis zu einer halben Minute dauern.` });
    try {
      const res = await fetch('/api/config/netzwerk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid: selected.ssid, psk }),
      });
      const data = await res.json() as { error?: string; internet?: boolean };
      if (!res.ok) {
        setMessage({ kind: 'error', text: data.error ?? 'Die Verbindung ist fehlgeschlagen.' });
      } else {
        setMessage({
          kind: 'success',
          text:
            `Verbunden mit „${selected.ssid}". Die Implenia-Box antwortet.` +
            (data.internet
              ? ' Internet ist verfügbar.'
              : ' Noch kein Internet — Messwerte werden gespeichert und später hochgeladen.'),
        });
        setSelected(null);
        setPsk('');
      }
    } catch {
      setMessage({
        kind: 'error',
        text:
          'Die Netzwerkeinstellung konnte nicht erreicht werden. Bitte den Kiosk neu starten ' +
          'und es erneut versuchen.',
      });
    } finally {
      setConnecting(false);
      loadStatus();
      scan();
    }
  }

  const unavailable = status && !status.capability.available ? status.capability.reason : null;

  return (
    <div style={styles.container}>
      <div style={styles.column}>
        {/* ── what this machine is on ─────────────────────────────────── */}
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>WLAN</span>
            {status && (
              <span
                style={{
                  ...styles.statusBadge,
                  backgroundColor: status.ssid ? 'var(--color-success)' : 'var(--color-warning)',
                  color: '#fff',
                }}
              >
                {status.ssid ? 'Verbunden' : 'Nicht verbunden'}
              </span>
            )}
          </div>

          {/*
            One row rather than a heading and a paragraph: the left column has
            to hold this card, the password field and a five-line message slot
            above the recording bar, and a wrapped SSID costs a whole line.
          */}
          <div style={netStyles.currentRow}>
            <span style={netStyles.currentSsid}>{status?.ssid ?? 'Kein WLAN verbunden'}</span>
            {status?.signal !== null && status?.signal !== undefined && (
              <span style={styles.label}>{strength(status.signal)} · {status.signal} %</span>
            )}
          </div>

          {/*
            Which machine these settings belong to. Today the server and the
            touchscreen are the same box, so this is the machine the technician
            is standing in front of — but it is the server's network that
            changes, and saying so costs one line.
          */}
          {status && (
            <div style={netStyles.hostLine}>Gerät: {status.hostname}</div>
          )}

          {/*
            The office trap: with a network cable plugged in, the wired
            connection wins and the Implenia-Box is unreachable even though the
            WLAN is up and this card says "Verbunden".
          */}
          {status?.routedElsewhere && (
            <div style={styles.blockedNotice}>
              Der Datenverkehr läuft derzeit über „{status.defaultRouteDevice}", nicht über das
              WLAN. Solange das Netzwerkkabel steckt, ist die Implenia-Box nicht erreichbar.
              Bitte das Kabel abziehen.
            </div>
          )}

          {unavailable && <div style={styles.blockedNotice}>{unavailable}</div>}
        </div>

        {/* ── the action ──────────────────────────────────────────────── */}
        {!unavailable && (
          <div style={styles.card}>
            <div style={styles.statusRow}>
              <span style={styles.label}>
                {selected ? `Verbinden mit „${selected.ssid}"` : 'Netzwerk wählen'}
              </span>
            </div>

            {selected?.secured && (
              <input
                type="password"
                value={psk}
                onChange={(e) => setPsk(e.target.value)}
                placeholder="WLAN-Passwort"
                autoComplete="off"
                style={styles.input}
              />
            )}

            {/*
              Reserved: the box is here whether or not there is something to
              report, so a three-line failure cannot push the button away from
              the finger about to tap it.
            */}
            <div style={{ ...netStyles.messageSlot, ...slotTone(message) }}>
              {message.kind === 'hint' ? HINT : message.text}
            </div>

            <div style={styles.buttonRow}>
              <button
                onClick={connect}
                disabled={!selected || connecting}
                style={{
                  ...styles.button,
                  ...styles.saveButton,
                  opacity: !selected || connecting ? 0.5 : 1,
                }}
              >
                {connecting ? 'Verbinde …' : 'Verbinden'}
              </button>
              {selected && !connecting && (
                <button
                  onClick={() => { setSelected(null); setPsk(''); setMessage({ kind: 'hint' }); }}
                  style={{ ...styles.button, backgroundColor: 'var(--surface-3)', color: 'var(--text-primary)' }}
                >
                  Abbrechen
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── the networks in range ──────────────────────────────────────── */}
      {!unavailable && (
        <div style={styles.column}>
          <div style={styles.card}>
            <div style={styles.statusRow}>
              <span style={styles.label}>In Reichweite</span>
              <button
                onClick={scan}
                disabled={scanning || connecting}
                style={{
                  ...styles.button,
                  backgroundColor: 'var(--surface-3)',
                  color: 'var(--text-primary)',
                  opacity: scanning || connecting ? 0.5 : 1,
                }}
              >
                {scanning ? 'Suche …' : 'Neu suchen'}
              </button>
            </div>

            {networks.length === 0 && !scanning && (
              <div style={styles.blockedNotice}>
                Kein WLAN gefunden. Bitte prüfen, ob die Implenia-Box eingeschaltet ist, und
                dann „Neu suchen" antippen.
              </div>
            )}

            {/*
              The only scrolling surface on this screen, and bounded on purpose:
              a site can see a dozen networks, and the alternative to a scrolling
              list is a list that hides the networks below the fold without
              saying so.
            */}
            <div style={netStyles.list}>
              {networks.map((n) => (
                <button
                  key={n.ssid}
                  onClick={() => choose(n)}
                  style={{
                    ...netStyles.row,
                    ...(selected?.ssid === n.ssid ? netStyles.rowSelected : {}),
                  }}
                >
                  <span style={netStyles.rowName}>
                    {n.ssid}
                    {n.active && <span style={netStyles.rowActive}>aktuell</span>}
                  </span>
                  <span style={netStyles.rowMeta}>
                    {n.secured ? '🔒' : 'offen'} {n.signal} %
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function slotTone(message: Message): CSSProperties {
  switch (message.kind) {
    case 'error':
      return { borderLeftColor: 'var(--color-danger)', color: 'var(--text-primary)' };
    case 'success':
      return { borderLeftColor: 'var(--color-success)', color: 'var(--text-primary)' };
    case 'busy':
      return { borderLeftColor: 'var(--color-accent)', color: 'var(--text-primary)' };
    default:
      return { borderLeftColor: 'var(--border)', color: 'var(--text-muted)' };
  }
}

const netStyles: Record<string, CSSProperties> = {
  messageSlot: {
    /**
     * Five lines of --font-base at 1.4, as a fixed height and not a minimum.
     *
     * A minimum still grows, and the left column has about twenty pixels of
     * slack above the recording bar — so a long failure would have pushed the
     * Verbinden button underneath the bar, on the one screen whose whole job is
     * recovering from a failure. The server keeps its messages inside this; the
     * scroll is the backstop for the one message it does not write itself.
     */
    height: '7.7rem',
    overflowY: 'auto',
    fontSize: 'var(--font-base)',
    lineHeight: 1.4,
    padding: 'var(--space-md)',
    marginTop: 'var(--space-md)',
    backgroundColor: 'var(--surface-0)',
    borderRadius: 'var(--radius-md)',
    borderLeft: '3px solid var(--border)',
    boxSizing: 'border-box',
  },
  currentRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 'var(--space-md)',
    paddingBottom: 'var(--space-sm)',
  },
  currentSsid: {
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  hostLine: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
    /**
     * About four and a half rows, which is what the taller of the two places
     * this screen appears can give it: embedded in the setup wizard, a list
     * this tall already puts the step's continue button at the very bottom of
     * a 768px display. A site sees one to three networks.
     */
    maxHeight: '336px',
    overflowY: 'auto',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-md)',
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-md)',
    backgroundColor: 'var(--surface-0)',
    border: '3px solid transparent',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    flexShrink: 0,
  },
  rowSelected: {
    borderColor: 'var(--color-accent)',
    backgroundColor: 'var(--surface-3)',
  },
  rowName: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowActive: {
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    color: '#fff',
    backgroundColor: 'var(--color-success)',
    borderRadius: 'var(--radius-lg)',
    padding: '2px 10px',
    flexShrink: 0,
  },
  rowMeta: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
};
