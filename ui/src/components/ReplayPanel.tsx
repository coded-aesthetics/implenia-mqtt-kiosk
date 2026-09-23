import { useState, useRef, useCallback, useEffect } from 'react';
import type { ReplaySpeed } from '../hooks/useReplay';

interface ReplayState {
  file: string | null;
  totalMessages: number;
  position: number;
  speed: ReplaySpeed;
  playing: boolean;
  fastForwarding: boolean;
  currentOffsetMs: number;
  durationMs: number;
  sessionId: number | null;
  readingCount: number;
}

interface Props {
  state: ReplayState;
  loading: boolean;
  error: string | null;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSetSpeed: (speed: ReplaySpeed) => void;
  onSeek: (offsetMs: number) => void;
  onLoad: (file: string) => void;
}

const SPEEDS: ReplaySpeed[] = [1, 10, 60, 'max'];

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function speedLabel(speed: ReplaySpeed): string {
  return speed === 'max' ? '⏩' : `${speed}×`;
}

function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

type PanelMode = 'input' | 'transport';

export function ReplayPanel({
  state, loading, error, onPlay, onPause, onStop, onSetSpeed, onSeek, onLoad,
}: Props) {
  const [fileInput, setFileInput] = useState('');
  // Drive mode from server state — once a file is loaded, show transport.
  // The user can switch back to input mode to load a different file.
  const [mode, setMode] = useState<PanelMode>(state.file ? 'transport' : 'input');
  const sliderRef = useRef<HTMLInputElement>(null);

  // When the server state changes from no-file to file-loaded, switch to
  // transport mode. This is the feedback: the panel visually changes.
  const prevFile = useRef(state.file);
  useEffect(() => {
    if (state.file && !prevFile.current) {
      setMode('transport');
    } else if (!state.file && prevFile.current) {
      setMode('input');
    }
    prevFile.current = state.file;
  }, [state.file]);

  // Debounce seek while dragging
  const seekTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const offsetMs = Number(e.target.value);
    if (seekTimeout.current) clearTimeout(seekTimeout.current);
    seekTimeout.current = setTimeout(() => {
      onSeek(offsetMs);
    }, 300);
  }, [onSeek]);

  const progress = state.durationMs > 0
    ? (state.currentOffsetMs / state.durationMs) * 100
    : 0;

  const handleLoad = () => {
    if (fileInput.trim()) onLoad(fileInput.trim());
  };

  // ── Badge: reflects actual state ───────────────────────────────────
  const badgeInfo = (() => {
    if (error) return { label: 'FEHLER', color: '#f44336' };
    if (loading) return { label: 'LADEN...', color: '#e65100' };
    if (state.fastForwarding) return { label: 'SEEK', color: '#e65100' };
    if (state.playing) return { label: 'PLAY', color: '#4caf50' };
    if (state.file && state.position > 0) return { label: 'PAUSE', color: '#7c4dff' };
    if (state.file) return { label: 'BEREIT', color: '#7c4dff' };
    return { label: 'REPLAY', color: '#555' };
  })();

  // ── Input mode ─────────────────────────────────────────────────────
  if (mode === 'input') {
    return (
      <div style={styles.panel}>
        <div style={styles.loadRow}>
          <span style={{ ...styles.badge, backgroundColor: badgeInfo.color }}>
            {badgeInfo.label}
          </span>
          <input
            type="text"
            value={fileInput}
            onChange={(e) => setFileInput(e.target.value)}
            placeholder="Pfad zur Dump-Datei (z.B. assets/bohrung_g8_marktbreit_mqtt.txt)"
            style={styles.fileInput}
            onKeyDown={(e) => { if (e.key === 'Enter') handleLoad(); }}
          />
          <button
            onClick={handleLoad}
            disabled={loading || !fileInput.trim()}
            style={{
              ...styles.controlButton,
              ...styles.loadButton,
              opacity: loading || !fileInput.trim() ? 0.5 : 1,
            }}
          >
            Laden
          </button>
          {/* Let the user switch back to transport if a file is already loaded */}
          {state.file && (
            <button
              onClick={() => setMode('transport')}
              style={{ ...styles.controlButton, ...styles.dimButton }}
            >
              ✕
            </button>
          )}
          {error && (
            <span style={styles.errorText}>{error}</span>
          )}
        </div>
      </div>
    );
  }

  // ── Transport mode ─────────────────────────────────────────────────
  return (
    <div style={styles.panel}>
      <div style={styles.mainRow}>
        {/* Left: badge + file info */}
        <div style={styles.infoSection}>
          <span style={{ ...styles.badge, backgroundColor: badgeInfo.color }}>
            {badgeInfo.label}
          </span>
          <button
            onClick={() => { setFileInput(state.file ?? ''); setMode('input'); }}
            style={styles.fileButton}
            title={state.file ?? ''}
          >
            {basename(state.file ?? '')}
          </button>
          <span style={styles.statsText}>
            {state.totalMessages.toLocaleString('de-DE')} msgs
            {state.readingCount > 0 && (
              <> · {state.readingCount.toLocaleString('de-DE')} rec</>
            )}
          </span>
        </div>

        {/* Center: transport controls + timeline */}
        <div style={styles.transportSection}>
          <button
            onClick={state.playing ? onPause : onPlay}
            style={{
              ...styles.playButton,
              ...(state.playing ? styles.playButtonActive : {}),
            }}
            disabled={loading}
          >
            {state.playing ? '⏸' : '▶'}
          </button>

          <button
            onClick={onStop}
            style={{ ...styles.controlButton, ...styles.stopButton }}
            disabled={loading}
          >
            ⏹
          </button>

          {/* Timeline */}
          <div style={styles.timelineWrapper}>
            <span style={styles.timeLabel}>{formatTime(state.currentOffsetMs)}</span>
            <div style={styles.sliderContainer}>
              <div
                style={{
                  ...styles.sliderFill,
                  width: `${progress}%`,
                }}
              />
              <input
                ref={sliderRef}
                type="range"
                min={0}
                max={state.durationMs}
                value={state.currentOffsetMs}
                onChange={handleSliderChange}
                style={styles.slider}
                className="replay-slider"
                disabled={loading}
              />
            </div>
            <span style={styles.timeLabel}>{formatTime(state.durationMs)}</span>
          </div>

          {/* Speed buttons */}
          <div style={styles.speedRow}>
            {SPEEDS.map((s) => (
              <button
                key={String(s)}
                onClick={() => onSetSpeed(s)}
                style={{
                  ...styles.speedButton,
                  ...(state.speed === s ? styles.speedButtonActive : {}),
                }}
              >
                {speedLabel(s)}
              </button>
            ))}
          </div>
        </div>

        {/* Right: position */}
        <div style={styles.positionSection}>
          <span style={styles.positionText}>
            {state.position.toLocaleString('de-DE')} / {state.totalMessages.toLocaleString('de-DE')}
          </span>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    backgroundColor: '#1a0a2e',
    borderTop: '2px solid #7c4dff',
    padding: '0.5rem 1.5rem',
    minHeight: '56px',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  mainRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    width: '100%',
  },
  loadRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    width: '100%',
  },
  infoSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    flexShrink: 0,
  },
  badge: {
    fontSize: '0.8rem',
    fontWeight: 700,
    color: '#ffffff',
    padding: '4px 10px',
    borderRadius: '6px',
    letterSpacing: '0.05em',
    flexShrink: 0,
    minWidth: '56px',
    textAlign: 'center' as const,
    transition: 'background-color 0.3s ease',
  },
  fileButton: {
    fontSize: '0.95rem',
    color: '#b39ddb',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '4px',
    fontFamily: 'var(--font-mono)',
    maxWidth: '220px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  statsText: {
    fontSize: '0.9rem',
    color: '#8899aa',
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },
  transportSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flex: 1,
    minWidth: 0,
  },
  playButton: {
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    border: '2px solid #7c4dff',
    backgroundColor: '#2a1050',
    color: '#ffffff',
    fontSize: '1.2rem',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontFamily: 'inherit',
    transition: 'all 0.15s ease',
  },
  playButtonActive: {
    borderColor: '#4caf50',
    backgroundColor: '#1a3020',
  },
  controlButton: {
    height: '40px',
    minWidth: '40px',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontFamily: 'inherit',
    fontSize: '1rem',
  },
  stopButton: {
    backgroundColor: '#2a1050',
    color: '#b39ddb',
    border: '1px solid #4a3070',
  },
  loadButton: {
    backgroundColor: '#7c4dff',
    color: '#ffffff',
    padding: '0 1.25rem',
    fontWeight: 600,
    fontSize: '1rem',
  },
  dimButton: {
    backgroundColor: 'transparent',
    color: '#8899aa',
    fontSize: '1.1rem',
  },
  timelineWrapper: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flex: 1,
    minWidth: 0,
  },
  timeLabel: {
    fontSize: '0.85rem',
    color: '#b39ddb',
    fontFamily: 'var(--font-mono)',
    flexShrink: 0,
    minWidth: '50px',
    textAlign: 'center' as const,
  },
  sliderContainer: {
    position: 'relative' as const,
    flex: 1,
    height: '8px',
    backgroundColor: '#2a1050',
    borderRadius: '4px',
    overflow: 'visible',
  },
  sliderFill: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    height: '100%',
    backgroundColor: '#7c4dff',
    borderRadius: '4px',
    pointerEvents: 'none' as const,
    transition: 'width 0.3s ease',
  },
  slider: {
    position: 'absolute' as const,
    top: '-10px',
    left: 0,
    width: '100%',
    height: '28px',
    margin: 0,
    padding: 0,
    cursor: 'pointer',
    WebkitAppearance: 'none' as never,
    appearance: 'none' as never,
    background: 'transparent',
  },
  speedRow: {
    display: 'flex',
    gap: '2px',
    borderRadius: '6px',
    overflow: 'hidden',
    flexShrink: 0,
  },
  speedButton: {
    padding: '6px 12px',
    fontSize: '0.9rem',
    fontWeight: 600,
    backgroundColor: '#2a1050',
    color: '#8899aa',
    border: 'none',
    cursor: 'pointer',
    minHeight: '36px',
    minWidth: '44px',
    fontFamily: 'inherit',
    transition: 'all 0.15s ease',
  },
  speedButtonActive: {
    backgroundColor: '#7c4dff',
    color: '#ffffff',
  },
  positionSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexShrink: 0,
  },
  positionText: {
    fontSize: '0.85rem',
    color: '#8899aa',
    fontFamily: 'var(--font-mono)',
  },
  fileInput: {
    flex: 1,
    padding: '0.5rem 0.75rem',
    fontSize: '1rem',
    backgroundColor: '#2a1050',
    border: '1px solid #4a3070',
    borderRadius: '8px',
    color: '#ffffff',
    outline: 'none',
    fontFamily: 'var(--font-mono)',
    minHeight: '44px',
    boxSizing: 'border-box' as const,
  },
  errorText: {
    fontSize: '0.9rem',
    color: '#f44336',
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
};
