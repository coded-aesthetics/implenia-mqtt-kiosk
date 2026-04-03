import { useState, useEffect } from 'react';

interface Props {
  connectivity: 'online' | 'offline' | 'unknown';
  updateAvailable: string | null;
}

export function StatusBar({ connectivity, updateAvailable }: Props) {
  const [version, setVersion] = useState('...');

  useEffect(() => {
    fetch('/status')
      .then((r) => r.json())
      .then((data) => setVersion(data.version))
      .catch(() => {});
  }, []);
  const isOnline = connectivity === 'online';
  const connColor = isOnline ? '#4caf50' : connectivity === 'offline' ? '#f44336' : '#9e9e9e';
  const connLabel = connectivity === 'unknown' ? 'Verbinde...' : isOnline ? 'Verbunden' : 'Offline';

  return (
    <div style={styles.bar}>
      <div style={styles.section}>
        <span style={{ ...styles.dot, backgroundColor: connColor }} />
        <span style={styles.text}>{connLabel}</span>
      </div>

      <div style={styles.section}>
        <span style={styles.versionText}>v{version}</span>
        {updateAvailable && (
          <span style={styles.badge}>Update {updateAvailable}</span>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1.5rem',
    backgroundColor: '#0f0f23',
    borderBottom: '1px solid #2a2a4a',
    flexWrap: 'wrap',
    gap: '0.5rem',
    minHeight: '48px',
  },
  section: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    minHeight: '44px',
    minWidth: '64px',
  },
  dot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
  },
  text: {
    fontSize: '0.9rem',
    color: '#cccccc',
  },
  versionText: {
    fontSize: '0.8rem',
    color: '#aaaaee',
  },
  badge: {
    fontSize: '0.75rem',
    color: '#ffffff',
    backgroundColor: '#e65100',
    padding: '2px 8px',
    borderRadius: '10px',
    fontWeight: 600,
  },
};
