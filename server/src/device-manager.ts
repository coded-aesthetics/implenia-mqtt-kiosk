import { EventEmitter } from 'node:events';
import { getDevices, type DeviceRow } from './db.js';
import { SimulatorSource, type DeviceFrame } from './simulator-source.js';
import { SerialSource } from './serial-source.js';
import { createLogger } from './logger.js';

const log = createLogger('devices');

type Source = SimulatorSource | SerialSource;

class DeviceManager extends EventEmitter {
  private sources = new Map<number, Source>();

  start(): void {
    this.reload();
  }

  stop(): void {
    for (const [id, source] of this.sources) {
      source.stop();
      log.info('Stopped device %d', id);
    }
    this.sources.clear();
  }

  reload(): void {
    const devices = getDevices();
    const wanted = new Set(devices.map((d) => d.id));

    for (const [id, source] of this.sources) {
      if (!wanted.has(id)) {
        source.stop();
        this.sources.delete(id);
        log.info('Removed device %d', id);
      }
    }

    for (const device of devices) {
      if (!this.sources.has(device.id)) {
        this.addDevice(device);
      }
    }
  }

  getStatus(): { deviceId: number; label: string; type: string; connected: boolean }[] {
    const devices = getDevices();
    return devices.map((d) => ({
      deviceId: d.id,
      label: d.label,
      type: d.type,
      connected: this.sources.get(d.id)?.connected ?? false,
    }));
  }

  private addDevice(device: DeviceRow): void {
    let source: Source;

    if (device.type === 'simulator') {
      source = new SimulatorSource(device.id);
    } else if (device.port) {
      source = new SerialSource(device.id, device.port, device.baud);
    } else {
      log.warn('Device %d (%s): no port configured, skipping', device.id, device.label);
      return;
    }

    source.on('frame', (frame: DeviceFrame) => {
      this.emit('frame', frame);
    });

    source.on('connected', () => {
      this.emit('device-status', { deviceId: device.id, connected: true });
    });

    source.on('disconnected', () => {
      this.emit('device-status', { deviceId: device.id, connected: false });
    });

    this.sources.set(device.id, source);
    source.start();
    log.info('Started device %d (%s) type=%s', device.id, device.label, device.type);
  }
}

export const deviceManager = new DeviceManager();
