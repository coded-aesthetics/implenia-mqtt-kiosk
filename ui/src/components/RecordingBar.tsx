import { useState, useEffect, useRef } from 'react';
import { imageDataURI, findByNr } from '@coded-aesthetics/din4023';
import type { OperatingMode, RecordingState, UploadProgress } from '../hooks/useWebSocket';
import { hasPipeHandling } from '../utils/operating-mode';
import { navigate } from '../hooks/useHashRouter';
import { shouldConfirmGeology } from '../utils/geology-stop';
import { farbeVon, nameVon } from '../utils/geologie';
import type { GeologieErfassung } from '../hooks/useGeologieErfassung';

interface Props {
  currentPage: string;
  /**
   * The phase the element screen is showing when no session owns it — the
   * opening phase of the recording this bar starts. Null while a session does
   * own it, because the server already knows that one.
   */
  startModus?: OperatingMode | null;
  /**
   * Whether this kiosk has recorded this element before, which is what the
   * start button is worded from: „fortsetzen" for a pillar somebody has
   * already worked on, „beginnen" for a fresh one. Same local lookup the
   * restored phase comes from (`useElementRueckkehr`), so it answers offline.
   */
  bereitsAufgezeichnet?: boolean;
  elementName?: string;
  recordingState: RecordingState;
  uploadProgress: UploadProgress | null;
  /**
   * Live geology entry, where the Verfahren supports it.
   *
   * The buttons live here rather than on the drilling screen because the bar is
   * already ~76 px tall for its own controls, so they cost no vertical space at
   * all — and in the left column they were taking 136 px off a profile that
   * only had 596 px to work with. They are also recording actions, which is
   * what this bar is for.
   */
  geologie?: GeologieErfassung;
}

type SessionStatus = 'idle' | 'recording' | 'ended' | 'empty' | 'uploading' | 'uploaded' | 'partial';

interface ExportOption {
  stream: string;
  label: string;
  count: number;
  exported: boolean;
}

