import { EventEmitter } from 'node:events';
import type { DataSource, SensorReading } from './data-source.js';
import { insertBuffer, pruneBuffer, insertSessionReading } from './db.js';
import { parsePayload } from './parse-payload.js';
import { mqttSource } from './mqtt.js';

export interface SensorMapEntry {
  sensorId: string;
  sensorType: string;
}

class DataIngestion extends EventEmitter {
  private source: DataSource;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private activeSession: { id: number; sensorMap: Map<string, SensorMapEntry> } | null = null;

  constructor(source: DataSource) {
    super();
    this.source = source;
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

  start(): void {
    this.source.on('reading', (reading: SensorReading) => {
      insertBuffer(reading.topic, reading.payload);

      this.emit('reading', reading);

      if (this.activeSession) {
        const topicSuffix = reading.topic.split('/').pop()?.toLowerCase() ?? '';
        const mapping = this.activeSession.sensorMap.get(topicSuffix);
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
    });

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
    this.source.stop();
  }
}

export const ingestion = new DataIngestion(mqttSource);
