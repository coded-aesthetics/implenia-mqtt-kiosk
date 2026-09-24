import { RohrwechselSettings } from './RohrwechselSettings';

export function RohrverlaengerungPage() {
  return (
    <div style={styles.container}>
      <RohrwechselSettings />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 'var(--space-xl)',
    maxWidth: '640px',
    margin: '0 auto',
    width: '100%',
    boxSizing: 'border-box',
  },
};
