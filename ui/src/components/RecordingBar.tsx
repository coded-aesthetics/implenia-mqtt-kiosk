import { useState, useEffect } from 'react';
import type { RecordingState, UploadProgress } from '../hooks/useWebSocket';

interface Props {
  currentPage: string;
  elementName?: string;
  recordingState: RecordingState;
  uploadProgress: UploadProgress | null;
}

type SessionStatus = 'idle' | 'recording' | 'ended' | 'empty' | 'uploading' | 'uploaded' | 'partial';

export function RecordingBar({ currentPage, elementName, recordingState, uploadProgress }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUploadResult, setLastUploadResult] = useState<'uploaded' | 'partial' | null>(null);
  const [emptyWarning, setEmptyWarning] = useState(false);

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

  // Only show on element page, or if recording is active for any element
  if (currentPage !== 'element' && !recordingState.active) return null;

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

  return (
    <div style={styles.bar}>
      {error && <div style={styles.error}>{error}</div>}

      {status === 'idle' && currentPage === 'element' && (
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
          <span style={styles.recordingLabel}>Aufzeichnung</span>
          <span style={styles.elapsed}>
            <ElapsedTime startedAt={recordingState.startedAt} />
          </span>
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
          <button
            style={{ ...styles.button, ...styles.uploadButton }}
            onClick={upload}
            disabled={loading}
          >
            {loading ? 'Wird vorbereitet...' : 'Daten hochladen'}
          </button>
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
    padding: '0.5rem 1.5rem',
    backgroundColor: '#0f0f23',
    borderTop: '1px solid #2a2a4a',
    minHeight: '64px',
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
    backgroundColor: '#388e3c',
    color: '#ffffff',
  },
  stopButton: {
    backgroundColor: '#d32f2f',
    color: '#ffffff',
  },
  uploadButton: {
    backgroundColor: '#388e3c',
    color: '#ffffff',
  },
  retryButton: {
    backgroundColor: '#e65100',
    color: '#ffffff',
  },
  redDot: {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    backgroundColor: '#f44336',
    display: 'inline-block',
    flexShrink: 0,
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  recordingLabel: {
    fontSize: '1.1rem',
    fontWeight: 700,
    color: '#f44336',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  elapsed: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: '#ffffff',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  count: {
    fontSize: '1rem',
    color: '#8899aa',
  },
  uploadLabel: {
    fontSize: '1rem',
    fontWeight: 600,
    color: '#ffffff',
  },
  progressBarOuter: {
    flex: 1,
    maxWidth: '300px',
    height: '12px',
    backgroundColor: '#2a2a4a',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  progressBarInner: {
    height: '100%',
    backgroundColor: '#388e3c',
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
    color: '#ffffff',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    minWidth: '3ch',
    textAlign: 'right',
  },
  successIcon: {
    fontSize: '1.6rem',
    fontWeight: 700,
    color: '#4caf50',
  },
  successLabel: {
    fontSize: '1.1rem',
    fontWeight: 600,
    color: '#4caf50',
  },
  warningIcon: {
    fontSize: '1.6rem',
    fontWeight: 700,
    color: '#e65100',
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    border: '2px solid #e65100',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  warningLabel: {
    fontSize: '1.1rem',
    fontWeight: 600,
    color: '#e65100',
  },
  error: {
    fontSize: '0.9rem',
    color: '#f44336',
    marginBottom: '0.5rem',
  },
};
