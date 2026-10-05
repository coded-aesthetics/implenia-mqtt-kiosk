import { EventEmitter } from 'node:events';
import type { DataSource, SensorReading } from './data-source.js';
import {
  insertBuffer, pruneBuffer, insertSessionReading, getDrillState, setDrillState,
  getOperatingMode, setOperatingModeRow, clearSessionReadings,
  createSession, endSession, getActiveSession,
} from './db.js';
import { parsePayload } from './parse-payload.js';
import { getResolverContext, resolveSensorKey } from './topic-resolver.js';
import { getSensorRole } from './sensor-meta.js';
import { mqttSource } from './mqtt.js';
import { deviceSource } from './device-source.js';
import { getTransport, type Transport } from './transport.js';
import { createLogger } from './logger.js';
import {
  applyClampPressure, initialDrillState, isClipped, observeDepth,
  parseDrillState, toStatus,
  type DrillPhase, type DrillState, type DrillStatus,
} from './rohrwechsel.js';
import {
  getRohrwechselConfig, isClampTopic, type RohrwechselConfig,
} from './rohrwechsel-config.js';
import { applyCalibration, calibrationFor, isNeutral } from './calibration.js';
import { VolumeTracker, getVolumeMappings } from './volume-integration.js';

const log = createLogger('ingestion');

export interface SensorMapEntry {
  sensorId: string;
  sensorType: string;
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

export function hasPipeHandling(mode: OperatingMode): boolean {
  return mode === 'bohren' || mode === 'austausch' || mode === 'einbauen' || mode === 'auffuellen';
}

interface ActiveSession {
  id: number;
  sensorMap: Map<string, SensorMapEntry>;
  drill: DrillState;
  rohrwechsel: RohrwechselConfig;
  operatingMode: OperatingMode;
  volumeTracker: VolumeTracker;
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
    this.emit('reading', { ...reading, payload: corrected.payload });

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
          this.emit('reading', { topic: volResult.topic, payload: volPayload, receivedAt: reading.receivedAt });
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

    if (!session || !session.rohrwechsel.enabled) return asRecorded;

    const cfg = session.rohrwechsel;
    const mode = session.operatingMode;

    const retracting = isRetracting(mode);

    if (hasPipeHandling(mode) && isClampTopic(reading.topic, cfg.clampTopic)) {
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

    if (key && getSensorRole(key) === 'depth' && Number.isFinite(raw)) {
      const { state, depth } = observeDepth(session.drill, calibrated, cfg, retracting);
      session.drill = state;

      if (depth !== null) {
        const rounded = roundValue(depth);
        return {
          payload: String(rounded),
          // The reading as it arrived, which is what makes a wrong offset or a
          // wrong calibration reconstructable later.
          valueRaw: rounded === raw ? null : raw,
          phase: state.phase,
          clipped: this.clips(state),
        };
      }
    }

    return { ...asRecorded, phase: session.drill.phase, clipped: this.clips(session.drill) };
  }

  /**
   * Whether a reading taken now must be held back.
   *
   * Both `bohren` and `auffuellen` clip during rohrwechsel (clamp closed) —
   * the drive is handling a pipe, and its readings corrupt averages.
   * `austausch` and `einbauen` never clip.
   */
  private clips(state: DrillState): boolean {
    const mode = this.activeSession?.operatingMode;
    if (mode && hasPipeHandling(mode)) return isClipped(state);
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
    const statusValue = session.operatingMode === 'bohren' ? 0 : 1;
    insertSessionReading(
      session.id, 'kiosk/status', mapping.sensorId, mapping.sensorType,
      statusValue, null,
    );
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
    this.activeSession = {
      id: sessionId,
      sensorMap,
      drill: restored ?? initialDrillState(),
      rohrwechsel: getRohrwechselConfig(),
      operatingMode: (storedMode ? normalizeOperatingMode(storedMode) : null)
        ?? this.pendingMode ?? 'bohren',
      volumeTracker: new VolumeTracker(getVolumeMappings()),
    };
    this.pendingMode = null;
    this.recordStatusReading(this.activeSession);
  }

  stopRecording(): void {
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

  private onSeekStart = (): void => { this.resetForSeek(); };

  private onReplayStart = (): void => {
    if (this.activeSession) return;
    const sessionId = createSession('replay', JSON.stringify({}));
    this.startRecording(sessionId, new Map());
    log.info('Started replay session %d', sessionId);
  };

  private onReplayStop = (): void => {
    if (!this.activeSession) return;
    const sessionId = this.activeSession.id;
    this.stopRecording();
    endSession(sessionId);
    log.info('Ended replay session %d', sessionId);
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
