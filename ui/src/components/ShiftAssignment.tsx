import { navigate } from '../hooks/useHashRouter';
import type { ShiftAssignmentState } from '../hooks/useImplenia';

interface Props {
  shift: ShiftAssignmentState;
  hasApiKey: boolean;
}

export function ShiftAssignment({ shift, hasApiKey }: Props) {
  if (!hasApiKey) {
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

  if (shift.error) {
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
        </div>
      </div>
    );
  }

  if (shift.notFound) {
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
        </div>
      </div>
    );
  }

  if (!shift.data || shift.data.measuring_devices.length === 0) {
    return (
      <div style={styles.center}>
        <div style={styles.emptyText}>Keine Elemente in der Schichtzuordnung</div>
      </div>
    );
  }

  const { data } = shift;

  return (
    <div style={styles.tileContainer}>
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
  errorText: {
    fontSize: '1.1rem',
    color: '#f44336',
    maxWidth: '400px',
    textAlign: 'center' as const,
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
    maxWidth: '900px',
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
};
