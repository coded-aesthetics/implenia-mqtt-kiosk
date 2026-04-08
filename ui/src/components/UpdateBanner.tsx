interface Props {
  version: string | null;
  applying: boolean;
}

export function UpdateBanner({ version, applying }: Props) {
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

  return (
    <div style={styles.banner}>
      <span style={styles.text}>
        Version {version} verfügbar.
      </span>
      <button
        style={styles.button}
        onClick={() => {
          fetch('/api/update', { method: 'POST' });
        }}
      >
        Installieren & neustarten
      </button>
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
