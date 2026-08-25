import { EventEmitter } from 'node:events';
import { createLogger } from './logger.js';

const log = createLogger('simulator');

export interface DeviceFrame {
  deviceId: number;
  address: string;
  values: number[];
  receivedAt: number;
}

const CHANNEL_COUNT = 15;
const FRAME_INTERVAL_MS = 500;

interface ChannelConfig {
  base: number;
  amplitude: number;
  speed: number;
}

const CHANNEL_CONFIGS: ChannelConfig[] = [
  { base: 50, amplitude: 10, speed: 0.3 },   // 0: Analog 0 (e.g. Anpressdruck)
  { base: 30, amplitude: 5, speed: 0.5 },    // 1: Analog 1 (e.g. Klemmbacke)
  { base: 8, amplitude: 3, speed: 0.2 },     // 2: Analog 2
  { base: 12, amplitude: 4, speed: 0.4 },    // 3: Analog 3
  { base: 4, amplitude: 2, speed: 0.15 },    // 4: Analog 4
  { base: 6, amplitude: 3, speed: 0.25 },    // 5: Analog 5
  { base: 0, amplitude: 1, speed: 0.1 },     // 6: reserved
  { base: 0, amplitude: 1, speed: 0.1 },     // 7: reserved
  { base: 0, amplitude: 1, speed: 0.1 },     // 8: reserved
  { base: 0, amplitude: 1, speed: 0.1 },     // 9: reserved
  { base: 120, amplitude: 30, speed: 0.6 },  // 10: Drehzahl
  { base: 15, amplitude: 15, speed: 0.08 },  // 11: CAN Tiefe (slow descent)
  { base: 2, amplitude: 1, speed: 0.35 },    // 12: CAN Ziehgeschwindigkeit
  { base: 0, amplitude: 3, speed: 0.12 },    // 13: CAN Winkel
  { base: 80, amplitude: 20, speed: 0.45 },  // 14: CAN Drehzahl
];

export class SimulatorSource extends EventEmitter {
  private deviceId: number;
  private address: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private phase = 0;
  private _connected = false;

  constructor(deviceId: number, address = '00') {
    super();
    this.deviceId = deviceId;
    this.address = address;
  }

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    if (this.timer) return;
    this._connected = true;
    log.info('Simulator %d started', this.deviceId);

    this.timer = setInterval(() => {
      this.phase += 0.1;
      const values: number[] = [];
      for (let i = 0; i < CHANNEL_COUNT; i++) {
        const cfg = CHANNEL_CONFIGS[i];
        const noise = (Math.random() - 0.5) * cfg.amplitude * 0.1;
        const value = cfg.base + Math.sin(this.phase * cfg.speed) * cfg.amplitude + noise;
        values.push(Math.round(value * 100) / 100);
      }

      const frame: DeviceFrame = {
        deviceId: this.deviceId,
        address: this.address,
        values,
        receivedAt: Date.now(),
      };
      this.emit('frame', frame);
    }, FRAME_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._connected = false;
    log.info('Simulator %d stopped', this.deviceId);
  }
}
