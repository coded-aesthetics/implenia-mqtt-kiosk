import { EventEmitter } from 'node:events';

export interface SensorReading {
  topic: string;
  payload: string;
  receivedAt: number;
  /**
   * The sensor this topic resolved to, lowercased — `resolveSensorKey()`'s
   * answer, or null when the topic resolves to nothing.
   *
   * Carried so the browser can find a sensor by *name*. A screen only ever
   * saw the raw topic, so it could match a sensor whose topic happens to end
   * with its name and nothing else: a topic wired on site in the
   * Sensorzuordnung (`plc/ch07` → `Richtung X`) resolved correctly for the
   * upload and showed up nowhere on screen. Set on the live path, on the
   * snapshot a reconnecting browser gets, and on a resumed session's seeded
   * values — anything that reaches `lastReadings`.
   */
  sensor?: string | null;
}

export abstract class DataSource extends EventEmitter {
  abstract start(): void;
  abstract stop(): void;
  abstract get connected(): boolean;
  abstract get sourceType(): string;
}
