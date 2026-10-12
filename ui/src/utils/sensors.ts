import type { VorgabenData } from '../hooks/useImplenia';
import type { SensorReading } from '../hooks/useWebSocket';

export function findSoll(vorgaben: VorgabenData | null, sensorName: string): number | null {
  if (!vorgaben) return null;
  const fv = vorgaben.float_sensors?.[sensorName];
  if (typeof fv === 'number' && Number.isFinite(fv)) return fv;
  const iv = vorgaben.int_sensors?.[sensorName];
  if (typeof iv === 'number' && Number.isFinite(iv)) return iv;
  return null;
}

export function buildSensorValues(readings: Map<string, SensorReading>): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of readings.values()) {
    const n = parseFloat(r.payload);
    const val = Number.isFinite(n) ? n : 0;
    map.set(r.topic, val);
    const slashIdx = r.topic.lastIndexOf('/');
    if (slashIdx >= 0) {
      map.set(r.topic.substring(slashIdx + 1), val);
    }
    // The server's own answer, lowercased — the only key that holds for a
    // topic wired on site, whose name is nowhere in the topic. Additional, not
    // instead: every existing caller looks up a CSV name in its original case.
    if (r.sensor) map.set(r.sensor, val);
  }
  return map;
}

/**
 * The live reading of a sensor, found by name.
 *
 * Three ways a topic can carry a sensor, in the order the server resolves
 * them: the sensor key it resolved the topic to (what the Sensorzuordnung
 * wired, and the only one that works for an opaque topic), the topic's last
 * segment, and the whole topic. Within one rank the newest wins.
 *
 * Returns the reading rather than the number because the caller needs
 * `receivedAt` too: a frozen angle shown as if it were live is worse than no
 * angle at all.
 */
export function findSensorReading(
  readings: Map<string, SensorReading>,
  sensorName: string,
): SensorReading | null {
  const wanted = sensorName.trim().toLowerCase();
  if (!wanted) return null;

  let best: SensorReading | null = null;
  let bestRank = Infinity;

  for (const r of readings.values()) {
    const topic = r.topic.toLowerCase();
    const segment = topic.split('/').pop() ?? '';
    const rank =
      r.sensor != null && r.sensor.toLowerCase() === wanted ? 0
        : segment === wanted ? 1
          : topic === wanted ? 2
            : Infinity;
    if (rank === Infinity) continue;
    if (rank < bestRank || (rank === bestRank && best !== null && r.receivedAt > best.receivedAt)) {
      best = r;
      bestRank = rank;
    }
  }

  return best;
}

/** The numeric value of `findSensorReading`, or null when it is not a number. */
export function findSensorNumber(
  readings: Map<string, SensorReading>,
  sensorName: string,
): { value: number; receivedAt: number } | null {
  const reading = findSensorReading(readings, sensorName);
  if (!reading) return null;
  const n = parseFloat(reading.payload);
  if (!Number.isFinite(n)) return null;
  return { value: n, receivedAt: reading.receivedAt };
}
