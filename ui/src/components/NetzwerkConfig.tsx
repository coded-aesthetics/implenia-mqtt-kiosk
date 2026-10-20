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
    <div style={{ ...styles.container, ...netStyles.fill }}>
      <div style={{ ...styles.column, ...netStyles.leftColumn }}>
        {/* ── what this machine is on ─────────────────────────────────── */}
        <div style={styles.card}>
          <div style={{ ...styles.statusRow, marginBottom: 'var(--space-sm)' }}>
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

            Two lines, deliberately: this card also carries the connect
            controls in the setup wizard, where a third line clips them.
          */}
          {status?.routedElsewhere && (
            <div style={{ ...styles.blockedNotice, marginBottom: 0 }}>
              Netzwerkkabel („{status.defaultRouteDevice}") steckt: Die Implenia-Box ist
              nicht erreichbar. Bitte abziehen.
            </div>
          )}

          {unavailable && <div style={{ ...styles.blockedNotice, marginBottom: 0 }}>{unavailable}</div>}
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

      {/* ── the networks in range, and what the kiosk has to say ───────── */}
      {!unavailable && (
        <div style={{ ...styles.column, minHeight: 0 }}>
          <div style={{ ...styles.card, ...netStyles.listCard }}>
            <div style={styles.statusRow}>
              {/*
                The count, because the list's height is now whatever is left
                over and can land on a clean row boundary — which hides the
                half-cut row that used to be the only sign it scrolls. It also
                says the scan found something when the box is not among the
                first few.
              */}
              <span style={styles.label}>
                In Reichweite{networks.length > 0 ? ` (${networks.length})` : ''}
              </span>
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
                  {/*
                    Words, and no padlock.

                    The kiosk has no emoji font — U+1F512 is covered by none of
                    its 113 fonts, so the lock rendered as a tofu box. Nor is
                    one worth installing: a padlock small enough to sit in this
                    row is the kind of fine control CLAUDE.md rules out anyway.

                    Only the open network is marked. Every access point on a
                    site is secured, so that is the unremarkable case, and
                    whether a password is needed is answered by the field that
                    does or does not appear when the row is tapped.
                  */}
                  <span style={netStyles.rowMeta}>
                    {n.secured ? '' : 'offen · '}{n.signal} %
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/*
            Under the list, not under the button.
            
            It belongs to the Verbinden action, and sitting there is where it
            reads best — but the left column also carries the status card, and
            that card grows: a kiosk still on its network cable shows a
            three-line warning about it, which pushed the button below the fold
            on the real machine. Here the height is reserved out of the list's
            share instead, so nothing the status card does can move the button,
            and an arriving error does not resize the list either.
          */}
          <div style={{ ...styles.card, ...netStyles.messageCard, ...slotTone(message) }}>
            {message.kind === 'hint' ? HINT : message.text}
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
  /**
   * The screen lays itself out against the height it is given rather than
   * growing past it. `flex: 1` and not `height: 100%`, so it works in both
   * places it appears: on the config page it fills `main`, and in the setup
   * wizard it takes what is left after the step's continue button.
   */
  fill: {
    flex: 1,
    minHeight: 0,
    // Without an explicit row the grid sizes to its content and the right
    // column never learns how tall it is allowed to be.
    gridTemplateRows: 'minmax(0, 1fr)',
    alignItems: 'stretch',
  },
  /**
   * Bounded like the right one.
   *
   * Without this the column simply grows past the height the screen was given
   * and draws over whatever comes after it — in the setup wizard, over the
   * step's own continue button. It normally has slack; it runs out only on a
   * kiosk that is still showing the warning about its network cable, which is
   * exactly the state a machine is in while being set up on a bench.
   */
  leftColumn: {
    minHeight: 0,
    overflowY: 'auto',
  },
  listCard: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  messageCard: {
    /**
     * Five lines of --font-base at 1.4, as a fixed height and not a minimum.
     *
     * Fixed in both directions on purpose: a message that arrived and resized
     * the list would move the network rows under the finger reaching for one.
     * The server keeps every message it can send inside five lines — pinned by
     * a test — and the scroll is the backstop for the one piece of text it does
     * not write itself.
     */
    height: '7.7rem',
    flexShrink: 0,
    overflowY: 'auto',
    fontSize: 'var(--font-base)',
    lineHeight: 1.4,
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
    // Whatever is left after the card header and the message box. No fixed
    // height: the two places this screen appears give it different room, and
    // so does a kiosk that is showing a warning about its network cable.
    flex: 1,
    minHeight: 0,
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
