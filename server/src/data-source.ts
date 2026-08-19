import { EventEmitter } from 'node:events';

export interface SensorReading {
  topic: string;
  payload: string;
  receivedAt: number;
}

export abstract class DataSource extends EventEmitter {
  abstract start(): void;
  abstract stop(): void;
  abstract get connected(): boolean;
  abstract get sourceType(): string;
}
