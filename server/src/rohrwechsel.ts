/**
 * Rohrverlängerung (pipe extension) handling.
 *
 * A drilling rig can only drill one Bohrrohr length at a time — 2 m or 3 m,
 * depending on the site. When that length is used up, drilling is interrupted:
 *
 *   1. the lower Klemmbacke closes and holds the pipe string in the ground
 *   2. the Drehantrieb runs Linkslauf and unscrews itself from the pipe
 *   3. it travels back up the mast; the excavator lays a new Bohrrohr in place
 *   4. Rechtslauf screws the new pipe into the old one and into the drive
 *   5. the Klemmbacke opens and drilling continues
 *
 * Everything the rig publishes during that window is real but is not drilling:
 * Drehzahl, Drehmoment and Vorschub come from the drive unscrewing itself, and
 * left in they corrupt every average. So the window is clipped.
 *
 * **How depth arrives depends on the rig** — see `DepthMode`. Some
 * manufacturers publish an absolute depth over CAN; rigs Implenia retrofits
 * publish the position of the Drehantrieb on the mast, which runs backwards by
 * a pipe length at every change. Both are in the fleet, so both are supported
 * and the choice is per machine.
 *
 * This module is the pure state machine for all of it: no side effects, and no
 * knowledge of MQTT, SQLite or the clock beyond what callers pass in.
 */

export type DrillPhase = 'bohren' | 'rohrwechsel';

/**
 * Where the depth a rig publishes comes from.
 *
 * - `absolut` — the rig reports the depth of the hole. It holds still while
 *   the string is clamped, because the bit has not moved. Nothing to correct.
 * - `inkrementell` — the rig reports the Schlittenweg, how far the Drehantrieb
 *   has travelled down the mast. It runs *backwards* during a Rohrwechsel and
 *   then restarts from the top while the bit is still at the bottom of the
 *   hole, so a running offset has to be carried:
 *
 *       tiefe = schlittenweg + offset
 *
 *   Confirmed against a retrofitted rig in the field: `Bohrgeraet/Tiefe` swept
 *   −6.8 … 7.5 m about forty times while the hole reached 43 m. See
 *   `assets/reference/README.md`.
 */
export type DepthMode = 'absolut' | 'inkrementell';

export const DEPTH_MODES: Record<DepthMode, string> = {
  absolut: 'Absolute Tiefe (vom Gerät)',
  inkrementell: 'Schlittenweg (nachgerüstet)',
};

export function isDepthMode(value: string): value is DepthMode {
  return value === 'absolut' || value === 'inkrementell';
}

export interface RohrwechselSettings {
  depthMode: DepthMode;
  /** Nominal Bohrrohr length in metres. Site-dependent — usually 2 or 3. */
  pipeLength: number;
  /** The Klemmbacke counts as closed at or above this pressure. */
  closeThreshold: number;
  /**
   * ...and as open again below this one. The gap between the two is
   * deliberate: a single threshold would flap on every bit of sensor noise and
   * clip half the drilling data.
   */
  openThreshold: number;
  /**
   * How far the depth drilled between two Rohrwechsel may deviate from
   * `pipeLength` before the kiosk says so (metres).
   */
  tolerance: number;
}

export interface DrillState {
  phase: DrillPhase;
  /** Bohrrohre in the ground. 1 while the first one is being drilled. */
  pipeCount: number;
  /** Metres added to a raw reading to get the true depth. Always 0 in `absolut`. */
  offset: number;
  /**
   * Deepest true depth reached — the bottom of the hole.
   *
   * In `inkrementell` this, not the last reading, is what the offset is
   * rebuilt from: the bit rests on the hole bottom when drilling stops, so a
   * brief lift before the Klemmbacke closes must not shorten the depth we
   * resume at. It also absorbs the lag between the clamp physically closing
   * and the kiosk seeing the pressure rise.
   */
  holeDepth: number;
  /** Raw value of the most recent depth reading, before any correction. */
  lastRaw: number | null;
  /** True depth of the most recent reading. */
  lastDepth: number | null;
  /** True depth when the previous Rohrwechsel began. The baseline for the check. */
  depthAtLastChange: number | null;
  /**
   * Whether the Klemmbacke has ever been seen *open*.
   *
   * The arming condition. Thresholds are a guess until a rig proves them: the
   * G08 capture publishes `Bohrgeraet/Klemmdruck` in the range 1609 … 5558,
   * nowhere near the 100/50 the defaults suggest, and against those defaults
   * every reading counts as "closed". Without this, the first message would
   * start a Rohrwechsel that never ends, and a whole shift would be clipped
   * out of the upload and the export. So nothing is clipped until the clamp
   * has been observed on both sides of the two thresholds at least once.
   */
  clampSeenOpen: boolean;
  /** When the first Klemmbacke reading arrived. Null before any did. */
  clampSince: number | null;
  /** German, user-facing. Null while the last Rohrwechsel looked plausible. */
  warning: string | null;
  /**
   * When the current warning was raised.
   *
   * A warning outlives the Rohrwechsel that caused it on purpose — the worker
   * is handling a pipe while it is up, and only afterwards can they go into
   * the settings. But a red banner that simply stays there is noise, so the
   * screen lets it be tapped away, and this is what tells a freshly raised
   * warning apart from the one that was already acknowledged.
   */
  warningSince: number | null;
  /** Rohrwechsel that did not add up. */
  implausibleChanges: number;
  /** When the current phase started. Null before the first transition. */
  phaseSince: number | null;
}

