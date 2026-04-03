import { useWebSocket } from './hooks/useWebSocket';
import { useHashRouter } from './hooks/useHashRouter';
import { useConfig, useShiftAssignment } from './hooks/useImplenia';
import { Header } from './components/Header';
import { UpdateBanner } from './components/UpdateBanner';
import { RecordingBar } from './components/RecordingBar';
import { ConfigPage } from './components/ConfigPage';
import { ShiftAssignment } from './components/ShiftAssignment';
import { ElementDetail } from './components/ElementDetail';

export function App() {
  const { readings, connectivity, recordingState, uploadProgress, updateAvailable, updateApplying } =
    useWebSocket();
  const route = useHashRouter();
  const config = useConfig();
  const shift = useShiftAssignment(config.hasApiKey);

  let content: React.ReactNode;
  let pageTitle: string | undefined;

  switch (route.page) {
    case 'config':
      content = <ConfigPage config={config} expandSection={route.query.section} />;
      pageTitle = 'Einstellungen';
      break;
    case 'element':
      content = (
        <ElementDetail
          elementName={route.params.name}
          readings={readings}
        />
      );
      pageTitle = route.params.name;
      break;
    default:
      content = <ShiftAssignment shift={shift} hasApiKey={config.hasApiKey} />;
      if (shift.data) {
        const [y, m, d] = shift.data.day_of_execution.split('-');
        pageTitle = `Schichtauftrag für ${d}.${m}.${y}`;
      }
      break;
  }

  return (
    <div style={styles.container}>
      <Header
        connectivity={connectivity}
        hasApiKey={config.hasApiKey}
        currentPage={route.page}
        pageTitle={pageTitle}
      />
      <UpdateBanner
        version={updateAvailable}
        applying={updateApplying}
      />
      <main style={{
        ...styles.main,
        ...(route.page === 'element' ? { overflow: 'hidden' } : {}),
      }}>
        {content}
      </main>
      <RecordingBar
        currentPage={route.page}
        elementName={route.params.name}
        recordingState={recordingState}
        uploadProgress={uploadProgress}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100vh',
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
    fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  main: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  },
};
