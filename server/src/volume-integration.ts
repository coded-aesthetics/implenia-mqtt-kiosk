import { getActiveVerfahren, loadSensorCsv } from './sensor-meta.js';
import { createLogger } from './logger.js';

const log = createLogger('volume-integration');

export interface CumulativeVolumeMapping {
  /** Lowercased sensor key (as returned by the topic resolver). */
  cumulativeKey: string;
  /** Topic name to emit for the per-element delta (original case from CSV). */
  syntheticTopic: string;
}

/**
 * Tracks the rig's cumulative volume readings and emits per-element deltas.
 *
 * Construction rigs publish a running volume total (from a PLC flow totalizer
 * that integrates at scan rate). The kiosk records the raw cumulative values
 * for upload and computes the per-element delta for the live display. This is
 * more accurate than re-integrating from the sparse MQTT flow rate readings
 * (~3 s intervals), which loses precision between samples.
 */
export class VolumeTracker {
  private baselines = new Map<string, number>();
  private byKey: Map<string, string>;

  constructor(mappings: CumulativeVolumeMapping[]) {
    this.byKey = new Map(mappings.map((m) => [m.cumulativeKey, m.syntheticTopic]));
  }

  /**
   * Process a resolved sensor reading. If `sensorKey` is a tracked cumulative
   * volume sensor, returns the per-element delta (current − baseline).
   * The first value seen becomes the baseline.
   */
  observe(
    sensorKey: string,
    value: number,
  ): { topic: string; volume: number } | null {
    const syntheticTopic = this.byKey.get(sensorKey);
    if (!syntheticTopic || !Number.isFinite(value)) return null;

    if (!this.baselines.has(sensorKey)) {
      this.baselines.set(sensorKey, value);
    }

    const baseline = this.baselines.get(sensorKey)!;
    return { topic: syntheticTopic, volume: value - baseline };
  }

  reset(): void {
    this.baselines.clear();
  }
}

/**
 * Cumulative volume sensors for the active Verfahren.
 *
 * Convention: a kiosk-source sensor with role `volume_*` is a per-element
 * delta computed from the rig's cumulative total (which arrives via MQTT and
 * resolves to the same sensor name through the topic map).
 */
export function getVolumeMappings(): CumulativeVolumeMapping[] {
  const verfahren = getActiveVerfahren();
  if (!verfahren) return [];

  const rows = loadSensorCsv(verfahren);
  if (!rows) return [];

  const mappings: CumulativeVolumeMapping[] = [];
  for (const row of rows) {
    if (row.source === 'kiosk' && row.role.startsWith('volume_')) {
      mappings.push({
        cumulativeKey: row.name.toLowerCase(),
        syntheticTopic: row.name,
      });
    }
  }

  if (mappings.length > 0) {
    log.info(
      'Volume tracking: %s',
      mappings.map((m) => m.syntheticTopic).join(', '),
    );
  }

  return mappings;
}
