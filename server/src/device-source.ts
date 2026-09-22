import { DataSource, type SensorReading } from './data-source.js';
import { deviceManager } from './device-manager.js';
import { getDeviceMappings } from './db.js';
import type { DeviceFrame } from './simulator-source.js';
import { createLogger } from './logger.js';

const log = createLogger('device-source');

/**
 * Serial (and simulator) devices as a `DataSource`.
 *
 * `deviceManager` emits raw frames — an array of floats per device, where the
 * position carries the meaning. This turns a frame into the same
 * `SensorReading` shape MQTT produces, using the channel mappings the
 * technician assigned, so both transports converge before ingestion buffers,
 * records and uploads.
 *
 * Before this existed, frames went straight to the WebSocket broadcaster:
 * serial data was displayed live and never recorded.
 */
class DeviceSource extends DataSource {
  private started = false;
  private readonly onFrame = (frame: DeviceFrame): void => {
    for (const m of this.mappingsFor(frame.deviceId)) {
      if (m.value_index >= frame.values.length) continue;
      const reading: SensorReading = {
        // Same shape the sensor map is keyed by, so the resolver treats a
        // serial reading exactly like an MQTT one.
        topic: `device/${frame.deviceId}/${m.sensor_name}`,
        payload: String(frame.values[m.value_index]),
        receivedAt: frame.receivedAt,
      };
      this.emit('reading', reading);
    }
  };

  // Channel mappings change rarely but are read per frame, so they are cached.
  private mappingCache = new Map<number, { rows: MappingRow[]; fetchedAt: number }>();
  private static readonly MAPPING_TTL_MS = 10_000;

  private mappingsFor(deviceId: number): MappingRow[] {
    const hit = this.mappingCache.get(deviceId);
    if (hit && Date.now() - hit.fetchedAt < DeviceSource.MAPPING_TTL_MS) return hit.rows;
    const rows = getDeviceMappings(deviceId);
    this.mappingCache.set(deviceId, { rows, fetchedAt: Date.now() });
    return rows;
  }

  /** Drop cached mappings so a just-assigned channel takes effect. */
  clearMappingCache(): void {
    this.mappingCache.clear();
  }

  get connected(): boolean {
    return deviceManager.getStatus().some((d) => d.connected);
  }

  get sourceType(): string {
    return 'serial';
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    deviceManager.on('frame', this.onFrame);
    deviceManager.start();
    log.info('Serial device source started');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    deviceManager.off('frame', this.onFrame);
    deviceManager.stop();
    this.mappingCache.clear();
    log.info('Serial device source stopped');
  }
}

interface MappingRow {
  device_id: number;
  value_index: number;
  sensor_name: string;
}

export const deviceSource = new DeviceSource();
