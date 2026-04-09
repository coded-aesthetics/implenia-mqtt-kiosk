import type { VoiceFeedback } from '../hooks/useVoiceCommands';

interface Props {
  feedback: VoiceFeedback;
}

export function VoiceFeedbackOverlay({ feedback }: Props) {
  if (!feedback) return null;

  let icon: string;
  let color: string;
  let primaryText: string;
  let secondaryText: string | null = null;

  switch (feedback.type) {
    case 'listening':
      icon = '\u{1F3A4}';
      color = '#1976d2';
      primaryText = 'Ich höre zu\u2026';
      secondaryText = feedback.interim || null;
      break;
    case 'dictating':
      icon = '\u{1F4AC}';
      color = '#e6a700';
      primaryText = feedback.interim ? 'Kommentar\u2026' : 'Kommentar diktieren\u2026';
      secondaryText = feedback.interim || 'Sagen Sie "fertig" zum Beenden';
      break;
    case 'success':
      icon = '\u2713';
      color = '#4caf50';
      primaryText = feedback.description;
      secondaryText = feedback.transcript;
      break;
    case 'blocked':
      icon = '!';
      color = '#e65100';
      primaryText = feedback.reason;
      secondaryText = feedback.transcript;
      break;
    case 'no-match':
      icon = '?';
      color = '#e65100';
      primaryText = 'Nicht erkannt';
      secondaryText = feedback.transcript;
      break;
    case 'error':
      icon = '\u2717';
      color = '#f44336';
      primaryText = feedback.message;
      break;
  }

  return (
    <div style={styles.overlay}>
      <div style={{ ...styles.container, borderColor: color }}>
        <span style={{ ...styles.icon, color }}>{icon}</span>
        <div style={styles.textColumn}>
          <span style={styles.primary}>{primaryText}</span>
          {secondaryText && (
            <span style={styles.secondary}>&laquo;{secondaryText}&raquo;</span>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 72,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 1000,
    pointerEvents: 'none',
  },
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem 1.25rem',
    backgroundColor: '#0f0f23ee',
    borderRadius: '12px',
    border: '2px solid',
    minWidth: '220px',
    maxWidth: '500px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
  },
  icon: {
    fontSize: '1.5rem',
    fontWeight: 700,
    flexShrink: 0,
    width: '2rem',
    textAlign: 'center' as const,
  },
  textColumn: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.2rem',
    minWidth: 0,
  },
  primary: {
    fontSize: '1.1rem',
    fontWeight: 600,
    color: '#ffffff',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  secondary: {
    fontSize: '0.85rem',
    color: '#8899aa',
    fontStyle: 'italic' as const,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
};
