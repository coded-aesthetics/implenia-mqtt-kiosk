import { useState, useMemo, useEffect, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useHashRouter, navigate } from './hooks/useHashRouter';
import { useConfig, useShiftAssignment, useActiveVerfahren, useElementVorgaben } from './hooks/useImplenia';
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
import { RohrverlaengerungPage } from './components/RohrverlaengerungPage';
import { BohrenScreen, INJEKTIONSBOHREN_BOHREN } from './components/BohrenScreen';
import { GeologieBestaetigung } from './components/GeologieBestaetigung';
import { VerpressenScreen, INJEKTIONSBOHREN_VERPRESSEN } from './components/VerpressenScreen';
import { resolveScreen, needsSetupRedirect } from './setupGate';
import { useCommentQueue } from './hooks/useCommentQueue';
import { isVerpressenMode } from './utils/operating-mode';
import { GeologiePicker } from './components/GeologiePicker';
import { useGeologieErfassung } from './hooks/useGeologieErfassung';
import { buildSchichten, collectVorgabeEntries } from './utils/vorgaben';
import { buildSensorValues } from './utils/sensors';
import { formatNumber } from './utils/format';
import type { OperatingMode } from './hooks/useWebSocket';
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

  // Resolved here rather than in the switch below, because falling back to the
  // kiosk's vorgaben cache is a hook and the switch runs past early returns.
  const shiftVorgaben = useMemo(
    () => shift.data?.measuring_devices.find((d) => d.name === route.params.name)?.vorgaben ?? null,
    [shift.data, route.params.name],
  );
  const deviceVorgaben = useElementVorgaben(route.params.name ?? null, shiftVorgaben);

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

  /**
   * Switch what the rig is doing.
   *
   * Lives here because the control moved into the header, next to the state it
   * sets, while the request itself is session-scoped. No error surface: the
   * switch renders from `recordingState`, which the WebSocket keeps
   * authoritative, so a failed request simply leaves the segment where it was —
   * visibly a no-op the operator can repeat. The only failure the endpoint has
   * is "no session", and the switch is not shown without one.
   */
  const setOperatingMode = useCallback(async (mode: OperatingMode) => {
    try {
      await fetch('/api/recording/mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, sessionId: recordingState.sessionId }),
      });
    } catch {
      // See above: the switch is server-rendered, so nothing moved.
    }
  }, [recordingState.sessionId]);

  /**
   * Live geology entry, assembled here because two places need the same state:
   * the recording bar draws the buttons and the drilling profile marks the
   * boundary the suggestion refers to.
   *
   * The depth is the one awkward part. The write needs none — the server dates
   * the reading at its own latest depth reading — but the *suggestion* has to
   * know where the drill is, and the live depth is only reachable through the
   * drilling screen's sensor config. Where that config does not apply, the
   * buttons still work; only the pre-loaded answer is absent.
   */
  const vorgabeSchichten = useMemo(() => {
    const entries = collectVorgabeEntries(deviceVorgaben);
    return buildSchichten(entries)?.schichten ?? null;
  }, [deviceVorgaben]);

  const liveTiefe = useMemo(() => {
    if (setup.verfahren !== 'injektionsbohren') return null;
    return buildSensorValues(readings).get(INJEKTIONSBOHREN_BOHREN.depthSensor) ?? null;
  }, [readings, setup.verfahren]);

  const geologie = useGeologieErfassung({
    sessionId: recordingState.sessionId,
    active: recordingState.active,
    operatingMode: recordingState.operatingMode,
    vorgabeSchichten,
    tiefe: liveTiefe,
  });

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
        config={config}
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
      const section = route.params.section;
      content = (
        <ConfigPage
          config={config}
          devMode={devMode}
          deviceFrames={deviceFrames}
          updateAvailable={updateAvailable}
          section={section}
        />
      );
      const SECTION_TITLES: Record<string, string> = {
        verbindung: 'Verbindung',
        datenquelle: 'Datenquelle',
        messwerte: 'Messwerte',
        system: 'System',
      };
      pageTitle = section ? SECTION_TITLES[section] ?? 'Einstellungen' : 'Einstellungen';
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
    case 'rohrverlaengerung': {
      content = <RohrverlaengerungPage />;
      pageTitle = 'Rohrverlängerung';
      break;
    }
    /**
     * The geology sign-off, between "Beenden" and the session actually ending.
     *
     * The commit and the stop are one request: the server writes the geology
     * readings and only then ends the session, because ending it is what
     * releases the auto-upload. See the stop route.
     */
    case 'geologie': {
      content = (
        <GeologieBestaetigung
          sessionId={recordingState.sessionId}
          elementName={recordingState.elementName ?? route.params.name}
          onBeenden={async (layers) => {
            try {
              const res = await fetch('/api/recording/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geology: layers }),
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                return data.error || `Die Aufzeichnung konnte nicht beendet werden (Fehler ${res.status}).`;
              }
              const name = recordingState.elementName ?? route.params.name;
              navigate(name ? `bohren/${encodeURIComponent(name)}` : '');
              return null;
            } catch (err) {
              return `Die Aufzeichnung konnte nicht beendet werden: ${(err as Error).message}`;
            }
          }}
          onZurueck={() => {
            const name = recordingState.elementName ?? route.params.name;
            navigate(name ? `bohren/${encodeURIComponent(name)}` : '');
          }}
        />
      );
      pageTitle = 'Geologie';
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
    case 'bohren':
    case 'element': {
      if (setup.verfahren === 'injektionsbohren') {
        if (isVerpressenMode(recordingState.operatingMode)) {
          content = (
            <VerpressenScreen
              readings={readings}
              vorgaben={deviceVorgaben}
              config={INJEKTIONSBOHREN_VERPRESSEN}
            />
          );
        } else {
          content = (
            <BohrenScreen
              readings={readings}
              vorgaben={deviceVorgaben}
              config={INJEKTIONSBOHREN_BOHREN}
              recordingState={recordingState}
              markierteGrenze={geologie.vorschlag?.tiefe ?? null}
            />
          );
        }
      } else {
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
      }
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
        configSection={route.page === 'config' ? route.params.section : undefined}
        pageTitle={pageTitle}
        voiceSupported={voice.isSupported}
        isListening={voice.isListening}
        wakeWordPhase={voice.wakeWordPhase}
        onMicPress={voice.startListening}
        onMicRelease={voice.stopListening}
        commentQueueCount={commentQueue.pendingCount}
        operatingMode={recordingState.operatingMode}
        onModeChange={setOperatingMode}
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
        ...(route.page === 'element' || route.page === 'bohren' || route.page === 'sensors' || route.page === 'calibration' || route.page === 'rohrverlaengerung' || route.page === 'geologie'
          || (route.page === 'config' && !route.params.section)
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
        geologie={geologie}
      />
      {/*
        The picker is opened from the recording bar but rendered here: it covers
        the screen, so mounting it inside the bar would nest a full-viewport
        overlay in a 76px-tall element.
      */}
      {geologie.picker && (
        <GeologiePicker
          art={geologie.picker}
          untertitel={liveTiefe != null ? `Aktuelle Tiefe ${formatNumber(liveTiefe)} m` : undefined}
          onWaehlen={(nr, name) => geologie.erfasse(nr, name)}
          onAbbrechen={geologie.schliessePicker}
        />
      )}
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
