import { useRef, useState } from 'react';
import { navigate } from '../hooks/useHashRouter';
import type { ShiftAssignmentState } from '../hooks/useImplenia';

interface Props {
  shift: ShiftAssignmentState;
  hasApiKey: boolean;
  onImport: (file: File) => Promise<{ ok: boolean; error?: string }>;
  onClearImport: () => Promise<void>;
}

function ImportButton({ onImport }: { onImport: Props['onImport'] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setError(null);
    const result = await onImport(file);
    if (!result.ok) setError(result.error ?? 'Import fehlgeschlagen');
    setImporting(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
      <input
        ref={fileRef}
        type="file"
        accept=".json"
        onChange={handleFile}
        style={{ display: 'none' }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={importing}
        style={styles.importButton}
      >
        {importing ? 'Wird importiert...' : 'Schichtauftrag importieren'}
      </button>
      {error && <div style={styles.importError}>{error}</div>}
    </div>
  );
}

function ImportBadge({ onClear }: { onClear: () => Promise<void> }) {
  return (
    <div style={styles.importBadge}>
      <span style={styles.importBadgeText}>Importiert aus Datei</span>
      <button onClick={onClear} style={styles.clearButton}>
        Zurücksetzen
      </button>
    </div>
  );
}

export function ShiftAssignment({ shift, hasApiKey, onImport, onClearImport }: Props) {
  const isImported = shift.source === 'import';

  if (!hasApiKey && !isImported && !shift.loading) {
    return (
      <div style={styles.center}>
        <div style={styles.notice}>
          <div style={styles.noticeIcon}>!</div>
          <div style={styles.noticeText}>Kein API-Schlüssel konfiguriert</div>
          <a
            href="#/config"
            onClick={(e) => { e.preventDefault(); navigate('config'); }}
            style={styles.configLink}
          >
            Einstellungen
          </a>
          <div style={styles.divider}>oder</div>
          <ImportButton onImport={onImport} />
        </div>
      </div>
    );
  }

  if (shift.loading) {
    return (
      <div style={styles.center}>
        <div style={styles.loadingText}>Schichtauftrag wird geladen...</div>
      </div>
    );
  }

  if (shift.error && !isImported) {
    return (
      <div style={styles.center}>
        <div style={styles.notice}>
          <div style={{ ...styles.noticeIcon, backgroundColor: '#e65100' }}>⚠</div>
          <div style={styles.noticeText}>Verbindungsproblem</div>
          <div style={styles.noticeSubtext}>{shift.error}</div>
          <a
            href="#/config?section=api-url"
            onClick={(e) => { e.preventDefault(); navigate('config?section=api-url'); }}
            style={styles.configLink}
          >
            Einstellungen
          </a>
          <div style={styles.divider}>oder</div>
          <ImportButton onImport={onImport} />
        </div>
      </div>
    );
  }

  if (shift.notFound && !isImported) {
    const today = new Date().toLocaleDateString('de-DE', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    return (
      <div style={styles.center}>
        <div style={styles.notice}>
          <div style={{ ...styles.noticeIcon, backgroundColor: '#e65100' }}>⚠</div>
          <div style={styles.noticeText}>
            Kein Schichtauftrag für heute
          </div>
          <div style={styles.noticeSubtext}>
            Bitte erstellen Sie einen Schichtauftrag für {today} im Implenia-Portal.
          </div>
          <div style={styles.divider}>oder</div>
          <ImportButton onImport={onImport} />
        </div>
      </div>
    );
  }

  if (!shift.data || shift.data.measuring_devices.length === 0) {
    return (
      <div style={styles.center}>
        <div style={styles.notice}>
          <div style={styles.emptyText}>Keine Elemente in der Schichtzuordnung</div>
          <ImportButton onImport={onImport} />
        </div>
      </div>
    );
  }

  const { data } = shift;

  return (
    <div style={styles.tileContainer}>
      <div style={{ width: '100%', maxWidth: '900px' }}>
        {isImported && <ImportBadge onClear={onClearImport} />}
        <div style={styles.grid}>
          {data.measuring_devices.map((device) => (
            <button
              key={device.id}
              onClick={() => navigate(`element/${encodeURIComponent(device.name)}`)}
              style={styles.tile}
            >
              <div style={styles.tileName}>{device.name}</div>
            </button>
          ))}
        </div>
        {!isImported && (
          <div style={styles.importFooter}>
            <ImportButton onImport={onImport} />
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  tileContainer: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100%',
    padding: '1.5rem',
    boxSizing: 'border-box' as const,
  },
  center: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1,
    height: '100%',
  },
  notice: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '1rem',
  },
  noticeIcon: {
    width: '64px',
    height: '64px',
    borderRadius: '50%',
    backgroundColor: '#f44336',
    color: '#ffffff',
    fontSize: '2rem',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noticeText: {
    fontSize: '1.3rem',
    color: '#cccccc',
    fontWeight: 600,
  },
  noticeSubtext: {
    fontSize: '1rem',
    color: '#8899aa',
    textAlign: 'center' as const,
    maxWidth: '400px',
    lineHeight: 1.5,
  },
  configLink: {
    fontSize: '1.1rem',
    color: '#1976d2',
    textDecoration: 'none',
    padding: '0.75rem 2rem',
    borderRadius: '8px',
    backgroundColor: '#16213e',
    fontWeight: 600,
    minHeight: '56px',
    display: 'flex',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: '1.2rem',
    color: '#556677',
  },
  emptyText: {
    fontSize: '1.2rem',
    color: '#556677',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '1.5rem',
    width: '100%',
  },
  tile: {
    backgroundColor: '#324272',
    borderRadius: '12px',
    padding: '2rem',
    minHeight: '120px',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    cursor: 'pointer',
    border: '2px solid transparent',
    color: '#ffffff',
    textAlign: 'center' as const,
    minWidth: '64px',
    fontSize: 'inherit',
    fontFamily: 'inherit',
  },
  tileName: {
    fontSize: '2.5rem',
    fontWeight: 700,
  },
  divider: {
    fontSize: '1rem',
    color: '#556677',
    margin: '0.25rem 0',
  },
  importButton: {
    fontSize: '1.1rem',
    color: '#ffffff',
    backgroundColor: '#2e7d32',
    border: 'none',
    borderRadius: '8px',
    padding: '0.75rem 2rem',
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: '56px',
    minWidth: '64px',
    fontFamily: 'inherit',
  },
  importError: {
    fontSize: '0.95rem',
    color: '#f44336',
    maxWidth: '360px',
    textAlign: 'center' as const,
    lineHeight: 1.4,
  },
  importBadge: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    marginBottom: '1rem',
    padding: '0.5rem 1rem',
    backgroundColor: '#1b3a1b',
    borderRadius: '8px',
  },
  importBadgeText: {
    fontSize: '1rem',
    color: '#81c784',
    fontWeight: 600,
  },
  clearButton: {
    fontSize: '0.9rem',
    color: '#cccccc',
    backgroundColor: 'transparent',
    border: '1px solid #555555',
    borderRadius: '6px',
    padding: '0.4rem 1rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
    minHeight: '40px',
    minWidth: '64px',
  },
  importFooter: {
    display: 'flex',
    justifyContent: 'center',
    marginTop: '1.5rem',
  },
};
