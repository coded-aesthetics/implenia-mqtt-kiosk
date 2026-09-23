import { useState } from 'react';
import type { UpdateSource } from '../hooks/useWebSocket';

interface Props {
  version: string | null;
  source: UpdateSource | null;
  applying: boolean;
  /** Installing restarts the app, so it waits until the element is finished. */
  recordingActive: boolean;
}

export function UpdateBanner({ version, source, applying, recordingActive }: Props) {
  const [error, setError] = useState<string | null>(null);

  if (import.meta.env.DEV) return null;
  if (!version && !applying) return null;

  if (applying) {
    return (
      <div style={{ ...styles.banner, backgroundColor: '#1565c0' }}>
        <span style={styles.text}>
          Update wird installiert... Die App startet gleich neu.
        </span>
      </div>
    );
  }

  const sourceLabel = source === 'usb' ? ' (USB)' : '';

  async function install() {
    setError(null);
    try {
      const res = await fetch('/api/update', { method: 'POST' });
      // The server refuses while a recording is running. Showing its reason
      // beats a button that silently does nothing.
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Das Update konnte nicht gestartet werden (Fehler ${res.status}).`);
      }
    } catch {
      setError('Das Update konnte nicht gestartet werden. Bitte erneut versuchen.');
    }
  }

  return (
    <div style={styles.banner}>
      <span style={styles.text}>
        Version {version} verfügbar{sourceLabel}.
      </span>
      {/* Never offered mid-element: installing restarts the app, which would
          punch a hole of missing measurements into the running recording. */}
      {recordingActive ? (
        <span style={styles.text}>
          Wird nach dem Beenden der Aufzeichnung installiert.
        </span>
      ) : (
        <button style={styles.button} onClick={install}>
          Installieren &amp; neustarten
        </button>
      )}
      {error && <span style={styles.text}>{error}</span>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  banner: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '1rem',
    padding: '0.75rem 1.5rem',
    backgroundColor: '#e65100',
    color: '#ffffff',
    flexWrap: 'wrap',
  },
  text: {
    fontSize: '1rem',
    fontWeight: 500,
  },
  button: {
    padding: '0.5rem 1.5rem',
    fontSize: '1rem',
    fontWeight: 600,
    backgroundColor: '#ffffff',
    color: '#e65100',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    minWidth: '64px',
    minHeight: '48px',
  },
};
