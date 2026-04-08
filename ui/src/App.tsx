import { useState, useMemo, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useHashRouter, navigate } from './hooks/useHashRouter';
import { useConfig, useShiftAssignment } from './hooks/useImplenia';
import { useVoiceCommands } from './hooks/useVoiceCommands';
import { Header } from './components/Header';
import { UpdateBanner } from './components/UpdateBanner';
import { RecordingBar } from './components/RecordingBar';
import { ConfigPage } from './components/ConfigPage';
import { ShiftAssignment } from './components/ShiftAssignment';
import { ElementDetail } from './components/ElementDetail';
import { VoiceFeedbackOverlay } from './components/VoiceFeedbackOverlay';
import type { ViewTab } from './components/ElementDetail';

export function App() {
  const { readings, connectivity, recordingState, uploadProgress, updateAvailable, updateApplying } =
    useWebSocket();
  const route = useHashRouter();
  const config = useConfig();
  const shift = useShiftAssignment(config.hasApiKey);

  // Lifted tab state for ElementDetail (so voice commands can control it)
  const [activeTab, setActiveTab] = useState<ViewTab>('messwerte');

  // Reset tab when navigating to a different element
  useEffect(() => {
    setActiveTab('messwerte');
  }, [route.params.name]);

  // Element names for voice command vocabulary
  const elementNames = useMemo(
    () => shift.data?.measuring_devices.map((d) => d.name) ?? [],
    [shift.data],
  );

  // Voice commands
  const voice = useVoiceCommands({
    route,
    recordingState,
    elementNames,
    setActiveTab,
    navigate,
  });

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
          activeTab={activeTab}
          setActiveTab={setActiveTab}
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
        voiceSupported={voice.isSupported}
        isListening={voice.isListening}
        onMicPress={voice.startListening}
        onMicRelease={voice.stopListening}
      />
      <VoiceFeedbackOverlay feedback={voice.feedback} />
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
