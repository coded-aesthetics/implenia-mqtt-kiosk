import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useHashRouter, navigate } from './hooks/useHashRouter';
import { useConfig, useShiftAssignment, useActiveVerfahren, useElementVorgaben, useElementRueckkehr, useVerfahrenSensors } from './hooks/useImplenia';
import { useVoiceCommands } from './hooks/useVoiceCommands';
import { Header } from './components/Header';
import { RecordingBar } from './components/RecordingBar';
import { ConfigPage } from './components/ConfigPage';
import { ShiftAssignment } from './components/ShiftAssignment';
import { ElementDetail } from './components/ElementDetail';
import { VoiceFeedbackOverlay } from './components/VoiceFeedbackOverlay';
import { TouchKeyboard } from './components/TouchKeyboard';
import { CommentQueuePage } from './components/CommentQueuePage';
import { SetupWizard } from './components/SetupWizard';
import { TopicAssignment } from './components/TopicAssignment';
import { DatenstromPage } from './components/DatenstromPage';
import { DatenstromDetail } from './components/DatenstromDetail';
import { RohrverlaengerungPage } from './components/RohrverlaengerungPage';
import { BohrenScreen, INJEKTIONSBOHREN_BOHREN } from './components/BohrenScreen';
import { BriefingScreen } from './components/BriefingScreen';
import { GeologieBestaetigung } from './components/GeologieBestaetigung';
import { VerpressenScreen, INJEKTIONSBOHREN_VERPRESSEN } from './components/VerpressenScreen';
import { AusrichtenScreen } from './components/AusrichtenScreen';
import { ausrichtenBeimOeffnen, ausrichtungErforderlich, ausrichtungMoeglich } from './utils/ausrichtung';
import { briefingBeimOeffnen } from './utils/briefing';
import { resolveScreen, needsSetupRedirect } from './setupGate';
import { useCommentQueue } from './hooks/useCommentQueue';
import { isVerpressenMode, MODE_LABELS } from './utils/operating-mode';
import { shouldConfirmGeology } from './utils/geology-stop';
import { GeologiePicker } from './components/GeologiePicker';
import { TiefenKorrektur } from './components/TiefenKorrektur';
import { useGeologieErfassung } from './hooks/useGeologieErfassung';
import { buildSchichten, collectVorgabeEntries } from './utils/vorgaben';
import { buildSensorValues, sensorValue } from './utils/sensors';
import { formatNumber } from './utils/format';
import type { OperatingMode } from './hooks/useWebSocket';
import type { ViewTab } from './components/ElementDetail';

