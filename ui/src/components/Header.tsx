import { useState, useEffect } from 'react';
import { navigate } from '../hooks/useHashRouter';
import type { OperatingMode } from '../hooks/useWebSocket';
import { PhaseStepper } from './PhaseStepper';
import logo from '../../assets/implenia-logo.png';

interface Props {
  connectivity: 'online' | 'offline' | 'unknown';
  hasApiKey: boolean;
  currentPage: string;
  configSection?: string;
  pageTitle?: string;
  voiceSupported?: boolean;
  isListening?: boolean;
  wakeWordPhase?: 'idle' | 'listening' | 'dictating';
  onMicPress?: () => void;
  onMicRelease?: () => void;
  commentQueueCount?: number;
  operatingMode?: OperatingMode | null;
  /**
   * Switch what the rig is doing. Omit to render the phase read-only.
   *
   * In the header because the control and the indicator for it belong together
   * — and in the *centre* rather than beside the icon cluster on the right: a
   * mis-tap here changes whether Klemmbacke readings are clipped out of the
   * upload, so it stays away from where hands already go for the mic and the
   * settings.
   */
  onModeChange?: (mode: OperatingMode) => void;
}

export function Header({ connectivity, hasApiKey, currentPage, configSection, pageTitle, voiceSupported, isListening, wakeWordPhase, onMicPress, onMicRelease, commentQueueCount, operatingMode, onModeChange }: Props) {
  const [version, setVersion] = useState('...');

  useEffect(() => {
    fetch('/status')
      .then((r) => r.json())
      .then((data) => setVersion(data.version))
      .catch(() => {});
  }, []);

  const isOnline = connectivity === 'online';
  const connColor = isOnline ? 'var(--color-success)' : connectivity === 'offline' ? 'var(--color-danger)' : 'var(--color-neutral)';
  const connLabel = connectivity === 'unknown' ? 'Verbinde...' : isOnline ? 'Verbunden' : 'Offline';

  return (
    <div style={styles.bar}>
      {/* Left: logo + optional back button */}
      <div style={styles.leftSection}>
        {(currentPage === 'element' || currentPage === 'bohren' || currentPage === 'comments' || !!configSection || currentPage === 'sensors' || currentPage === 'calibration' || currentPage === 'rohrverlaengerung') && (
          <button
            onClick={() => {
              if (configSection) navigate('config');
              else if (currentPage === 'sensors') navigate('config/datenquelle');
              else if (currentPage === 'calibration' || currentPage === 'rohrverlaengerung') navigate('config/messwerte');
              else navigate('/');
            }}
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

      {/* Center: page title + phase badge */}
      <div style={styles.centerSection}>
        {pageTitle && <span style={styles.pageTitle}>{pageTitle}</span>}
        {operatingMode && (currentPage === 'element' || currentPage === 'bohren') && (
          <PhaseStepper mode={operatingMode} onChange={onModeChange} />
        )}
      </div>

      {/* Right: connectivity + version + settings */}
      <div style={styles.rightSection}>
        <span style={{ ...styles.dot, backgroundColor: connColor }} />
        <span style={styles.statusText}>{connLabel}</span>
        <span style={styles.divider} />
        <span style={styles.versionText}>v{version}</span>
        {voiceSupported && (
          <button
            onPointerDown={onMicPress}
            onPointerUp={onMicRelease}
            onPointerLeave={onMicRelease}
            style={{
              ...styles.micButton,
              ...(isListening ? styles.micListening : {}),
              ...(wakeWordPhase === 'dictating' ? styles.micDictating : {}),
              ...(!isListening && !wakeWordPhase?.startsWith('dict') && wakeWordPhase === 'listening' ? styles.micPassive : {}),
            }}
            aria-label={isListening ? 'Spracherkennung aktiv' : wakeWordPhase === 'listening' ? 'Sagen Sie "Computer"' : 'Sprachbefehl'}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>
        )}
        {(commentQueueCount ?? 0) > 0 && (
          <button
            onClick={() => navigate('comments')}
            style={{
              ...styles.commentQueueButton,
              ...(currentPage === 'comments' ? styles.commentQueueActive : {}),
            }}
            aria-label={`${commentQueueCount} Kommentare`}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span style={styles.queueBadge}>{commentQueueCount}</span>
          </button>
        )}
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
    backgroundColor: 'var(--surface-0)',
    borderBottom: '1px solid var(--border)',
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
    lineHeight: 1,
    padding: 0,
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-2)',
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
    // 64, not 80: at 80 the logo alone pushed the bar to 96px — overriding its
    // own minHeight — and spent 12% of a 768px viewport on branding. 64 leaves
    // the header 80px tall, which is exactly a 64px tap target plus its padding.
    height: '64px',
    objectFit: 'contain' as const,
    borderRadius: '8px',
  },
  centerSection: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '0.75rem',
  },
  pageTitle: {
    // Element names are free text and the centre now shares its width with the
    // phase switch, so the title yields rather than pushing the switch off.
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '2.0rem',
    fontWeight: 600,
    color: 'var(--text-primary)',
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
    color: 'var(--text-muted)',
  },
  divider: {
    width: '1px',
    height: '20px',
    backgroundColor: 'var(--border)',
  },
  versionText: {
    fontSize: '0.9rem',
    color: 'var(--text-muted)',
  },
  settingsButton: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    borderRadius: '8px',
    color: 'var(--text-muted)',
    textDecoration: 'none',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
  },
  settingsActive: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
  },
  micButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    color: 'var(--text-muted)',
    backgroundColor: 'var(--surface-2)',
    border: '2px solid transparent',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'all 0.15s ease',
    fontFamily: 'inherit',
  },
  micListening: {
    color: 'var(--color-danger)',
    borderColor: 'var(--color-danger)',
    backgroundColor: 'var(--surface-0)',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  micPassive: {
    color: 'var(--color-accent)',
    borderColor: 'var(--color-accent)',
    backgroundColor: 'var(--surface-0)',
    animation: 'pulse 3s ease-in-out infinite',
  },
  micDictating: {
    color: 'var(--color-caution)',
    borderColor: 'var(--color-caution)',
    backgroundColor: 'var(--surface-0)',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  commentQueueButton: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    borderRadius: '8px',
    color: 'var(--color-caution)',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
  },
  commentQueueActive: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
  },
  queueBadge: {
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    minWidth: '18px',
    height: '18px',
    borderRadius: '9px',
    backgroundColor: 'var(--color-caution)',
    color: 'var(--text-primary)',
    fontSize: '11px',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    padding: '0 4px',
  },
  alertBadge: {
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    backgroundColor: 'var(--color-danger)',
    color: '#fff',
    fontSize: '12px',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  },
};
