import { useEffect, useState } from 'react';
import type { ConfigState } from '../hooks/useImplenia';
import { navigate } from '../hooks/useHashRouter';

interface Props {
  config: ConfigState;
  updateAvailable: string | null;
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

export function ConfigHub({ config, updateAvailable }: Props) {
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
    </div>
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
