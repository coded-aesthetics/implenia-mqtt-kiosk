import { useState, useEffect } from 'react';
import { imageDataURI, findByNr } from '@coded-aesthetics/din4023';
import type { RecordingState, UploadProgress } from '../hooks/useWebSocket';
import { hasPipeHandling } from '../utils/operating-mode';
import { navigate } from '../hooks/useHashRouter';
import { shouldConfirmGeology } from '../utils/geology-stop';
import { farbeVon, nameVon } from '../utils/geologie';
import type { GeologieErfassung } from '../hooks/useGeologieErfassung';

interface Props {
  currentPage: string;
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

export function RecordingBar({ currentPage, elementName, recordingState, uploadProgress, geologie }: Props) {
  const rohrwechsel = recordingState.rohrwechsel;
  const operatingMode = recordingState.operatingMode;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUploadResult, setLastUploadResult] = useState<'uploaded' | 'partial' | null>(null);
  const [emptyWarning, setEmptyWarning] = useState(false);
  const [exportOptions, setExportOptions] = useState<ExportOption[]>([]);
  const [exportTick, setExportTick] = useState(0);

  // Remember the element name across recording → upload → idle transitions.
  // recordingState.elementName goes null after upload completes, but the
  // "Wiederaufnehmen" button still needs the name.
  const [lastElementName, setLastElementName] = useState<string | null>(null);
  useEffect(() => {
    if (recordingState.elementName) {
      setLastElementName(recordingState.elementName);
    }
  }, [recordingState.elementName]);
  const effectiveElementName = recordingState.elementName ?? lastElementName;

  // "Wiederaufnehmen" state (undo auto-completion after upload)
  const [resumePending, setResumePending] = useState(false);
  const [resumed, setResumed] = useState(false);

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
      setResumePending(false);
      setResumed(false);
      setLastElementName(recordingState.elementName);
    }
  }, [recordingState.active, recordingState.elementName]);

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

  // Same for the resume confirmation. Without it the bar stays up on *every*
  // screen until the next recording starts — including the element list, where
  // it costs the row of resume tiles its space at 1024x768 — reporting a
  // resume the worker has long since acted on.
  useEffect(() => {
    if (!resumed) return;
    const id = setTimeout(() => setResumed(false), 10_000);
    return () => clearTimeout(id);
  }, [resumed]);

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

  // Show on element/bohren pages, while recording, or while showing post-upload state
  const hasPostUploadState = lastUploadResult !== null || resumed || emptyWarning;
  // The geology sign-off carries its own Beenden and Zurück. A second Beenden
  // in the bar below it would stop without the profile — the one outcome that
  // screen exists to prevent.
  if (currentPage === 'geologie') return null;
  if (currentPage !== 'element' && currentPage !== 'bohren' && !recordingState.active && !hasPostUploadState) return null;

  async function startRecording() {
    if (!elementName) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/recording/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elementName }),
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
        const name = recordingState.elementName;
        navigate(name ? `geologie/${encodeURIComponent(name)}` : 'geologie');
        return;
      }
    }
    await stopNow();
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

  async function resumeElement() {
    const name = effectiveElementName;
    if (!name) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/elements/${encodeURIComponent(name)}/complete`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Fehler ${res.status}`);
      }
      setResumed(true);
      setResumePending(false);
    } catch (err) {
      setError((err as Error).message);
      setResumePending(false);
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
          {loading ? 'Wird gestartet...' : 'Aufzeichnung beginnen'}
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
          <span style={styles.elementNameLaufend}>{effectiveElementName}</span>
          {geologieButtons}
          {geologie?.rueckmeldung && (
            <span style={styles.geoRueckmeldung}>✓ {geologie.rueckmeldung}</span>
          )}
          {geologie?.fehler && (
            <span style={styles.geoFehler}>{geologie.fehler}</span>
          )}
          {/*
            Still worded, and still the widest control here. It ends the
            element, releases the upload and writes the Ausführungsdatum —
            recoverable via "Wiederaufnehmen", but not something to leave to
            icon recognition.
          */}
          <button
            style={{ ...styles.button, ...styles.stopButton }}
            onClick={stopRecording}
            disabled={loading}
          >
            Beenden
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

      {status === 'uploaded' && !resumed && (
        <div style={styles.recordingRow}>
          <span style={styles.successIcon}>✓</span>
          <span style={styles.successLabel}>Erfolgreich hochgeladen</span>
          <button
            style={{
              ...styles.button,
              ...(resumePending ? styles.resumeButtonConfirm : styles.resumeButtonDefault),
            }}
            onClick={() => { if (resumePending) resumeElement(); else setResumePending(true); }}
            disabled={loading}
          >
            {resumePending ? 'Wirklich wiederaufnehmen?' : 'Wiederaufnehmen'}
          </button>
        </div>
      )}

      {resumed && (
        <div style={styles.recordingRow}>
          <span style={styles.successIcon}>✓</span>
          <span style={styles.successLabel}>Element wiederaufgenommen</span>
        </div>
      )}

      {status === 'partial' && uploadProgress && (
        <div style={styles.recordingRow}>
          <span style={styles.warningIcon}>!</span>
          <span style={styles.warningLabel}>
            {uploadProgress.sensorsFailed} Sensoren fehlgeschlagen
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
  recordingRow: {
    display: 'flex',
    alignItems: 'center',
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
  stopButton: {
    backgroundColor: 'var(--color-danger-strong)',
    color: '#fff',
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
  resumeButtonDefault: {
    backgroundColor: 'var(--color-accent-strong)',
    color: '#fff',
  },
  resumeButtonConfirm: {
    backgroundColor: 'var(--color-accent)',
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
    flexShrink: 0,
    /*
     * Measured at 1024x768: with both geology buttons at their 150px floor and
     * Beenden at 180, the name has 428px to work with — about 31 characters,
     * which covers every element name the pilot sites use ("Pfahl 2.1 Achse
     * C/14 P-0147" is 27 and renders in full).
     *
     * Capped below that anyway, because the failure past it is the bad kind:
     * the row is `nowrap`, so an unbounded name pushes Beenden off a screen
     * with no scrollbar — the same way a 71-character DIN name once did (see
     * geoLabel). Losing the tail of an unusually long name beats losing the
     * stop button, and the header still shows it in full on the element screen.
     */
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
    fontSize: 'var(--font-sm)',
    color: 'var(--color-danger)',
    marginBottom: '0.5rem',
  },
  /** Like recordingRow, but it must never wrap. See the comment at its use. */
  recordingRowFest: {
    display: 'flex',
    alignItems: 'center',
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
