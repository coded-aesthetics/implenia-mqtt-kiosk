import { useState, useEffect } from 'react';
import { navigate } from '../hooks/useHashRouter';
import type { OperatingMode, ApiHealth, SourceHealth } from '../hooks/useWebSocket';
import {
  aktuelleMeldung, meldungsSchluessel, verbindungsMeldungen, MELDUNG_WECHSEL_MS,
} from '../utils/verbindung';
import { useUhrzeit } from '../hooks/useUhrzeit';
import { PhaseStepper, type AusrichtenSlot } from './PhaseStepper';
import { VersionIndicator } from './VersionIndicator';
import logo from '../../assets/implenia-logo.png';

interface Props {
  connectivity: 'online' | 'offline' | 'unknown';
  /**
   * Whether the Implenia platform is answering. Reported beside the internet
   * state in the same indicator, because a kiosk with internet and no backend
   * uploads exactly as much as one with neither — see utils/verbindung.ts.
   */
  apiHealth?: ApiHealth;
  /**
   * Whether sensor data is arriving. Shares the one indicator with the two
   * above — see utils/verbindung.ts for why it goes first when several are
   * wrong at once.
   */
  sourceHealth?: SourceHealth;
  sourceType?: string;
  hasApiKey: boolean;
  currentPage: string;
  configSection?: string;
  /**
   * The channel open on the Datenstrom screen, so the back button can return to
   * the stream instead of leaving it. In the URL and not in component state for
   * the same reason the route carries it: a reload must not change what a
   * button does.
   */
  datenstromTopic?: string;
  pageTitle?: string;
  voiceSupported?: boolean;
  isListening?: boolean;
  wakeWordPhase?: 'idle' | 'listening' | 'dictating';
  onMicPress?: () => void;
  onMicRelease?: () => void;
  commentQueueCount?: number;
  /** An element is being recorded: the update offer shrinks to a dot. */
  recording?: boolean;
  operatingMode?: OperatingMode | null;
  /**
   * Switch what the rig is doing. Omit to render the phase read-only.
   *
   * In the header because the control and the indicator for it belong together
   * — and in the *centre* rather than beside the icon cluster on the right: a
   * mis-tap here changes whether Klemmbacke readings are clipped out of the
   * upload, so it stays away from where hands already go for the mic and the
   * settings.
   */
  onModeChange?: (mode: OperatingMode) => void;
  /**
   * Hide the phase stepper on a page that would otherwise show it.
   *
   * For the geology sign-off's Beenden variant. There the stepper is not the
   * escape hatch it is at the phase step — that variant has its own
   * `Zurück zur Aufzeichnung` — and it is actively dangerous: stepping the
   * phase from there re-navigates to the route *without* `?beenden=1`, which
   * silently turns the one button the operator is aiming at from "Beenden"
   * into "Weiter zum Austausch". A glove catching the stepper instead of the
   * button would commit and return with the recording still running, which is
   * the "tapped Beenden, nothing ended" confusion the route flag exists to
   * remove.
   */
  hidePhaseStepper?: boolean;
  /**
   * The alignment screen as the stepper's first slot. Omit for an element that
   * does not have to be aimed (Vertikalneigung 0, or none given).
   *
   * Passed through rather than derived here: whether an element needs aligning
   * comes from its Vorgabe, which App already holds, and the stepper is the
   * one place a worker can always reach it from — with or without a running
   * recording, which is why it may appear when `operatingMode` is null.
   */
  ausrichten?: AusrichtenSlot;
  /**
   * The newer version the updater found, announced only by the version
   * indicator — there is no banner. An update is never urgent: the kiosk keeps
   * recording and uploading on the version it has.
   */
  updateAvailable?: string | null;
  updateApplying?: boolean;
  updateSource?: 'github' | 'usb' | null;
  /** Why the last apply gave up. The indicator shows it; nothing else does. */
  updateFailure?: string | null;
}