export const DEFAULT_SETTINGS: RohrwechselSettings = {
  // The conservative default: pass the rig's depth through untouched. A wrong
  // choice here shows up as an implausible depth per pipe within one change.
  depthMode: 'absolut',
  pipeLength: 2,
  closeThreshold: 100,
  openThreshold: 50,
  tolerance: 0.3,
};

export function initialDrillState(): DrillState {
  return {
    phase: 'bohren',
    pipeCount: 1,
    offset: 0,
    holeDepth: 0,
    lastRaw: null,
    lastDepth: null,
    depthAtLastChange: null,
    clampSeenOpen: false,
    clampSince: null,
    warning: null,
    warningSince: null,
    implausibleChanges: 0,
    phaseSince: null,
  };
}

function formatMeters(value: number): string {
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * How long the Klemmbacke may read "closed" without ever reading "open"
 * before the kiosk says the thresholds do not fit this rig.
 *
 * Long enough that a recording started mid-Rohrwechsel does not trigger it —
 * a pipe change takes a minute or two — and short enough that a technician
 * setting the machine up finds out within the first hole.
 */
export const THRESHOLD_WARNING_AFTER_MS = 5 * 60_000;

/**
 * Shown when the Klemmbacke has read "zu" from the first message on and never
 * once read "offen". Says explicitly that nothing is being hidden, so the
 * worker knows the recording is intact and can keep going.
 */
export const THRESHOLD_WARNING =
  'Die Klemmbacke meldet durchgehend „zu" und war noch nie offen. Die Schwellwerte ' +
  'passen vermutlich nicht zu diesem Gerät. Es wird nichts ausgeblendet — alle ' +
  'Messwerte werden aufgezeichnet und hochgeladen. Bitte in den Einstellungen unter ' +
  '„Rohrverlängerung" den aktuellen Wert ablesen und die Schwellen danach setzen.';

export type DrillTransition = 'rohrwechsel-start' | 'rohrwechsel-ende' | null;

export interface ClampResult {
  state: DrillState;
  transition: DrillTransition;
}

/**
 * Feed a Klemmbacke pressure reading to the machine.
 *
 * Closing starts the clipping window and checks the depth drilled since the
 * last change. Opening ends it, counts the new pipe, and — in `inkrementell` —
 * rebuilds the offset from where the carriage actually ended up.
 *
 * `drilling` is what the rig is doing, and it changes what a closed clamp
 * *means*. While grouting it holds the string steady for most of the phase
 * (81% of it on the G08 capture) and no Bohrrohr is being added: the phase is
 * still tracked, so clipping resumes correctly the moment the worker switches
 * back to Bohren, but nothing is counted, no depth is corrected and nothing is
 * called implausible — there is no pipe to check.
 */
export function applyClampPressure(
  state: DrillState,
  pressure: number,
  settings: RohrwechselSettings,
  now: number,
  drilling = true,
): ClampResult {
  if (!Number.isFinite(pressure)) return { state, transition: null };

  const seen: DrillState = {
    ...state,
    clampSince: state.clampSince ?? now,
    clampSeenOpen: state.clampSeenOpen || pressure < settings.openThreshold,
  };

  if (seen.phase === 'bohren') {
    if (pressure < settings.closeThreshold) return { state: seen, transition: null };

    // Not armed yet: this clamp has never been seen open, so "closed" may
    // simply be what every reading looks like against thresholds meant for a
    // different rig. Clipping on that would swallow the entire session, so
    // hold off and — once it is clear this is not just a recording that began
    // mid-Rohrwechsel — say so.
    if (!seen.clampSeenOpen) {
      const stuck =
        seen.clampSince !== null && now - seen.clampSince >= THRESHOLD_WARNING_AFTER_MS;
      if (!stuck || seen.warning === THRESHOLD_WARNING) return { state: seen, transition: null };
      return {
        state: { ...seen, warning: THRESHOLD_WARNING, warningSince: now },
        transition: null,
      };
    }

    // Only from the second change onwards. The first has no baseline —
    // recording may have started with pipes already in the ground, and a
    // warning about that would be noise, not information.
    const drilled =
      drilling && seen.depthAtLastChange !== null && seen.lastDepth !== null
        ? seen.lastDepth - seen.depthAtLastChange
        : null;
    const warning = drilled === null ? null : describeDrilled(drilled, settings);

    return {
      state: {
        ...seen,
        phase: 'rohrwechsel',
        phaseSince: now,
        // Cleared while grouting: a baseline taken before or during Verpressen
        // says nothing about the next pipe, and checking against it would
        // report a Rohrwechsel as implausible for no reason.
        depthAtLastChange: drilling ? (seen.lastDepth ?? seen.depthAtLastChange) : null,
        warning,
        warningSince: warning ? now : null,
        implausibleChanges: seen.implausibleChanges + (warning ? 1 : 0),
      },
      transition: 'rohrwechsel-start',
    };
  }

  if (pressure >= settings.openThreshold) return { state: seen, transition: null };

  const reopened: DrillState = {
    ...seen,
    phase: 'bohren',
    phaseSince: now,
    // Carried across the transition deliberately: the worker was busy with a
    // Bohrrohr while it was up, and going into the settings is something they
    // can only do once the pipe is in. `warningSince` bounds it — the screen
    // lets an acknowledged warning be tapped away.
    warning: seen.warning,
    warningSince: seen.warningSince,
    pipeCount: drilling ? seen.pipeCount + 1 : seen.pipeCount,
  };

  // No Bohrrohr was added: while grouting the clamp cycles to *remove* pipe,
  // so rebuilding the offset from the carriage would push the depth the wrong
  // way with every cycle — and those depths are uploaded, because nothing is
  // clipped during Verpressen.
  if (!drilling) return { state: reopened, transition: 'rohrwechsel-ende' };

  if (settings.depthMode !== 'inkrementell' || seen.lastRaw === null) {
    return { state: reopened, transition: 'rohrwechsel-ende' };
  }

  // The clamp has opened: the new pipe is in and the string is coupled again.
  // The bit never moved, so wherever the carriage sits now must map to the
  // depth we froze.
  const newOffset = seen.holeDepth - seen.lastRaw;

  // A Rohrverlängerung can only ever push the offset up. A step of zero or
  // less means this was not one — most likely the string being pulled back
  // out, which cycles the clamp the same way. Keeping the old offset lets the
  // depth follow the carriage back up, which is roughly right, instead of
  // inventing a jump.
  if (newOffset <= seen.offset) {
    return {
      state: {
        ...reopened,
        pipeCount: seen.pipeCount,
        implausibleChanges: seen.implausibleChanges + 1,
        warning:
          'Klemmbacke war zu, aber es wurde kein neues Bohrrohr erkannt. Die Bohrtiefe ' +
          'läuft unverändert weiter — bitte die angezeigte Tiefe prüfen.',
        warningSince: now,
      },
      transition: 'rohrwechsel-ende',
    };
  }

  return {
    state: { ...reopened, offset: newOffset, lastDepth: seen.holeDepth },
    transition: 'rohrwechsel-ende',
  };
}

/**
 * What to tell the worker about the depth drilled since the last Rohrwechsel,
 * or null when it is what it should be.
 */
function describeDrilled(drilled: number, settings: RohrwechselSettings): string | null {
  if (Math.abs(drilled - settings.pipeLength) <= settings.tolerance) return null;

  if (drilled < settings.tolerance) {
    // Includes the negative case: a Schlittenweg read as an absolute depth
    // runs backwards at every change.
    // Two changes in a row with nothing drilled in between is what a threshold
    // sitting inside the clamp's normal pressure range looks like.
    return (
      'Rohrwechsel ohne Bohrfortschritt erkannt. Möglicherweise ist der Schwellwert ' +
      'der Klemmbacke falsch eingestellt — bitte in den Einstellungen unter ' +
      '„Rohrverlängerung" prüfen.'
    );
  }

  const base =
    `Seit dem letzten Rohrwechsel wurden ${formatMeters(drilled)} m gebohrt, ` +
    `erwartet sind ${formatMeters(settings.pipeLength)} m (Rohrlänge). `;

  // A consistent over- or under-reading of the same factor is a calibration
  // problem, so turn the complaint into the correction to make. The machine
  // works in already-calibrated values, so what it can offer is the factor to
  // multiply the existing one by — which is all the screen needs.
  if (drilled > 0) {
    const factor = settings.pipeLength / drilled;
    return (
      base +
      'Wenn das bei jedem Rohr so ist, stimmt die Kalibrierung der Bohrtiefe nicht — ' +
      `der Faktor müsste mit ${factor.toLocaleString('de-DE', {
        minimumFractionDigits: 3, maximumFractionDigits: 3,
      })} multipliziert werden (Einstellungen → Kalibrierung).`
    );
  }

  return base + 'Bitte die Aufzeichnung und die Einstellung der Tiefenmessung prüfen.';
}

export interface DepthResult {
  state: DrillState;
  /** The depth to record, or null when the reading carried none. */
  depth: number | null;
}

/**
 * Feed a depth reading to the machine and get back the depth to record.
 *
 * In `absolut` that is the reading itself. In `inkrementell` it is the reading
 * plus the accumulated offset, and during a Rohrwechsel it is the frozen hole
 * bottom — the carriage is travelling up the mast and its position is not a
 * depth at all.
 *
 * Freezing is the one thing that must not happen while `drilling` is false:
 * during Verpressen the string is being pulled *out*, so the depth genuinely
 * changes while the clamp is closed, and holding it at the hole bottom would
 * upload a flat line for the whole grouting phase.
 */
export function observeDepth(
  state: DrillState,
  raw: number,
  settings: RohrwechselSettings,
  drilling = true,
): DepthResult {
  if (!Number.isFinite(raw)) return { state, depth: state.lastDepth };

  if (settings.depthMode === 'inkrementell') {
    if (drilling && state.phase === 'rohrwechsel') {
      return { state: { ...state, lastRaw: raw }, depth: state.holeDepth };
    }
    const depth = raw + state.offset;
    return {
      state: {
        ...state,
        lastRaw: raw,
        lastDepth: depth,
        holeDepth: Math.max(state.holeDepth, depth),
      },
      depth,
    };
  }

  return {
    state: {
      ...state,
      lastRaw: raw,
      lastDepth: raw,
      holeDepth: Math.max(state.holeDepth, raw),
    },
    depth: raw,
  };
}

/** Whether a reading taken right now belongs to a Rohrwechsel and must be clipped. */
export function isClipped(state: DrillState): boolean {
  return state.phase === 'rohrwechsel';
}

/** What the UI needs to show. Kept separate from the internal bookkeeping. */
export interface DrillStatus {
  phase: DrillPhase;
  pipeCount: number;
  /** Metres currently added to the rig's reading. Always 0 in `absolut`. */
  offset: number;
  warning: string | null;
  /** When `warning` was raised, so the screen can tell a new one from a known one. */
  warningSince: number | null;
  implausibleChanges: number;
  phaseSince: number | null;
}

export function toStatus(state: DrillState): DrillStatus {
  return {
    phase: state.phase,
    pipeCount: state.pipeCount,
    offset: state.offset,
    warning: state.warning,
    warningSince: state.warningSince,
    implausibleChanges: state.implausibleChanges,
    phaseSince: state.phaseSince,
  };
}

/** Restore a state persisted with JSON.stringify, or null if it is unusable. */
export function parseDrillState(json: string | null | undefined): DrillState | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const p = parsed as Partial<DrillState>;
  if (p.phase !== 'bohren' && p.phase !== 'rohrwechsel') return null;
  if (!Number.isFinite(p.pipeCount)) return null;

  const base = initialDrillState();
  const num = (v: unknown, fallback: number): number =>
    Number.isFinite(v) ? (v as number) : fallback;
  const numOrNull = (v: unknown): number | null =>
    Number.isFinite(v) ? (v as number) : null;

  return {
    ...base,
    ...p,
    phase: p.phase,
    pipeCount: p.pipeCount as number,
    offset: num(p.offset, 0),
    holeDepth: num(p.holeDepth, 0),
    lastRaw: numOrNull(p.lastRaw),
    lastDepth: numOrNull(p.lastDepth),
    depthAtLastChange: numOrNull(p.depthAtLastChange),
    clampSeenOpen: p.clampSeenOpen === true,
    clampSince: numOrNull(p.clampSince),
    warningSince: numOrNull(p.warningSince),
    implausibleChanges: num(p.implausibleChanges, 0),
  };
}
