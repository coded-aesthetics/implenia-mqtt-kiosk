import { useWebSocket } from './hooks/useWebSocket';
import { SensorDisplay } from './components/SensorDisplay';
import { StatusBar } from './components/StatusBar';
import { UpdateBanner } from './components/UpdateBanner';
import { UploadQueue } from './components/UploadQueue';

export function App() {
  const { readings, connectivity, queueStats, updateAvailable, updateApplying } =
    useWebSocket();

  return (
    <div style={styles.container}>
      <StatusBar
        connectivity={connectivity}
        queueStats={queueStats}
        updateAvailable={updateAvailable}
      />
      <UpdateBanner
        version={updateAvailable}
        applying={updateApplying}
      />
      <main style={styles.main}>
        <SensorDisplay readings={readings} />
      </main>
      <UploadQueue stats={queueStats} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
    fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
  main: {
    flex: 1,
    padding: '1rem',
    overflow: 'auto',
  },
};
