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
  /** German, user-facing. Null while the last Rohrwechsel looked plausible. */
  warning: string | null;
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
    warning: null,
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
 */
export function applyClampPressure(
  state: DrillState,
  pressure: number,
  settings: RohrwechselSettings,
  now: number,
): ClampResult {
  if (!Number.isFinite(pressure)) return { state, transition: null };

  if (state.phase === 'bohren') {
    if (pressure < settings.closeThreshold) return { state, transition: null };

    // Only from the second change onwards. The first has no baseline —
    // recording may have started with pipes already in the ground, and a
    // warning about that would be noise, not information.
    const drilled =
      state.depthAtLastChange !== null && state.lastDepth !== null
        ? state.lastDepth - state.depthAtLastChange
        : null;
    const warning = drilled === null ? null : describeDrilled(drilled, settings);

    return {
      state: {
        ...state,
        phase: 'rohrwechsel',
        phaseSince: now,
        depthAtLastChange: state.lastDepth ?? state.depthAtLastChange,
        warning,
        implausibleChanges: state.implausibleChanges + (warning ? 1 : 0),
      },
      transition: 'rohrwechsel-start',
    };
  }

  if (pressure >= settings.openThreshold) return { state, transition: null };

  const reopened: DrillState = {
    ...state,
    phase: 'bohren',
    phaseSince: now,
    pipeCount: state.pipeCount + 1,
  };

  if (settings.depthMode !== 'inkrementell' || state.lastRaw === null) {
    return { state: reopened, transition: 'rohrwechsel-ende' };
  }

  // The clamp has opened: the new pipe is in and the string is coupled again.
  // The bit never moved, so wherever the carriage sits now must map to the
  // depth we froze.
  const newOffset = state.holeDepth - state.lastRaw;

  // A Rohrverlängerung can only ever push the offset up. A step of zero or
  // less means this was not one — most likely the string being pulled back
  // out, which cycles the clamp the same way. Keeping the old offset lets the
  // depth follow the carriage back up, which is roughly right, instead of
  // inventing a jump.
  if (newOffset <= state.offset) {
    return {
      state: {
        ...reopened,
        pipeCount: state.pipeCount,
        implausibleChanges: state.implausibleChanges + 1,
        warning:
          'Klemmbacke war zu, aber es wurde kein neues Bohrrohr erkannt. Die Bohrtiefe ' +
          'läuft unverändert weiter — bitte die angezeigte Tiefe prüfen.',
      },
      transition: 'rohrwechsel-ende',
    };
  }

  return {
    state: { ...reopened, offset: newOffset, lastDepth: state.holeDepth },
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
 */
export function observeDepth(
  state: DrillState,
  raw: number,
  settings: RohrwechselSettings,
): DepthResult {
  if (!Number.isFinite(raw)) return { state, depth: state.lastDepth };

  if (settings.depthMode === 'inkrementell') {
    if (state.phase === 'rohrwechsel') {
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
  implausibleChanges: number;
  phaseSince: number | null;
}

export function toStatus(state: DrillState): DrillStatus {
  return {
    phase: state.phase,
    pipeCount: state.pipeCount,
    offset: state.offset,
    warning: state.warning,
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
    implausibleChanges: num(p.implausibleChanges, 0),
  };
}