export function Header({ connectivity, apiHealth = 'unknown', sourceHealth = 'unknown', sourceType = 'mqtt', hasApiKey, currentPage, configSection,
  datenstromTopic, pageTitle, voiceSupported, isListening, wakeWordPhase, onMicPress, onMicRelease, commentQueueCount, recording = false, operatingMode, onModeChange, hidePhaseStepper, ausrichten, updateAvailable = null, updateApplying = false, updateSource = null, updateFailure = null }: Props) {
  const [version, setVersion] = useState('...');

  useEffect(() => {
    fetch('/status')
      .then((r) => r.json())
      .then((data) => setVersion(data.version))
      .catch(() => {});
  }, []);

  /*
   * One indicator, several things it may have to say.
   *
   * The header is the most contested space on the screen — it carries the
   * phase stepper during a recording — so a second and third dot were not an
   * option, and showing only the worst problem would hide the others: on site
   * the box is both the data source and the uplink, so one failure produces
   * two messages. They take turns instead.
   *
   * The tick only runs while there is more than one message. A single problem
   * sits still, which is both calmer and what makes the movement mean
   * something when it does happen.
   */
  const meldungen = verbindungsMeldungen(connectivity, apiHealth, sourceHealth, sourceType);
  const schluessel = meldungsSchluessel(meldungen);
  const [meldungsTick, setMeldungsTick] = useState(0);

  useEffect(() => {
    setMeldungsTick(0);
    if (meldungen.length < 2) return;
    const timer = setInterval(() => setMeldungsTick((t) => t + 1), MELDUNG_WECHSEL_MS);
    return () => clearInterval(timer);
    // `schluessel` is the dependency, not `meldungen`: the array is rebuilt on
    // every render and would restart the rotation before it ever advanced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schluessel, meldungen.length]);

  const uhrzeit = useUhrzeit();

  const verbindung = aktuelleMeldung(meldungen, meldungsTick);
  const connColor = `var(--color-${verbindung.farbe})`;
  const connLabel = verbindung.label;

  return (
    <div style={styles.bar}>
      {/* Left: logo + optional back button */}
      <div style={styles.leftSection}>
        {(currentPage === 'element' || currentPage === 'bohren' || currentPage === 'comments' || !!configSection || currentPage === 'sensors' || currentPage === 'datenstrom' || currentPage === 'rohrverlaengerung') && (
          <button
            onClick={() => {
              if (configSection) navigate('config');
              else if (currentPage === 'sensors') navigate('config/datenquelle');
              // A channel's detail goes back to the stream, not out of it; the
              // stream goes back to Messwerte, which is the card that opens it.
              else if (currentPage === 'datenstrom') navigate(datenstromTopic ? 'datenstrom' : 'config/messwerte');
              else if (currentPage === 'rohrverlaengerung') navigate('config/messwerte');
              else navigate('/');
            }}
            style={styles.backButton}
          >
            ←
          </button>
        )}
        <a
          href="#/"
          onClick={(e) => { e.preventDefault(); navigate('/'); }}
          style={styles.logoLink}
        >
          <img src={logo} alt="Implenia" style={styles.logo} />
        </a>
      </div>

      {/* Center: page title + phase badge */}
      <div style={styles.centerSection}>
        {pageTitle && <span style={styles.pageTitle}>{pageTitle}</span>}
        {/*
          Also on `geologie`, where it is the only way off the screen besides
          committing: the sign-off has one forward button and no second exit, so
          the way back from a mis-tapped phase step is the step itself. One way
          back, the same one as everywhere else. Not on that screen's Beenden
          variant, which has its own way back and where a phase step would
          change what the button does — see `hidePhaseStepper`.
        */}
        {(operatingMode || ausrichten) && !hidePhaseStepper
          && (currentPage === 'element' || currentPage === 'bohren' || currentPage === 'geologie' || currentPage === 'ausrichten') && (
          <PhaseStepper mode={operatingMode ?? null} onChange={onModeChange} ausrichten={ausrichten} />
        )}
      </div>

      {/* Right: connectivity + version + settings */}
      <div style={styles.rightSection}>
        {/*
          The clock sits on top of the connectivity label, inside the width that
          label already reserves, because the header has no spare width to give
          it: with the phase stepper up, an update offered and a comment queued,
          the element name in the centre is down to about a dozen pixels. Two
          lines in the column that is already there cost nothing, in every state
          — so the clock never has to move or collapse when a recording starts.
          It is the same two-line box the version indicator next to it uses.

          The dot stays outside the column, where it was, for the same reason:
          moving it onto the label's line would widen the cluster by its own
          12px plus a gap. It is nudged down instead, so it reads as belonging
          to the label under the clock rather than to the clock itself.
        */}
        <div style={styles.statusGroup}>
          <span style={{ ...styles.dot, backgroundColor: connColor }} />
          <div style={styles.statusColumn}>
            <span style={styles.clock}>{uhrzeit}</span>
            <span style={styles.statusText}>{connLabel}</span>
          </div>
        </div>
        <span style={styles.divider} />
        <VersionIndicator version={version} available={updateAvailable} applying={updateApplying} source={updateSource} failure={updateFailure} recording={recording} />
        {voiceSupported && (
          <button
            onPointerDown={onMicPress}
            onPointerUp={onMicRelease}
            onPointerLeave={onMicRelease}
            style={{
              ...styles.micButton,
              ...(isListening ? styles.micListening : {}),
              ...(wakeWordPhase === 'dictating' ? styles.micDictating : {}),
              ...(!isListening && !wakeWordPhase?.startsWith('dict') && wakeWordPhase === 'listening' ? styles.micPassive : {}),
            }}
            aria-label={isListening ? 'Spracherkennung aktiv' : wakeWordPhase === 'listening' ? 'Sagen Sie "Computer"' : 'Sprachbefehl'}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>
        )}
        {(commentQueueCount ?? 0) > 0 && (
          <button
            onClick={() => navigate('comments')}
            style={{
              ...styles.commentQueueButton,
              ...(currentPage === 'comments' ? styles.commentQueueActive : {}),
            }}
            aria-label={`${commentQueueCount} Kommentare`}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span style={styles.queueBadge}>{commentQueueCount}</span>
          </button>
        )}
        <a
          href="#/config"
          onClick={(e) => { e.preventDefault(); navigate('config'); }}
          style={{
            ...styles.settingsButton,
            ...(currentPage === 'config' ? styles.settingsActive : {}),
          }}
          aria-label="Einstellungen"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          {!hasApiKey && (
            <span style={styles.alertBadge}>!</span>
          )}
        </a>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.5rem 1.5rem',
    backgroundColor: 'var(--surface-0)',
    borderBottom: '1px solid var(--border)',
    minHeight: '64px',
  },
  leftSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  backButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    fontSize: '1.5rem',
    fontWeight: 700,
    lineHeight: 1,
    padding: 0,
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-2)',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: 'inherit',
  },
  logoLink: {
    display: 'flex',
    alignItems: 'center',
    textDecoration: 'none',
  },
  logo: {
    // 64, not 80: at 80 the logo alone pushed the bar to 96px — overriding its
    // own minHeight — and spent 12% of a 768px viewport on branding. 64 leaves
    // the header 80px tall, which is exactly a 64px tap target plus its padding.
    height: '64px',
    objectFit: 'contain' as const,
    borderRadius: '8px',
  },
  centerSection: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '0.75rem',
  },
  pageTitle: {
    // Element names are free text and the centre now shares its width with the
    // phase switch, so the title yields rather than pushing the switch off.
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '2.0rem',
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '0.02em',
  },
  rightSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minHeight: '48px',
  },
  statusGroup: {
    display: 'flex',
    // The dot belongs to the connectivity label, which is now the lower of two
    // lines, so the group is bottom-aligned and the dot nudged off that edge
    // rather than centred against a block it only half describes.
    alignItems: 'flex-end',
    gap: '0.75rem',
  },
  statusColumn: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-start',
  },
  dot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
    // Centres the dot on the label's text line: the line box is ~19px tall at
    // 0.95rem, so (19 - 12) / 2.
    marginBottom: '4px',
  },
  clock: {
    /*
     * The time of day, `HH:mm`. See hooks/useUhrzeit.ts for why there are no
     * seconds and why the tick re-aligns to the minute.
     *
     * It gets the primary text colour and 1.4rem while the connectivity label
     * under it stays muted, so the column reads clock-first — a worker glancing
     * up for the time should not have to pick it out of the status line.
     *
     * No width of its own: "14:32" is about 56px at this size, well inside the
     * 108px the label below already reserves, so the column's width is the
     * label's and the cluster beside it does not move. `tabular-nums` keeps it
     * that way through a digit change — the one thing that could still shift
     * the column once a minute.
     */
    fontSize: 'var(--font-md)',
    fontWeight: 600,
    lineHeight: 1.15,
    color: 'var(--text-primary)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap' as const,
  },
  statusText: {
    fontSize: '0.95rem',
    color: 'var(--text-muted)',
    /*
     * Fixed, because the message rotates.
     * „Verbunden" and „Server offline" are 19px apart, and a label that
     * resized every four seconds would walk the version indicator, the
     * microphone and the settings button back and forth beside it — the same
     * objection that kept the age out of the drilling screen's gauges.
     *
     * 108px is measured, not counted, and measured **in DejaVu Sans**: the
     * font stack is `"Segoe UI", system-ui, -apple-system, sans-serif` and a
     * kiosk installs `fonts-dejavu-core` and nothing else, so it renders the
     * last entry — 6% wider than this laptop's. Every label the indicator can
     * produce fits: Replay offline 104, Server offline 102, MQTT offline 96,
     * Verbunden 83.
     */
    minWidth: '108px',
    whiteSpace: 'nowrap' as const,
  },
  divider: {
    width: '1px',
    height: '20px',
    backgroundColor: 'var(--border)',
  },
  versionText: {
    fontSize: '0.9rem',
    color: 'var(--text-muted)',
  },
  settingsButton: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    borderRadius: '8px',
    color: 'var(--text-muted)',
    textDecoration: 'none',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
  },
  settingsActive: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
  },
  micButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    color: 'var(--text-muted)',
    backgroundColor: 'var(--surface-2)',
    border: '2px solid transparent',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'all 0.15s ease',
    fontFamily: 'inherit',
  },
  micListening: {
    color: 'var(--color-danger)',
    borderColor: 'var(--color-danger)',
    backgroundColor: 'var(--surface-0)',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  micPassive: {
    color: 'var(--color-accent)',
    borderColor: 'var(--color-accent)',
    backgroundColor: 'var(--surface-0)',
    animation: 'pulse 3s ease-in-out infinite',
  },
  micDictating: {
    color: 'var(--color-caution)',
    borderColor: 'var(--color-caution)',
    backgroundColor: 'var(--surface-0)',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  commentQueueButton: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    borderRadius: '8px',
    color: 'var(--color-caution)',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
  },
  commentQueueActive: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
  },
  queueBadge: {
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    minWidth: '18px',
    height: '18px',
    borderRadius: '9px',
    backgroundColor: 'var(--color-caution)',
    color: 'var(--text-primary)',
    fontSize: '11px',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    padding: '0 4px',
  },
  alertBadge: {
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    backgroundColor: 'var(--color-danger)',
    color: '#fff',
    fontSize: '12px',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  },
};