export function App() {
  const { readings, deviceFrames, connectivity, apiHealth, sourceHealth, sourceType, recordingState, uploadProgress, updateAvailable, updateSource, updateApplying, updateFailure, replaySeeking } =
    useWebSocket();
  const route = useHashRouter();
  const config = useConfig();
  const setup = useActiveVerfahren();
  const shift = useShiftAssignment(config.hasApiKey, config.apiUrl);
  const { importShift, clearImport } = shift;

  /**
   * Arriving at the element list refetches, and so does connectivity coming
   * back.
   *
   * useShiftAssignment lives here, above the router, so it mounts once for the
   * life of the app: navigating to the element list only re-renders it and
   * fires no request. A failure from an hour ago therefore stayed on screen
   * until something unrelated changed — with no way for a worker to clear it.
   *
   * The first mount is skipped, since the hook fetches on its own.
   */
  const prevPageRef = useRef<string | null>(null);
  const prevConnRef = useRef(connectivity);
  const refetchShift = shift.refetch;
  useEffect(() => {
    const was = prevPageRef.current;
    prevPageRef.current = route.page;
    if (route.page === 'home' && was !== null && was !== 'home') refetchShift();
  }, [route.page, refetchShift]);
  useEffect(() => {
    const was = prevConnRef.current;
    prevConnRef.current = connectivity;
    if (connectivity === 'online' && was === 'offline') refetchShift();
  }, [connectivity, refetchShift]);
  /*
   * And when the platform comes back, which is a separate event: a kiosk shown
   * yesterday's cached list because the backend was down must not keep showing
   * it once the backend answers again. The internet never went anywhere in
   * that case, so the watchdog above never fires.
   */
  const prevApiRef = useRef(apiHealth);
  useEffect(() => {
    const was = prevApiRef.current;
    prevApiRef.current = apiHealth;
    if (apiHealth === 'ok' && (was === 'unreachable' || was === 'rejected')) refetchShift();
  }, [apiHealth, refetchShift]);

  const [devMode, setDevMode] = useState(false);
  useEffect(() => {
    fetch('/status').then((r) => r.json()).then((d) => setDevMode(!!d.devMode)).catch(() => {});
  }, []);

  // Lifted tab state for ElementDetail (so voice commands can control it)
  const [activeTab, setActiveTab] = useState<ViewTab>('messwerte');
  /**
   * Whether the depth correction is open.
   *
   * Here rather than in the drilling screen because it covers the viewport —
   * the same reason GeologiePicker is mounted at this level — and because both
   * the Bohren and the Verpressen screen open the same one.
   */
  const [korrekturOffen, setKorrekturOffen] = useState(false);

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

  /*
   * What this element was last doing here: whether it has been recorded at all,
   * and the phase its last session was in. Local lookup, so it answers offline.
   */
  const rueckkehr = useElementRueckkehr(
    route.params.name ?? null,
    // Re-asked whenever a session starts or ends, because that is when the
    // answer changes and this screen does not reload. See the hook.
    `${recordingState.active}:${recordingState.sessionId}`,
  );

  /**
   * The phase before a recording exists.
   *
   * Seeded from the element's last session, then moved by the stepper. It is
   * local because there is nothing to write to: `operating_mode` is a column
   * on a session, and a pillar being looked at has none. It travels to the
   * server exactly once, with `POST /api/recording/start`, which opens the new
   * session in it — so the screen the operator tapped start on is the phase
   * the readings are stamped with.
   *
   * Null means "not chosen": the restored phase then shows through. The
   * distinction matters because stepping back to the restored phase has to be
   * possible, and a seeded-then-compared state could not tell the two apart.
   */
  const [vorabModus, setVorabModus] = useState<OperatingMode | null>(null);
  useEffect(() => { setVorabModus(null); }, [route.params.name]);

  /**
   * Which phase the screens draw, and the stepper shows.
   *
   * A running recording is the authority, whatever element is on screen — that
   * is what the rig is doing. Without one, the recording state still answers
   * for *its own* element (a session that has ended and is waiting to upload
   * keeps its phase, and the stepper still writes to that row); for any other
   * element it has nothing to say and the local phase takes over.
   */
  const modusAusAufzeichnung = recordingState.active
    || recordingState.elementName === route.params.name
    ? recordingState.operatingMode
    : null;
  const angezeigterModus = modusAusAufzeichnung ?? vorabModus ?? rueckkehr.modus;
  /** Is there a session behind the phase, or is it only the screen's own? */
  const modusIstLokal = modusAusAufzeichnung === null;

  /*
   * The Verfahren's own sensors, from the CSV the server ships — the alignment
   * screen finds its two live angles by role in here. Local, so it answers on
   * a kiosk that has been offline for days.
   */
  const verfahrenSensoren = useVerfahrenSensors(setup.verfahren);

  /**
   * The Vorgaben briefing: what is planned here, before anyone drills it.
   *
   * Rendered by `element/<name>` rather than reached by a redirect, which is
   * what lets its forward button navigate on without being bounced straight
   * back — see `briefingBeimOeffnen` for the whole rule. It is deliberately
   * asked *before* the alignment redirect below and suppresses it: both answer
   * the same question about the same page, and the briefing comes first in the
   * sequence, with the dials one tap on from it.
   */
  const briefingOffen = briefingBeimOeffnen({
    seite: route.page,
    verfahren: setup.verfahren,
    aufzeichnungLaeuft: recordingState.active,
    bereitsAufgezeichnet: rueckkehr.bekannt,
    nochUnbekannt: rueckkehr.status === 'laedt',
    vorgaben: deviceVorgaben,
  });

  /**
   * Aiming the rig: offered as the stepper slot before Bohren, and only for an
   * element whose Vertikalneigung is not 0 — a plumb hole has no direction to
   * aim — on a Verfahren that actually has the two live angle sensors.
   * Available with no recording running, because that is when it happens.
   */
  const ausrichtenElement = route.params.name;
  /*
   * On the screen itself the slot is offered whatever the Vorgabe says: it is
   * the only way off it. Opened for a plumb element — a typed URL, a stale
   * bookmark, a reload while the Vorgabe is still loading — the condition
   * alone left the operator on a screen with no exit at all.
   */
  const ausrichtenSlot = ausrichtenElement
    && (route.page === 'ausrichten'
      || (ausrichtungMoeglich(verfahrenSensoren.sensoren)
        && ausrichtungErforderlich(deviceVorgaben)))
    ? {
      aktiv: route.page === 'ausrichten',
      oeffnen: () => navigate(`ausrichten/${encodeURIComponent(ausrichtenElement)}`),
      /*
       * `bohren/`, not `element/`. The two routes render the same screen, and
       * the difference is the one thing that keeps the redirect below from
       * being a trap: `element/<name>` means "open this element" and may be
       * sent here, `bohren/<name>` is the drilling screen asked for directly.
       * Leaving by way of the former would bounce straight back in.
       */
      schliessen: () => navigate(`bohren/${encodeURIComponent(ausrichtenElement)}`),
    }
    : undefined;

  /**
   * Opening a tilted element lands on the alignment screen.
   *
   * Aiming the rig is the first thing that happens there, so it is the first
   * thing on screen — rather than the drilling screen plus the knowledge that
   * the stepper holds a step nobody has taken yet. The way on is the stepper's
   * Bohren slot, one tap, and the recording starts from there as before:
   * nothing here gates it.
   *
   * The condition lives in `ausrichtenBeimOeffnen`, which spells out why it is
   * keyed on the route and skipped for a running recording. Two consequences
   * worth knowing at this end:
   *
   * — It fires whenever the Vorgabe arrives, which for a **resumed** element is
   *   a cached fetch rather than the shift payload already in hand. Such an
   *   element shows the drilling screen for a moment before the jump. The
   *   alternative is holding the screen back on a request, which is the one
   *   thing this kiosk never does.
   * — A Vorgabe that never arrives — offline, nothing cached — leaves the
   *   element opening exactly as it did before.
   */
  useEffect(() => {
    if (!ausrichtenElement) return;
    // The briefing is showing, and its forward button is the way to the dials.
    // Without this the redirect fires on the very page the briefing renders on
    // and the operator never sees it.
    if (briefingOffen) return;
    if (!ausrichtenBeimOeffnen({
      seite: route.page,
      aufzeichnungLaeuft: recordingState.active,
      bereitsAufgezeichnet: rueckkehr.bekannt,
      nochUnbekannt: rueckkehr.status === 'laedt',
      vorgaben: deviceVorgaben,
      sensoren: verfahrenSensoren.sensoren,
    })) return;
    navigate(`ausrichten/${encodeURIComponent(ausrichtenElement)}`);
  }, [
    ausrichtenElement, route.page, recordingState.active,
    rueckkehr.bekannt, rueckkehr.status,
    deviceVorgaben, verfahrenSensoren.sensoren, briefingOffen,
  ]);

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
   * While a recording runs, the element screens belong to the element being
   * recorded.
   *
   * Opening another one was allowed and quietly wrong in two ways at once.
   * These screens draw the *rig's* live readings, so another element's screen
   * paired that element's Soll values with this element's Ist values; and the
   * header's phase stepper there writes to the running session, so an operator
   * stepping the phase on what looks like an untouched pillar moved the phase
   * of the one in the ground — `Status`, which implenia-web's
   * Herstellprotokoll segments every KPI by.
   *
   * The element list keeps the other tiles visible and inert, which is where a
   * worker meets this rule. This covers the ways in that bypass a tile: a
   * reload on such a URL, a typed hash, a second tab, a voice command on an
   * older bundle. Only the element's own screens — the geology sign-off is
   * about the *session* and is always reached with the recording element's own
   * name.
   *
   * It lands on `element/<name>`, the route that means "open this element", so
   * a tilted element still goes wherever opening it goes.
   */
  useEffect(() => {
    const { active, elementName } = recordingState;
    if (!active || !elementName) return;
    if (screen !== 'app') return;
    const offen = route.params.name;
    if (!offen || offen === elementName) return;
    if (route.page !== 'element' && route.page !== 'bohren' && route.page !== 'ausrichten') return;
    navigate(`element/${encodeURIComponent(elementName)}`);
  }, [
    recordingState.active, recordingState.elementName,
    route.page, route.params.name, screen,
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
  /**
   * Apply a depth correction, and keep the screen open if it was refused.
   *
   * Returns the server's German message rather than swallowing it: the
   * refusals a worker can hit — no depth reading yet, a depth above the ground
   * — are all actionable, and this is the one place they can act on them.
   */
  const tiefeKorrigieren = useCallback(async (deltaMeter: number): Promise<string | null> => {
    try {
      const res = await fetch('/api/recording/depth-correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: deltaMeter }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return data.error || `Die Tiefe konnte nicht korrigiert werden (Fehler ${res.status}).`;
      }
      setKorrekturOffen(false);
      return null;
    } catch (err) {
      return `Die Tiefe konnte nicht korrigiert werden: ${(err as Error).message}`;
    }
  }, []);

  /*
   * A recording that ends takes the correction screen with it: there is
   * nothing left to correct, and a stop by voice or from a second tab would
   * otherwise leave a worker holding a screen whose Übernehmen can only fail.
   */
  useEffect(() => {
    if (!recordingState.active && korrekturOffen) setKorrekturOffen(false);
  }, [recordingState.active, korrekturOffen]);

  const setOperatingMode = useCallback(async (mode: OperatingMode) => {
    const vorher = recordingState.operatingMode;
    const sessionId = recordingState.sessionId;
    /*
     * No session behind this phase — a resumed element being looked at before
     * the recording starts. The step is the screen's own, so it is taken here
     * and handed to the start route later. Asking the server would be asking
     * it to write a mode onto somebody else's session, which is what the route
     * answers 409 to: a dead stepper on the one screen whose phase the
     * operator most needs to correct.
     */
    if (modusIstLokal) {
      setVorabModus(mode);
      return;
    }
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
      // Same fallback as every other navigation here: the step is tapped from
      // the drilling screen, whose route already names the element, so a
      // recording state that has not caught up yet still lands on the element's
      // own profile rather than a nameless one.
      const name = recordingState.elementName ?? route.params.name;
      navigate(name ? `geologie/${encodeURIComponent(name)}` : 'geologie');
    }
  }, [
    recordingState.sessionId, recordingState.operatingMode, recordingState.active,
    recordingState.elementName, route.page, route.params.name, modusIstLokal,
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
    return sensorValue(buildSensorValues(readings), INJEKTIONSBOHREN_BOHREN.depthSensor) ?? null;
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
        step={route.params.step ?? 'netzwerk'}
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
          recording={recordingState.active}
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
    case 'datenstrom': {
      // `?sensor=` addresses a sensor the Verfahren expects and nothing is
      // feeding: it has no topic to put in the path, and it still has a
      // calibration that has to be readable and clearable.
      content = route.params.topic || route.query.sensor
        ? (
          <DatenstromDetail
            topic={route.params.topic}
            sensorName={route.query.sensor}
            readings={readings}
          />
        )
        : <DatenstromPage readings={readings} />;
      pageTitle = 'Datenstrom';
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
     * Two entry points, told apart by **`?beenden=1` in the route**:
     *
     * — **The phase step out of `bohren`** — the normal path, with no flag.
     *   Drilling has just ended and the recording continues, so the commit is
     *   its own request and the operator carries on to the next phase.
     * — **Beenden** — the backstop, with the flag. There the commit and the
     *   stop are one request: the server writes the geology readings and only
     *   then ends the session, because ending it is what releases the
     *   auto-upload. See the stop route.
     *
     * The flag rather than the operating mode, which is what this once read.
     * The mode answers "which phase is the rig in", not "what did the operator
     * ask for", and the two come apart in both directions. A Beenden on a
     * session already past `bohren` — the sign-off there was skipped because
     * its context fetch failed, or left without committing — would have been
     * answered by a button that commits and returns, leaving the recording
     * running and the operator tapping Beenden twice. And `operatingMode` is
     * null until the first `recording-state` message arrives, so a reload on
     * this screen briefly offered *the opposite consequence* under the same
     * button: one tap in that window ended a recording mid-Austausch, with
     * Einbauen and Auffüllen never recorded and the upload released early.
     * The URL survives a reload and a PM2 restart; the WebSocket state does
     * not.
     */
    case 'geologie': {
      const name = recordingState.elementName ?? route.params.name;
      const zurueck = (): void => navigate(name ? `bohren/${encodeURIComponent(name)}` : '');
      const mode = recordingState.operatingMode;
      const nachBohren = route.query.beenden !== '1';

      content = nachBohren ? (
        <GeologieBestaetigung
          sessionId={recordingState.sessionId}
          elementName={name}
          aktion={{
            // Naming the phase needs the mode, which is null until the first
            // `recording-state` message. A bare "Weiter" until then rather
            // than "Weiter zum undefined" — safe to fill in under the finger,
            // because both spellings of this button do the same thing. The
            // variant itself must never be decided this way; see above.
            label: isVerpressenMode(mode)
              ? `Weiter zum ${MODE_LABELS[mode as OperatingMode]}`
              : 'Weiter',
            laufend: 'Wird gespeichert…',
          }}
          onBeenden={async (layers) => {
            try {
              const res = await fetch('/api/recording/geology/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geology: layers }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) {
                return data.error
                  || `Das Geologieprofil konnte nicht gespeichert werden (Fehler ${res.status}). Bitte erneut versuchen.`;
              }
              /*
               * A 200 that wrote no boundary means the profile is lost — a
               * malformed body, no depth readings, sensors that would not
               * resolve. The route answers 200 on purpose, because the
               * measurements are fine and nothing may stand between the
               * operator and the next phase; but it marks the session confirmed
               * either way, so the stop will not ask again. Swallowing the
               * message here would make that loss completely silent.
               *
               * Shown rather than navigated past, which keeps the button
               * available for a retry. The way on without one is the phase
               * stepper in the header, the same way back as from any step.
               *
               * A commit that *did* write is never held up, even with a hinweis
               * attached: that one reports layers the server discarded as
               * incomplete, which retrying cannot change, so trapping the
               * operator over it would buy nothing.
               */
              const geschrieben = Number(data.geology?.geschrieben ?? 0);
              if (geschrieben === 0 && typeof data.hinweis === 'string' && data.hinweis) {
                return data.hinweis;
              }
              zurueck();
              return null;
            } catch (err) {
              return `Das Geologieprofil konnte nicht gespeichert werden: ${(err as Error).message}`;
            }
          }}
          /*
           * Held back until a commit has failed. The review is not optional, so
           * nothing stands open to skip past; but the phase stepper — the way
           * back from a mis-tap — is itself a request, so a local server that
           * cannot be reached would otherwise leave both controls dead and the
           * screen a dead end.
           */
          zurueck={{ aktion: zurueck, nurNachFehler: true }}
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
          zurueck={{ aktion: zurueck }}
        />
      );
      pageTitle = 'Geologie';
      break;
    }
    case 'ausrichten': {
      content = (
        <AusrichtenScreen
          readings={readings}
          vorgaben={deviceVorgaben}
          sensoren={verfahrenSensoren}
        />
      );
      pageTitle = route.params.name;
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
      if (briefingOffen) {
        /*
         * `bohren/`, never `element/` — the two render the same screens and
         * the route is the only thing that tells "open this element" from
         * "the drilling screen, directly". Leaving by way of the former would
         * land straight back on the briefing. Same reasoning as the alignment
         * screen's own exit.
         */
        const ziel = ausrichtenSlot
          ? `ausrichten/${encodeURIComponent(route.params.name ?? '')}`
          : `bohren/${encodeURIComponent(route.params.name ?? '')}`;
        content = (
          <BriefingScreen
            vorgaben={deviceVorgaben}
            weiter={{
              label: ausrichtenSlot ? 'Weiter zum Ausrichten' : 'Weiter zum Bohren',
              aktion: () => navigate(ziel),
            }}
          />
        );
      } else if (setup.verfahren === 'injektionsbohren') {
        if (isVerpressenMode(angezeigterModus)) {
          content = (
            <VerpressenScreen
              readings={readings}
              vorgaben={deviceVorgaben}
              config={INJEKTIONSBOHREN_VERPRESSEN}
              onKorrigieren={
                recordingState.active ? () => setKorrekturOffen(true) : undefined
              }
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
              onKorrigieren={
                recordingState.active ? () => setKorrekturOffen(true) : undefined
              }
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
        apiHealth={apiHealth}
        sourceHealth={sourceHealth}
        sourceType={sourceType}
        hasApiKey={config.hasApiKey}
        currentPage={route.page}
        configSection={route.page === 'config' ? route.params.section : undefined}
        datenstromDetail={route.page === 'datenstrom'
          ? route.params.topic ?? route.query.sensor
          : undefined}
        pageTitle={pageTitle}
        voiceSupported={voice.isSupported}
        isListening={voice.isListening}
        wakeWordPhase={voice.wakeWordPhase}
        onMicPress={voice.startListening}
        onMicRelease={voice.stopListening}
        commentQueueCount={commentQueue.pendingCount}
        recording={recordingState.active}
        operatingMode={angezeigterModus}
        onModeChange={setOperatingMode}
        hidePhaseStepper={route.page === 'geologie' && route.query.beenden === '1'}
        ausrichten={ausrichtenSlot}
        updateAvailable={updateAvailable}
        updateApplying={updateApplying}
        updateSource={updateSource}
        updateFailure={updateFailure}
      />
      <VoiceFeedbackOverlay feedback={voice.feedback} />
      {replaySeeking && (
        <div style={styles.seekingOverlay}>
          <div style={styles.seekingText}>Spule vor…</div>
        </div>
      )}
      <main style={{
        ...styles.main,
        ...(route.page === 'element' || route.page === 'bohren' || route.page === 'sensors' || route.page === 'datenstrom' || route.page === 'rohrverlaengerung' || route.page === 'geologie' || route.page === 'ausrichten'
          // The hub, and the WLAN screen: both lay themselves out against the
          // available height rather than growing past it. Everything else on
          // /config is a stack of cards that may scroll.
          || (route.page === 'config' && (!route.params.section || route.params.section === 'netzwerk'))
          ? { overflow: 'hidden', display: 'flex', flexDirection: 'column' as const }
          : {}),
      }}>
        {content}
      </main>
      {/*
        Between main and the recording bar on purpose: main is flex:1, so the
        keyboard takes its height out of main instead of covering it, and the
        bar stays visible while somebody types. Renders nothing until an input
        is focused.
      */}
      <TouchKeyboard />
      <RecordingBar
        currentPage={route.page}
        elementName={route.params.name}
        // The phase the screen is showing, so a recording started from a
        // resumed element's Auffüllen screen opens in Auffüllen rather than
        // silently stepping back to Bohren under the operator's finger.
        startModus={modusIstLokal ? angezeigterModus : null}
        // Has this kiosk recorded this element before? The start button says
        // „fortsetzen" rather than „beginnen" if it has — the same local
        // lookup the restored phase comes from.
        bereitsAufgezeichnet={rueckkehr.bekannt}
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
      {/*
        Depth correction — the measuring wheel slips and the worker fixes it
        from the pipes they have mounted. Mounted here for the same reason as
        the picker above: it covers the viewport, and both drilling screens
        open the same one.
      */}
      {korrekturOffen && (
        <TiefenKorrektur
          tiefe={liveTiefe}
          bisherigeKorrektur={recordingState.depthCorrection}
          onUebernehmen={tiefeKorrigieren}
          onAbbrechen={() => setKorrekturOffen(false)}
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
