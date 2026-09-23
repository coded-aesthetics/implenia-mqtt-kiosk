import { useState, useRef, useCallback } from 'react';
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

export function ReplayPanel({
  state, loading, onPlay, onPause, onStop, onSetSpeed, onSeek, onLoad,
}: Props) {
  const [fileInput, setFileInput] = useState('');
  const [showFileInput, setShowFileInput] = useState(!state.file);
  const sliderRef = useRef<HTMLInputElement>(null);

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

  // File not loaded — show the load UI
  if (!state.file || showFileInput) {
    return (
      <div style={styles.panel}>
        <div style={styles.loadRow}>
          <span style={styles.replayBadge}>REPLAY</span>
          <input
            type="text"
            value={fileInput}
            onChange={(e) => setFileInput(e.target.value)}
            placeholder="Pfad zur Dump-Datei (z.B. assets/bohrung_g8_marktbreit_mqtt.txt)"
            style={styles.fileInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && fileInput.trim()) {
                onLoad(fileInput.trim());
                setShowFileInput(false);
              }
            }}
          />
          <button
            onClick={() => {
              if (fileInput.trim()) {
                onLoad(fileInput.trim());
                setShowFileInput(false);
              }
            }}
            disabled={loading || !fileInput.trim()}
            style={{
              ...styles.controlButton,
              ...styles.loadButton,
              opacity: loading || !fileInput.trim() ? 0.5 : 1,
            }}
          >
            {loading ? '...' : 'Laden'}
          </button>
          {state.file && (
            <button
              onClick={() => setShowFileInput(false)}
              style={{ ...styles.controlButton, ...styles.dimButton }}
            >
              ✕
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <div style={styles.mainRow}>
        {/* Left: badge + file info */}
        <div style={styles.infoSection}>
          <span style={styles.replayBadge}>REPLAY</span>
          <button
            onClick={() => setShowFileInput(true)}
            style={styles.fileButton}
            title={state.file}
          >
            {basename(state.file)}
          </button>
          <span style={styles.statsText}>
            {state.readingCount.toLocaleString('de-DE')} aufgenommen
          </span>
        </div>

        {/* Center: transport controls + timeline */}
        <div style={styles.transportSection}>
          {/* Play / Pause */}
          <button
            onClick={state.playing ? onPause : onPlay}
            style={styles.playButton}
            disabled={loading}
          >
            {state.playing ? '⏸' : '▶'}
          </button>

          {/* Stop */}
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

        {/* Right: position info */}
        <div style={styles.positionSection}>
          <span style={styles.positionText}>
            {state.position.toLocaleString('de-DE')} / {state.totalMessages.toLocaleString('de-DE')}
          </span>
          {state.fastForwarding && (
            <span style={styles.ffBadge}>Seeking...</span>
          )}
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
  replayBadge: {
    fontSize: '0.8rem',
    fontWeight: 700,
    color: '#ffffff',
    backgroundColor: '#7c4dff',
    padding: '4px 10px',
    borderRadius: '6px',
    letterSpacing: '0.05em',
    flexShrink: 0,
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
    // Custom range styling via CSS class below
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
  ffBadge: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: '#ffffff',
    backgroundColor: '#e65100',
    padding: '2px 8px',
    borderRadius: '4px',
    animation: 'pulse 1s ease-in-out infinite',
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
};