export function RecordingBar({ currentPage, elementName, startModus = null, bereitsAufgezeichnet = false, recordingState, uploadProgress, geologie }: Props) {
  const rohrwechsel = recordingState.rohrwechsel;
  const operatingMode = recordingState.operatingMode;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUploadResult, setLastUploadResult] = useState<'uploaded' | 'partial' | null>(null);
  const [emptyWarning, setEmptyWarning] = useState(false);
  const [exportOptions, setExportOptions] = useState<ExportOption[]>([]);
  const [exportTick, setExportTick] = useState(0);

  /*
   * "Abschließen" confirmation state.
   *
   * It was a single tap, and it commits the geology profile, releases the
   * upload and stamps the Ausführungsdatum. Workers were tapping it to reach
   * the things the recording guard blocks — an update, the WLAN switch — and
   * the geology sign-off that followed was the only one they would ever get
   * for that element. "Pausieren" is now the button for that, and this one
   * asks first.
   */
  const [abschliessenPending, setAbschliessenPending] = useState(false);
  const abschliessenRef = useRef<HTMLButtonElement | null>(null);

  /*
   * Tapping anything else cancels, per the tap-to-confirm pattern. Without it
   * the pending state is a dead end on a touchscreen: the row hides the
   * controls that would otherwise have served as "anything else", so there is
   * nothing left in the bar to tap that means no.
   */
  useEffect(() => {
    if (!abschliessenPending) return;
    const abbrechen = (e: PointerEvent): void => {
      if (abschliessenRef.current?.contains(e.target as Node)) return;
      setAbschliessenPending(false);
    };
    document.addEventListener('pointerdown', abbrechen, true);
    return () => document.removeEventListener('pointerdown', abbrechen, true);
  }, [abschliessenPending]);

  // A recording that stops for any reason leaves the confirmation behind.
  useEffect(() => {
    if (!recordingState.active) setAbschliessenPending(false);
  }, [recordingState.active]);

  // Determine current display status
  const status: SessionStatus = (() => {
    if (emptyWarning) return 'empty';
    if (uploadProgress && uploadProgress.currentSensor !== null) return 'uploading';
    if (lastUploadResult) return lastUploadResult;
    if (recordingState.active) return 'recording';
    if (recordingState.sessionId && !recordingState.active) return 'ended';
    return 'idle';
  })();

  // Clear transient states when a new recording starts
  useEffect(() => {
    if (recordingState.active) {
      setLastUploadResult(null);
      setEmptyWarning(false);
    }
  }, [recordingState.active]);

  // Track upload completion
  useEffect(() => {
    if (uploadProgress && uploadProgress.currentSensor === null && uploadProgress.sensorsTotal > 0) {
      setLastUploadResult(uploadProgress.sensorsFailed > 0 ? 'partial' : 'uploaded');
    }
  }, [uploadProgress]);

  // Auto-dismiss success message after 10 seconds
  useEffect(() => {
    if (lastUploadResult !== 'uploaded') return;
    const id = setTimeout(() => setLastUploadResult(null), 10_000);
    return () => clearTimeout(id);
  }, [lastUploadResult]);

  // Auto-dismiss empty session warning after 10 seconds
  useEffect(() => {
    if (!emptyWarning) return;
    const id = setTimeout(() => setEmptyWarning(false), 10_000);
    return () => clearTimeout(id);
  }, [emptyWarning]);

  // Fetch which streams can be exported once a session has ended.
  useEffect(() => {
    const sessionId = recordingState.sessionId;
    if (status !== 'ended' || !sessionId) {
      setExportOptions([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/recording/${sessionId}/export-options`)
      .then((r) => (r.ok ? r.json() : { streams: [] }))
      .then((data) => {
        if (!cancelled) setExportOptions(data.streams ?? []);
      })
      .catch(() => {
        if (!cancelled) setExportOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [status, recordingState.sessionId, exportTick]);

  /**
   * Where the bar is shown, and what is allowed to summon it.
   *
   * On an element's own screens it is always there, so a message costs no
   * layout at all — the idle state of this bar *is* the start button, and
   * every state is one row of the same height.
   *
   * Everywhere else it appears only for **outstanding work**: a running
   * recording, an upload in flight, or a session still waiting to go
   * (`sessionId` stays set while it is `ended` or `partial`). A transient
   * confirmation summoned it too, and the element list then jumped 47px as it
   * appeared and 47px back ten seconds later — for a message about something
   * already finished. It also cannot simply stay reserved there: a permanent
   * bar leaves that grid 415px where six tiles and the „Abgeschlossene
   * Elemente" row need 419.
   *
   * What a worker loses: the upload confirmation if they walk to the list
   * while it runs. What they get instead is permanent and in the place they
   * are looking — the element sits under „Abgeschlossene Elemente" with its
   * date, and a failed upload still brings the bar up everywhere, because that
   * one is outstanding work.
   *
   * `emptyWarning` counts as outstanding work, and that is the line this rule
   * is drawn on: it says a recording ended having captured *nothing*, which is
   * a warning and not a confirmation. Both stop buttons sit in this bar, which
   * is on screen during a recording wherever the worker is standing, so a stop
   * can perfectly well happen from the element list — and that is the one
   * message that must not be swallowed because of where they were.
   */
  const offeneArbeit = recordingState.active || recordingState.sessionId !== null
    || emptyWarning;
  // The geology sign-off carries its own Beenden and Zurück. A second Beenden
  // in the bar below it would stop without the profile — the one outcome that
  // screen exists to prevent.
  if (currentPage === 'geologie') return null;
  if (currentPage !== 'element' && currentPage !== 'bohren' && !offeneArbeit) return null;

  async function startRecording() {
    if (!elementName) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/recording/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(startModus ? { elementName, operatingMode: startModus } : { elementName }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Fehler ${res.status}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Beenden.
   *
   * A session that actually drilled, on a Verfahren that records geology, goes
   * to the sign-off screen first — which is where the forgotten layer changes
   * get caught. Everything else stops straight away, exactly as before:
   * grouting-only sessions, machines without geology sensors, and a session
   * that never went down.
   *
   * The check costs one request to the local server. If it fails for any
   * reason, the stop proceeds — geology must never be what stands between an
   * operator and finishing an element.
   */
  async function stopRecording() {
    const sessionId = recordingState.sessionId;
    if (recordingState.active && sessionId !== null) {
      setLoading(true);
      const confirm = await shouldConfirmGeology(sessionId);
      setLoading(false);
      if (confirm) {
        /*
         * `?beenden=1` is what tells the sign-off screen that it has to stop
         * the recording, not merely commit and carry on.
         *
         * In the route rather than read off the operating mode, for two
         * reasons. A session can reach here past `bohren` — the sign-off at the
         * phase step was skipped because its context fetch failed, or the
         * operator left that screen without committing — and a mode-derived
         * screen would then answer "Beenden" with a button that commits and
         * returns, leaving the recording running. And `operatingMode` is null
         * until the first `recording-state` message, so after a reload on this
         * screen a mode-derived variant would briefly offer the *other*
         * consequence under the same button. The URL survives the reload; the
         * WebSocket state does not.
         */
        const name = recordingState.elementName;
        navigate(name
          ? `geologie/${encodeURIComponent(name)}?beenden=1`
          : 'geologie?beenden=1');
        return;
      }
    }
    await stopNow();
  }

  /**
   * Pausieren.
   *
   * Ends the session and finishes nothing: no geology sign-off, no
   * Ausführungsdatum. The element stays resumable and reopens on its phase, so
   * this is the button for stopping to apply an update or switch the WLAN —
   * the cases that were being served by Beenden, at the cost of the element's
   * one geology review.
   *
   * Never routes through the sign-off. Reviewing a profile here would make the
   * pause the thing it exists not to be.
   */
  async function pauseRecording() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/recording/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pause: true }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Fehler ${res.status}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function stopNow() {
    const hadReadings = recordingState.readingCount > 0;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/recording/stop', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Fehler ${res.status}`);
      }
      if (!hadReadings) {
        setEmptyWarning(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function exportSession(stream: string) {
    if (!recordingState.sessionId) return;
    const a = document.createElement('a');
    a.href = `/api/recording/${recordingState.sessionId}/export?stream=${encodeURIComponent(stream)}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => setExportTick((n) => n + 1), 1500);
  }

  async function upload() {
    if (!recordingState.sessionId) return;
    setLoading(true);
    setError(null);
    setLastUploadResult(null);
    try {
      const res = await fetch(`/api/recording/${recordingState.sessionId}/upload`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Fehler ${res.status}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Readings are being held back as a pipe change.
   *
   * Not merely cosmetic: in this phase the Rohrverlängerung state machine clips
   * readings out of every upload and export, so this has to be unmistakable at
   * a glance. Three things change at once — shape (disc to two bars), colour
   * (danger red to warning orange) and the pulse stopping — which is what
   * carries the meaning now that no word does.
   */
  const pausiert = !!operatingMode && hasPipeHandling(operatingMode)
    && rohrwechsel?.phase === 'rohrwechsel';

  /**
   * What is being recorded, as an icon and nothing else.
   *
   * No label, in either state. A word that appears only when paused makes every
   * control in the bar shift sideways at the moment the operator is watching
   * the rig rather than the screen, and it says nothing the symbol does not.
   * Both icons occupy the same 20px so there is no movement at all; the state
   * still reaches assistive tech through `aria-label`.
   *
   * Deliberately not a button: there is no manual pause in this kiosk — the
   * phase is derived from the Klemmbacke — so giving it button chrome would
   * invite a tap that cannot do anything. The phase the operator *can* change
   * is the Bohren/Verpressen switch, which lives in the header next to the
   * state it sets.
   */
  const statusIcon = pausiert ? (
    <span style={styles.pauseIcon} aria-label="Pausiert">
      <i style={styles.pauseBar} />
      <i style={styles.pauseBar} />
    </span>
  ) : (
    <span style={styles.recIcon} aria-label="Aufzeichnung läuft" />
  );

  /*
   * Two slots, always, so the bar never reflows.
   *
   * Left: the layer change. Pre-loaded with the expected answer near a planned
   * boundary (one tap), otherwise it opens the quick picker in the profile
   * column.
   *
   * Right: the obstruction. While the drill is *inside* one this becomes
   * "Hindernis Ende" and needs no pick at all — the obstruction interrupted a
   * planned layer and the plan says which, so leaving it is a single tap. That
   * was two taps and a full-screen picker before.
   */
  const geologieButtons = geologie?.verfuegbar ? (
    <>
      <button
        data-testid="geologie-schicht"
        style={
          geologie.auswahl === 'schicht' ? styles.geoButtonOffen
            : geologie.vorschlag ? styles.geoButtonVorschlag
              : styles.geoButton
        }
        onClick={() => {
          if (geologie.vorschlag && geologie.auswahl !== 'schicht') {
            geologie.erfasse(geologie.vorschlag.nr, nameVon(geologie.vorschlag.nr));
          } else {
            // Tapping again closes the list, so the button that opened it also
            // dismisses it and the list needs no cancel tile of its own.
            geologie.oeffne('schicht');
          }
        }}
      >
        {geologie.vorschlag && geologie.auswahl !== 'schicht' ? (
          <>
            <Hatch nr={geologie.vorschlag.nr} />
            <span style={styles.geoLabel}>{nameVon(geologie.vorschlag.nr)}?</span>
          </>
        ) : (
          <span style={styles.geoLabel}>Schicht</span>
        )}
      </button>

      {geologie.imHindernis ? (
        <button
          data-testid="geologie-hindernis"
          style={styles.geoButtonHindernisEnde}
          onClick={() => geologie.beendeHindernis()}
        >
          Hindernis Ende
        </button>
      ) : (
        <button
          data-testid="geologie-hindernis"
          style={geologie.auswahl === 'hindernis'
            ? styles.geoButtonHindernisOffen
            : styles.geoButtonHindernis}
          onClick={() => geologie.oeffne('hindernis')}
        >
          Hindernis
        </button>
      )}
    </>
  ) : null;

  return (
    <div style={styles.bar}>
      {error && <div style={styles.error}>{error}</div>}

      {status === 'idle' && (currentPage === 'element' || currentPage === 'bohren') && (
        <button
          style={{ ...styles.button, ...styles.startButton }}
          onClick={startRecording}
          disabled={loading}
        >
          {loading ? 'Wird gestartet...'
            : bereitsAufgezeichnet ? 'Aufzeichnung fortsetzen' : 'Aufzeichnung beginnen'}
        </button>
      )}

      {/*
        One row, and it has to stay one row: `recordingRow` wraps, and a bar
        that grows a second line eats exactly the vertical space this layout
        was rearranged to free. The smoke test pins it at 1024x768.
      */}
      {status === 'recording' && (
        <div style={styles.recordingRowFest}>
          {statusIcon}
          {/*
            Which pillar, on every screen — where the elapsed time used to be.
            The bar is the only thing on screen during a recording that does
            not depend on the route, and the header names the element on the
            element screen alone. So on the element list, in the settings or on
            the geology sign-off this was the one place that could say what the
            blinking dot refers to, and it said nothing. The duplicate on the
            element screen is the price, and a cheap one.
          */}
          <span style={styles.elementNameLaufend}>{recordingState.elementName}</span>
          {!abschliessenPending && geologieButtons}
          {!abschliessenPending && geologie?.rueckmeldung && (
            <span style={styles.geoRueckmeldung}>✓ {geologie.rueckmeldung}</span>
          )}
          {!abschliessenPending && geologie?.fehler && (
            <span style={styles.geoFehler}>{geologie.fehler}</span>
          )}
          {/*
            Pausieren sits before Abschließen because it is the weaker of the
            two and the one a worker reaching for "stop" usually wants. Hidden
            while the confirmation is up: it would otherwise be the easiest
            mis-tap next to the button being confirmed, and a mis-tap there
            ends the recording for real.
          */}
          {!abschliessenPending && (
            <button
              style={{ ...styles.button, ...styles.pauseButton }}
              onClick={pauseRecording}
              disabled={loading}
            >
              Pausieren
            </button>
          )}
          {/*
            Still worded, and still the widest control here. It ends the
            element, releases the upload and writes the Ausführungsdatum —
            recoverable from the element's „Abgeschlossene Elemente" tile, but
            not something to leave to icon recognition.

            Two taps now. The finality of the geology profile is stated on the
            sign-off screen this leads to, not here: that screen *shows* the
            profile, and a warning about something the worker cannot see yet is
            a weaker warning than the same sentence beside the picture of it.
          */}
          <button
            ref={abschliessenRef}
            style={{
              ...styles.button,
              ...(abschliessenPending ? styles.stopButtonConfirm : styles.stopButtonDefault),
            }}
            onClick={() => {
              if (abschliessenPending) {
                setAbschliessenPending(false);
                void stopRecording();
              } else {
                setAbschliessenPending(true);
              }
            }}
            disabled={loading}
          >
            {abschliessenPending ? 'Wirklich abschließen?' : 'Abschließen'}
          </button>
        </div>
      )}

      {status === 'empty' && (
        <div style={styles.recordingRow}>
          <span style={styles.warningIcon}>!</span>
          <span style={styles.warningLabel}>Keine Messwerte aufgezeichnet</span>
        </div>
      )}

      {status === 'ended' && (
        <div style={styles.recordingRow}>
          <span style={styles.count}>{recordingState.readingCount} Messwerte aufgezeichnet</span>
          {/*
            Auto-upload normally carries the session straight from here to
            "uploading", so reaching this state means it could not: the kiosk
            was offline when the recording stopped, or a restart interrupted the
            attempt. The session then blocks both finishing this element and
            starting the next one, so there has to be a way out by hand.
          */}
          <button
            style={{ ...styles.button, ...styles.uploadButton }}
            onClick={upload}
            disabled={loading}
          >
            {loading ? 'Wird hochgeladen...' : 'Daten hochladen'}
          </button>
          {exportOptions.map((opt) => (
            <button
              key={opt.stream}
              style={{ ...styles.button, ...styles.exportButton }}
              onClick={() => exportSession(opt.stream)}
              disabled={loading}
            >
              {opt.exported ? `${opt.label} ✓ erneut exportieren` : `${opt.label} exportieren`}
            </button>
          ))}
          {exportOptions.some((o) => !o.exported) && exportOptions.some((o) => o.exported) && (
            <span style={styles.exportHint}>
              Noch nicht exportiert:{' '}
              {exportOptions.filter((o) => !o.exported).map((o) => o.label).join(', ')}
            </span>
          )}
        </div>
      )}

      {status === 'uploading' && uploadProgress && (
        <div style={styles.uploadRow}>
          <span style={styles.uploadLabel}>Daten werden hochgeladen...</span>
          <div style={styles.progressBarOuter}>
            <div
              style={{
                ...styles.progressBarInner,
                width: `${(uploadProgress.sensorsCompleted / uploadProgress.sensorsTotal) * 100}%`,
              }}
            />
          </div>
          <span style={styles.uploadPercent}>
            {Math.round((uploadProgress.sensorsCompleted / uploadProgress.sensorsTotal) * 100)}%
          </span>
        </div>
      )}

      {/*
        The upload landed. A confirmation and nothing to do — the way back to
        an element finished by mistake is its „Abgeschlossene Elemente" tile,
        which does the same thing this used to and does not expire after ten
        seconds. See "Transient messages never move the layout" in the README.
      */}
      {status === 'uploaded' && (
        <div style={styles.recordingRow}>
          <span style={styles.successIcon}>✓</span>
          <span style={styles.successLabel}>Erfolgreich hochgeladen</span>
        </div>
      )}

      {status === 'partial' && uploadProgress && (
        <div style={styles.recordingRow}>
          <span style={styles.warningIcon}>!</span>
          <span style={styles.warningLabel}>
            {uploadProgress.sensorsFailed}{' '}
            {uploadProgress.unit === 'paket'
              ? uploadProgress.sensorsFailed === 1 ? 'Paket' : 'Pakete'
              : uploadProgress.sensorsFailed === 1 ? 'Sensor' : 'Sensoren'}{' '}
            fehlgeschlagen
          </span>
          <button
            style={{ ...styles.button, ...styles.retryButton }}
            onClick={upload}
            disabled={loading}
          >
            Erneut versuchen
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The DIN 4023 hatch symbol for a ground type — the same one the profile draws,
 * which is how someone who reads these charts recognises the button without
 * reading its label. Obstructions carry no symbol in DIN 4023, so they get the
 * flat colour `farbeVon` assigns them.
 */
function Hatch({ nr }: { nr: number }) {
  const entry = findByNr(nr);
  const img = entry ? imageDataURI(entry) : undefined;
  return (
    <span
      style={{
        ...styles.hatch,
        backgroundColor: farbeVon(nr),
        ...(img ? { backgroundImage: `url(${img})`, backgroundSize: 'cover' } : {}),
      }}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '0.35rem 1.5rem',
    backgroundColor: 'var(--surface-0)',
    borderTop: '1px solid var(--border)',
  },
  /*
   * Every state of this bar is one row of the same height.
   *
   * 52px is the height of the buttons the row usually carries, so a row that
   * holds only text — „Erfolgreich hochgeladen", „Keine Messwerte
   * aufgezeichnet" — is exactly as tall as the start button it stands in for.
   * Without it the bar measured 64px with a button and 47 with a message, and
   * the screen above it moved by 17px twice per upload.
   */
  recordingRow: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '52px',
    gap: '1rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  button: {
    border: 'none',
    borderRadius: '8px',
    fontSize: '1.1rem',
    fontWeight: 700,
    cursor: 'pointer',
    padding: '0.75rem 2rem',
    minHeight: '52px',
    minWidth: '180px',
    textAlign: 'center',
  },
  startButton: {
    backgroundColor: 'var(--color-success-strong)',
    color: '#fff',
  },
  /*
   * The documented danger pattern: muted at rest, solid on the confirmation.
   * It used to be solid red at rest, which read as "the button for stopping"
   * rather than "the destructive one", and it was a single tap.
   */
  stopButtonDefault: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--color-danger)',
  },
  stopButtonConfirm: {
    backgroundColor: 'var(--color-danger)',
    color: '#fff',
  },
  // Narrower floor than the 180px base: it shares the row with both geology
  // buttons and Abschließen, and 1024px has no room to spare. Still far above
  // the 64px tap-target minimum.
  pauseButton: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
    minWidth: '150px',
  },
  exportButton: {
    backgroundColor: 'var(--color-accent-strong)',
    color: '#fff',
  },
  exportHint: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
  },
  retryButton: {
    backgroundColor: 'var(--color-warning)',
    color: '#fff',
  },
  uploadButton: {
    backgroundColor: 'var(--color-accent-strong)',
    color: '#fff',
  },
  elementNameLaufend: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
    // Monospaced, as the timer was: these are identifiers like "P-01", and the
    // digits are what is being read off them.
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    whiteSpace: 'nowrap' as const,
    /*
     * Measured at 1024x768: with both geology buttons at their 150px floor,
     * Pausieren at 150 and Abschließen at 180, the name no longer has the
     * 428px it had before Pausieren joined the row.
     *
     * So it shrinks instead of being re-capped at a number: `flexShrink: 1`
     * gives up exactly as much as the row is short, and no more — the full
     * 420px is still there on a Verfahren without geology buttons, and in the
     * confirmation state, where they are hidden.
     *
     * The cap stays, because the failure past it is the bad kind: the row is
     * `nowrap`, so an unbounded name pushes Abschließen off a screen with no
     * scrollbar — the same way a 71-character DIN name once did (see
     * geoLabel). Losing the tail of an unusually long name beats losing the
     * stop button, and the header still shows it in full on the element screen.
     */
    flexShrink: 1,
    maxWidth: '420px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  count: {
    fontSize: '1rem',
    color: 'var(--text-muted)',
  },
  uploadLabel: {
    fontSize: '1rem',
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  progressBarOuter: {
    flex: 1,
    maxWidth: '300px',
    height: '12px',
    backgroundColor: 'var(--border)',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  progressBarInner: {
    height: '100%',
    backgroundColor: 'var(--color-success-strong)',
    borderRadius: '6px',
    transition: 'width 0.3s ease',
  },
  uploadRow: {
    display: 'flex',
    alignItems: 'center',
    // Same 52px as every other row: the progress bar must not make the bar a
    // different height from the button that started the upload.
    minHeight: '52px',
    gap: '1rem',
    width: '100%',
    maxWidth: '500px',
  },
  uploadPercent: {
    fontSize: '1.1rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    minWidth: '3ch',
    textAlign: 'right',
  },
  successIcon: {
    fontSize: '1.6rem',
    fontWeight: 700,
    color: 'var(--color-success)',
  },
  successLabel: {
    fontSize: '1.1rem',
    fontWeight: 600,
    color: 'var(--color-success)',
  },
  warningIcon: {
    fontSize: '1.6rem',
    fontWeight: 700,
    color: 'var(--color-warning)',
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    border: '2px solid var(--color-warning)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  warningLabel: {
    fontSize: '1.1rem',
    fontWeight: 600,
    color: 'var(--color-warning)',
  },
  error: {
    /*
     * Not --font-sm: that is the floor, reserved for labels and meta info,
     * and an error is the one thing in this bar a worker has to actually read
     * and act on. These carry the recovery instruction now, so they are body
     * text.
     */
    fontSize: 'var(--font-base)',
    color: 'var(--color-danger)',
    marginBottom: '0.5rem',
    lineHeight: 1.35,
    textAlign: 'center',
  },
  /** Like recordingRow, but it must never wrap. See the comment at its use. */
  recordingRowFest: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '52px',
    gap: '0.75rem',
    flexWrap: 'nowrap',
    justifyContent: 'center',
    width: '100%',
    minWidth: 0,
  },
  recIcon: {
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    backgroundColor: 'var(--color-danger)',
    flexShrink: 0,
    // The pulse is what reads as "running" now that the word is gone.
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  pauseIcon: {
    // Same 20px box as recIcon: a different width would reintroduce the sideways
    // shift that dropping the label was meant to remove.
    width: '20px',
    height: '20px',
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  pauseBar: {
    display: 'block',
    width: '7px',
    height: '20px',
    borderRadius: '2px',
    backgroundColor: 'var(--color-warning)',
  },
  geoButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    minHeight: 'var(--tap-min)',
    minWidth: '150px',
    // Capped, and allowed to shrink: see geoLabel.
    maxWidth: '260px',
    flexShrink: 1,
    padding: '0 var(--space-md)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-primary)',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  geoButtonVorschlag: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    minHeight: 'var(--tap-min)',
    minWidth: '150px',
    // Capped, and allowed to shrink: see geoLabel.
    maxWidth: '260px',
    flexShrink: 1,
    padding: '0 var(--space-md)',
    border: '2px solid var(--color-accent)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-3)',
    color: 'var(--color-accent-strong)',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  /** The quick picker is open in the column; tapping again closes it. */
  geoButtonOffen: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    minHeight: 'var(--tap-min)',
    minWidth: '150px',
    // Capped, and allowed to shrink: see geoLabel.
    maxWidth: '260px',
    flexShrink: 1,
    padding: '0 var(--space-md)',
    border: '2px solid var(--color-accent)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-accent)',
    color: '#fff',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  geoButtonHindernisOffen: {
    minHeight: 'var(--tap-min)',
    minWidth: '150px',
    padding: '0 var(--space-md)',
    border: '2px solid var(--color-warning)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-warning)',
    color: '#fff',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
    flexShrink: 0,
  },
  /** Inside an obstruction: the one tap back to planned ground. */
  geoButtonHindernisEnde: {
    minHeight: 'var(--tap-min)',
    minWidth: '150px',
    padding: '0 var(--space-md)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-warning)',
    color: '#fff',
    fontSize: 'var(--font-base)',
    fontWeight: 800,
    fontFamily: 'inherit',
    cursor: 'pointer',
    flexShrink: 0,
  },
  geoButtonHindernis: {
    minHeight: 'var(--tap-min)',
    minWidth: '150px',
    padding: '0 var(--space-md)',
    border: '2px solid var(--color-warning)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--color-warning-text)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
    flexShrink: 0,
  },
  geoLabel: {
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    // DIN names run to 71 characters ("Blättrige, feinschichtige Metamorphite
    // (z. B. Glimmerschiefer, Phyllit)"). Unbounded, that grew the button to
    // 651px and pushed Beenden's right edge to 1064 on a 1024px screen — the
    // stop control simply gone, with no scrollbar to reveal it, until the drill
    // passed the boundary. The common names are short enough to show in full.
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },
  hatch: {
    width: '28px',
    height: '28px',
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
  },
  geoRueckmeldung: {
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--color-success-strong)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },
  geoFehler: {
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    color: 'var(--color-danger-strong)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
};
