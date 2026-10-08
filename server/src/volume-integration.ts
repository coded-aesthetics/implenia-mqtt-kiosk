import { getActiveVerfahren, loadSensorCsv } from './sensor-meta.js';
import { getFirstSessionValue } from './db.js';
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
 *
 * The baselines are state, so a restart mid-element has to restore them or the
 * displayed volume drops to zero and climbs again from wherever the rig's
 * totalizer stood at boot — on the screen whose job is telling the worker how
 * much slurry this pillar has had. They are not persisted separately:
 * `baselinesFromSession` reads them back out of the readings already recorded,
 * which is the same number by definition.
 */
export class VolumeTracker {
  private baselines: Map<string, number>;
  private byKey: Map<string, string>;

  /**
   * `baselines` restores the state of a session that is being resumed — see
   * baselinesFromSession. Omitted for a new one, where the first reading of
   * each sensor becomes its baseline as it arrives.
   */
  constructor(mappings: CumulativeVolumeMapping[], baselines?: Map<string, number>) {
    this.byKey = new Map(mappings.map((m) => [m.cumulativeKey, m.syntheticTopic]));
    this.baselines = new Map(baselines ?? []);
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
 * Rebuild the baselines of a session already holding readings.
 *
 * Empty for a session that has just been created — nothing is recorded yet —
 * so the resume path needs no branch of its own: the same call covers a start
 * and a restart.
 *
 * Resolved through the session's own sensor map, because the baseline is keyed
 * by sensor *name* while readings carry a sensor id. A cumulative sensor the
 * map does not cover records with a null sensor_id and cannot be recovered;
 * it also never uploads, so the display restarting is the smaller of its two
 * problems.
 */
export function baselinesFromSession(
  sessionId: number,
  sensorMap: Map<string, { sensorId: string }>,
  mappings: CumulativeVolumeMapping[],
): Map<string, number> {
  const baselines = new Map<string, number>();
  for (const mapping of mappings) {
    const sensorId = sensorMap.get(mapping.cumulativeKey)?.sensorId;
    if (!sensorId) continue;
    const first = getFirstSessionValue(sessionId, sensorId);
    if (first !== null) baselines.set(mapping.cumulativeKey, first);
  }
  if (baselines.size > 0) {
    log.info(
      'Session %d: restored volume baselines (%s)',
      sessionId,
      [...baselines].map(([k, v]) => `${k}=${v}`).join(', '),
    );
  }
  return baselines;
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
