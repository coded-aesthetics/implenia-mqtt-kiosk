import { EventEmitter } from 'node:events';
import type { DataSource, SensorReading } from './data-source.js';
import { insertBuffer, pruneBuffer, insertSessionReading } from './db.js';
import { parsePayload } from './parse-payload.js';
import { getResolverContext, resolveSensorKey } from './topic-resolver.js';
import { mqttSource } from './mqtt.js';
import { deviceSource } from './device-source.js';
import { getTransport, type Transport } from './transport.js';

export interface SensorMapEntry {
  sensorId: string;
  sensorType: string;
}

export class DataIngestion extends EventEmitter {
  private source: DataSource;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private activeSession: { id: number; sensorMap: Map<string, SensorMapEntry> } | null = null;
  private started = false;

  private readonly onReading = (reading: SensorReading): void => {
    insertBuffer(reading.topic, reading.payload);

    this.emit('reading', reading);

    if (this.activeSession) {
      // Overrides and the shipped topic map resolve boxes whose topic names
      // differ from the sensor names; an unresolved topic still gets stored,
      // just without a sensor id — and is therefore never uploaded.
      const key = resolveSensorKey(reading.topic, getResolverContext());
      const mapping = key ? this.activeSession.sensorMap.get(key) : undefined;
      const { valueNumeric, valueText } = parsePayload(reading.payload);

      insertSessionReading(
        this.activeSession.id,
        reading.topic,
        mapping?.sensorId ?? null,
        mapping?.sensorType ?? null,
        valueNumeric,
        valueText,
      );
    }
  };

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

  startRecording(sessionId: number, sensorMap: Map<string, SensorMapEntry>): void {
    this.activeSession = { id: sessionId, sensorMap };
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
