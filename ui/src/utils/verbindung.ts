import type { ApiHealth, SourceHealth } from '../hooks/useWebSocket';

export type Connectivity = 'online' | 'offline' | 'unknown';

export interface VerbindungsMeldung {
  label: string;
  /** A token name, resolved against the theme by the caller. */
  farbe: 'success' | 'danger' | 'warning' | 'neutral';
}

/**
 * How long one message stays up before the indicator switches to the next.
 *
 * Only ever used when there is more than one to show. Four seconds is slow
 * enough to read at a glance and fast enough that a worker standing at the
 * machine sees both within a few seconds — and nothing on the screen moves
 * while a single problem is showing, which is the normal case.
 */
export const MELDUNG_WECHSEL_MS = 4_000;

/** What a dead data source is called, in the words the Datenquelle screen uses. */
function quelleOhneDaten(sourceType: string): string {
  if (sourceType === 'mqtt') return 'MQTT offline';
  if (sourceType === 'serial') return 'USB offline';
  if (sourceType === 'replay') return 'Replay offline';
  // Short on purpose: the indicator's width is fixed (Header's `statusText`),
  // and a label wider than that box is the layout shift this was pinned to
  // prevent. Unreachable today — every source maps above — which is exactly
  // why it must not be the one label nobody measured.
  return 'Keine Daten';
}

/**
 * Everything wrong with this kiosk's connections, worst first — or a single
 * „Verbunden" when there is nothing wrong.
 *
 * Three independent questions share one indicator, because the header has room
 * for one and is already carrying the phase stepper during a recording. When
 * more than one is answered badly the indicator cycles through them
 * (`MELDUNG_WECHSEL_MS`) rather than showing the worst and hiding the rest: on
 * site the box is both the data source *and* the uplink, so a box that dies
 * takes out two of the three at once, and an indicator that reported only one
 * of them would have a technician fixing half the problem.
 *
 * **Data arriving comes first.** A failed upload is buffered and retried — the
 * measurements survive. A source that is down means readings that never
 * existed, so it is the only one of the three that loses data, and it is the
 * one to read first.
 *
 * Internet before the platform, and the platform not at all while the internet
 * is down: it cannot be asked, so claiming it is unreachable would be
 * guessing. `unknown` and `unconfigured` on either side claim nothing — a
 * bench kiosk with no credentials and no broker is not a fault.
 */
export function verbindungsMeldungen(
  connectivity: Connectivity,
  apiHealth: ApiHealth,
  sourceHealth: SourceHealth = 'unknown',
  sourceType = 'mqtt',
): VerbindungsMeldung[] {
  // Nothing has been observed yet — including, deliberately, nothing about the
  // data source: the first websocket frames arrive together.
  if (connectivity === 'unknown') return [{ label: 'Verbinde...', farbe: 'neutral' }];

  const meldungen: VerbindungsMeldung[] = [];

  if (sourceHealth === 'disconnected') {
    meldungen.push({ label: quelleOhneDaten(sourceType), farbe: 'danger' });
  }

  if (connectivity === 'offline') {
    meldungen.push({ label: 'Offline', farbe: 'danger' });
  } else if (apiHealth === 'unreachable') {
    meldungen.push({ label: 'Server offline', farbe: 'warning' });
  } else if (apiHealth === 'rejected') {
    meldungen.push({ label: 'Kein Zugriff', farbe: 'warning' });
  }

  if (meldungen.length === 0) return [{ label: 'Verbunden', farbe: 'success' }];
  return meldungen;
}

/**
 * Which message is up on a given tick.
 *
 * Pure and separate from the timer so the rotation is testable, and so a
 * message set that shrinks while the timer is past its end cannot index off
 * the array — the indicator wraps instead of going blank.
 */
export function aktuelleMeldung(
  meldungen: VerbindungsMeldung[],
  tick: number,
): VerbindungsMeldung {
  if (meldungen.length === 0) return { label: 'Verbunden', farbe: 'success' };
  return meldungen[Math.abs(tick) % meldungen.length];
}

/**
 * A key that changes exactly when the *set* of messages does.
 *
 * The rotation restarts on it, so a problem that clears mid-cycle does not
 * leave the indicator sitting on a stale message until the next tick, and a
 * new problem is shown immediately rather than up to four seconds later.
 */
export function meldungsSchluessel(meldungen: VerbindungsMeldung[]): string {
  return meldungen.map((m) => m.label).join('|');
}
