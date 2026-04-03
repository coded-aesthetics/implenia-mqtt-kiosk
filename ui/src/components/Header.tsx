import { useState, useEffect } from 'react';
import { navigate } from '../hooks/useHashRouter';
import logo from '../../assets/implenia-logo.png';

interface Props {
  connectivity: 'online' | 'offline' | 'unknown';
  hasApiKey: boolean;
  currentPage: string;
  pageTitle?: string;
}

export function Header({ connectivity, hasApiKey, currentPage, pageTitle }: Props) {
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
      {/* Left: logo + optional back button */}
      <div style={styles.leftSection}>
        {currentPage === 'element' && (
          <button
            onClick={() => navigate('/')}
            style={styles.backButton}
          >
            ←
          </button>
        )}
        <a
          href="#/"
          onClick={(e) => { e.preventDefault(); navigate('/'); }}
          style={styles.logoLink}
        >
          <img src={logo} alt="Implenia" style={styles.logo} />
        </a>
      </div>

      {/* Center: page title */}
      <div style={styles.centerSection}>
        {pageTitle && <span style={styles.pageTitle}>{pageTitle}</span>}
      </div>

      {/* Right: connectivity + version + settings */}
      <div style={styles.rightSection}>
        <span style={{ ...styles.dot, backgroundColor: connColor }} />
        <span style={styles.statusText}>{connLabel}</span>
        <span style={styles.divider} />
        <span style={styles.versionText}>v{version}</span>
        <a
          href="#/config"
          onClick={(e) => { e.preventDefault(); navigate('config'); }}
          style={{
            ...styles.settingsButton,
            ...(currentPage === 'config' ? styles.settingsActive : {}),
          }}
          aria-label="Einstellungen"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          {!hasApiKey && (
            <span style={styles.alertBadge}>!</span>
          )}
        </a>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.5rem 1.5rem',
    backgroundColor: '#0f0f23',
    borderBottom: '1px solid #2a2a4a',
    minHeight: '64px',
  },
  leftSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  backButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    fontSize: '1.5rem',
    fontWeight: 700,
    color: '#ffffff',
    backgroundColor: '#16213e',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: 'inherit',
  },
  logoLink: {
    display: 'flex',
    alignItems: 'center',
    textDecoration: 'none',
  },
  logo: {
    height: '80px',
    objectFit: 'contain' as const,
  },
  centerSection: {
    flex: 1,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pageTitle: {
    fontSize: '2.0rem',
    fontWeight: 600,
    color: '#eee',
    letterSpacing: '0.02em',
  },
  rightSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minHeight: '48px',
  },
  dot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
  },
  statusText: {
    fontSize: '0.95rem',
    color: '#aaaaaa',
  },
  divider: {
    width: '1px',
    height: '20px',
    backgroundColor: '#2a2a4a',
  },
  versionText: {
    fontSize: '0.9rem',
    color: '#aaaadd',
  },
  settingsButton: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    borderRadius: '8px',
    color: '#8899aa',
    textDecoration: 'none',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
  },
  settingsActive: {
    backgroundColor: '#1a1a3e',
    color: '#ffffff',
  },
  alertBadge: {
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    backgroundColor: '#f44336',
    color: '#ffffff',
    fontSize: '12px',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  },
};
