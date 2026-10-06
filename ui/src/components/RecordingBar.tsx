import { useState, useEffect } from 'react';
import type { RecordingState, UploadProgress, OperatingMode } from '../hooks/useWebSocket';
import { isVerpressenMode, hasPipeHandling } from '../utils/operating-mode';

interface Props {
  currentPage: string;
  elementName?: string;
  recordingState: RecordingState;
  uploadProgress: UploadProgress | null;
}

type SessionStatus = 'idle' | 'recording' | 'ended' | 'empty' | 'uploading' | 'uploaded' | 'partial';

interface ExportOption {
  stream: string;
  label: string;
  count: number;
  exported: boolean;
}

export function RecordingBar({ currentPage, elementName, recordingState, uploadProgress }: Props) {
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

  async function setMode(mode: OperatingMode) {
    if (mode === operatingMode) return;
    setError(null);
    try {
      const res = await fetch('/api/recording/mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, sessionId: recordingState.sessionId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Fehler ${res.status}`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function stopRecording() {
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

  const inVerpressen = isVerpressenMode(operatingMode);
  const modeToggle = operatingMode ? (
    <div style={styles.modeToggle}>
      <button
        style={operatingMode === 'bohren' ? styles.modeButtonActive : styles.modeButton}
        onClick={() => setMode('bohren')}
      >
        B
      </button>
      <button
        style={inVerpressen ? styles.modeButtonActive : styles.modeButton}
        onClick={() => { if (!inVerpressen) setMode('austausch'); }}
      >
        V
      </button>
    </div>
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

      {status === 'recording' && (
        <div style={styles.recordingRow}>
          <span style={styles.redDot} />
          <span style={styles.recordingLabel}>
            {operatingMode && hasPipeHandling(operatingMode) && rohrwechsel?.phase === 'rohrwechsel'
              ? 'Pausiert'
              : 'Aufzeichnung'}
          </span>
          <span style={styles.elapsed}>
            <ElapsedTime startedAt={recordingState.startedAt} />
          </span>
          {modeToggle}
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
          {modeToggle}
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
          {modeToggle}
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
          {modeToggle}
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

function ElapsedTime({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!startedAt) return null;
  const secs = Math.floor((now - startedAt) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return <>{m}:{String(s).padStart(2, '0')}</>;
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
  redDot: {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    backgroundColor: 'var(--color-danger)',
    display: 'inline-block',
    flexShrink: 0,
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  recordingLabel: {
    fontSize: '1.1rem',
    fontWeight: 700,
    color: 'var(--color-danger)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  elapsed: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
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
  modeToggle: {
    display: 'flex',
    gap: '2px',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  modeButton: {
    minHeight: '64px',
    minWidth: '64px',
    padding: '0 0.75rem',
    fontSize: '1.2rem',
    fontWeight: 600,
    fontFamily: 'inherit',
    border: 'none',
    cursor: 'pointer',
    backgroundColor: 'var(--surface-0)',
    color: 'var(--text-muted)',
  },
  modeButtonActive: {
    minHeight: '64px',
    minWidth: '64px',
    padding: '0 0.75rem',
    fontSize: '1.2rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    border: 'none',
    cursor: 'pointer',
    backgroundColor: 'var(--color-accent)',
    color: '#fff',
  },
};
