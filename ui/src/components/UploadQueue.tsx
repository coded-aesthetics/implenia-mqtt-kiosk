import type { QueueStats } from '../hooks/useWebSocket';

interface Props {
  stats: QueueStats;
}

export function UploadQueue({ stats }: Props) {
  return (
    <div style={styles.bar}>
      <div style={styles.stat}>
        <span style={styles.count}>{stats.pending}</span>
        <span style={styles.label}>Pending</span>
      </div>
      <div style={styles.divider} />
      <div style={styles.stat}>
        <span style={{ ...styles.count, color: '#4caf50' }}>{stats.uploaded}</span>
        <span style={styles.label}>Uploaded</span>
      </div>
      <div style={styles.divider} />
      <div style={styles.stat}>
        <span style={{ ...styles.count, color: stats.failed > 0 ? '#f44336' : '#666688' }}>
          {stats.failed}
        </span>
        <span style={styles.label}>Failed</span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '1.5rem',
    padding: '0.75rem 1.5rem',
    backgroundColor: '#0f0f23',
    borderTop: '1px solid #2a2a4a',
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minWidth: '64px',
    minHeight: '48px',
    justifyContent: 'center',
  },
  count: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: '#cccccc',
  },
  label: {
    fontSize: '0.7rem',
    color: '#666688',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  divider: {
    width: '1px',
    height: '32px',
    backgroundColor: '#2a2a4a',
  },
};
