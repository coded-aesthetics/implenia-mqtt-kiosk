import { EventEmitter } from 'node:events';
import type { DataSource, SensorReading } from './data-source.js';
import {
  insertBuffer, pruneBuffer, insertSessionReading, getDrillState, setDrillState,
  getOperatingMode, setOperatingModeRow, clearSessionReadings,
  createSession, endSession, getActiveSession, getLatestSessionReadings,
} from './db.js';
import { parsePayload } from './parse-payload.js';
import { getResolverContext, resolveSensorKey } from './topic-resolver.js';
import { getSensorRole } from './sensor-meta.js';
import { mqttSource } from './mqtt.js';
import { deviceSource } from './device-source.js';
import { getTransport, type Transport } from './transport.js';
import { createLogger } from './logger.js';
import {
  applyClampPressure, applyDepthCorrection, initialDrillState, isClipped, observeDepth,
  parseDrillState, toStatus,
  type DepthCorrectionApplied, type DrillPhase, type DrillState, type DrillStatus,
} from './rohrwechsel.js';
import {
  getRohrwechselConfig, isClampTopic, type RohrwechselConfig,
} from './rohrwechsel-config.js';
import { applyCalibration, calibrationFor, isNeutral } from './calibration.js';
import {
  VolumeTracker, baselinesFromSession, getVolumeMappings, volumeSnapshot,
  type CumulativeVolumeMapping,
} from './volume-integration.js';

const log = createLogger('ingestion');

/** The operating mode, recorded as a `Status` reading. See recordStatusReading. */
const STATUS_TOPIC = 'kiosk/status';

/**
 * Log entries routed into the session by `attachLogSensor` in recording.ts.
 *
 * A copy of that module's `LOG_SENSOR_NAME`, not an import: this module is part
 * of an import cycle with it (`ingestion → mqtt → websocket → recording →
 * ingestion`), so reading its const here at module-body time throws on boot.
 * `log-topic.test.ts` pins them together.
 */
export const LOG_TOPIC = 'logs';

/**
 * A manual depth correction, recorded as a `Kommentar` reading. See
 * recordCorrectionComment.
 */
const COMMENT_TOPIC = 'kiosk/kommentar';

/** The element's free-text sensor, lowercased as the sensor map keys it. */
const COMMENT_SENSOR_KEY = 'kommentar';

/**
 * Topics the kiosk writes into a session itself and never emits.
 *
 * They belong in the upload and are no part of what a screen shows — and
 * `ElementDetail` renders one tile per reading it holds, so seeding them would
 * put a `status` tile and a raw JSON log line on the Messwerte screen after
 * every resume.
 */
const SELF_WRITTEN_TOPICS = new Set<string>([STATUS_TOPIC, LOG_TOPIC, COMMENT_TOPIC]);

export interface SensorMapEntry {
  sensorId: string;
  sensorType: string;
  /**
   * The sensor's semantic role (`depth`, `is_completed`, `geology_nr`, …) as
   * it stood when the session started, or undefined for a sensor that has
   * none — and for every session recorded before roles were persisted.
   *
   * Pinned to the session on purpose. See `sensorNameByRole` in recording.ts.
   */
  role?: string;
  /**
   * Where the sensor's values come from — `mqtt`, `kiosk`, `user`, `server` —
   * as it stood when the session started, or undefined for a session recorded
   * before this was persisted.
   *
   * Pinned for the same reason as the role, and it decides something just as
   * consequential: only the machine's own telemetry may be reduced onto a grid
   * on the way out, because only there does an empty cell honestly mean "the
   * sensor had nothing to report". See `GRIDDABLE_SOURCES` in csv-upload.ts.
   */
  source?: string;
  /**
   * The sensor's name as the platform spells it.
   *
   * The map is keyed by the *lowercased* name, because that is what a resolved
   * topic gives, and the real spelling is not recoverable from it. It has to
   * be kept: a completion write is addressed to the platform by sensor name
   * (`string_sensors: { Ausführungsdatum: … }`), and `ausführungsdatum` is a
   * different sensor — or a new one. It is also the spelling a German error
   * message about a missing sensor should show the operator.
   */
  name?: string;
}

