import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
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
import { isVerpressenMode, MODE_LABELS } from './utils/operating-mode';
import { shouldConfirmGeology } from './utils/geology-stop';
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
   * Land on the element a recording is running for.
   *
   * A restart mid-element re-attaches the session server-side
   * (`resumeRecording`) but the browser comes back on the element list, with a
   * bar saying a recording is running and — until now — nothing saying which.
   * The worker is at the rig, not at the screen, so the kiosk has to put itself
   * back where it was rather than wait to be asked.
   *
   * The jump is once per session, and `gesprungen` is marked before the route
   * is even looked at: a worker who started this recording themselves and then
   * walked back to the list must not be dragged forward again. It is the boot
   * case this exists for, where the hash is still empty.
   *
   * The phase needs no handling — `element/<name>` renders the drilling or the
   * Austausch/Einbauen/Auffüllen screen from `operatingMode`, which arrives in
   * the same message as `active` and is itself restored from the session.
   */
  const gesprungen = useRef<number | null>(null);
  useEffect(() => {
    const { active, sessionId, elementName } = recordingState;
    if (!active || sessionId === null || !elementName) return;
    // Not marked while the gate is still deciding: the WebSocket state
    // regularly lands before /api/verfahren answers, and marking here would
    // consume the one jump before it could happen.
    if (screen !== 'app') return;
    if (gesprungen.current === sessionId) return;
    gesprungen.current = sessionId;
    if (route.page !== 'home') return;
    navigate(`element/${encodeURIComponent(elementName)}`);
  }, [
    recordingState.active, recordingState.sessionId, recordingState.elementName,
    screen, route.page,
  ]);

  /**
   * Switch what the rig is doing.
   *
   * Lives here because the control moved into the header, next to the state it
   * sets, while the request itself is session-scoped. No error surface: the
   * switch renders from `recordingState`, which the WebSocket keeps
   * authoritative, so a failed request simply leaves the segment where it was —
   * visibly a no-op the operator can repeat. The only failure the endpoint has
   * is "no session", and the switch is not shown without one.
   *
   * ── The step out of Bohren shows the geology sign-off ──────
   *
   * Drilling is over at that step and the profile is final, while the recording
   * runs on through Austausch, Einbauen and Auffüllen — possibly into the next
   * day. Confirming the ground here is confirming it while the hole is still
   * fresh in mind, which is the whole reason the review moved off the stop.
   *
   * **The mode is switched first, then the screen opens.** The rig may start
   * retracting the moment the operator taps, and a server that still thinks
   * `bohren` reads the Klemmbacke as a pipe change and records the retraction
   * as drilling data — which would corrupt the very depth series the geology
   * aligns against. The review may wait; the clipping behaviour may not.
   *
   * The request is also what stamps `drilling_ended_at`, so the profile is
   * built from drilling alone however long the operator spends reviewing it.
   *
   * Stepping *back* into `bohren` leaves the screen again, because the server
   * has just cleared the sign-off and the window: the hole is going to get
   * deeper, and the profile with it.
   */
  const setOperatingMode = useCallback(async (mode: OperatingMode) => {
    const vorher = recordingState.operatingMode;
    const sessionId = recordingState.sessionId;
    try {
      const res = await fetch('/api/recording/mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, sessionId }),
      });
      if (!res.ok) return;
    } catch {
      // See above: the switch is server-rendered, so nothing moved.
      return;
    }

    if (mode === 'bohren') {
      if (route.page === 'geologie') {
        const name = recordingState.elementName ?? route.params.name;
        navigate(name ? `bohren/${encodeURIComponent(name)}` : '');
      }
      return;
    }

    // Only the step that ends drilling, and only once per session — a step on
    // from Austausch to Einbauen has nothing new to confirm.
    if (vorher !== 'bohren' || !recordingState.active || sessionId === null) return;
    if (await shouldConfirmGeology(sessionId)) {
      const name = recordingState.elementName;
      navigate(name ? `geologie/${encodeURIComponent(name)}` : 'geologie');
    }
  }, [
    recordingState.sessionId, recordingState.operatingMode, recordingState.active,
    recordingState.elementName, route.page, route.params.name,
  ]);

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

  /**
   * Only the drilling screen has a profile column for the quick picker to take
   * over. Elsewhere the full-screen picker is the only way to choose — which
   * costs a screen change, but those Verfahren have no column to offer.
   */
  const spalteVerfuegbar = setup.verfahren === 'injektionsbohren';

  const geologie = useGeologieErfassung({
    sessionId: recordingState.sessionId,
    active: recordingState.active,
    operatingMode: recordingState.operatingMode,
    vorgabeSchichten,
    tiefe: liveTiefe,
    spalteVerfuegbar,
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
     * The geology sign-off.
     *
     * Two entry points, told apart by the operating mode, because the mode is
     * switched before the screen opens:
     *
     * — **Past `bohren`** — the normal path. Drilling has just ended and the
     *   recording continues, so the commit is its own request and the operator
     *   carries on to the next phase. No second exit: the way back from a
     *   mis-tapped phase step is the phase stepper in the header.
     * — **Still in `bohren`** — the backstop at Beenden, for a session that
     *   never left drilling. There the commit and the stop are one request: the
     *   server writes the geology readings and only then ends the session,
     *   because ending it is what releases the auto-upload. See the stop route.
     */
    case 'geologie': {
      const name = recordingState.elementName ?? route.params.name;
      const zurueck = (): void => navigate(name ? `bohren/${encodeURIComponent(name)}` : '');
      const mode = recordingState.operatingMode;
      const nachBohren = isVerpressenMode(mode);

      content = nachBohren ? (
        <GeologieBestaetigung
          sessionId={recordingState.sessionId}
          elementName={name}
          aktion={{
            label: `Weiter zum ${MODE_LABELS[mode as OperatingMode]}`,
            laufend: 'Wird gespeichert…',
          }}
          onBeenden={async (layers) => {
            try {
              const res = await fetch('/api/recording/geology/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geology: layers }),
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                return data.error
                  || `Das Geologieprofil konnte nicht gespeichert werden (Fehler ${res.status}). Bitte erneut versuchen.`;
              }
              zurueck();
              return null;
            } catch (err) {
              return `Das Geologieprofil konnte nicht gespeichert werden: ${(err as Error).message}`;
            }
          }}
        />
      ) : (
        <GeologieBestaetigung
          sessionId={recordingState.sessionId}
          elementName={name}
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
              zurueck();
              return null;
            } catch (err) {
              return `Die Aufzeichnung konnte nicht beendet werden: ${(err as Error).message}`;
            }
          }}
          onZurueck={zurueck}
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
              geologie={geologie}
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
      content = (
        <ShiftAssignment
          shift={shift}
          hasApiKey={config.hasApiKey}
          onImport={importShift}
          onClearImport={clearImport}
          recordingElement={recordingState.active ? recordingState.elementName : null}
        />
      );
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
        The full DIN vocabulary, reached via "Andere" from the quick picker — or
        directly on a screen with no profile column to host that. Rendered here
        because it covers the screen, so mounting it inside the recording bar
        would nest a full-viewport overlay in a 76px-tall element.
      */}
      {geologie.vollbild && (
        <GeologiePicker
          art={geologie.vollbild}
          untertitel={liveTiefe != null ? `Aktuelle Tiefe ${formatNumber(liveTiefe)} m` : undefined}
          // Badged, not re-offered: the quick column already had these, and
          // the operator who escalated anyway is usually looking for ground
          // the plan does not name. Marking them is what tells the two apart.
          //
          // `geplanteArten`, never `kandidaten`. The latter is the column's
          // tile list, which appends a recorded ground the plan never named
          // and caps at five — so badging from it told the operator the plan
          // predicted ground it never mentioned, and left a sixth planned
          // soil unmarked.
          vorgabeNrs={geologie.geplanteArten}
          aktiveNr={geologie.aktiveArt}
          onWaehlen={(nr, name) => geologie.erfasse(nr, name)}
          onAbbrechen={geologie.schliesse}
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
