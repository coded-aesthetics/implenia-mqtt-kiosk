import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * The installed version, and the only place an update is ever announced.
 *
 * It replaces a banner that pushed itself across the top of every screen for a
 * service action nobody had asked for. An update is not urgent: the kiosk keeps
 * recording and uploading on the version it has, and installing one restarts
 * the app. So it waits here, in the header, next to the version it would
 * replace — visible to anybody who looks, invisible to a worker who does not.
 *
 * Tapping follows the house pattern for consequential actions: no dialog, no
 * second screen. The first tap turns the control into "Wirklich updaten?" and
 * the second one installs. A tap anywhere else cancels.
 *
 * With no update known, a tap checks for one — which is also the only way to
 * verify the updater without waiting out the poll interval.
 */

interface Props {
  /** The running version, from /status. */
  version: string;
  /** The newer version the updater found, if any. */
  available: string | null;
  /** True once the download has started; the app restarts shortly after. */
  applying: boolean;
  /**
   * Where the update came from. A USB stick is worth naming: it tells whoever
   * is looking that somebody put it there deliberately, rather than it
   * arriving from GitHub on its own.
   */
  source?: 'github' | 'usb' | null;
}

type Mode = 'idle' | 'checking' | 'confirming';

export function VersionIndicator({ version, available, applying, source = null }: Props) {
  const [mode, setMode] = useState<Mode>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // "Tapping anything else cancels" — the same escape the destructive buttons
  // elsewhere give, so an accidental first tap costs nothing.
  useEffect(() => {
    if (mode !== 'confirming') return;
    const cancel = (e: PointerEvent) => {
      if (boxRef.current && e.target instanceof Node && boxRef.current.contains(e.target)) return;
      setMode('idle');
    };
    document.addEventListener('pointerdown', cancel, true);
    return () => document.removeEventListener('pointerdown', cancel, true);
  }, [mode]);

  // A message is a transient answer ("aktuell", or why an install was refused),
  // not a state to get stuck in.
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(t);
  }, [message]);

  async function checkNow() {
    setMode('checking');
    setMessage(null);
    try {
      const res = await fetch('/api/update/check', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { version?: string | null };
      // `available` arrives over the WebSocket, so a found update shows itself;
      // only "nothing there" needs saying.
      if (!body.version) setMessage('Aktuell');
    } catch {
      setMessage('Keine Verbindung');
    } finally {
      setMode('idle');
    }
  }

  async function install() {
    setMode('idle');
    try {
      const res = await fetch('/api/update', { method: 'POST' });
      if (!res.ok) {
        // The server refuses while a recording runs, and its reason is the
        // actionable one. Showing it beats a button that does nothing.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage(body.error ?? `Fehler ${res.status}`);
      }
    } catch {
      setMessage('Update konnte nicht gestartet werden');
    }
  }

  if (applying) {
    return (
      <div style={{ ...styles.box, ...styles.applying }} aria-live="polite">
        <span style={styles.line}>Update läuft</span>
        <span style={styles.lineSmall}>App startet neu</span>
      </div>
    );
  }

  if (mode === 'confirming' && available) {
    return (
      <div ref={boxRef} style={styles.wrap}>
        <button type="button" onClick={install} style={{ ...styles.box, ...styles.confirm }}>
          {/* "Wirklich {verb}?" per the house pattern, and the verb is the one
              the offer used — upgraden, not updaten. */}
          <span style={styles.line}>Wirklich upgraden?</span>
          <span style={styles.lineSmall}>App startet neu</span>
        </button>
      </div>
    );
  }

  if (available) {
    return (
      <div ref={boxRef} style={styles.wrap}>
        <button
          type="button"
          onClick={() => setMode('confirming')}
          style={{ ...styles.box, ...styles.offered }}
        >
          {/* One line naming both versions and the action. Two stacked lines
              read as a label with a subtitle; this reads as the button it is. */}
          <span style={styles.lineAccent}>
            von v{version} auf v{available} upgraden{source === 'usb' ? ' (USB)' : ''}
          </span>
        </button>
        {message && <span style={styles.message}>{message}</span>}
      </div>
    );
  }

  return (
    <div ref={boxRef} style={styles.wrap}>
      <button
        type="button"
        onClick={checkNow}
        disabled={mode === 'checking'}
        style={{ ...styles.box, ...styles.plain }}
        title="Nach Updates suchen"
      >
        <span style={styles.lineMuted}>{mode === 'checking' ? 'Suche…' : `v${version}`}</span>
        {message && <span style={styles.lineSmall}>{message}</span>}
      </button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  // 48px to match the header's other controls, not the 64px the worker screens
  // use: the bar itself is pinned at 64px tall on a 768px display, and the
  // settings and microphone buttons set this convention already.
  box: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '48px',
    padding: '0 0.75rem',
    gap: '1px',
    border: '1px solid transparent',
    borderRadius: '8px',
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'center',
  },
  plain: {},
  offered: {
    background: 'var(--surface-2)',
    borderColor: 'var(--color-accent)',
  },
  confirm: {
    background: 'var(--color-accent)',
    borderColor: 'var(--color-accent)',
  },
  applying: {
    background: 'var(--color-accent)',
    cursor: 'default',
  },
  // 1rem floor per CLAUDE.md: everything here is information somebody reads.
  line: { fontSize: '1rem', fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' },
  lineSmall: { fontSize: '1rem', color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap' },
  lineMuted: { fontSize: '1rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' },
  lineAccent: { fontSize: '1rem', fontWeight: 700, color: 'var(--color-accent)', whiteSpace: 'nowrap' },
  message: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: '4px',
    maxWidth: '22rem',
    padding: '0.5rem 0.75rem',
    fontSize: '1rem',
    lineHeight: 1.4,
    color: 'var(--text-primary)',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: '0 8px 24px -12px var(--overlay-shadow)',
    zIndex: 60,
  },
};