/**
 * What the rig is doing.
 *
 * - `bohren`     — drilling down, Rohrwechsel adds pipes
 * - `austausch`  — slurry exchange, no pipe handling
 * - `einbauen`   — steel core insertion, no pipe handling
 * - `auffuellen` — pipe retraction with depth tracking (inverse of bohren)
 */
export type OperatingMode = 'bohren' | 'austausch' | 'einbauen' | 'auffuellen';

const OPERATING_MODES: ReadonlySet<string> = new Set(['bohren', 'austausch', 'einbauen', 'auffuellen']);

const LEGACY_MODE_MAP: Record<string, OperatingMode> = {
  verpressen: 'austausch',
};

export function isOperatingMode(value: string): value is OperatingMode {
  return OPERATING_MODES.has(value);
}

export function normalizeOperatingMode(value: string): OperatingMode | null {
  if (isOperatingMode(value)) return value;
  return LEGACY_MODE_MAP[value] ?? null;
}

export function isRetracting(mode: OperatingMode): boolean {
  return mode === 'austausch' || mode === 'einbauen' || mode === 'auffuellen';
}

/**
 * Whether the drive handles pipes in this mode, and the clamp closing can
 * therefore mean a pipe change.
 *
 * Only `bohren`, which reaches depth by adding 2 m or 3 m pipes, and
 * `auffuellen`, which removes them the same way. `austausch` and `einbauen`
 * handle no pipes at all.
 *
 * It read "all four modes" for a while, on the premise that the clamp can
 * trigger a pipe change in any mode that handles pipes — true, but those two
 * do not. What it cost is specific and was measured on the G08 rig: in
 * `austausch` the clamp *rests closed*, holding the string while the slurry is
 * exchanged (min 1654, max 5256, mean 4250, against a close threshold of
 * 4000), so the state machine sat in `rohrwechsel` for the entire phase and
 * clipped it. 3 848 of the phase's 3 886 depth readings were held back —
 * recorded, tagged, and excluded from the upload — leaving the platform a
 * one-second sliver of a 0.86 m retraction.
 *
 * The inversion is the whole point: in `bohren` and `auffuellen` the clamp is
 * open while the drive works and closes only to re-grip, which is what makes
 * "closed ⇒ pipe change" a sound proxy. In the other two its resting state is
 * closed, so it carries no information about pipes.
 *
 * What is given up: a pipe genuinely handled during `austausch` or `einbauen`
 * is no longer clipped, so its phantom depth would reach the series. Nobody
 * handles pipes there — and a depth change in those modes is real. The ~1 m
 * the drill rises before `einbauen` is the denser slurry pushing it up from
 * below, which is a measurement, not an artefact.
 */
export function hasPipeHandling(mode: OperatingMode): boolean {
  return mode === 'bohren' || mode === 'auffuellen';
}

interface ActiveSession {
  id: number;
  sensorMap: Map<string, SensorMapEntry>;
  drill: DrillState;
  rohrwechsel: RohrwechselConfig;
  operatingMode: OperatingMode;
  volumeTracker: VolumeTracker;
  /**
   * The synthetic topics the volume tracker emits under.
   *
   * Kept so they can be dropped when the session ends: they are deltas against
   * *this* element's starting total and mean nothing once it is finished.
   */
  volumeTopics: string[];
  /**
   * The topic the depth last arrived on, or null before it ever did.
   *
   * A manual correction has to reach the screen immediately, and on a rig
   * standing still — which is exactly when a worker counts pipes and notices
   * the drift — the next reading may be minutes away. This is what the
   * corrected value is re-emitted under. Kept per session rather than derived
   * from the sensor map because a topic is what `lastReadings` is keyed by.
   */
  depthTopic: string | null;
}

/** What a reading looks like after Rohrverlängerung handling. */
interface Corrected {
  /** The value to record. Differs from the raw one only for a corrected depth. */
  payload: string;
  /** The uncorrected value, when the payload was rewritten. */
  valueRaw: number | null;
  phase: DrillPhase;
  clipped: boolean;
}

/**
 * Enough decimals for any sensor the kiosk records, and no float noise.
 * Depth is metres, where a thousandth is a millimetre.
 */
function roundValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * A payload as a number, or NaN when it does not carry one.
 *
 * Deliberately the same parse the recording path uses, so the two can never
 * disagree about what a payload is: a value `parsePayload` reads as a number
 * but this one rejected would be recorded uncalibrated and would silently stop
 * the Klemmbacke from ever being detected. A blank payload stays NaN rather
 * than becoming 0 — a rig publishing nothing must not read as "clamp wide
 * open", which is exactly the wrong direction to guess in.
 */
function numericPayload(payload: string): number {
  return parsePayload(payload).valueNumeric ?? NaN;
}

/** German, two decimals — the Kommentar is read by people, not parsers. */
function meters(value: number): string {
  return value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** ...with an explicit sign, so a correction reads as a direction. */
function signedMeters(value: number): string {
  return `${value > 0 ? '+' : ''}${meters(value)}`;
}

/**
 * A refused depth correction.
 *
 * `kind` is what the route turns into a status: `input` is a 400, `state` a
 * 409. The message is German and actionable — it is shown to the worker on the
 * correction screen, and they cannot call anyone.
 */
export class DepthCorrectionError extends Error {
  constructor(message: string, readonly kind: 'input' | 'state') {
    super(message);
    this.name = 'DepthCorrectionError';
  }
}

export class DataIngestion extends EventEmitter {
  private source: DataSource;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private activeSession: ActiveSession | null = null;
  private pendingMode: OperatingMode | null = null;
  private started = false;

  private readonly onReading = (reading: SensorReading): void => {
    // Synthetic control topic: replay files can embed mode-switch events.
    if (reading.topic === 'kiosk/operating-mode') {
      const mode = reading.payload.trim();
      if (!isOperatingMode(mode)) return;
      if (this.activeSession) {
        this.setOperatingMode(mode);
      } else {
        this.pendingMode = mode;
        this.emit('operating-mode', mode);
      }
      return;
    }

    insertBuffer(reading.topic, reading.payload, reading.receivedAt);

    // Overrides and the shipped topic map resolve boxes whose topic names
    // differ from the sensor names; an unresolved topic still gets stored,
    // just without a sensor id — and is therefore never uploaded.
    const key = resolveSensorKey(reading.topic, getResolverContext());
    const corrected = this.applyRohrwechsel(reading, key);

    // Only a depth on a retrofitted rig is ever rewritten, and only then does
    // the live screen show something other than what arrived — the corrected
    // depth is the one the worker needs.
    this.emitReading({ ...reading, payload: corrected.payload, sensor: key });

    if (this.activeSession) {
      const mapping = key ? this.activeSession.sensorMap.get(key) : undefined;
      const { valueNumeric, valueText } = parsePayload(corrected.payload);

      insertSessionReading(
        this.activeSession.id,
        reading.topic,
        mapping?.sensorId ?? null,
        mapping?.sensorType ?? null,
        valueNumeric,
        valueText,
        { receivedAt: reading.receivedAt, valueRaw: corrected.valueRaw, phase: corrected.phase, clipped: corrected.clipped },
      );

      if (key) {
        const volResult = this.activeSession.volumeTracker.observe(
          key, valueNumeric ?? NaN,
        );
        if (volResult) {
          const volPayload = String(roundValue(volResult.volume));
          this.emitReading({
            topic: volResult.topic, payload: volPayload, receivedAt: reading.receivedAt,
            sensor: resolveSensorKey(volResult.topic, getResolverContext()),
          });
        }
      }
    }
  };

  /**
   * Run the reading through the Rohrverlängerung state machine and decide
   * which phase it belongs to.
   *
   * A Klemmbacke reading drives the phase. A depth reading is turned into a
   * true depth — which on a rig publishing the Schlittenweg means adding the
   * accumulated offset — and noted as the baseline for the per-pipe
   * plausibility check. Everything else just gets tagged, so a Drehzahl
   * recorded while the drive was unscrewing itself from the pipe never reaches
   * an average.
   *
   * Scoped to a recording session on purpose: the pipe count belongs to one
   * hole, and there is no hole until an element is being recorded.
   */
  private applyRohrwechsel(reading: SensorReading, key: string | null): Corrected {
    const session = this.activeSession;
    const raw = numericPayload(reading.payload);

    // Calibration is independent of the Rohrwechsel feature and applies even
    // when no Klemmbacke is configured: a miscalibrated sensor records wrong
    // values whether or not the rig changes pipes.
    const calibration = calibrationFor(key);
    const calibrated = applyCalibration(raw, calibration);
    const asRecorded: Corrected = Number.isFinite(raw) && !isNeutral(calibration)
      ? { payload: String(roundValue(calibrated)), valueRaw: raw, phase: 'bohren', clipped: false }
      : { payload: reading.payload, valueRaw: null, phase: 'bohren', clipped: false };

    if (!session) return asRecorded;

    const cfg = session.rohrwechsel;
    const mode = session.operatingMode;

    const retracting = isRetracting(mode);

    if (cfg.enabled && hasPipeHandling(mode) && isClampTopic(reading.topic, cfg.clampTopic)) {
      // Deliberately the raw value: the thresholds are set by watching what
      // the clamp actually publishes, so a calibration meant for a sensor of
      // the same name must not move them underneath the technician.
      const before = session.drill;
      const { state, transition } = applyClampPressure(
        before, raw, cfg, reading.receivedAt, retracting,
      );
      session.drill = state;

      // A warning can also be raised without a phase change — the thresholds
      // not fitting the rig is exactly that case — and it is the one the
      // worker most needs to see, so it gets pushed just the same.
      if (transition || state.warning !== before.warning) {
        // Persisted here and nowhere else: a phase change is the only moment
        // this state moves, and a restart that loses it mid-Rohrwechsel would
        // record the rest of the pipe change as drilling data. It is only
        // picked back up once something re-attaches the session — see
        // startRecording(), which nothing calls on boot today.
        try {
          setDrillState(session.id, JSON.stringify(state));
        } catch (err) {
          log.error('Could not persist Rohrwechsel state: %s', (err as Error).message);
        }
        if (transition === 'rohrwechsel-start') {
          log.info(
            'Rohrwechsel started at %s m (Rohr %d)',
            state.lastDepth?.toFixed(2) ?? 'unbekannt', state.pipeCount,
          );
        } else if (transition === 'rohrwechsel-ende') {
          log.info('Rohrwechsel finished — drilling Rohr %d', state.pipeCount);
        }
        if (state.warning && state.warning !== before.warning) {
          log.warn('Rohrwechsel: %s', state.warning);
        }
        this.emit('rohrwechsel', { transition, status: toStatus(state) });
      }

      return { ...asRecorded, phase: state.phase, clipped: this.clips(state) };
    }

    // Deliberately outside the `cfg.enabled` guard above: with no Klemmbacke
    // there is no phase and nothing is clipped, but the depth still carries
    // the worker's manual correction — see applyDepthCorrection. With nothing
    // to apply this is `absolut` arithmetic with an offset of 0, which is the
    // reading itself.
    if (key && getSensorRole(key) === 'depth' && Number.isFinite(raw)) {
      session.depthTopic = reading.topic;
      const { state, depth } = observeDepth(session.drill, calibrated, cfg, retracting);
      session.drill = state;

      if (depth !== null) {
        const rounded = roundValue(depth);
        return {
          payload: String(rounded),
          // The reading as it arrived, which is what makes a wrong offset or a
          // wrong calibration reconstructable later.
          valueRaw: rounded === raw ? null : raw,
          phase: this.phaseNow(state),
          clipped: this.clips(state),
        };
      }
    }

    return {
      ...asRecorded,
      phase: this.phaseNow(session.drill),
      clipped: this.clips(session.drill),
    };
  }

  /**
   * The phase a reading taken now belongs to.
   *
   * Always `bohren` when Rohrverlängerung is off, whatever the state machine
   * still holds. A clamp topic removed mid-element leaves a persisted
   * `rohrwechsel` phase that nothing can now end — and a reading tagged with it
   * is dropped from the geology depth series and from the upload.
   */
  private phaseNow(state: DrillState): DrillPhase {
    return this.activeSession?.rohrwechsel.enabled ? state.phase : 'bohren';
  }

  /**
   * Whether a reading taken now must be held back.
   *
   * `bohren` and `auffuellen` clip during rohrwechsel (clamp closed) — the
   * drive is handling a pipe, and its readings corrupt averages. `austausch`
   * and `einbauen` never clip, because no pipe is ever handled in them and
   * their clamp rests closed: see `hasPipeHandling`.
   */
  private clips(state: DrillState): boolean {
    const session = this.activeSession;
    if (!session?.rohrwechsel.enabled) return false;
    if (hasPipeHandling(session.operatingMode)) return isClipped(state);
    return false;
  }

  constructor(source: DataSource) {
    super();
    this.source = source;
  }

  /**
   * Swap the active data source — the transport switch. Stops the old source,
   * moves the reading listener, and starts the new one if we were running.
   */
  setSource(source: DataSource): void {
    if (source === this.source) return;
    const wasStarted = this.started;
    if (wasStarted) {
      this.source.off('reading', this.onReading);
      this.source.off('seek-start', this.onSeekStart);
      this.source.off('replay-start', this.onReplayStart);
      this.source.off('replay-stop', this.onReplayStop);
      this.source.stop();
    }
    // Another transport publishes other topics; keeping the old ones would
    // show a screen full of values nothing can ever update again.
    this.lastReadings.clear();
    this.source = source;
    if (wasStarted) {
      this.source.on('reading', this.onReading);
      this.source.on('seek-start', this.onSeekStart);
      this.source.on('replay-start', this.onReplayStart);
      this.source.on('replay-stop', this.onReplayStop);
      this.source.start();
    }
  }

  /** The source matching a transport key. */
  static sourceFor(transport: Transport): DataSource {
    return transport === 'serial' ? deviceSource : mqttSource;
  }

  get sourceConnected(): boolean {
    return this.source.connected;
  }

  get sourceType(): string {
    return this.source.sourceType;
  }

  /** What the rig is doing, or null when nothing is being recorded. */
  get operatingMode(): OperatingMode | null {
    return this.activeSession?.operatingMode ?? this.pendingMode;
  }

  /**
   * Switch operating mode. Persisted, so a restart mid-element does not
   * silently resume with the wrong clipping behaviour.
   */
  setOperatingMode(mode: OperatingMode): void {
    const session = this.activeSession;
    if (!session || session.operatingMode === mode) return;
    session.operatingMode = mode;
    // A mode switch invalidates the per-pipe baseline and the phase timing,
    // so the new mode starts fresh — no stale drilling baseline triggers a
    // false plausibility warning during Verpressen, and no stale phaseSince
    // causes immediate clipping.
    session.drill = {
      ...session.drill,
      phase: 'bohren',
      phaseSince: null,
      depthAtLastChange: null,
    };
    setOperatingModeRow(session.id, mode);
    this.recordStatusReading(session);
    log.info('Operating mode for session %d is now %s', session.id, mode);
    this.emit('operating-mode', mode);
  }

  /**
   * Record the current operating mode as a `Status` sensor reading.
   *
   * The Injektionsbohren protocol in implenia-web segments all KPIs by
   * phase using Status == 0 (bohren) / Status == 1 (verpressen). Without
   * these readings the protocol has no phase data and returns hasData: false.
   */
  private recordStatusReading(session: ActiveSession): void {
    const mapping = session.sensorMap.get('status');
    if (!mapping) return;
    const STATUS_MAP: Record<OperatingMode, number> = {
      bohren: 0,
      austausch: 1,
      einbauen: 2,
      auffuellen: 3,
    };
    const statusValue = STATUS_MAP[session.operatingMode];
    insertSessionReading(
      session.id, STATUS_TOPIC, mapping.sensorId, mapping.sensorType,
      statusValue, null,
    );
  }

  /**
   * Correct the depth of the hole being recorded, by `delta` metres.
   *
   * The arithmetic and every reason for it are in `applyDepthCorrection`; this
   * is the part with side effects. Three of them, in this order:
   *
   * 1. **Persisted immediately.** `drill_state` is otherwise written only at a
   *    phase change, which may be a pipe away or may never come — and a
   *    correction lost to a PM2 restart would leave the worker looking at the
   *    wrong depth again with no sign of why.
   * 2. **Re-emitted to the screens.** A worker corrects the depth while the
   *    rig is standing still, so waiting for the next reading would leave the
   *    old value on screen for minutes. Display only: this is the same instant
   *    re-stated, not a measurement, and recording it would put a depth
   *    reading in the session that the rig never sent — which is also what
   *    geology boundaries get dated against.
   * 3. **Written into the session as a `Kommentar`.** The depth series steps,
   *    and this is the only thing that tells anyone on the platform why. As a
   *    session reading rather than a live API call on purpose: it then uploads
   *    with the element, from a site with no connectivity just the same.
   *
   * A failed persist or a missing `Kommentar` sensor is logged and does not
   * fail the correction. The worker is looking at a corrected depth either
   * way, and refusing afterwards would leave them with a wrong one.
   */
  correctDepth(delta: number): DepthCorrectionApplied {
    const session = this.activeSession;
    if (!session) {
      throw new DepthCorrectionError(
        'Es läuft keine Aufzeichnung. Die Tiefe kann nur während einer Aufzeichnung ' +
        'korrigiert werden. Für einen dauerhaft falschen Nullpunkt: ' +
        'Einstellungen → Kalibrierung.',
        'state',
      );
    }

    const result = applyDepthCorrection(session.drill, delta);
    if (!result.ok) throw new DepthCorrectionError(result.error, result.kind);

    const { applied } = result;
    session.drill = applied.state;

    try {
      setDrillState(session.id, JSON.stringify(applied.state));
    } catch (err) {
      log.error('Could not persist depth correction: %s', (err as Error).message);
    }

    if (session.depthTopic) {
      const known = this.lastReadings.get(session.depthTopic);
      if (known) {
        this.emitReading({
          ...known,
          payload: String(roundValue(applied.to)),
          receivedAt: Date.now(),
        });
      }
    }

    this.recordCorrectionComment(session, applied);

    log.info(
      'Depth corrected: %s m -> %s m (%s m, total %s m on this element)',
      applied.from.toFixed(2), applied.to.toFixed(2),
      applied.delta.toFixed(2), applied.total.toFixed(2),
    );

    return applied;
  }

  /**
   * Note the correction in the element's `Kommentar` sensor.
   *
   * German and readable by whoever opens the element on the platform: the
   * numbers alone would not say that the step in the depth series is a
   * deliberate correction rather than a sensor fault. The running total is
   * included because it is the slip diagnosis — a wheel that needed three
   * metres on one hole needs a technician, not another correction.
   */
  private recordCorrectionComment(
    session: ActiveSession, applied: DepthCorrectionApplied,
  ): void {
    const mapping = session.sensorMap.get(COMMENT_SENSOR_KEY);
    if (!mapping) {
      log.warn(
        'Depth corrected, but this element has no "Kommentar" sensor — ' +
        'the correction is not part of the upload',
      );
      return;
    }

    const text =
      `Tiefe korrigiert: ${meters(applied.from)} m → ${meters(applied.to)} m ` +
      `(${signedMeters(applied.delta)} m; Korrektur auf diesem Element insgesamt ` +
      `${signedMeters(applied.total)} m)`;

    try {
      insertSessionReading(
        session.id, COMMENT_TOPIC, mapping.sensorId, mapping.sensorType, null, text,
      );
    } catch (err) {
      log.error('Could not record the depth correction comment: %s', (err as Error).message);
    }
  }

  /**
   * Metres the worker has corrected the depth by on the running element, or
   * null when nothing is being recorded.
   *
   * Separate from `drillStatus`, which is null unless a Klemmbacke is
   * configured: a correction applies on every rig, so a kiosk with no
   * Rohrverlängerung tracking must still be able to show it.
   */
  get depthCorrection(): number | null {
    if (!this.activeSession) return null;
    return this.activeSession.drill.manualCorrection;
  }

  /** Rohrverlängerung state of the running session, or null when idle. */
  get drillStatus(): DrillStatus | null {
    if (!this.activeSession || !this.activeSession.rohrwechsel.enabled) return null;
    return toStatus(this.activeSession.drill);
  }

  /**
   * Pick up changed Rohrverlängerung settings without ending the session.
   * A threshold typed on the config page has to take effect on the element
   * being drilled right now, not the next one.
   */
  refreshRohrwechselConfig(): void {
    if (this.activeSession) {
      this.activeSession.rohrwechsel = getRohrwechselConfig();
    }
  }

  /**
   * Reset session state for replay seek. Clears all recorded readings and
   * resets the drill state machine so the fast-forward from position 0
   * rebuilds everything from scratch.
   */
  resetForSeek(): void {
    if (this.activeSession) {
      clearSessionReadings(this.activeSession.id);
      this.activeSession.drill = initialDrillState();
      this.activeSession.volumeTracker.reset();
      this.lastReadings.clear();
      // The session's opening `Status` reading went with everything else, and
      // nothing re-states it: a mode is recorded when it *changes*
      // (`setOperatingMode` returns early otherwise), so a session that goes
      // on to drill in the mode it already had uploads with no `Status = 0`
      // row anywhere.
      //
      // implenia-web segments every Injektionsbohren KPI on that value
      // (`detectPhases`, filter `Status === 0`), so its absence empties the
      // entire Bohren phase: no duration, no pressure or flow averages, a
      // zero-width window for the depth chart, and therefore not one observed
      // geology layer — from a recording whose depth series is complete and
      // whose upload reported success.
      //
      // Only a replay seeks, so only a replay hits this, which is precisely
      // what makes it worth a line of code: it is the path every QA run of the
      // upload goes through, and it was quietly invalidating what the run was
      // meant to verify.
      this.recordStatusReading(this.activeSession);
    }
  }

  startRecording(sessionId: number, sensorMap: Map<string, SensorMapEntry>): void {
    // A session that already carries state is being resumed, not started —
    // after a crash or an auto-update restart. Picking the phase and the pipe
    // count back up keeps the screen honest about what the rig is doing.
    const restored = parseDrillState(getDrillState(sessionId));
    if (restored) {
      log.info('Resuming session %d at Rohr %d (%s)', sessionId, restored.pipeCount, restored.phase);
    }
    const storedMode = getOperatingMode(sessionId);
    // Baselines come out of the readings this session already holds, which is
    // nothing at all for a fresh one. A resumed session would otherwise show
    // the slurry volume restarting from zero, having recorded the rig's
    // cumulative total correctly all along.
    const mappings = getVolumeMappings();
    this.activeSession = {
      id: sessionId,
      sensorMap,
      drill: restored ?? initialDrillState(),
      rohrwechsel: getRohrwechselConfig(),
      operatingMode: (storedMode ? normalizeOperatingMode(storedMode) : null)
        ?? this.pendingMode ?? 'bohren',
      volumeTracker: new VolumeTracker(
        mappings,
        baselinesFromSession(sessionId, sensorMap, mappings),
      ),
      volumeTopics: mappings.map((m) => m.syntheticTopic),
      depthTopic: null,
    };
    this.pendingMode = null;
    this.seedLastReadings(sessionId, sensorMap, mappings);
    this.recordStatusReading(this.activeSession);
  }

  stopRecording(): void {
    // The per-element volumes go with the session. They are only ever emitted
    // from inside the recording branch of onReading, so one left behind can
    // never be corrected: the next screen to load would be handed the finished
    // element's litres for a pillar that has had none, and nothing would
    // overwrite it. The rig's own sensors stay — a depth or a pressure is the
    // machine's current state, element or no element, and the next reading
    // moves it on.
    if (this.activeSession) {
      for (const topic of this.activeSession.volumeTopics) this.lastReadings.delete(topic);
    }
    this.activeSession = null;
  }

  /**
   * Cycle the data source so it picks up changed settings. The MQTT broker URL
   * is read in start() rather than frozen at import, so changing it in the
   * setup wizard only needs this — not a process restart. The 'reading'
   * listener lives on the source's emitter and survives the cycle.
   */
  restartSource(): void {
    this.source.stop();
    this.source.start();
  }

  /**
   * The last value emitted for each topic.
   *
   * A browser that has just loaded holds nothing: the WebSocket only pushes
   * readings as they arrive, so every tile reads 0 until the rig publishes
   * again — after a PM2 restart, after a page reload, after the kiosk browser
   * is reopened. On a rig standing still that is not a flicker, it is the
   * screen lying about the hole. `CLAUDE.md`: no data source → show last known
   * state.
   *
   * Values as emitted, not as they arrived: calibrated, carrying the
   * Schlittenweg offset, and including the volume deltas that are computed for
   * the display and never recorded. Replaying `mqtt_buffer` instead would put
   * the carriage position on screen as if it were the depth.
   */
  private lastReadings = new Map<string, SensorReading>();

  private emitReading(reading: SensorReading): void {
    this.lastReadings.set(reading.topic, reading);
    this.emit('reading', reading);
  }

  /** What a screen that has just connected starts from. */
  latestReadings(): SensorReading[] {
    return [...this.lastReadings.values()];
  }

  /**
   * Rebuild the last-known values of a session that is being resumed.
   *
   * Only what this session recorded, which is also the only place the stored
   * value is the corrected one. A session that has just been created has
   * nothing, so a normal start seeds nothing and the map fills as data
   * arrives.
   */
  private seedLastReadings(
    sessionId: number,
    sensorMap: Map<string, SensorMapEntry>,
    mappings: CumulativeVolumeMapping[],
  ): void {
    let depthSeenAt = -1;
    for (const row of getLatestSessionReadings(sessionId)) {
      if (SELF_WRITTEN_TOPICS.has(row.topic)) continue;
      const payload = row.valueNumeric !== null ? String(row.valueNumeric) : row.valueText;
      if (payload === null) continue;
      const key = resolveSensorKey(row.topic, getResolverContext());

      // Which topic the depth arrives on, so a correction made before the rig
      // publishes again still reaches the screen. The resumed session is
      // exactly where this matters: after an hourly auto-update the kiosk
      // shows a depth restored from these rows, and on a rig that is standing
      // still — which is when a worker has time to count pipes — the next
      // reading may be minutes away.
      //
      // Before the `continue` below, which is about the cached *value*: which
      // topic carries the depth is true whether or not a fresher one is held.
      if (key && getSensorRole(key) === 'depth' && row.receivedAt > depthSeenAt && this.activeSession) {
        this.activeSession.depthTopic = row.topic;
        depthSeenAt = row.receivedAt;
      }

      const known = this.lastReadings.get(row.topic);
      if (known && known.receivedAt >= row.receivedAt) continue;
      this.lastReadings.set(row.topic, {
        topic: row.topic, payload, receivedAt: row.receivedAt, sensor: key,
      });
    }

    // Set outright. The session's own readings are what the delta is computed
    // from, so at the moment it is seeded nothing can be more current — and a
    // previous element's value, if one were still here, would be plain wrong.
    for (const { topic, volume } of volumeSnapshot(sessionId, sensorMap, mappings)) {
      this.lastReadings.set(topic, {
        topic, payload: String(roundValue(volume)), receivedAt: Date.now(),
        sensor: resolveSensorKey(topic, getResolverContext()),
      });
    }

    if (this.lastReadings.size > 0) {
      log.info('Session %d: %d last-known values restored', sessionId, this.lastReadings.size);
    }
  }

  private onSeekStart = (): void => { this.resetForSeek(); };

  private onReplayStart = (): void => {
    // Replay just streams MQTT data — the user starts recording via the UI
    // with a real element name, which fetches the sensor map from the API.
    // Auto-creating a session here produced an empty sensor map, so every
    // reading got sensor_id = NULL and upload silently sent nothing.
    log.info('Replay started — data is flowing, start recording via the UI to capture it');
  };

  private onReplayStop = (): void => {
    log.info('Replay stopped');
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    this.source.on('reading', this.onReading);
    this.source.on('seek-start', this.onSeekStart);
    this.source.on('replay-start', this.onReplayStart);
    this.source.on('replay-stop', this.onReplayStop);
    this.source.start();

    this.pruneTimer = setInterval(() => {
      pruneBuffer();
    }, 10 * 60 * 1000);
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.started) {
      this.source.off('reading', this.onReading);
      this.source.off('seek-start', this.onSeekStart);
      this.source.off('replay-start', this.onReplayStart);
      this.source.off('replay-stop', this.onReplayStop);
      this.started = false;
    }
    this.source.stop();
  }
}

// Source is chosen by the configured transport, not fixed at import.
export const ingestion = new DataIngestion(DataIngestion.sourceFor(getTransport()));
