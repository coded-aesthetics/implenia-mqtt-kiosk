import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { ReadlineParser } from 'serialport';
import { parseElvisFrame } from './elvis-parser.js';
import { createLogger } from './logger.js';
import type { DeviceFrame } from './simulator-source.js';

const log = createLogger('serial');

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

export class SerialSource extends EventEmitter {
  private deviceId: number;
  private portPath: string;
  private baudRate: number;
  private port: SerialPort | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private stopped = false;

  constructor(deviceId: number, portPath: string, baudRate: number) {
    super();
    this.deviceId = deviceId;
    this.portPath = portPath;
    this.baudRate = baudRate;
  }

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.port?.isOpen) {
      this.port.close();
    }
    this.port = null;
    this._connected = false;
  }

  private open(): void {
    if (this.stopped) return;

    try {
      this.port = new SerialPort({
        path: this.portPath,
        baudRate: this.baudRate,
        autoOpen: false,
      });
    } catch (err) {
      log.error('Device %d: failed to create port %s: %s', this.deviceId, this.portPath, (err as Error).message);
      this.scheduleReconnect();
      return;
    }

    const parser = this.port.pipe(new ReadlineParser({ delimiter: '\r' }));

    parser.on('data', (line: string) => {
      log.debug('Device %d: raw line: %s', this.deviceId, line);
      const parsed = parseElvisFrame(line + '\r');
      if (!parsed) {
        log.warn('Device %d: failed to parse frame: %s', this.deviceId, line);
        return;
      }

      log.debug('Device %d: parsed frame addr=%s values=%d', this.deviceId, parsed.address, parsed.values.length);
      const frame: DeviceFrame = {
        deviceId: this.deviceId,
        address: parsed.address,
        values: parsed.values,
        receivedAt: Date.now(),
      };
      this.emit('frame', frame);
    });

    this.port.on('open', () => {
      this._connected = true;
      this.reconnectDelay = RECONNECT_BASE_MS;
      log.info('Device %d: connected to %s at %d baud', this.deviceId, this.portPath, this.baudRate);
      this.emit('connected');
    });

    this.port.on('close', () => {
      this._connected = false;
      log.info('Device %d: port closed', this.deviceId);
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.port.on('error', (err: Error) => {
      log.error('Device %d: port error: %s', this.deviceId, err.message);
      this._connected = false;
      this.emit('disconnected');
      if (this.port?.isOpen) {
        this.port.close();
      }
      this.scheduleReconnect();
    });

    this.port.open((err: Error | null | undefined) => {
      if (err) {
        log.warn('Device %d: cannot open %s: %s', this.deviceId, this.portPath, err.message);
        this._connected = false;
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    log.debug('Device %d: reconnecting in %dms', this.deviceId, this.reconnectDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}
