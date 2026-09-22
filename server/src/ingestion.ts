import { EventEmitter } from 'node:events';
import type { DataSource, SensorReading } from './data-source.js';
import {
  insertBuffer, pruneBuffer, insertSessionReading, getDrillState, setDrillState,
  getOperatingMode, setOperatingModeRow,
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

const log = createLogger('ingestion');

export interface SensorMapEntry {
  sensorId: string;
  sensorType: string;
}

/** What the rig is doing. Only `bohren` has Rohrwechsel to clip. */
export type OperatingMode = 'bohren' | 'verpressen';

export function isOperatingMode(value: string): value is OperatingMode {
  return value === 'bohren' || value === 'verpressen';
}

interface ActiveSession {
  id: number;
  sensorMap: Map<string, SensorMapEntry>;
  drill: DrillState;
  rohrwechsel: RohrwechselConfig;
  operatingMode: OperatingMode;
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
 * Not `Number(payload)`: that turns an empty payload into 0, and a rig
 * publishing a blank Klemmbacke value would read as "clamp wide open" — which
 * is exactly the wrong direction to guess in.
 */
function numericPayload(payload: string): number {
  const trimmed = payload.trim();
  return trimmed === '' ? NaN : Number(trimmed);
}

export class DataIngestion extends EventEmitter {
  private source: DataSource;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private activeSession: ActiveSession | null = null;
  private started = false;

  private readonly onReading = (reading: SensorReading): void => {
    insertBuffer(reading.topic, reading.payload);

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
        { valueRaw: corrected.valueRaw, phase: corrected.phase, clipped: corrected.clipped },
      );
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

    if (isClampTopic(reading.topic, cfg.clampTopic)) {
      // Deliberately the raw value: the thresholds are set by watching what
      // the clamp actually publishes, so a calibration meant for a sensor of
      // the same name must not move them underneath the technician.
      const { state, transition } = applyClampPressure(
        session.drill, raw, cfg, reading.receivedAt,
      );
      session.drill = state;

      if (transition) {
        // Persisted here and nowhere else: a phase change is the only moment
        // this state moves, and a restart that loses it mid-Rohrwechsel would
        // record the rest of the pipe change as drilling data.
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
          if (state.warning) log.warn('Rohrwechsel implausible: %s', state.warning);
        } else {
          log.info('Rohrwechsel finished — drilling Rohr %d', state.pipeCount);
        }
        this.emit('rohrwechsel', { transition, status: toStatus(state) });
      }

      return { ...asRecorded, phase: state.phase, clipped: this.clips(state) };
    }

    if (key && getSensorRole(key) === 'depth' && Number.isFinite(raw)) {
      const { state, depth } = observeDepth(session.drill, calibrated, cfg);
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
   * A closed Klemmbacke only means a pipe change **while drilling**. During
   * Verpressen it holds the pipe string steady and stays closed for most of
   * the phase — 81% of it on the G08 reference capture, against 43% while
   * drilling. Clipping on the clamp alone would therefore discard most of the
   * grouting data, which is exactly the data Injektionsbohren exists to
   * record.
   */
  private clips(state: DrillState): boolean {
    return isClipped(state) && this.activeSession?.operatingMode === 'bohren';
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
      this.source.stop();
    }
    this.source = source;
    if (wasStarted) {
      this.source.on('reading', this.onReading);
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
    return this.activeSession?.operatingMode ?? null;
  }

  /**
   * Switch between drilling and grouting. Persisted, so a restart mid-element
   * does not silently resume clipping a grouting phase.
   */
  setOperatingMode(mode: OperatingMode): void {
    const session = this.activeSession;
    if (!session || session.operatingMode === mode) return;
    session.operatingMode = mode;
    setOperatingModeRow(session.id, mode);
    log.info('Operating mode for session %d is now %s', session.id, mode);
    this.emit('operating-mode', mode);
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
      operatingMode: storedMode && isOperatingMode(storedMode) ? storedMode : 'bohren',
    };
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

  start(): void {
    if (this.started) return;
    this.started = true;
    this.source.on('reading', this.onReading);
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
      this.started = false;
    }
    this.source.stop();
  }
}

// Source is chosen by the configured transport, not fixed at import.
export const ingestion = new DataIngestion(DataIngestion.sourceFor(getTransport()));
