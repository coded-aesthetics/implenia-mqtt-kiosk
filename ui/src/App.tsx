import { useState, useMemo, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useHashRouter, navigate } from './hooks/useHashRouter';
import { useConfig, useShiftAssignment, useActiveVerfahren } from './hooks/useImplenia';
import { useVoiceCommands } from './hooks/useVoiceCommands';
import { Header } from './components/Header';
import { UpdateBanner } from './components/UpdateBanner';
import { RecordingBar } from './components/RecordingBar';
import { ConfigPage } from './components/ConfigPage';
import { ShiftAssignment } from './components/ShiftAssignment';
import { ElementDetail } from './components/ElementDetail';
import { VoiceFeedbackOverlay } from './components/VoiceFeedbackOverlay';
import { CommentQueuePage } from './components/CommentQueuePage';
import { SetupWizard } from './components/SetupWizard';
import { TopicAssignment } from './components/TopicAssignment';
import { CalibrationPage } from './components/CalibrationPage';
import { resolveScreen, needsSetupRedirect } from './setupGate';
import { useCommentQueue } from './hooks/useCommentQueue';
import type { ViewTab } from './components/ElementDetail';

export function App() {
  const { readings, deviceFrames, connectivity, recordingState, uploadProgress, updateAvailable, updateSource, updateApplying, replaySeeking } =
    useWebSocket();
  const route = useHashRouter();
  const config = useConfig();
  const setup = useActiveVerfahren();
  const shift = useShiftAssignment(config.hasApiKey);
  const { importShift, clearImport } = shift;

  const [devMode, setDevMode] = useState(false);
  useEffect(() => {
    fetch('/status').then((r) => r.json()).then((d) => setDevMode(!!d.devMode)).catch(() => {});
  }, []);

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

  // The wizard is a route, so its visibility cannot be knocked out by the
  // state it writes. An unconfigured kiosk is redirected into it; from there
  // the URL is what decides, until the wizard navigates away itself.
  const gate = {
    onSetupRoute: route.page === 'setup',
    settled: !setup.loading,
    hasError: setup.error !== null,
    verfahren: setup.verfahren,
  };
  const screen = resolveScreen(gate);

  useEffect(() => {
    if (needsSetupRedirect(gate)) navigate('setup');
  }, [gate.onSetupRoute, gate.settled, gate.hasError, gate.verfahren]);

  // Comment queue (background whisper transcription + API posting)
  const commentQueue = useCommentQueue();

  // Voice commands
  const voice = useVoiceCommands({
    route,
    recordingState,
    elementNames,
    setActiveTab,
    navigate,
    enqueueComment: commentQueue.enqueue,
  });

  // ── First-start gate ──────────────────────────────────────────────────
  // The Verfahren decides how every sensor is interpreted, so nothing else can
  // be shown until it is set. Deliberately checked before any other routing.
  if (screen === 'setup') {
    return (
      <SetupWizard
        step={route.params.step ?? 'verfahren'}
        onFinish={() => { setup.refetch(); navigate(''); }}
        hasApiKey={config.hasApiKey}
      />
    );
  }
  if (screen === 'error') {
    // State unknown (server unreachable) — never assume "not set up".
    return <div style={styles.gate}>{setup.error}</div>;
  }
  if (screen === 'checking') {
    return <div style={styles.gate}>Einrichtung wird geprüft...</div>;
  }

  let content: React.ReactNode;
  let pageTitle: string | undefined;

  switch (route.page) {
    case 'config': {
      content = (
        <ConfigPage
          config={config}
          devMode={devMode}
          deviceFrames={deviceFrames}
        />
      );
      pageTitle = 'Einstellungen';
      break;
    }
    case 'sensors': {
      content = <TopicAssignment />;
      pageTitle = 'Sensorzuordnung';
      break;
    }
    case 'calibration': {
      content = <CalibrationPage />;
      pageTitle = 'Kalibrierung';
      break;
    }
    case 'comments': {
      content = (
        <CommentQueuePage
          queue={commentQueue.queue}
          onEdit={commentQueue.editText}
          onDelete={commentQueue.deleteComment}
          onRetry={commentQueue.retry}
        />
      );
      pageTitle = 'Kommentare';
      break;
    }
    case 'element': {
      const deviceVorgaben = shift.data?.measuring_devices.find(
        (d) => d.name === route.params.name,
      )?.vorgaben ?? null;
      content = (
        <ElementDetail
          elementName={route.params.name}
          readings={readings}
          vorgaben={deviceVorgaben}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          commentQueue={commentQueue.queue}
          onCommentEdit={commentQueue.editText}
          onCommentDelete={commentQueue.deleteComment}
          onCommentRetry={commentQueue.retry}
        />
      );
      pageTitle = route.params.name;
      break;
    }
    default:
      content = <ShiftAssignment shift={shift} hasApiKey={config.hasApiKey} onImport={importShift} onClearImport={clearImport} />;
      if (shift.data) {
        pageTitle = 'Elemente';
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
        wakeWordPhase={voice.wakeWordPhase}
        onMicPress={voice.startListening}
        onMicRelease={voice.stopListening}
        commentQueueCount={commentQueue.pendingCount}
      />
      <VoiceFeedbackOverlay feedback={voice.feedback} />
      <UpdateBanner
        version={updateAvailable}
        source={updateSource}
        applying={updateApplying}
        recordingActive={recordingState.active}
      />
      {replaySeeking && (
        <div style={styles.seekingOverlay}>
          <div style={styles.seekingText}>Spule vor…</div>
        </div>
      )}
      <main style={{
        ...styles.main,
        ...(route.page === 'element' || route.page === 'sensors' || route.page === 'calibration'
          ? { overflow: 'hidden', display: 'flex', flexDirection: 'column' as const }
          : {}),
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
    backgroundColor: 'var(--surface-1)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-body)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  main: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  },
  gate: {
    height: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--space-xl)',
    textAlign: 'center',
    backgroundColor: 'var(--surface-1)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-body)',
    fontSize: 'var(--font-md)',
  },
  seekingOverlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
  },
  seekingText: {
    fontSize: '2rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
};
